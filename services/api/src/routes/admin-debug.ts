// Wave 7.2 — Admin diagnostics: debug bundle, calc jobs, recent errors.

import type { FastifyInstance } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import {
  getActiveTarget,
  getActiveTargetVersion,
  getRuntimePoolSize,
  type RuntimeCategory,
} from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { getBackpressureSnapshot } from "../backpressure.ts";
import { listRecentRuns } from "../calc/recent-runs.ts";
import { listActiveCalcJobs } from "../calc/calc-jobs.ts";
import { listRecentErrors } from "../ops/recent-errors.ts";
import { formatLogLinesText, listLogLines } from "../ops/log-buffer.ts";
import { getDriftResults } from "../jobs/drift-detector.ts";
import { getSensKeyCountSnapshot } from "../lib/sens-key-count-cache.ts";
import * as inflight from "../inflight-registry.ts";
import { listActiveGeneratorRuns } from "./generator.ts";
import { listActiveBulkIngestRuns } from "./ingest.ts";
import { translateObservabilityRedisError } from "../redis-errors.ts";
import { getBootstrapStatus as getServerBootstrapFlag } from "../server.ts";
import {
  createBulkLoaderStatusFetch,
  discoverBulkLoaderTopology,
  fetchAggregatedBulkLoadStatus,
} from "../bulk-loader-topology.ts";

function parseInfo(text: string): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx);
    const raw = line.slice(idx + 1).trim();
    const n = Number(raw);
    out[key] = Number.isFinite(n) ? n : raw;
  }
  return out;
}

async function fetchBulkLoaderSnapshot(): Promise<unknown | null> {
  const base = process.env.BULK_LOADER_URL
    ?? `http://localhost:${process.env.BULK_LOADER_PORT ?? 8086}`;
  try {
    const fetchOne = createBulkLoaderStatusFetch({ base, fetchImpl: fetch });
    const topo = await discoverBulkLoaderTopology(fetchOne);
    return await fetchAggregatedBulkLoadStatus(fetchOne, topo.replicas);
  } catch {
    return null;
  }
}

export function registerAdminDebugRoutes(
  app: FastifyInstance,
  getRedis: (category?: RuntimeCategory) => RedisLike | Promise<RedisLike>,
): void {
  app.get("/admin/calc-jobs", { config: { category: "light" } }, async () => {
    return { active: listActiveCalcJobs() };
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/admin/recent-errors",
    { config: { category: "light" } },
    async (req) => {
      const raw = Number(req.query?.limit);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 50) : 20;
      return { items: listRecentErrors(limit) };
    },
  );

  app.get<{ Querystring: { tail?: string; format?: string } }>(
    "/admin/logs",
    { config: { category: "light" } },
    async (req, reply) => {
      const raw = Number(req.query?.tail);
      const tail = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 1000) : 200;
      const lines = listLogLines(tail);
      if (req.query?.format === "text") {
        reply.header("content-type", "text/plain; charset=utf-8");
        return formatLogLinesText(lines);
      }
      return {
        tail,
        count: lines.length,
        docker_hint: "docker compose logs api --tail=500",
        items: lines,
      };
    },
  );

  app.get("/admin/debug-bundle", { config: { category: "light" } }, async (req, reply) => {
    const generated_at = new Date().toISOString();
    let target_label = "";
    let target: { host: string; port: number; label: string; version: number } | null = null;
    try {
      const t = getActiveTarget();
      target_label = t.label;
      target = {
        host: t.host,
        port: t.port,
        label: t.label,
        version: getActiveTargetVersion(),
      };
    } catch {
      target = null;
    }

    const bootstrap = getBootstrapStatus();
    const server_boot = getServerBootstrapFlag();
    const backpressure = getBackpressureSnapshot();
    const drift = getDriftResults();
    const drift_count = drift.filter((r) => r.status === "drift").length;

    let cluster: Record<string, unknown> | null = null;
    if (target_label) {
      try {
        const redis = await getRedis(req.poolCategory);
        const prefix = "sens:";
        const [, keys] = await redis.scan("0", "MATCH", `${prefix}*`, "COUNT", "1000");
        const [memText, statsText, dbsize] = await Promise.all([
          redis.info("memory"),
          redis.info("stats"),
          redis.dbsize(),
        ]);
        const parsed = parseInfo(memText);
        const statsParsed = parseInfo(statsText);
        const index_count = await getSensKeyCountSnapshot(target_label, redis);
        cluster = {
          keys: {
            prefix,
            dbsize,
            sample: keys.slice(0, 20),
            sample_size: Math.min(keys.length, 20),
          },
          memory: {
            used_memory_human: parsed.used_memory_human ?? null,
            used_memory: Number(parsed.used_memory ?? 0),
            instantaneous_ops_per_sec: Number(statsParsed.instantaneous_ops_per_sec ?? 0),
          },
          index_count,
        };
      } catch (err) {
        const translated = translateObservabilityRedisError(err, target_label, bootstrap.phase);
        cluster = {
          error: translated?.body ?? { message: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    const bulk_loader = await fetchBulkLoaderSnapshot();

    return {
      generated_at,
      target,
      bootstrap: {
        phase: bootstrap.phase,
        target_label: bootstrap.target_label ?? target_label,
        err: bootstrap.err ?? null,
        server_ready: server_boot.ok,
        server_boot_err: server_boot.ok ? null : (server_boot.err ?? server_boot.reason ?? null),
      },
      backpressure: backpressure
        ? {
            heavy_inflight: backpressure.heavy,
            heavy_limit: backpressure.heavyLimit,
            light_inflight: backpressure.light,
            light_limit: backpressure.lightLimit,
          }
        : null,
      runtime_pools: {
        heavy_calc: getRuntimePoolSize("heavy-calc"),
        heavy_ingest: getRuntimePoolSize("heavy-ingest"),
        light: getRuntimePoolSize("light"),
      },
      cluster,
      calc: {
        active_jobs: listActiveCalcJobs(),
        recent_runs: listRecentRuns(10),
      },
      ingest: {
        generator_active: listActiveGeneratorRuns(),
        bulk_active: listActiveBulkIngestRuns(),
        bulk_loader,
      },
      drift: {
        threshold_pct: Number(process.env.DRIFT_THRESHOLD_PCT ?? "0.01"),
        total_checks: drift.length,
        drift_count,
        recent: drift.slice(-5).reverse(),
      },
      inflight: inflight.snapshot(),
      recent_errors: listRecentErrors(10),
      recent_logs: listLogLines(50),
    };
  });
}

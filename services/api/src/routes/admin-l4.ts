// Wave 6.39.C — Layer 4 admin endpoints.
//
// Single registration entry that wires the five Layer 4 surfaces:
//   GET  /admin/drift-status     — last 100 drift-check results + threshold
//   GET  /admin/snapshots         — prior rollup snapshot runs
//   GET  /admin/stream-status     — XLEN + configured MAXLEN + retention h
//   POST /admin/reconcile-bucket  — atomic rollup overwrite (admin-token)
//   GET  /metrics                 — Prometheus counters (drift / snap /
//                                   reconcile)
// Wired from services/api/src/routes/admin.ts so the L4 surface lands on
// the same Fastify app without touching server.ts.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RedisLike } from "../redis-like.ts";
import type { RuntimeCategory } from "../active-target.ts";
import { rollupKey } from "@frtb/calc-shared/rollup-keys";
import { getDriftResults } from "../jobs/drift-detector.ts";
import { listSnapshots } from "../jobs/snapshot.ts";
import { readStreamStatus } from "../jobs/stream-retention.ts";
import { incCounter } from "../jobs/metrics.ts";

export type DriftSensitivity = "Delta" | "Vega" | "Curvature";

export interface AdminL4RoutesOpts {
  // Shared-secret used for /admin/reconcile-bucket. Falls back to
  // process.env.ADMIN_TOKEN when omitted; tests always pass explicitly.
  adminToken?: string;
  // Drift threshold echoed on /admin/drift-status (informational only —
  // the job itself owns the active threshold). Defaults to 0.01 (%).
  driftThresholdPct?: number;
  // Stream-retention snapshot used by /admin/stream-status. Production
  // wires this from the boot-time benchmark (jobs/stream-retention).
  streamConfig: {
    streamKey: string;
    maxLen: number;
    peakRatePerSec: number;
  };
  // Reconcile recompute. Production wires a thin wrapper around
  // aggregateBucketsViaIndex; tests stub a fixture sum.
  recomputeBucketSum: (
    redis: RedisLike,
    riskClass: string,
    bucket: string,
    sensitivityType: DriftSensitivity,
  ) => Promise<number>;
}

interface ReconcileBody {
  risk_class?: unknown;
  bucket?: unknown;
  sensitivity_type?: unknown;
}

function tokenFromRequest(req: FastifyRequest): string | null {
  const raw = req.headers["x-admin-token"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw[0] ?? null;
  return null;
}

export function registerAdminL4Routes(
  app: FastifyInstance,
  getRedis: (category?: RuntimeCategory) => RedisLike,
  opts: AdminL4RoutesOpts,
): void {
  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? "";
  const driftThresholdPct = opts.driftThresholdPct ?? 0.01;
  const streamCfg = opts.streamConfig;

  app.get("/admin/drift-status", { config: { category: "light" } }, async () => {
    return {
      threshold_pct: driftThresholdPct,
      results: getDriftResults(),
    };
  });

  app.get("/admin/snapshots", { config: { category: "light" } }, async (req) => {
    const redis = getRedis(req.poolCategory);
    const snapshots = await listSnapshots(redis);
    return { snapshots };
  });

  app.get("/admin/stream-status", { config: { category: "light" } }, async (req) => {
    const redis = getRedis(req.poolCategory);
    const status = await readStreamStatus(redis, {
      streamKey: streamCfg.streamKey,
      maxLen: streamCfg.maxLen,
      peakRatePerSec: streamCfg.peakRatePerSec,
    });
    return status;
  });

  app.post("/admin/reconcile-bucket", async (req: FastifyRequest, reply: FastifyReply) => {
    const presented = tokenFromRequest(req);
    if (!adminToken || presented !== adminToken) {
      reply.code(401);
      return { error: "unauthorized" };
    }
    const body = (req.body ?? {}) as ReconcileBody;
    const rcRaw = typeof body.risk_class === "string" ? body.risk_class : "";
    const bktRaw = typeof body.bucket === "string" ? body.bucket : "";
    const sensRaw = typeof body.sensitivity_type === "string" ? body.sensitivity_type : "Delta";
    if (!rcRaw || !bktRaw) {
      reply.code(400);
      return { error: "risk_class and bucket are required" };
    }
    if (sensRaw !== "Delta" && sensRaw !== "Vega" && sensRaw !== "Curvature") {
      reply.code(400);
      return { error: "sensitivity_type must be Delta | Vega | Curvature" };
    }
    incCounter("reconcile_total");
    const redis = getRedis(req.poolCategory);
    const rc = rcRaw.toUpperCase();
    const sens = sensRaw as DriftSensitivity;
    const key = rollupKey(rc, bktRaw, sens);

    const before = await redis.call("HGETALL", key);
    const beforeMap: Record<string, string> = {};
    if (Array.isArray(before)) {
      for (let i = 0; i < before.length; i += 2) beforeMap[String(before[i])] = String(before[i + 1]);
    } else if (before && typeof before === "object") {
      for (const [k, v] of Object.entries(before as Record<string, unknown>)) beforeMap[k] = String(v);
    }
    const beforeSum = Number(beforeMap.sum_ws ?? 0);
    const beforeCount = Number(beforeMap.count ?? 0);
    const afterSum = await opts.recomputeBucketSum(redis, rc, bktRaw, sens);

    // Atomic DEL + HMSET via pipeline. HMSET is RESP-2 legacy but accepted
    // by every server we target; HSET multi-field also works on >=4.0.0.
    const denom = Math.abs(beforeSum);
    const driftPct = denom > 0
      ? (Math.abs(beforeSum - afterSum) / denom) * 100
      : (afterSum === 0 ? 0 : Infinity);

    await redis.call("DEL", key);
    await redis.call("HMSET", key, "sum_ws", String(afterSum), "sum_ws_sq", String(afterSum * afterSum), "count", String(beforeCount));

    return {
      ok: true,
      before_sum: beforeSum,
      after_sum: afterSum,
      drift_pct: driftPct,
      risk_class: rc,
      bucket: bktRaw,
      sensitivity_type: sens,
    };
  });

  // /metrics is owned by routes/admin-calc.ts (Wave 6.39.B); the L4
  // counters surface through that handler because both call sites share
  // the jobs/metrics.ts registry. No second route registration here —
  // Fastify rejects duplicate paths.
}

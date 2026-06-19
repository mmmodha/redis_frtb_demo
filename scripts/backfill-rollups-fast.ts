#!/usr/bin/env node
// Wave 6.30.B5 — pipelined wrapper around services/ingest/src/backfill-rollups.ts.
//
// Why it exists: the module's main() awaits each JSON.GET serially. Against a
// remote Redis endpoint that holds ~10^8 sens:* docs, the round-trip × 1
// in-flight cap pegs throughput at a few hundred keys/s — projecting tens of
// hours of wall time. This wrapper reuses the exported accumulateRollup
// helper (single source of truth for field shapes) and adds:
//   1. SCAN with a larger COUNT hint (BACKFILL_SCAN_COUNT, default 1000)
//   2. JSON.GET fan-out via Promise.all per SCAN batch (BACKFILL_CONCURRENCY,
//      default 100 — keeps that many JSON.GETs in flight at once)
//   3. Periodic progress lines to stderr so a tail -f shows live counters
//
// The HSET phase mirrors backfill-rollups.ts byte-for-byte; field names come
// from shared/calc/src/rollup-keys.ts via re-import to keep the contract in
// lock-step with the consumer write path.
//
// Idempotent — same as the module: HSET overwrites with the same fields, so
// re-running on the same corpus is a no-op.

import { fileURLToPath } from "node:url";
import { Redis, Cluster } from "ioredis";
import { accumulateRollup } from "../services/ingest/src/backfill-rollups.ts";
import { ROLLUP_FIELDS_SCALAR, ROLLUP_FIELDS_CURVATURE } from "../shared/calc/src/rollup-keys.ts";

interface ScalarAcc { sum_ws: number; sum_ws_sq: number; count: number }
interface CurvatureAcc {
  sum_ws_up: number; sum_ws_up_sq: number;
  sum_ws_down: number; sum_ws_down_sq: number;
  count: number;
}

type RedisLike = {
  call: (cmd: string, ...args: string[]) => Promise<unknown>;
  nodes?: (role: string) => RedisLike[];
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
};

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const REDIS_CLUSTER = String(process.env.REDIS_CLUSTER ?? "true").toLowerCase() === "true";
const REDIS_TLS = String(process.env.REDIS_TLS ?? "").toLowerCase() === "true";
const SCAN_COUNT = Number(process.env.BACKFILL_SCAN_COUNT ?? "1000");
const KEY_MATCH = process.env.BACKFILL_ROLLUPS_KEY_MATCH ?? "sens:*";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? "100");
const PROGRESS_EVERY = Number(process.env.BACKFILL_PROGRESS_EVERY ?? "500000");

function buildClient(): RedisLike {
  const u = new URL(REDIS_URL);
  const host = u.hostname || "127.0.0.1";
  const port = u.port ? Number(u.port) : 6379;
  const password = u.password ? decodeURIComponent(u.password) : undefined;
  const username = u.username ? decodeURIComponent(u.username) : undefined;
  const tls = REDIS_TLS || u.protocol === "rediss:" ? {} : undefined;
  const redisOptions = {
    ...(password ? { password } : {}),
    ...(username ? { username } : {}),
    ...(tls ? { tls } : {}),
    connectTimeout: 5_000,
    commandTimeout: 30_000,
    keepAlive: 30_000,
  };
  if (REDIS_CLUSTER) {
    return new Cluster([{ host, port }], { redisOptions, slotsRefreshTimeout: 5_000 }) as unknown as RedisLike;
  }
  return new Redis({ host, port, ...redisOptions }) as unknown as RedisLike;
}

function resolveMasterNodes(client: RedisLike): RedisLike[] {
  if (typeof client.nodes === "function") return client.nodes("master");
  return [client];
}

async function scanAndAccumulate(
  node: RedisLike,
  scalar: Map<string, ScalarAcc>,
  curvature: Map<string, CurvatureAcc>,
  report: { scanned: number; errors: number },
  t0: number,
  nextLog: { v: number },
): Promise<void> {
  let cursor = "0";
  do {
    const reply = (await node.call("SCAN", cursor, "MATCH", KEY_MATCH, "COUNT", String(SCAN_COUNT))) as unknown;
    if (!Array.isArray(reply) || reply.length < 2 || typeof reply[0] !== "string" || !Array.isArray(reply[1])) break;
    cursor = reply[0];
    const keys = reply[1] as string[];
    // Pipeline JSON.GET in CONCURRENCY-sized waves. Within a wave, all calls
    // are in flight on the same multiplexed socket so the per-call latency
    // collapses to ~1× RTT for the batch instead of N× RTT serial.
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      const slice = keys.slice(i, i + CONCURRENCY);
      const raws = await Promise.all(
        slice.map((k) => node.call("JSON.GET", k).then((v) => v).catch(() => null)),
      );
      for (let j = 0; j < slice.length; j++) {
        report.scanned++;
        const raw = raws[j];
        if (typeof raw !== "string") { report.errors++; continue; }
        let doc: Record<string, unknown>;
        try { doc = JSON.parse(raw) as Record<string, unknown>; }
        catch { report.errors++; continue; }
        accumulateRollup(doc, scalar as Map<string, never>, curvature as Map<string, never>);
      }
      if (report.scanned >= nextLog.v) {
        const elapsed = Date.now() - t0;
        const rate = report.scanned / Math.max(1, elapsed / 1000);
        // eslint-disable-next-line no-console
        console.error(`progress scanned=${report.scanned} errors=${report.errors} cursor=${cursor} elapsed_ms=${elapsed} rate_keys_s=${rate.toFixed(0)} scalar_keys=${scalar.size} curv_keys=${curvature.size}`);
        nextLog.v += PROGRESS_EVERY;
      }
    }
  } while (cursor !== "0");
}

async function main(): Promise<void> {
  const client = buildClient();
  const report = { scanned: 0, rollups_written: 0, errors: 0 };
  const scalar = new Map<string, ScalarAcc>();
  const curvature = new Map<string, CurvatureAcc>();
  const t0 = Date.now();
  const nextLog = { v: PROGRESS_EVERY };
  try {
    const nodes = resolveMasterNodes(client);
    // eslint-disable-next-line no-console
    console.error(`backfill-rollups-fast start nodes=${nodes.length} concurrency=${CONCURRENCY} scan_count=${SCAN_COUNT} match=${KEY_MATCH} redis=${REDIS_URL}`);
    for (const node of nodes) await scanAndAccumulate(node, scalar, curvature, report, t0, nextLog);
    // HSET phase — same field shape as backfill-rollups.ts. Routes via the
    // {rc:bkt} hash-tag in the key.
    const [F_SUM_WS, F_SUM_WS_SQ, F_COUNT] = ROLLUP_FIELDS_SCALAR;
    for (const [key, a] of scalar.entries()) {
      try {
        await client.call("HSET", key, F_SUM_WS, String(a.sum_ws), F_SUM_WS_SQ, String(a.sum_ws_sq), F_COUNT, String(a.count));
        report.rollups_written++;
      } catch { report.errors++; }
    }
    const [C_UP, C_UP_SQ, C_DOWN, C_DOWN_SQ, C_COUNT] = ROLLUP_FIELDS_CURVATURE;
    for (const [key, a] of curvature.entries()) {
      try {
        await client.call("HSET", key, C_UP, String(a.sum_ws_up), C_UP_SQ, String(a.sum_ws_up_sq), C_DOWN, String(a.sum_ws_down), C_DOWN_SQ, String(a.sum_ws_down_sq), C_COUNT, String(a.count));
        report.rollups_written++;
      } catch { report.errors++; }
    }
    const ms = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...report, elapsed_ms: ms, redis: REDIS_URL }));
  } finally {
    if (typeof client.quit === "function") await client.quit().catch(() => undefined);
    else if (typeof client.disconnect === "function") client.disconnect();
  }
}

const invokedDirectly = (() => {
  try { return process.argv[1] === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ err: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}

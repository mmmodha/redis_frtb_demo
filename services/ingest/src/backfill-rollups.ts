#!/usr/bin/env node
// Wave 6.14c — one-shot rollup backfill. Walks every `sens:*` JSON doc per
// master node, accumulates the per-(rc, bkt, sens) (and per-tenor) sums in
// memory, then HSETs the rollup hash keys. Idempotent: HSET overwrites with
// the same fields, so re-running on the same corpus is a no-op.
//
// Accumulating in memory before any write avoids racing with a live
// consumer — a concurrent HINCRBYFLOAT on a fresh row would double-apply if
// we HINCRBYFLOAT'd during the SCAN; HSET on the post-scan totals is the
// authoritative replacement.

import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { rollupKey } from "@frtb/calc-shared";
import type { RedisLike } from "./consumer.ts";

const SCAN_COUNT = Number(process.env.BACKFILL_SCAN_COUNT ?? "500");
const KEY_MATCH = process.env.BACKFILL_ROLLUPS_KEY_MATCH ?? "sens:*";

interface ScalarAcc { sum_ws: number; sum_ws_sq: number; count: number }
interface CurvatureAcc {
  sum_ws_up: number; sum_ws_up_sq: number;
  sum_ws_down: number; sum_ws_down_sq: number;
  count: number;
}

export interface BackfillRollupsReport {
  scanned: number;
  rollups_written: number;
  errors: number;
}

// Detection mirrors resolveMasterNodes() in services/api/src/bootstrap.ts —
// ioredis Cluster has .nodes(), Redis does not.
function resolveMasterNodes(client: RedisLike): RedisLike[] {
  const maybe = client as { nodes?: (role: string) => RedisLike[] };
  if (typeof maybe.nodes === "function") return maybe.nodes("master");
  return [client];
}

// Accumulate one enriched doc into the in-memory rollup maps. Mirrors the
// field shape of emitRollupHincrs() in consumer.ts exactly — scalar legs
// write sum_ws/sum_ws_sq/count; Curvature legs sign-split into sum_ws_up*
// + sum_ws_down*; perTenor classes (GIRR Delta/Vega/Curvature) add a
// per-tenor sub-rollup at rollup:{rc:bkt}:<sens>:tenor:<t>.
export function accumulateRollup(
  doc: Record<string, unknown>,
  scalar: Map<string, ScalarAcc>,
  curvature: Map<string, CurvatureAcc>,
): void {
  const rc = typeof doc.risk_class === "string" ? doc.risk_class : undefined;
  const bkt = typeof doc.bucket === "string" ? doc.bucket : undefined;
  const sens = typeof doc.sensitivity_type === "string" ? doc.sensitivity_type : undefined;
  if (!rc || !bkt || !sens) return;

  if (sens === "Curvature") {
    const up = doc.weighted_cvr_up;
    const down = doc.weighted_cvr_down;
    if (typeof up === "number" && typeof down === "number") {
      bumpCurv(curvature, rollupKey(rc, bkt, sens), up, down);
    }
    const upMap = doc.weighted_cvr_up_per_tenor;
    const downMap = doc.weighted_cvr_down_per_tenor;
    if (
      upMap && typeof upMap === "object" && !Array.isArray(upMap) &&
      downMap && typeof downMap === "object" && !Array.isArray(downMap)
    ) {
      const ups = upMap as Record<string, number>;
      const downs = downMap as Record<string, number>;
      for (const t of Object.keys(ups)) {
        const u = ups[t]; const d = downs[t];
        if (typeof u !== "number" || typeof d !== "number") continue;
        bumpCurv(curvature, rollupKey(rc, bkt, sens, t), u, d);
      }
    }
    return;
  }

  const ws = doc.weighted_value;
  if (typeof ws === "number") {
    bumpScalar(scalar, rollupKey(rc, bkt, sens), ws);
  }
  const perTenor = doc.weighted_value_per_tenor;
  if (perTenor && typeof perTenor === "object" && !Array.isArray(perTenor)) {
    const m = perTenor as Record<string, number>;
    for (const t of Object.keys(m)) {
      const v = m[t];
      if (typeof v !== "number") continue;
      bumpScalar(scalar, rollupKey(rc, bkt, sens, t), v);
    }
  }
}

function bumpScalar(map: Map<string, ScalarAcc>, key: string, ws: number): void {
  const a = map.get(key) ?? { sum_ws: 0, sum_ws_sq: 0, count: 0 };
  a.sum_ws += ws; a.sum_ws_sq += ws * ws; a.count += 1;
  map.set(key, a);
}

function bumpCurv(map: Map<string, CurvatureAcc>, key: string, up: number, down: number): void {
  const a = map.get(key) ?? { sum_ws_up: 0, sum_ws_up_sq: 0, sum_ws_down: 0, sum_ws_down_sq: 0, count: 0 };
  a.sum_ws_up += up; a.sum_ws_up_sq += up * up;
  a.sum_ws_down += down; a.sum_ws_down_sq += down * down;
  a.count += 1;
  map.set(key, a);
}

// Cluster-aware SCAN + JSON.GET per master, accumulate everything into the
// in-memory maps, then HSET each rollup hash via the cluster client (the
// `{rc:bkt}` hash-tag routes every write to the matching shard). Returns a
// report of scanned/written/error counts; never throws on per-row failures
// so a single corrupt doc can't abort the whole rebuild.
export async function backfillRollups(
  client: RedisLike,
  opts?: { match?: string; count?: number },
): Promise<BackfillRollupsReport> {
  const match = opts?.match ?? KEY_MATCH;
  const count = opts?.count ?? SCAN_COUNT;
  const report: BackfillRollupsReport = { scanned: 0, rollups_written: 0, errors: 0 };
  const scalar = new Map<string, ScalarAcc>();
  const curvature = new Map<string, CurvatureAcc>();

  const nodes = resolveMasterNodes(client);
  for (const node of nodes) {
    let cursor = "0";
    do {
      const reply = (await node.call(
        "SCAN", cursor, "MATCH", match, "COUNT", String(count),
      )) as unknown;
      if (
        !Array.isArray(reply) || reply.length < 2 ||
        typeof reply[0] !== "string" || !Array.isArray(reply[1])
      ) {
        break;
      }
      cursor = reply[0];
      const keys = reply[1] as string[];
      for (const k of keys) {
        report.scanned++;
        try {
          const raw = await node.call("JSON.GET", k);
          if (typeof raw !== "string") { report.errors++; continue; }
          let doc: Record<string, unknown>;
          try { doc = JSON.parse(raw) as Record<string, unknown>; }
          catch { report.errors++; continue; }
          accumulateRollup(doc, scalar, curvature);
        } catch {
          report.errors++;
        }
      }
    } while (cursor !== "0");
  }

  // HSET via the cluster client — ioredis routes each key to the shard the
  // `{rc:bkt}` hash-tag pins it to, matching the underlying sens:* keys.
  for (const [key, a] of scalar.entries()) {
    try {
      await client.call(
        "HSET", key,
        "sum_ws", String(a.sum_ws),
        "sum_ws_sq", String(a.sum_ws_sq),
        "count", String(a.count),
      );
      report.rollups_written++;
    } catch {
      report.errors++;
    }
  }
  for (const [key, a] of curvature.entries()) {
    try {
      await client.call(
        "HSET", key,
        "sum_ws_up", String(a.sum_ws_up),
        "sum_ws_up_sq", String(a.sum_ws_up_sq),
        "sum_ws_down", String(a.sum_ws_down),
        "sum_ws_down_sq", String(a.sum_ws_down_sq),
        "count", String(a.count),
      );
      report.rollups_written++;
    } catch {
      report.errors++;
    }
  }

  return report;
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const client = createRedisClient({ url: redisUrl }) as unknown as RedisLike;
  try {
    const t0 = Date.now();
    const report = await backfillRollups(client);
    const ms = Date.now() - t0;
    // Single JSON line so demo scripts can grep / parse the result.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...report, elapsed_ms: ms, redis: redisUrl }));
  } finally {
    await (client as Redis).quit().catch(() => undefined);
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


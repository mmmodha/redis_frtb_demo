#!/usr/bin/env node
// Wave 6.14c — one-shot rollup backfill. Walks every `sens:*` doc per master
// node, accumulates the per-(rc, bkt, sens) (and per-tenor) sums in memory,
// then HSETs the rollup hash keys. Idempotent: HSET overwrites with the same
// fields, so re-running on the same corpus is a no-op.
//
// Accumulating in memory before any write avoids racing with a live
// consumer — a concurrent HINCRBYFLOAT on a fresh row would double-apply if
// we HINCRBYFLOAT'd during the SCAN; HSET on the post-scan totals is the
// authoritative replacement.
//
// Storage-format aware (Wave 6.55.H-fix): the default storage flipped from
// JSON to `hash-sidetable` in Wave 6.38.A, so `sens:<ulid>` is a HASH on
// fresh deployments and a JSON doc on the legacy `json` / `json-shadow-hash`
// variants. backfillRollups now TYPE-discriminates per key and reconstructs
// the in-memory doc shape (`weighted_value` / `weighted_value_per_tenor` /
// `weighted_cvr_{up,down}{_per_tenor}`) from the flat `ws_<class>_<leg>…`
// HASH fields written by `flattenDocForHash`.

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
// per-tenor sub-rollup at rollup:<rc>:<bkt>:<sens>:tenor:<t>
// (Wave 7.0.6.6 — tag-free).
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

// Wave 6.38.A — leg names used in the flat HASH field shape
// `ws_<class_lower>_<leg>[_<tenor>]`. Mirrors `legsForSensType` in consumer.ts.
function legsForSensType(sens: string): readonly string[] {
  if (sens === "Curvature") return ["cvr_up", "cvr_down"];
  if (sens === "Delta") return ["delta"];
  if (sens === "Vega") return ["vega"];
  return [];
}

// Reconstructs the in-memory doc shape (the one accumulateRollup expects)
// from the flat `ws_<class>_<leg>[_<tenor>]` fields written by
// flattenDocForHash. For per-tenor classes (GIRR), the scalar
// `weighted_value` / `weighted_cvr_*` is intentionally omitted from the HASH
// to save bytes; here we recompute it as Σ per-tenor — symmetric with
// enrichDoc, which writes the same Σ to the JSON doc.
function reconstructDocFromHash(fields: Record<string, string>): Record<string, unknown> {
  const doc: Record<string, unknown> = { ...fields };
  const rc = typeof fields.risk_class === "string" ? fields.risk_class : undefined;
  const sens = typeof fields.sensitivity_type === "string" ? fields.sensitivity_type : undefined;
  if (!rc || !sens) return doc;
  const lower = rc.toLowerCase();
  if (sens === "Curvature") {
    const upScalar = `ws_${lower}_cvr_up`;
    const downScalar = `ws_${lower}_cvr_down`;
    const upPrefix = `${upScalar}_`;
    const downPrefix = `${downScalar}_`;
    const upPerTenor: Record<string, number> = {};
    const downPerTenor: Record<string, number> = {};
    for (const f of Object.keys(fields)) {
      if (f === upScalar || f === downScalar) continue;
      if (f.startsWith(upPrefix)) {
        const v = Number(fields[f]);
        if (Number.isFinite(v)) upPerTenor[f.slice(upPrefix.length)] = v;
      } else if (f.startsWith(downPrefix)) {
        const v = Number(fields[f]);
        if (Number.isFinite(v)) downPerTenor[f.slice(downPrefix.length)] = v;
      }
    }
    const upKeys = Object.keys(upPerTenor);
    const downKeys = Object.keys(downPerTenor);
    if (upKeys.length > 0 && downKeys.length > 0) {
      doc.weighted_cvr_up_per_tenor = upPerTenor;
      doc.weighted_cvr_down_per_tenor = downPerTenor;
      doc.weighted_cvr_up = upKeys.reduce((a, t) => a + upPerTenor[t]!, 0);
      doc.weighted_cvr_down = downKeys.reduce((a, t) => a + downPerTenor[t]!, 0);
    } else {
      if (fields[upScalar] !== undefined) doc.weighted_cvr_up = Number(fields[upScalar]);
      if (fields[downScalar] !== undefined) doc.weighted_cvr_down = Number(fields[downScalar]);
    }
    return doc;
  }
  const leg = legsForSensType(sens)[0];
  if (!leg) return doc;
  const scalarField = `ws_${lower}_${leg}`;
  const tenorPrefix = `${scalarField}_`;
  const perTenor: Record<string, number> = {};
  for (const f of Object.keys(fields)) {
    if (f === scalarField) continue;
    if (f.startsWith(tenorPrefix)) {
      const v = Number(fields[f]);
      if (Number.isFinite(v)) perTenor[f.slice(tenorPrefix.length)] = v;
    }
  }
  const tenorKeys = Object.keys(perTenor);
  if (tenorKeys.length > 0) {
    doc.weighted_value_per_tenor = perTenor;
    doc.weighted_value = tenorKeys.reduce((a, t) => a + perTenor[t]!, 0);
  } else if (fields[scalarField] !== undefined) {
    doc.weighted_value = Number(fields[scalarField]);
  }
  return doc;
}

// Parses an HGETALL reply (ioredis returns a flat string[] for raw `call`).
function hgetallReplyToMap(reply: unknown): Record<string, string> | null {
  if (!Array.isArray(reply)) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < reply.length; i += 2) {
    const k = reply[i];
    const v = reply[i + 1];
    if (typeof k !== "string" || typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

// Cluster-aware SCAN per master with per-key TYPE discrimination: HASH keys
// (default `hash-sidetable` / `hash-encoded` storage) go through HGETALL +
// reconstructDocFromHash; JSON keys (legacy `json` / `json-shadow-hash`) go
// through JSON.GET + JSON.parse. Accumulate everything in memory, then HSET
// each rollup hash via the cluster client (the `{rc:bkt}` hash-tag routes
// every write to the matching shard). Never throws on per-row failures so
// a single corrupt doc can't abort the whole rebuild.
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
          const type = await node.call("TYPE", k);
          if (type === "hash") {
            const hReply = await node.call("HGETALL", k);
            const fields = hgetallReplyToMap(hReply);
            if (!fields) { report.errors++; continue; }
            accumulateRollup(reconstructDocFromHash(fields), scalar, curvature);
          } else if (type === "ReJSON-RL") {
            const raw = await node.call("JSON.GET", k);
            if (typeof raw !== "string") { report.errors++; continue; }
            let doc: Record<string, unknown>;
            try { doc = JSON.parse(raw) as Record<string, unknown>; }
            catch { report.errors++; continue; }
            accumulateRollup(doc, scalar, curvature);
          } else {
            report.errors++;
          }
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


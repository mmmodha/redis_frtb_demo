// Wave 6.39.A — direct-write writer. Bypasses the Redis Stream entirely and
// issues HSET (per STORAGE_FORMAT) + pre-aggregated HINCRBYFLOAT + SADD on
// the cluster pipeline directly. Same surface contract as `StreamProducer`
// (add / flush / close + rowsSent / batchCount / byClass counters) so the
// shared row-loop (`runGenerationInline`) drives either backend unchanged.
//
// Hooks injected via DI from `services/ingest/src/consumer.ts` — the storage
// shape is owned by ingest, so the writer reuses the same dispatcher
// (`writeDocForStorage`) + the same enrichment (`enrichDoc`) for all four
// STORAGE_FORMAT variants. Zero drift: any future change to the consumer's
// writer is picked up automatically.
//
// Pre-aggregation invariants:
//   • Rollup HINCRBYFLOAT: per-batch accumulator on (rollupKey, field) tuples;
//     ONE HINCRBYFLOAT per unique tuple per flush (vs N rows × ~3 fields per
//     row that emitRollupHincrs would emit naively).
//   • Seen-set SADD: per-batch dedup on (rc, bkt, sens) — one SADD per
//     unique value within the batch (Redis Set dedup is server-side, but
//     pre-aggregating here saves the round-trip bytes too).

import type { Redis, Cluster } from "ioredis";
import type { Schema } from "@frtb/schema";
import {
  rollupKey,
  SEEN_RISK_CLASS_KEY,
  seenBucketKey,
  seenSensTypeKey,
} from "@frtb/calc-shared";
import type { SensitivityRow } from "./row-generator.ts";

export type StorageFormat = "hash-sidetable" | "hash-encoded" | "json" | "json-shadow-hash";

// Minimal pipeline surface — matches ioredis Pipeline. `call` covers
// HINCRBYFLOAT / SADD / FT.SUGADD; the writer dispatcher uses `call` for
// HSET / JSON.SET too so all paths funnel through the same recorder.
export interface PipelineLike {
  call(cmd: string, ...args: unknown[]): unknown;
  exec(): Promise<Array<[Error | null, unknown]>>;
}
export interface ClientLike {
  pipeline(): PipelineLike;
}

export interface DirectWriterHooks {
  enrichDoc(doc: Record<string, unknown>, schema?: Schema): Record<string, unknown>;
  writeDocForStorage(pipeline: PipelineLike, key: string, doc: Record<string, unknown>, format: StorageFormat): void;
  buildKey(hashTag: string, id: string): string;
}

export interface DirectWriterOptions {
  schema: Schema;
  storageFormat?: StorageFormat;
  batchSize?: number;
  hooks: DirectWriterHooks;
}

export interface DirectWriter {
  add(row: SensitivityRow): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly rowsSent: number;
  readonly batchCount: number;
  readonly byClass: Record<string, number>;
}

type RedisLike = Redis | Cluster;

interface Accum {
  // (rollupKey → (field → Σ value)). Float deltas accumulate via +=.
  rollup: Map<string, Map<string, number>>;
  // Discovery sets — one SADD per unique value per flush.
  seenRc: Set<string>;
  seenBktByRc: Map<string, Set<string>>;
  seenSensByRcBkt: Map<string, Set<string>>;
  // Enriched docs pending HSET via the storage dispatcher.
  docs: Array<{ key: string; doc: Record<string, unknown> }>;
  count: number;
}

function newAccum(): Accum {
  return {
    rollup: new Map(),
    seenRc: new Set(),
    seenBktByRc: new Map(),
    seenSensByRcBkt: new Map(),
    docs: [],
    count: 0,
  };
}

function bump(acc: Accum, key: string, field: string, delta: number): void {
  let m = acc.rollup.get(key);
  if (!m) { m = new Map(); acc.rollup.set(key, m); }
  m.set(field, (m.get(field) ?? 0) + delta);
}

function accumulateSeen(acc: Accum, doc: Record<string, unknown>): void {
  const rc = typeof doc.risk_class === "string" ? doc.risk_class : undefined;
  const bkt = typeof doc.bucket === "string" ? doc.bucket : undefined;
  const sens = typeof doc.sensitivity_type === "string" ? doc.sensitivity_type : undefined;
  if (!rc || !bkt || !sens) return;
  acc.seenRc.add(rc);
  let bs = acc.seenBktByRc.get(rc);
  if (!bs) { bs = new Set(); acc.seenBktByRc.set(rc, bs); }
  bs.add(bkt);
  const key = `${rc}:${bkt}`;
  let ss = acc.seenSensByRcBkt.get(key);
  if (!ss) { ss = new Set(); acc.seenSensByRcBkt.set(key, ss); }
  ss.add(sens);
}

// Lifts the stream-mode XADD field shape onto the doc shape the consumer's
// enrichDoc/writeDocForStorage expect. Generator rows already carry every
// field as a top-level property (no JSON-string `payload` field — that's a
// stream-transport detail). We only need to drop the meta fields and pass
// the rest through.
function rowToDoc(row: SensitivityRow): Record<string, unknown> {
  const { _hash_tag, _id, ...rest } = row;
  void _hash_tag; void _id;
  return rest;
}

export function createDirectWriter(
  client: RedisLike | ClientLike,
  opts: DirectWriterOptions,
): DirectWriter {
  const schema = opts.schema;
  const storageFormat: StorageFormat = opts.storageFormat ?? "hash-sidetable";
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const { enrichDoc, writeDocForStorage, buildKey } = opts.hooks;
  let acc = newAccum();
  const stats = { rowsSent: 0, batchCount: 0, byClass: {} as Record<string, number> };

  async function dispatch(): Promise<void> {
    if (acc.count === 0) return;
    const batch = acc;
    acc = newAccum();
    stats.batchCount += 1;
    const pipeline = (client as { pipeline(): PipelineLike }).pipeline();
    for (const { key, doc } of batch.docs) {
      writeDocForStorage(pipeline, key, doc, storageFormat);
    }
    for (const [key, fields] of batch.rollup) {
      for (const [field, value] of fields) {
        pipeline.call("HINCRBYFLOAT", key, field, String(value));
      }
    }
    for (const rc of batch.seenRc) pipeline.call("SADD", SEEN_RISK_CLASS_KEY, rc);
    for (const [rc, bkts] of batch.seenBktByRc) {
      for (const bkt of bkts) pipeline.call("SADD", seenBucketKey(rc), bkt);
    }
    for (const [rcBkt, senses] of batch.seenSensByRcBkt) {
      const [rc, bkt] = rcBkt.split(":") as [string, string];
      for (const s of senses) pipeline.call("SADD", seenSensTypeKey(rc, bkt), s);
    }
    const result = await pipeline.exec();
    if (result) {
      for (const [err] of result) { if (err) throw err; }
    }
    stats.rowsSent += batch.count;
  }

  return {
    async add(row: SensitivityRow): Promise<void> {
      const doc = enrichDoc(rowToDoc(row), schema);
      const key = buildKey(row._hash_tag, row._id);
      acc.docs.push({ key, doc });
      accumulateRollup(acc, doc);
      accumulateSeen(acc, doc);
      acc.count += 1;
      stats.byClass[row.risk_class] = (stats.byClass[row.risk_class] ?? 0) + 1;
      if (acc.count >= batchSize) await dispatch();
    },
    async flush(): Promise<void> { await dispatch(); },
    async close(): Promise<void> { await dispatch(); },
    get rowsSent() { return stats.rowsSent; },
    get batchCount() { return stats.batchCount; },
    get byClass() { return stats.byClass; },
  };
}

function accumulateRollup(acc: Accum, doc: Record<string, unknown>): void {
  const rc = typeof doc.risk_class === "string" ? doc.risk_class : undefined;
  const bkt = typeof doc.bucket === "string" ? doc.bucket : undefined;
  const sens = typeof doc.sensitivity_type === "string" ? doc.sensitivity_type : undefined;
  if (!rc || !bkt || !sens) return;

  if (sens === "Curvature") {
    const up = doc.weighted_cvr_up;
    const down = doc.weighted_cvr_down;
    if (typeof up === "number" && typeof down === "number") {
      const k = rollupKey(rc, bkt, sens);
      bump(acc, k, "sum_ws_up", up);
      bump(acc, k, "sum_ws_up_sq", up * up);
      bump(acc, k, "sum_ws_down", down);
      bump(acc, k, "sum_ws_down_sq", down * down);
      bump(acc, k, "count", 1);
    }
    const upMap = doc.weighted_cvr_up_per_tenor as Record<string, number> | undefined;
    const downMap = doc.weighted_cvr_down_per_tenor as Record<string, number> | undefined;
    if (upMap && typeof upMap === "object" && !Array.isArray(upMap) &&
        downMap && typeof downMap === "object" && !Array.isArray(downMap)) {
      for (const t of Object.keys(upMap)) {
        const u = upMap[t]; const d = downMap[t];
        if (typeof u !== "number" || typeof d !== "number") continue;
        const tk = rollupKey(rc, bkt, sens, t);
        bump(acc, tk, "sum_ws_up", u);
        bump(acc, tk, "sum_ws_up_sq", u * u);
        bump(acc, tk, "sum_ws_down", d);
        bump(acc, tk, "sum_ws_down_sq", d * d);
        bump(acc, tk, "count", 1);
      }
    }
    return;
  }

  const ws = doc.weighted_value;
  if (typeof ws === "number") {
    const k = rollupKey(rc, bkt, sens);
    bump(acc, k, "sum_ws", ws);
    bump(acc, k, "sum_ws_sq", ws * ws);
    bump(acc, k, "count", 1);
  }
  const perTenor = doc.weighted_value_per_tenor as Record<string, number> | undefined;
  if (perTenor && typeof perTenor === "object" && !Array.isArray(perTenor)) {
    for (const t of Object.keys(perTenor)) {
      const v = perTenor[t];
      if (typeof v !== "number") continue;
      const tk = rollupKey(rc, bkt, sens, t);
      bump(acc, tk, "sum_ws", v);
      bump(acc, tk, "sum_ws_sq", v * v);
      bump(acc, tk, "count", 1);
    }
  }
}

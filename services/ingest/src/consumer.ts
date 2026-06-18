import type { Redis, Cluster } from "ioredis";
import type { Schema, RiskWeightTable } from "@frtb/schema";
import {
  rollupKey,
  SEEN_RISK_CLASS_KEY,
  seenBucketKey,
  seenSensTypeKey,
} from "@frtb/calc-shared";
import type { RunnerProfile } from "./profile.ts";

// Stream consumer for the FRTB ingest service.
// Reads from Redis Stream `sensitivities:in` via XREADGROUP, builds the final
// key `sens:<ulid>` (ULID-only for uniform slot distribution across the cluster
// per Wave 6.31 Option B), writes the doc with JSON.SET, then XACKs. JSON.SET
// with the same key+doc is naturally idempotent: re-deliveries of the same
// logical row produce no duplicate keys.

export type RedisLike = Redis | Cluster;

export interface ConsumerOptions {
  stream: string;
  group: string;
  consumerName: string;
  batchSize?: number;
  blockMs?: number;
  // Wave 5.83B — schema is loaded once at consumer creation and threaded
  // through processBatch so enrichDoc can pre-compute per-tenor
  // weighted_value (and weighted_cvr_up/down for Curvature) from the
  // schema's risk_weights block. Omitted in unit-test stubs that only
  // exercise pipeline-call ordering — enrichDoc still stamps the
  // `_calibration: "demo"` tag in that case.
  schema?: Schema;
  // Wave 6.15a — optional per-runner profiler. Constructed only when
  // INGEST_PROFILE=1; when undefined every timed branch in processBatch
  // is a single nil-check and skipped, keeping the hot path byte-identical
  // to pre-6.15a behaviour.
  profile?: RunnerProfile;
}

export interface ConsumerStats {
  consumed: number;
  acked: number;
  errors: number;
  batches: number;
}

export interface ConsumerRunner {
  start(): void;
  stop(): Promise<void>;
  readonly stats: ConsumerStats;
}

// Builds the final sens-doc key `sens:<ulid>` — ULID-only for uniform slot
// distribution across the Redis Cluster keyspace (Wave 6.31, Option B). The
// `hashTag` parameter is retained for call-site signature stability and is
// intentionally ignored. `risk_class` / `bucket` remain JSON fields on the
// doc and indexed via `idx:sens`, so FT.AGGREGATE `GROUPBY @risk_class
// @bucket` still works; rollup and seen keys keep their hash-tag wrapper.
export function buildKey(hashTag: string, id: string): string {
  void hashTag;
  return `sens:${id}`;
}

// Reassembles the JSON doc from a Stream message. The generator stamps
// `risk_class`, `bucket`, `_hash_tag`, `_id`, and a JSON-stringified `payload`
// at the top level (see services/generator/src/producer.ts). The stored doc
// merges top-level routing fields with the parsed payload, dropping the
// transport-only meta fields (`_hash_tag`, `_id`, `payload`).
export function buildDoc(message: Record<string, string>): Record<string, unknown> {
  const { _hash_tag: _h, _id: _i, payload, risk_class, bucket, ...rest } = message;
  void _h; void _i;
  const parsed: Record<string, unknown> = payload ? JSON.parse(payload) : {};
  return { risk_class, bucket, ...rest, ...parsed };
}

// Wave 5.83B — literal calibration tag stamped on every ingested doc. Powers
// the `_calibration` TAG on idx:sens; demo-only literal here, the actual
// versioning hook lands in a later wave.
export const CALIBRATION_TAG = "demo";

// Resolves the per-(class, bucket, tenor) risk weight from the schema's
// `risk_weights` block — by_tenor, by_bucket, or constant — falling back to 0
// when the table is missing or the key is absent. Pure / synchronous; no IO.
function weightFor(table: RiskWeightTable | undefined, bucket: string, tenor: string | null): number {
  if (!table) return 0;
  if ("constant" in table) return table.constant;
  if ("by_tenor" in table) return tenor != null ? (table.by_tenor[tenor] ?? 0) : 0;
  if ("by_bucket" in table) return table.by_bucket[bucket] ?? 0;
  return 0;
}

// Wave 5.83B-fix — per-leg weighting must mirror the Lua kernels exactly:
//   Delta     → schema's `<class>_delta_weights` (table above).
//   Vega      → identity (the schema's vega weights are 1.0; equity_vega and
//               fx_vega kernels hardcode 1.0 in bootstrap.ts, girr_vega reads
//               girr_vega_weights.constant which is 1.0 in the locked schema).
//   Curvature → identity (no schema weight applied; ψ-gate + max happen in the
//               reduce step).
// Returning 1.0 for Vega/Curvature pre-multiplies by 1.0 so the stored
// `weighted_value` / `weighted_cvr_*` field is the bare sensitivity — which is
// exactly what the FT.AGGREGATE fast path needs to match the Lua reference.
function legWeight(
  sensType: string,
  table: RiskWeightTable | undefined,
  bucket: string,
  tenor: string | null,
): number {
  if (sensType === "Vega" || sensType === "Curvature") return 1.0;
  return weightFor(table, bucket, tenor);
}

// Wave 5.83B — additive enrichment step run before JSON.SET. Computes the
// per-tenor (or scalar) pre-weighted sensitivities so the calc fast path
// can FT.AGGREGATE on `ws_*` numeric fields without a per-row JSON.GET.
// The raw `risk_value` and `weight` fields are preserved untouched — this
// is purely additive so the Lua differential-test path keeps working.
//
// Wave 5.83B-fix — per-leg weight rule (mirrors the Lua kernels exactly):
//   Delta     → schema's `<class>_delta_weights` (per-tenor or by-bucket).
//   Vega      → identity (no schema weight applied).
//   Curvature → identity (ψ-gate + max applied in the reduce step).
// Both Vega and Curvature pass the bare sensitivity through as the weighted
// field, so a downstream FT.AGGREGATE SUM over `ws_*` matches the per-row
// `w · s` accumulation the Lua kernels do (with w=1.0).
//
// Wave 5.83F — per-tenor classes (GIRR) now emit per-tenor data at a
// distinct JSONPath and keep `$.weighted_value` / `$.weighted_cvr_*` as
// SCALAR signed sums (Σ over tenors). This unblocks idx:sens: the NUMERIC
// field declarations on `$.weighted_value` (and `$.weighted_cvr_*`) used
// by Equity/FX no longer collide with an Object value on GIRR docs, so
// RediSearch stops aborting indexing on the GIRR PREFIX-matched rows.
//   - GIRR Delta/Vega per-tenor object → scalar at `$.weighted_value`
//     (Σ_t w_t * s_t) and the per-tenor map at `$.weighted_value_per_tenor`.
//   - GIRR Curvature per-tenor arrays → scalar at `$.weighted_cvr_{up,down}`
//     and the per-tenor map at `$.weighted_cvr_{up,down}_per_tenor`.
// Equity / FX scalar shapes are unchanged.
//
// Shapes (see shared/schema/src/types.ts `SensitivityRiskValue`):
//   - Delta/Vega per-tenor object `{ "3M": v0, "6M": v1, ... }` → produces
//     `weighted_value_per_tenor: { "3M": w_k*v0, ... }` AND scalar
//     `weighted_value = Σ_k w_k*v0` (signed sum, matches S_b in girr_delta.lua).
//   - Delta/Vega scalar `{ spot: v }` or bare `number` → produces a scalar
//     `weighted_value = w * v` (Equity / FX convention).
//   - Delta/Vega legacy array `[v0, v1, ...]` (test fixtures) → zipped against
//     `doc.tenor` (when an array of labels) or the schema's class tenor nodes;
//     produces a per-tenor map at `weighted_value_per_tenor` + scalar
//     `weighted_value`. Skipped silently if no tenor labels.
//   - Curvature per-tenor `{ cvr_up: number[], cvr_down: number[] }` → emits
//     per-tenor maps at `weighted_cvr_{up,down}_per_tenor` + scalar
//     `weighted_cvr_{up,down}` (signed sums), keyed by the schema's class
//     tenor nodes.
//   - Curvature scalar `{ cvr_up: number, cvr_down: number }` (Equity / FX) →
//     emits scalar `weighted_cvr_up` / `weighted_cvr_down`.
//
// `_calibration: "demo"` is always stamped, even when no schema is provided
// (preserves the SUGADD-only unit-test stub path).
export function enrichDoc(
  doc: Record<string, unknown>,
  schema?: Schema,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = { ...doc, _calibration: CALIBRATION_TAG };
  if (!schema) return enriched;
  const riskClass = typeof doc.risk_class === "string" ? doc.risk_class : undefined;
  const bucket = typeof doc.bucket === "string" ? doc.bucket : "";
  if (!riskClass) return enriched;
  const cls = schema.risk_classes?.[riskClass];
  if (!cls) return enriched;
  const table = cls.risk_weights_ref ? schema.risk_weights[cls.risk_weights_ref] : undefined;
  const tenorNodes: readonly string[] | undefined = cls.tenor?.nodes;
  const sensType = typeof doc.sensitivity_type === "string" ? doc.sensitivity_type : "";
  const rv = doc.risk_value;

  // Curvature first — distinct field names (weighted_cvr_up / weighted_cvr_down).
  // Lua kernels apply no weight, so legWeight returns 1.0 here regardless of
  // bucket/tenor — pass the bare CVR value through.
  if (sensType === "Curvature" && rv != null && typeof rv === "object" && !Array.isArray(rv)) {
    const cvrObj = rv as { cvr_up?: unknown; cvr_down?: unknown };
    if (Array.isArray(cvrObj.cvr_up) && Array.isArray(cvrObj.cvr_down) && tenorNodes) {
      // Wave 5.83F — per-tenor classes (GIRR): per-tenor maps move to
      // `_per_tenor` paths; scalar `weighted_cvr_{up,down}` carry signed
      // Σ_t WS_t so the NUMERIC index field stays scalar across all classes.
      const up = cvrObj.cvr_up as number[];
      const down = cvrObj.cvr_down as number[];
      const upOut: Record<string, number> = {};
      const downOut: Record<string, number> = {};
      let upSum = 0;
      let downSum = 0;
      const n = Math.min(up.length, down.length, tenorNodes.length);
      for (let i = 0; i < n; i++) {
        const t = tenorNodes[i]!;
        const w = legWeight(sensType, table, bucket, t);
        const u = w * up[i]!;
        const d = w * down[i]!;
        upOut[t] = u;
        downOut[t] = d;
        upSum += u;
        downSum += d;
      }
      enriched.weighted_cvr_up_per_tenor = upOut;
      enriched.weighted_cvr_down_per_tenor = downOut;
      enriched.weighted_cvr_up = upSum;
      enriched.weighted_cvr_down = downSum;
    } else if (typeof cvrObj.cvr_up === "number" && typeof cvrObj.cvr_down === "number") {
      const w = legWeight(sensType, table, bucket, null);
      enriched.weighted_cvr_up = w * cvrObj.cvr_up;
      enriched.weighted_cvr_down = w * cvrObj.cvr_down;
    }
    return enriched;
  }

  // Delta / Vega — single `weighted_value` field. Delta multiplies by the
  // class's delta-weight table; Vega is identity (legWeight returns 1.0).
  if (rv != null && typeof rv === "object" && !Array.isArray(rv)) {
    const obj = rv as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === "spot" && typeof obj.spot === "number") {
      // Equity / FX scalar shape.
      const w = legWeight(sensType, table, bucket, null);
      enriched.weighted_value = w * obj.spot;
    } else {
      // Wave 5.83F — per-tenor object (GIRR): per-tenor map lives at
      // `weighted_value_per_tenor`; scalar `weighted_value` carries the
      // signed Σ_k WS_k so the NUMERIC index field stays scalar.
      const out: Record<string, number> = {};
      let sum = 0;
      for (const k of keys) {
        const v = obj[k];
        if (typeof v !== "number") continue;
        const w = legWeight(sensType, table, bucket, k);
        const ws = w * v;
        out[k] = ws;
        sum += ws;
      }
      enriched.weighted_value_per_tenor = out;
      enriched.weighted_value = sum;
    }
  } else if (Array.isArray(rv)) {
    // Legacy array shape (test fixtures): zip against doc.tenor when it's
    // an array of labels, else fall back to the schema's class tenor nodes.
    const docTenor = doc.tenor;
    const labels: readonly string[] | undefined = Array.isArray(docTenor) && docTenor.every((t) => typeof t === "string")
      ? (docTenor as string[])
      : tenorNodes;
    if (labels) {
      // Wave 5.83F — same per-tenor split as the object branch above.
      const out: Record<string, number> = {};
      let sum = 0;
      const n = Math.min(rv.length, labels.length);
      for (let i = 0; i < n; i++) {
        const v = rv[i];
        if (typeof v !== "number") continue;
        const t = labels[i]!;
        const w = legWeight(sensType, table, bucket, t);
        const ws = w * v;
        out[t] = ws;
        sum += ws;
      }
      enriched.weighted_value_per_tenor = out;
      enriched.weighted_value = sum;
    }
  } else if (typeof rv === "number") {
    // Bare scalar (Equity / FX legacy fixture shape).
    const w = legWeight(sensType, table, bucket, null);
    enriched.weighted_value = w * rv;
  }
  return enriched;
}

// Wave 6.14a — incremental rollup-hash writer. After JSON.SET, the apply
// path also HINCRBYFLOATs a per-(risk_class, bucket, sensitivity_type)
// rollup hash with this row's contribution so calc can read pre-aggregated
// Σws / Σws² / count without scanning per-row docs. Hash-tagged on
// `<rc>:<bkt>` to co-locate with the matching `sens:{rc:bkt}:<ulid>` keys.
//
// Scalar (Delta/Vega) rows write `sum_ws`, `sum_ws_sq`, `count`. Curvature
// rows sign-split into `sum_ws_up`, `sum_ws_up_sq`, `sum_ws_down`,
// `sum_ws_down_sq`, `count` so the calc reduce can apply the ψ-gate +
// max(K_up, K_down) without re-reading the underlying docs. PerTenor
// classes (GIRR Delta/Vega/Curvature) additionally maintain per-tenor
// breakdowns at `rollup:{rc:bkt}:sens:tenor:<t>` with the same fields.
//
// All HINCRBYFLOAT calls are pushed onto the same pipeline as the JSON.SET
// + XACK so the whole apply is one round-trip per row. Idempotency follows
// the existing XACK + group-state contract: an entry that has been
// XACKed is never re-delivered, so its rollup contribution is applied
// exactly once. (Re-XADDing the same logical _id with a fresh XADD id is
// a different envelope and will double-count — same as the SUGADD path.)
type PipelineLike = { call: (cmd: string, ...args: unknown[]) => unknown };

// Wave 6.24 — materialized discovery sets. Three SADDs per applied row
// (deduped server-side by Redis Set semantics, so steady-state ingest emits
// the same three commands every batch but only the first apply per
// (rc, bkt, sens_type) tuple actually grows the set). Pipelined alongside
// JSON.SET + emitRollupHincrs so the apply remains one round-trip per row.
//
// Hash-tag placement matches `shared/calc/src/rollup-keys.ts`:
//   * `seen:risk_class`              — global key, single slot in cluster
//                                      mode. Hot enough that calc / facets
//                                      can hit it directly without a fan-
//                                      out.
//   * `seen:bucket:{<rc>}`           — slot-affinity with the per-class
//                                      rollup hashes (`rollup:{<rc>:<bkt>}`),
//                                      so a future `SINTERSTORE`-style
//                                      bucket discovery routes to the same
//                                      shard as the data it inspects.
//   * `seen:sens_type:{<rc>:<bkt>}`  — co-located with the per-bucket
//                                      rollup hashes / sens keys; SMEMBERS
//                                      here drives the facets sensitivity-
//                                      type listing without fan-out.
export function emitSeenSadds(pipeline: PipelineLike, doc: Record<string, unknown>): void {
  const rc = typeof doc.risk_class === "string" ? doc.risk_class : undefined;
  const bkt = typeof doc.bucket === "string" ? doc.bucket : undefined;
  const sens = typeof doc.sensitivity_type === "string" ? doc.sensitivity_type : undefined;
  if (!rc || !bkt || !sens) return;
  pipeline.call("SADD", SEEN_RISK_CLASS_KEY, rc);
  pipeline.call("SADD", seenBucketKey(rc), bkt);
  pipeline.call("SADD", seenSensTypeKey(rc, bkt), sens);
}

export function emitRollupHincrs(pipeline: PipelineLike, doc: Record<string, unknown>): void {
  const rc = typeof doc.risk_class === "string" ? doc.risk_class : undefined;
  const bkt = typeof doc.bucket === "string" ? doc.bucket : undefined;
  const sens = typeof doc.sensitivity_type === "string" ? doc.sensitivity_type : undefined;
  if (!rc || !bkt || !sens) return;

  if (sens === "Curvature") {
    const up = doc.weighted_cvr_up;
    const down = doc.weighted_cvr_down;
    if (typeof up === "number" && typeof down === "number") {
      const baseKey = rollupKey(rc, bkt, sens);
      pipeline.call("HINCRBYFLOAT", baseKey, "sum_ws_up", String(up));
      pipeline.call("HINCRBYFLOAT", baseKey, "sum_ws_up_sq", String(up * up));
      pipeline.call("HINCRBYFLOAT", baseKey, "sum_ws_down", String(down));
      pipeline.call("HINCRBYFLOAT", baseKey, "sum_ws_down_sq", String(down * down));
      pipeline.call("HINCRBYFLOAT", baseKey, "count", "1");
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
        const u = ups[t];
        const d = downs[t];
        if (typeof u !== "number" || typeof d !== "number") continue;
        const tKey = rollupKey(rc, bkt, sens, t);
        pipeline.call("HINCRBYFLOAT", tKey, "sum_ws_up", String(u));
        pipeline.call("HINCRBYFLOAT", tKey, "sum_ws_up_sq", String(u * u));
        pipeline.call("HINCRBYFLOAT", tKey, "sum_ws_down", String(d));
        pipeline.call("HINCRBYFLOAT", tKey, "sum_ws_down_sq", String(d * d));
        pipeline.call("HINCRBYFLOAT", tKey, "count", "1");
      }
    }
    return;
  }

  const ws = doc.weighted_value;
  if (typeof ws === "number") {
    const baseKey = rollupKey(rc, bkt, sens);
    pipeline.call("HINCRBYFLOAT", baseKey, "sum_ws", String(ws));
    pipeline.call("HINCRBYFLOAT", baseKey, "sum_ws_sq", String(ws * ws));
    pipeline.call("HINCRBYFLOAT", baseKey, "count", "1");
  }
  const perTenor = doc.weighted_value_per_tenor;
  if (perTenor && typeof perTenor === "object" && !Array.isArray(perTenor)) {
    const m = perTenor as Record<string, number>;
    for (const t of Object.keys(m)) {
      const v = m[t];
      if (typeof v !== "number") continue;
      const tKey = rollupKey(rc, bkt, sens, t);
      pipeline.call("HINCRBYFLOAT", tKey, "sum_ws", String(v));
      pipeline.call("HINCRBYFLOAT", tKey, "sum_ws_sq", String(v * v));
      pipeline.call("HINCRBYFLOAT", tKey, "count", "1");
    }
  }
}

// Creates the consumer group on the stream, MKSTREAM to handle the
// pre-publish case. Treats BUSYGROUP (group already exists) as success.
export async function ensureGroup(client: RedisLike, stream: string, group: string): Promise<void> {
  try {
    await client.xgroup("CREATE", stream, group, "$", "MKSTREAM");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("BUSYGROUP")) throw err;
  }
}

function fieldsToMap(fields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i]!;
    const v = fields[i + 1]!;
    out[k] = v;
  }
  return out;
}

type XReadGroupReply = Array<[string, Array<[string, string[]]>]> | null;

// Single XREADGROUP batch: reads up to `batchSize` entries, writes each via
// JSON.SET and XACKs in one pipelined round-trip. `id` is either ">" (new
// entries) or "0" (pending entries previously delivered to this consumer name
// but not yet acked — used on restart to claim in-flight work).
export async function processBatch(
  client: RedisLike,
  opts: ConsumerOptions,
  id: ">" | "0" = ">",
  blockMs?: number
): Promise<number> {
  const count = Math.max(1, opts.batchSize ?? 500);
  const block = blockMs ?? opts.blockMs ?? 0;
  // Wave 6.15a — `profile` is set only when INGEST_PROFILE=1; every
  // `if (profile)` branch below is skipped when undefined so the hot path
  // stays byte-identical to pre-6.15a behaviour.
  const profile = opts.profile;
  const fetchStart = profile ? process.hrtime.bigint() : 0n;
  const reply = (await (client as Redis).xreadgroup(
    "GROUP", opts.group, opts.consumerName,
    "COUNT", count,
    "BLOCK", block,
    "STREAMS", opts.stream, id
  )) as XReadGroupReply;
  if (profile) profile.recordStep("fetch", process.hrtime.bigint() - fetchStart);
  if (!reply) return 0;

  let processed = 0;
  for (const [, entries] of reply) {
    if (entries.length === 0) continue;
    if (profile) profile.recordRowsRead(entries.length);
    const pipeline = client.pipeline();
    for (const [entryId, fields] of entries) {
      const parseStart = profile ? process.hrtime.bigint() : 0n;
      const msg = fieldsToMap(fields);
      const hashTag = msg._hash_tag ?? (msg.risk_class && msg.bucket ? `${msg.risk_class}:${msg.bucket}` : undefined);
      const ulid = msg._id;
      if (!hashTag || !ulid) {
        if (profile) {
          profile.recordStep("parse", process.hrtime.bigint() - parseStart);
          profile.recordRowsAcked(1);
        }
        // Malformed entry — ack so it leaves the PEL but don't write a doc.
        pipeline.xack(opts.stream, opts.group, entryId);
        continue;
      }
      const key = buildKey(hashTag, ulid);
      // Wave 5.83B — enrichDoc folds in per-tenor `weighted_value`
      // (and `weighted_cvr_up/down` for Curvature) from the schema, plus
      // the `_calibration: "demo"` literal tag, then JSON.SET writes the
      // full enriched doc in one shot.
      const doc = enrichDoc(buildDoc(msg), opts.schema);
      const docJson = JSON.stringify(doc);
      const buildStart = profile ? process.hrtime.bigint() : 0n;
      if (profile) profile.recordStep("parse", buildStart - parseStart);
      pipeline.call("JSON.SET", key, "$", docJson);
      // Wave 6.14a — per-row contribution to the per-bucket rollup hashes
      // (and per-tenor sub-rollups for perTenor classes). Pipelined alongside
      // the JSON.SET so the whole apply is one round-trip per row; placed
      // before XACK so a HINCRBYFLOAT pipeline-level failure rolls back the
      // ack and the row is redelivered.
      emitRollupHincrs(pipeline as unknown as PipelineLike, doc);
      // Wave 6.24 — also SADD this row's (rc, bkt, sens_type) into the
      // materialized discovery sets so calc / facets can answer "which
      // (rc, bkt) tuples have data?" without an FT.AGGREGATE on idx:sens.
      // Same pipeline as JSON.SET / HINCRBYFLOAT so a SADD failure rolls
      // back the ack alongside its peers.
      emitSeenSadds(pipeline as unknown as PipelineLike, doc);
      // Wave 5.30a — autocomplete suggester live-populate. INCR bumps the
      // score on duplicate values so frequent terms rank higher in FT.SUGGET.
      // Pipelined alongside JSON.SET (and before XACK) so a SUGADD failure
      // rolls back the ack and the row is redelivered.
      if (doc.book) {
        pipeline.call("FT.SUGADD", "sug:book", String(doc.book), "1", "INCR");
      }
      if (doc.trade_id) {
        pipeline.call("FT.SUGADD", "sug:trade_id", String(doc.trade_id), "1", "INCR");
      }
      if (doc.risk_factor) {
        pipeline.call("FT.SUGADD", "sug:risk_factor", String(doc.risk_factor), "1", "INCR");
      }
      pipeline.xack(opts.stream, opts.group, entryId);
      if (profile) {
        profile.recordStep("pipe_build", process.hrtime.bigint() - buildStart);
        profile.recordRowsApplied(1);
        profile.recordRowsAcked(1);
      }
      processed++;
    }
    const execStart = profile ? process.hrtime.bigint() : 0n;
    await pipeline.exec();
    if (profile) profile.recordStep("pipe_exec", process.hrtime.bigint() - execStart);
  }
  return processed;
}

// Long-running XREADGROUP loop. On start, drains any pending entries this
// consumer name was holding before exit, then blocks on new entries until
// stop() is called. Graceful shutdown waits for the in-flight batch to
// complete before resolving.
export function createConsumer(client: RedisLike, opts: ConsumerOptions): ConsumerRunner {
  const stats: ConsumerStats = { consumed: 0, acked: 0, errors: 0, batches: 0 };
  let stopped = false;
  let loopDone: Promise<void> | undefined;

  async function tick(id: ">" | "0", block: number): Promise<number> {
    try {
      const n = await processBatch(client, opts, id, block);
      if (n > 0) {
        stats.consumed += n;
        stats.acked += n;
        stats.batches += 1;
      }
      return n;
    } catch (err) {
      stats.errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("NOGROUP")) {
        await ensureGroup(client, opts.stream, opts.group);
      }
      return 0;
    }
  }

  async function loop(): Promise<void> {
    // claim-on-restart: replay anything previously delivered to this
    // consumer name but never XACKed (e.g. crashed mid-batch).
    while (!stopped) {
      const n = await tick("0", 0);
      if (n === 0) break;
    }
    while (!stopped) {
      await tick(">", opts.blockMs ?? 1000);
    }
  }

  return {
    start(): void {
      if (loopDone) return;
      loopDone = loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (loopDone) await loopDone;
    },
    get stats() { return stats; },
  };
}

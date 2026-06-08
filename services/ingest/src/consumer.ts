import type { Redis, Cluster } from "ioredis";
import type { Schema, RiskWeightTable } from "@frtb/schema";

// Stream consumer for the FRTB ingest service.
// Reads from Redis Stream `sensitivities:in` via XREADGROUP, builds the locked
// final key `sens:{risk_class:bucket}:{ulid}` (literal braces = hash-tag for
// slot-affinity per Wave 2 contract), writes the doc with JSON.SET, then XACKs.
// JSON.SET with the same key+doc is naturally idempotent: re-deliveries of the
// same logical row produce no duplicate keys.

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

// Builds the locked final key shape `sens:{risk_class:bucket}:{ulid}`.
// The literal `{...}` braces around the hash-tag are required so Redis
// Cluster routes all sensitivities for the same (risk_class, bucket) to the
// same slot (per Wave 2 contract — keeps SBM FCALL slot-local).
export function buildKey(hashTag: string, id: string): string {
  return `sens:{${hashTag}}:${id}`;
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
// Shapes (see shared/schema/src/types.ts `SensitivityRiskValue`):
//   - Delta/Vega per-tenor object `{ "3M": v0, "6M": v1, ... }` → produces
//     `weighted_value: { "3M": w_k*v0, "6M": w_k*v1, ... }` (per-tenor object).
//   - Delta/Vega scalar `{ spot: v }` or bare `number` → produces a scalar
//     `weighted_value = w * v` (Equity / FX convention).
//   - Delta/Vega legacy array `[v0, v1, ...]` (test fixtures) → zipped against
//     `doc.tenor` (when an array of labels) or the schema's class tenor nodes;
//     produces a per-tenor object. Skipped silently if no tenor labels.
//   - Curvature per-tenor `{ cvr_up: number[], cvr_down: number[] }` → emits
//     `weighted_cvr_up` / `weighted_cvr_down` as per-tenor objects keyed by
//     the schema's class tenor nodes.
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
      const up = cvrObj.cvr_up as number[];
      const down = cvrObj.cvr_down as number[];
      const upOut: Record<string, number> = {};
      const downOut: Record<string, number> = {};
      const n = Math.min(up.length, down.length, tenorNodes.length);
      for (let i = 0; i < n; i++) {
        const t = tenorNodes[i]!;
        const w = legWeight(sensType, table, bucket, t);
        upOut[t] = w * up[i]!;
        downOut[t] = w * down[i]!;
      }
      enriched.weighted_cvr_up = upOut;
      enriched.weighted_cvr_down = downOut;
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
      // Per-tenor object: keys are tenor labels.
      const out: Record<string, number> = {};
      for (const k of keys) {
        const v = obj[k];
        if (typeof v !== "number") continue;
        const w = legWeight(sensType, table, bucket, k);
        out[k] = w * v;
      }
      enriched.weighted_value = out;
    }
  } else if (Array.isArray(rv)) {
    // Legacy array shape (test fixtures): zip against doc.tenor when it's
    // an array of labels, else fall back to the schema's class tenor nodes.
    const docTenor = doc.tenor;
    const labels: readonly string[] | undefined = Array.isArray(docTenor) && docTenor.every((t) => typeof t === "string")
      ? (docTenor as string[])
      : tenorNodes;
    if (labels) {
      const out: Record<string, number> = {};
      const n = Math.min(rv.length, labels.length);
      for (let i = 0; i < n; i++) {
        const v = rv[i];
        if (typeof v !== "number") continue;
        const t = labels[i]!;
        const w = legWeight(sensType, table, bucket, t);
        out[t] = w * v;
      }
      enriched.weighted_value = out;
    }
  } else if (typeof rv === "number") {
    // Bare scalar (Equity / FX legacy fixture shape).
    const w = legWeight(sensType, table, bucket, null);
    enriched.weighted_value = w * rv;
  }
  return enriched;
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
  const reply = (await (client as Redis).xreadgroup(
    "GROUP", opts.group, opts.consumerName,
    "COUNT", count,
    "BLOCK", block,
    "STREAMS", opts.stream, id
  )) as XReadGroupReply;
  if (!reply) return 0;

  let processed = 0;
  for (const [, entries] of reply) {
    if (entries.length === 0) continue;
    const pipeline = client.pipeline();
    for (const [entryId, fields] of entries) {
      const msg = fieldsToMap(fields);
      const hashTag = msg._hash_tag ?? (msg.risk_class && msg.bucket ? `${msg.risk_class}:${msg.bucket}` : undefined);
      const ulid = msg._id;
      if (!hashTag || !ulid) {
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
      pipeline.call("JSON.SET", key, "$", JSON.stringify(doc));
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
      processed++;
    }
    await pipeline.exec();
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

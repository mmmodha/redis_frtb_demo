import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { getBootstrapStatus } from "../bootstrap-status.ts";
import { getSensIndexName } from "../lib/sens-index.ts";
import { translateRedisError } from "../redis-errors.ts";

// Escape RediSearch TAG punctuation per dialect 2 — colon, dash, brace, etc.
// are token separators and must be backslash-escaped to match literally.
const TAG_SPECIALS = /[\s,.<>{}\[\]"':;!@#$%^&*()\-+=~|\/?]/g;
function escapeTag(v: string): string {
  return v.replace(TAG_SPECIALS, (m) => `\\${m}`);
}

interface PivotQuery {
  risk_class?: string;
  bucket?: string;
  sensitivity_type?: string;
  book?: string;
  trade_id?: string;
  risk_factor?: string;
  limit?: string;
  offset?: string;
}

// Wave 6.47.B — inline copy of the consumer's `sideTableKeyFor` helper. The
// `hash-sidetable` writer (services/ingest/src/consumer.ts:562) wraps the
// parent key in braces so the side-table HASH lands on the same Redis Cluster
// slot. Inlined (rather than re-imported via @frtb/calc-shared) because the
// helper is not currently exported from the shared package; keep this in sync
// with the writer if the naming ever changes.
function sideTableKeyFor(parentKey: string): string {
  return `{${parentKey}}:tenors`;
}

// Wave 6.47.B — ioredis pipeline surface (Redis|Cluster both expose it). Kept
// off the narrow RedisLike interface for the same reason as facets.ts:
// minimal stubs without `.pipeline()` can fall back to per-call execution.
type PipelineClient = {
  pipeline(): {
    call(command: string, ...args: unknown[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
};

function hasPipeline(r: RedisLike): r is RedisLike & PipelineClient {
  return typeof (r as unknown as Partial<PipelineClient>).pipeline === "function";
}

// Wave 6.47.B — reconstruct `risk_value` from an HGETALL reply on the
// `hash-sidetable` companion key. The writer (sideTableArgsFor) stores
// per-tenor `<label> -> <number-as-string>` pairs for Delta/Vega rows whose
// raw risk_value is a tenor-keyed object; scalar Equity/FX rows have no
// side-table key at all (and Curvature is currently skipped by the writer
// too — see consumer.ts:577). This parser is defensive against both shapes
// plus a hypothetical Curvature variant that JSON-encodes cvr_up/cvr_down
// arrays and an optional `__tenor_order__` JSON array used to preserve
// tenor ordering when present.
function parseSideTableRiskValue(reply: unknown): unknown {
  const entries = entriesFromHashReply(reply);
  if (!entries || entries.length === 0) return undefined;
  let tenorOrder: string[] | null = null;
  const map = new Map<string, string>();
  for (const [k, v] of entries) {
    if (k === "__tenor_order__") {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) tenorOrder = parsed.map((t) => String(t));
      } catch { /* leave tenorOrder null */ }
      continue;
    }
    map.set(k, v);
  }
  const keys = [...map.keys()];
  if (keys.length === 0) return undefined;
  if (keys.every((k) => k === "cvr_up" || k === "cvr_down")) {
    const out: Record<string, number[]> = {};
    for (const k of keys) {
      try {
        const v = JSON.parse(map.get(k)!);
        if (Array.isArray(v)) {
          const nums: number[] = [];
          for (const e of v) {
            const n = Number(e);
            if (Number.isFinite(n)) nums.push(n);
          }
          out[k] = nums;
        }
      } catch { /* skip malformed leg */ }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  const orderedKeys = tenorOrder ? tenorOrder.filter((k) => map.has(k)) : keys;
  const out: Record<string, number> = {};
  for (const k of orderedKeys) {
    const n = Number(map.get(k));
    if (Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function entriesFromHashReply(reply: unknown): Array<[string, string]> | null {
  if (reply == null) return null;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return null;
    const out: Array<[string, string]> = [];
    for (let i = 0; i + 1 < reply.length; i += 2) {
      out.push([String(reply[i]), String(reply[i + 1])]);
    }
    return out;
  }
  if (typeof reply === "object") {
    const o = reply as Record<string, unknown>;
    const ks = Object.keys(o);
    if (ks.length === 0) return null;
    return ks.map((k) => [k, String(o[k])] as [string, string]);
  }
  return null;
}

// Wave 6.47.B — schema-derived weight lookup for a single row. Mirrors the
// `RiskWeightTable` discriminator in shared/schema/src/types.ts:
//   - `by_tenor` (GIRR) → return the full tenor → weight object so the UI
//     can render a tenor-keyed list alongside the tenor-keyed risk_value.
//   - `by_bucket` (CSR / Equity / Commodity) → scalar lookup keyed by the
//     row's `bucket`.
//   - `constant` (FX, GIRR Vega) → the single scalar value.
// Returns `undefined` for any missing piece so the caller can leave
// `doc.weight` untouched (matching the "—" UI fallback).
function resolveWeightFromSchema(
  schema: Schema | undefined,
  doc: Record<string, unknown>,
): unknown {
  if (!schema) return undefined;
  const rc = doc.risk_class;
  if (typeof rc !== "string") return undefined;
  const cls = schema.risk_classes?.[rc];
  if (!cls) return undefined;
  const ref = cls.risk_weights_ref;
  if (!ref) return undefined;
  const table = schema.risk_weights?.[ref];
  if (!table) return undefined;
  if ("by_tenor" in table && table.by_tenor && typeof table.by_tenor === "object") {
    return { ...table.by_tenor };
  }
  if ("by_bucket" in table && table.by_bucket && typeof table.by_bucket === "object") {
    const bk = doc.bucket;
    if (typeof bk !== "string") return undefined;
    const w = (table.by_bucket as Record<string, number>)[bk];
    return typeof w === "number" ? w : undefined;
  }
  if ("constant" in table && typeof table.constant === "number") {
    return table.constant;
  }
  return undefined;
}

export function registerPivotRoute(
  app: FastifyInstance,
  getRedis: () => RedisLike,
  opts: { schema?: Schema } = {},
): void {
  app.get<{ Querystring: PivotQuery }>("/pivot", { config: { category: "heavy-calc" } }, async (req, reply) => {
    const q = req.query;
    const limit = Math.min(1000, Math.max(0, parseInt(q.limit ?? "100", 10) || 100));
    const offset = parseInt(q.offset ?? "0", 10);
    if (Number.isNaN(offset) || offset < 0) {
      reply.code(400);
      return { error: "offset must be a non-negative integer" };
    }

    const parts: string[] = [];
    if (q.risk_class) parts.push(`@risk_class:{${escapeTag(q.risk_class)}}`);
    if (q.bucket) parts.push(`@bucket:{${escapeTag(q.bucket)}}`);
    if (q.sensitivity_type) parts.push(`@sensitivity_type:{${escapeTag(q.sensitivity_type)}}`);
    if (q.book) parts.push(`@book:{${escapeTag(q.book)}}`);
    if (q.trade_id) parts.push(`@trade_id:{${escapeTag(q.trade_id)}}`);
    if (q.risk_factor) parts.push(`@risk_factor:{${escapeTag(q.risk_factor)}}`);
    const query = parts.length === 0 ? "*" : parts.join(" ");

    // Wave 5.16t — resolve active redis per-request so a profile switch is
    // picked up on the very next /pivot call.
    const redis = getRedis();
    const target_label = getActiveTarget().label;
    // Wave 6.18i — resolve to the live versioned `idx:sens:v{hash7}` so
    // FT.SEARCH targets the same index name bootstrap last created.
    const indexName = await getSensIndexName(redis, target_label);

    const t0 = process.hrtime.bigint();
    let raw: unknown[];
    try {
      raw = (await redis.call(
        "FT.SEARCH",
        indexName,
        query,
        "LIMIT",
        String(offset),
        String(limit),
        "DIALECT",
        "2"
      )) as unknown[];
    } catch (err) {
      const translated = translateRedisError(err, target_label, getBootstrapStatus().phase);
      if (translated) {
        reply.code(translated.status);
        return translated.body;
      }
      throw err;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const total = Number(raw[0] ?? 0);
    const rows: Array<{ key: string; doc: unknown }> = [];
    // FT.SEARCH layout: [total, key1, fields1, key2, fields2, ...] where
    // fields1 is a flat ["$", "<json>"] array when RETURN $ is used (default).
    for (let i = 1; i < raw.length; i += 2) {
      const key = String(raw[i]);
      const fields = raw[i + 1] as unknown[] | undefined;
      let doc: unknown = null;
      if (Array.isArray(fields)) {
        // find $ in field pairs
        for (let j = 0; j < fields.length; j += 2) {
          if (fields[j] === "$" || fields[j] === "$.") {
            try {
              doc = JSON.parse(String(fields[j + 1]));
            } catch {
              doc = fields[j + 1];
            }
            break;
          }
        }
        if (doc === null) {
          // fall back to a flat field map if RETURN spec varies
          const m: Record<string, unknown> = {};
          for (let j = 0; j < fields.length; j += 2) m[String(fields[j])] = fields[j + 1];
          doc = m;
        }
      }
      rows.push({ key, doc });
    }

    // Wave 6.47.B — enrich each row with (a) raw `risk_value` from the
    // per-row side-table key when the parent HASH didn't carry it (the
    // `hash-sidetable` storage variant — the Wave 6.38.A default — stores
    // only pre-weighted `ws_*` numerics on the parent, so FT.SEARCH returns
    // a doc with no `risk_value` for per-tenor classes) and (b) the schema-
    // derived `weight` (raw `weight` is never persisted by the hash-sidetable
    // writer — it's used to compute `ws_*` and then discarded). Both fields
    // are additive: an already-populated `risk_value` / `weight` (legacy json
    // / json-shadow-hash variants) is never overwritten.
    const enrichTargets: Array<{ row: { key: string; doc: unknown }; docObj: Record<string, unknown> }> = [];
    for (const row of rows) {
      if (!row.doc || typeof row.doc !== "object" || Array.isArray(row.doc)) continue;
      enrichTargets.push({ row, docObj: row.doc as Record<string, unknown> });
    }

    // Pipeline one HGETALL per row that still needs raw risk_value. Scalar
    // Equity/FX rows have no side-table key (the writer skips them) — the
    // reply will be empty and `parseSideTableRiskValue` returns undefined,
    // so `doc.risk_value` stays untouched.
    const sideTableTargets = enrichTargets.filter(({ docObj }) => docObj.risk_value === undefined);
    if (sideTableTargets.length > 0 && hasPipeline(redis)) {
      const pipeline = redis.pipeline();
      for (const { row } of sideTableTargets) {
        pipeline.call("HGETALL", sideTableKeyFor(row.key));
      }
      let results: Array<[Error | null, unknown]> | null = null;
      try {
        results = await pipeline.exec();
      } catch {
        // Side-table enrichment is best-effort; surface the FT.SEARCH rows
        // verbatim if the pipeline fails (the UI already handles "—").
        results = null;
      }
      if (results) {
        for (let i = 0; i < sideTableTargets.length && i < results.length; i++) {
          const tuple = results[i]!;
          if (tuple[0]) continue;
          const rv = parseSideTableRiskValue(tuple[1]);
          if (rv !== undefined) sideTableTargets[i]!.docObj.risk_value = rv;
        }
      }
    }

    // Schema-derived weight enrichment (does not require Redis I/O — all
    // lookups are in-memory off the schema table loaded at boot).
    if (opts.schema) {
      for (const { docObj } of enrichTargets) {
        if (docObj.weight !== undefined) continue;
        const w = resolveWeightFromSchema(opts.schema, docObj);
        if (w !== undefined) docObj.weight = w;
      }
    }

    return { rows, total, limit, offset, ms: Math.round(ms * 1000) / 1000 };
  });
}

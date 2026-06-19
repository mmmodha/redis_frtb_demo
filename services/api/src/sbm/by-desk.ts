// Wave 6.41.B — single-FT.AGGREGATE per-desk K_b approximation.
//
// Issues ONE `FT.AGGREGATE … GROUPBY @desk` against `idx:sens` (no per-desk
// fanout, no FCALL). Reduces over the canonical pre-weighted `ws_*` fields
// (same field shape the rollup-readout path consumes — see
// `aggregate-via-index.ts`) and computes a per-desk K_b using the constant-ρ
// closed form.
//
// PRECISION CONTRACT
// The per-desk K_b returned here is NOT the Basel curvature-aware K_b. It is
// a single-aggregate approximation in which each desk's rows are treated as
// one synthetic "bucket": ΣWS and ΣWS² are summed over every row that
// matches (risk_class, sensitivity_type, optional include/exclude predicates)
// regardless of which actual @bucket those rows belong to. The Basel
// per-bucket K_b is then collapsed to:
//   K_b_desk² = ΣWS² + ρ · ((ΣWS)² − ΣWS²)
// which drops the cross-bucket γ_bc term entirely. For Curvature we also
// drop the ψ-gating (the negative-only sign-split needs row-level data the
// single GROUPBY cannot recover) and instead pick the worse of K_b⁺/K_b⁻
// per direction using the same constant-ρ closed form. Suitable for ranking
// desks by their contribution magnitude; not suitable for reporting the
// Basel-correct desk-level charge.

import type { Schema } from "@frtb/schema";
import type { RedisLike } from "../redis-like.ts";
import {
  FT_AGGREGATE_TIMEOUT_MS,
  resolveLegFields,
  resolveQueryNodes,
  resolveRho,
} from "./aggregate-via-index.ts";

export type ByDeskLeg = "delta" | "vega" | "curvature";

export interface ByDeskFilters {
  bucketSubset?: ReadonlyArray<string>;
  include?: {
    book?: ReadonlyArray<string>;
    desk?: ReadonlyArray<string>;
  };
  exclude?: {
    book?: ReadonlyArray<string>;
    trade_id?: ReadonlyArray<string>;
    risk_factor?: ReadonlyArray<string>;
  };
}

export interface ByDeskRow {
  desk: string;
  K_b: number;
  count: number;
}

export interface ByDeskAggregateOpts {
  redis: RedisLike;
  schema: Schema;
  // Canonical UPPERCASE risk-class key.
  riskClass: string;
  leg: ByDeskLeg;
  // Versioned `idx:sens:v{hash7}` (or unversioned `idx:sens`) — resolved by
  // the caller via getSensIndexName so the helper does not bake the literal.
  indexName: string;
  filters?: ByDeskFilters;
  // Optional ρ override (post-scaling by the correlation regime). When
  // omitted, the helper falls back to the schema-derived ρ for the
  // (risk_class, leg).
  rhoOverride?: number;
}

// TAG escape mirroring routes/calc.ts + aggregate-via-index.ts so subset /
// include / exclude predicates flow through the index query parser intact.
const TAG_SPECIALS = /[\s,.<>{}\[\]"':;!@#$%^&*()\-+=~|\/?]/g;
function escapeTag(v: string): string {
  return v.replace(TAG_SPECIALS, (m) => `\\${m}`);
}

const PER_TENOR_CLASSES = new Set(["GIRR"]);

function safeNum(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Constant-ρ K_b closed form. Same shape as kbFromConstantRho in
// aggregate-via-index.ts; duplicated here to keep this module's surface
// self-contained (the helper there is private).
function kbFromConstantRho(sumWs: number, sumWsSq: number, rho: number): number {
  let cross = sumWs * sumWs - sumWsSq;
  if (cross < 0) cross = 0;
  let kbSq = sumWsSq + rho * cross;
  if (kbSq < 0) kbSq = 0;
  return Math.sqrt(kbSq);
}

// Build the FT.AGGREGATE argv (everything after the command name). LOAD +
// APPLY @f+0 coercion mirrors buildFastPathAggregateArgs so missing HASH
// fields collapse to 0 on every RediSearch flavour (avoids the EXISTS /
// UNSTABLE `case` rejection path documented in Wave 6.39.H).
export function buildByDeskAggregateArgs(
  query: string,
  fieldList: ReadonlyArray<string>,
  indexName: string,
): unknown[] {
  const args: unknown[] = [indexName, query];
  const loadFields: string[] = [];
  const loadSeen = new Set<string>();
  const applyClauses: Array<[string, string]> = [];
  const sumReducers: Array<[string, string]> = [];
  for (const f of fieldList) {
    if (!loadSeen.has(f)) {
      loadSeen.add(f);
      loadFields.push(f);
    }
    const safeAlias = `${f}_safe`;
    const sqAlias = `${f}_sq`;
    applyClauses.push([`@${f}+0`, safeAlias]);
    applyClauses.push([`(@${safeAlias}*@${safeAlias})`, sqAlias]);
    sumReducers.push([safeAlias, `sum_${f}`]);
    sumReducers.push([sqAlias, `sum_${f}_sq`]);
  }
  if (loadFields.length > 0) {
    args.push("LOAD", String(loadFields.length));
    for (const f of loadFields) args.push(`@${f}`);
  }
  for (const [expr, alias] of applyClauses) {
    args.push("APPLY", expr, "AS", alias);
  }
  args.push("GROUPBY", "1", "@desk");
  for (const [src, alias] of sumReducers) {
    args.push("REDUCE", "SUM", "1", `@${src}`, "AS", alias);
  }
  args.push("REDUCE", "COUNT", "0", "AS", "row_count");
  args.push("LIMIT", "0", "10000");
  args.push("DIALECT", "2");
  args.push("TIMEOUT", String(FT_AGGREGATE_TIMEOUT_MS));
  return args;
}

export function buildByDeskQuery(
  riskClass: string,
  sensitivityType: "Delta" | "Vega" | "Curvature",
  filters: ByDeskFilters | undefined,
): string {
  const parts: string[] = [
    `@risk_class:{${escapeTag(riskClass)}}`,
    `@sensitivity_type:{${escapeTag(sensitivityType)}}`,
  ];
  if (filters?.bucketSubset && filters.bucketSubset.length > 0) {
    parts.push(`@bucket:{${filters.bucketSubset.map(escapeTag).join("|")}}`);
  }
  if (filters?.include?.desk && filters.include.desk.length > 0) {
    parts.push(`@desk:{${filters.include.desk.map(escapeTag).join("|")}}`);
  }
  if (filters?.include?.book && filters.include.book.length > 0) {
    parts.push(`@book:{${filters.include.book.map(escapeTag).join("|")}}`);
  }
  const ex = filters?.exclude;
  if (ex) {
    for (const key of ["book", "trade_id", "risk_factor"] as const) {
      const list = ex[key];
      if (list && list.length > 0) {
        parts.push(`-@${key}:{${list.map(escapeTag).join("|")}}`);
      }
    }
  }
  return parts.join(" ");
}

// Parse one FT.AGGREGATE reply into a Map keyed by @desk. Tolerant of both
// flat key/value rows (RESP2) and map-shaped rows (RESP3 / in-process fakes),
// mirroring parseAggregateRows in aggregate-via-index.ts but indexing on the
// `desk` field instead of `bucket`.
function parseDeskRows(reply: unknown): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!Array.isArray(reply)) return out;
  for (let i = 1; i < reply.length; i++) {
    const row = reply[i];
    const m: Record<string, string> = {};
    if (Array.isArray(row)) {
      for (let j = 0; j < row.length; j += 2) {
        const k = String(row[j]).replace(/^@/, "");
        m[k] = String(row[j + 1]);
      }
    } else if (row && typeof row === "object") {
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        m[k.replace(/^@/, "")] = String(v);
      }
    }
    const desk = m.desk;
    if (!desk) continue;
    const prev = out.get(desk);
    if (!prev) {
      out.set(desk, m);
    } else {
      const merged: Record<string, string> = { ...prev };
      for (const [k, v] of Object.entries(m)) {
        if (k === "desk") continue;
        const cur = Number(merged[k] ?? 0);
        merged[k] = String(cur + Number(v));
      }
      out.set(desk, merged);
    }
  }
  return out;
}

export async function aggregateByDesk(opts: ByDeskAggregateOpts): Promise<ByDeskRow[]> {
  const rc = opts.riskClass.toUpperCase();
  const fields = resolveLegFields(opts.schema, rc, opts.leg);
  const rho = opts.rhoOverride ?? resolveRho(opts.schema, rc, opts.leg);
  const perTenor =
    PER_TENOR_CLASSES.has(rc) &&
    (opts.schema.risk_classes[rc]?.tenor?.nodes?.length ?? 0) > 0;

  const query = buildByDeskQuery(rc, fields.sensitivityType, opts.filters);
  const deltaList = fields.delta ?? [];
  const vegaList = fields.vega ?? [];
  const cvrUp = fields.cvrUp ?? [];
  const cvrDown = fields.cvrDown ?? [];
  const legList =
    opts.leg === "delta" ? deltaList :
    opts.leg === "vega" ? vegaList :
    [...cvrUp, ...cvrDown];

  const argv = buildByDeskAggregateArgs(query, legList, opts.indexName);

  // Cluster fan-out: dispatch the same FT.AGGREGATE on every master shard
  // and merge per-desk numeric reducer outputs. Mirrors the shard-merge
  // pattern in aggregateBucketsViaIndex so cluster + standalone behaviour
  // stay consistent.
  const nodes = resolveQueryNodes(opts.redis);
  const merged = new Map<string, Record<string, string>>();
  for (const node of nodes) {
    const reply = await node.call("FT.AGGREGATE", ...argv);
    const rows = parseDeskRows(reply);
    for (const [desk, row] of rows) {
      const prev = merged.get(desk);
      if (!prev) { merged.set(desk, row); continue; }
      const next: Record<string, string> = { ...prev };
      for (const [k, v] of Object.entries(row)) {
        if (k === "desk") continue;
        const cur = Number(next[k] ?? 0);
        next[k] = String(cur + Number(v));
      }
      merged.set(desk, next);
    }
  }

  const out: ByDeskRow[] = [];
  for (const [desk, row] of merged) {
    const count = safeNum(row.row_count);
    if (opts.leg === "delta" || opts.leg === "vega") {
      const list = opts.leg === "delta" ? deltaList : vegaList;
      let sumWs: number;
      let sumWsSq: number;
      if (perTenor && opts.leg === "delta") {
        // GIRR Delta: per-tenor SUMs are squared then summed (mirrors
        // girr_delta.lua + bucketResultFromRow's perTenor branch).
        const wsK = list.map((f) => safeNum(row[`sum_${f}_safe`]));
        sumWs = wsK.reduce((a, b) => a + b, 0);
        sumWsSq = wsK.reduce((acc, x) => acc + x * x, 0);
      } else {
        // Per-row sum_ws_sq path for scalar classes + GIRR Vega.
        sumWs = 0;
        sumWsSq = 0;
        for (const f of list) {
          sumWs += safeNum(row[`sum_${f}_safe`]);
          sumWsSq += safeNum(row[`sum_${f}_sq`]);
        }
      }
      out.push({ desk, K_b: kbFromConstantRho(sumWs, sumWsSq, rho), count });
      continue;
    }
    // Curvature — compute K_b⁺ / K_b⁻ via the same constant-ρ closed form
    // and pick the worse magnitude. The ψ-gated negative-only sign-split
    // used in §21.5(3) needs row-level data the single GROUPBY @desk
    // cannot recover, so the cross_term collapses to the constant-ρ shape.
    const kbForDir = (dirFields: ReadonlyArray<string>): number => {
      let sumWs: number;
      let sumWsSq: number;
      if (perTenor) {
        const wsK = dirFields.map((f) => safeNum(row[`sum_${f}_safe`]));
        sumWs = wsK.reduce((a, b) => a + b, 0);
        sumWsSq = wsK.reduce((acc, x) => acc + x * x, 0);
      } else {
        sumWs = 0;
        sumWsSq = 0;
        for (const f of dirFields) {
          sumWs += safeNum(row[`sum_${f}_safe`]);
          sumWsSq += safeNum(row[`sum_${f}_sq`]);
        }
      }
      return kbFromConstantRho(sumWs, sumWsSq, rho);
    };
    const kbUp = kbForDir(cvrUp);
    const kbDown = kbForDir(cvrDown);
    out.push({ desk, K_b: Math.max(kbUp, kbDown), count });
  }
  return out;
}

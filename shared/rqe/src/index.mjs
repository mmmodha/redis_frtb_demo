// @frtb/rqe — Redis Query Engine index definitions for FRTB sensitivity pivots.
//
// Wave 2 locked contract (see spec.md "Wave 2 contracts"):
//   - Index name:  idx:sens
//   - Key prefix:  sens:           (matches sens:<ulid> after Wave 6.31)
//   - Wave 6.38.A: migrated ON JSON → ON HASH (HASH side-table layout default)
//   - DIALECT 2
//   - TAG attributes: risk_class, bucket, sensitivity_type, book, trade_id,
//     risk_factor, trader, _calibration, desk
//
// Consumers:
//   - api boot calls ensureSensIndex(client) once at startup
//   - tools/rqe-index-cli wraps ensure/drop/recreate/info for live demo control
//
// Sample FT.SEARCH queries this index serves (driving the /pivot endpoint):
//   FT.SEARCH idx:sens "@risk_class:{GIRR}" LIMIT 0 50 DIALECT 2
//   FT.SEARCH idx:sens "@risk_class:{GIRR} @bucket:{USD\\-IRS}" LIMIT 0 50 DIALECT 2
//   FT.SEARCH idx:sens "@sensitivity_type:{Delta}" GROUPBY 1 @bucket REDUCE COUNT 0 AS n
//   FT.SEARCH idx:sens "@book:{RATES\\-LDN}" RETURN 3 risk_class bucket trade_id
//   FT.SEARCH idx:sens "@desk:{RATES_LDN}" LIMIT 0 1 DIALECT 2
//
// Per redis-development rqe-index-creation: index ONLY the fields we query.
// Per rqe-dialect: every query uses DIALECT 2.

export const IDX_NAME = "idx:sens";
export const IDX_PREFIX = "sens:";

// Schema, in declaration order. Add fields here by appending; the FT.CREATE
// command is built from this array so additions are mechanical.
//
// Wave 5.17a — added `risk_factor` (Tier-1 bank tag dimension; pool of 16 per
// class). `trade_id` was already indexed and stays indexed.
// Wave 5.83A — added `trader` (per-row attribution) and `_calibration`
// (low-cardinality ingest tag) as static TAGs; per-class per-tenor
// pre-weighted NUMERIC SORTABLE fields are derived from the schema via
// buildSchemaFields(schema) below.
// Wave 6.38.A — added `desk` (15-desk taxonomy: RATES/FX/EQUITY/CREDIT/
// COMMODITY × LDN/NYC/HKG, e.g. `RATES_LDN`). Underscore separator so TAG
// queries need no escaping. Paths switched to bare HASH field names — the
// FT.CREATE clause is now `ON HASH`, so JSONPath prefixes are dropped.
export const IDX_SCHEMA_FIELDS = Object.freeze([
  { path: "risk_class", as: "risk_class", type: "TAG" },
  { path: "bucket", as: "bucket", type: "TAG" },
  { path: "sensitivity_type", as: "sensitivity_type", type: "TAG" },
  { path: "book", as: "book", type: "TAG" },
  { path: "trade_id", as: "trade_id", type: "TAG" },
  { path: "risk_factor", as: "risk_factor", type: "TAG" },
  { path: "trader", as: "trader", type: "TAG" },
  { path: "_calibration", as: "_calibration", type: "TAG" },
  { path: "desk", as: "desk", type: "TAG" },
]);

// Wave 5.83A — risk classes whose pre-weighted sensitivities live under a
// per-tenor object (e.g. `weighted_value_per_tenor["3M"]`). Other classes
// (Equity, FX) emit scalar `weighted_value` / `weighted_cvr_*` and get a
// single ws_* alias per leg with no tenor suffix.
const PER_TENOR_CLASSES = Object.freeze(["GIRR"]);
// Legs, their scalar JSON root path, and the per-tenor JSON root path.
// `delta` and `vega` share `$.weighted_value` (sensitivity_type discriminates
// at query time); curvature splits into two per-direction paths.
//
// Wave 5.83F — per-tenor classes (GIRR) write their per-tenor maps to a
// distinct `*_per_tenor` JSONPath so `$.weighted_value` (and the curvature
// pair) can stay SCALAR across every class. That removes the GIRR-vs-
// Equity/FX type collision that aborted idx:sens indexing on the GIRR
// prefix-matched docs.
const WS_LEGS = Object.freeze([
  { leg: "delta", root: "weighted_value", perTenorRoot: "weighted_value_per_tenor" },
  { leg: "vega", root: "weighted_value", perTenorRoot: "weighted_value_per_tenor" },
  { leg: "cvr_up", root: "weighted_cvr_up", perTenorRoot: "weighted_cvr_up_per_tenor" },
  { leg: "cvr_down", root: "weighted_cvr_down", perTenorRoot: "weighted_cvr_down_per_tenor" },
]);

// Wave 6.38.A — HASH layout. Per-tenor pre-weighted values are stored as
// flat HASH fields named `ws_<class>_<leg>_<tenor>` on the parent
// `sens:<ulid>` HASH (so a single HASH field reach is enough for
// FT.AGGREGATE). For the side-table variant, the raw per-tenor risk_value
// map lives on `{sens:<ulid>}:tenors` (Wave 6.39.G — re-tagged to share a
// slot with its parent) and is NOT indexed.
function tenorHashField(classLower, leg, tenor) {
  return `ws_${classLower}_${leg}_${tenor}`;
}

// buildSchemaFields — full ordered field list for FT.CREATE. Returns the
// static base (TAG attributes) plus dynamic per-class per-tenor (or scalar)
// pre-weighted NUMERIC SORTABLE fields derived from the schema. Pass no
// schema (or one without risk_classes) to get just the static base — the
// CLI's `print` / `ensure` paths use this back-compat shape.
export function buildSchemaFields(schema) {
  const out = IDX_SCHEMA_FIELDS.slice();
  const riskClasses = schema && schema.risk_classes ? schema.risk_classes : null;
  if (!riskClasses) return out;
  for (const className of Object.keys(riskClasses)) {
    const cfg = riskClasses[className];
    if (!cfg) continue;
    const classLower = className.toLowerCase();
    const tenorNodes = cfg.tenor && Array.isArray(cfg.tenor.nodes) ? cfg.tenor.nodes : [];
    const isPerTenor = PER_TENOR_CLASSES.includes(className) && tenorNodes.length > 0;
    for (const { leg, root } of WS_LEGS) {
      void root;
      if (isPerTenor) {
        // Wave 6.38.A — HASH field name == alias for per-tenor legs. The
        // consumer writer flattens the per-tenor map to these flat fields on
        // the parent HASH so a single FT.AGGREGATE reach is enough.
        for (const tenor of tenorNodes) {
          const name = tenorHashField(classLower, leg, tenor);
          out.push({
            path: name,
            as: name,
            type: "NUMERIC",
            sortable: true,
          });
        }
      } else {
        // Scalar legs (Equity, FX) — HASH field name matches the alias and
        // mirrors the JSON-era scalar root used by the consumer.
        const name = `ws_${classLower}_${leg}`;
        out.push({
          path: name,
          as: name,
          type: "NUMERIC",
          sortable: true,
        });
      }
    }
  }
  return out;
}

// Builds the FT.CREATE argv (everything after the command name). Exposed so
// the CLI can echo the exact command it's about to run for the demo. When a
// schema is provided, includes the per-class per-tenor pre-weighted NUMERIC
// SORTABLE fields; without one, just the static base (preserves CLI
// back-compat — `print` / `ensure` without a schema still emit a valid
// FT.CREATE for the TAG-only portion).
//
// Wave 6.38.A — switched `ON JSON` to `ON HASH`. All path values returned by
// buildSchemaFields are bare HASH field names (no JSONPath `$.` prefix). The
// PREFIX list now carries `sens:` (default `hash-sidetable` / `hash-encoded`
// parents) AND `sensh:` (the `json-shadow-hash` HASH mirror). RediSearch on
// `ON HASH` silently skips keys whose type does not match (so the legacy
// `json` variant's `sens:<ulid>` JSON document, when present, is a no-op
// here). Wave 6.39.G — the side-table HASH lives at `{sens:<ulid>}:tenors`
// (braces wrap the parent key so both share a slot). Its literal key starts
// with `{` not `sens:`, so it never matches either FT.CREATE PREFIX and is
// implicitly excluded from idx:sens — the FILTER `exists(@risk_class)` below
// is kept as a defence-in-depth guard against rogue keys.
export const IDX_SHADOW_PREFIX = "sensh:";
export function buildCreateArgs(schema) {
  const args = [
    IDX_NAME,
    "ON", "HASH",
    "PREFIX", "2", IDX_PREFIX, IDX_SHADOW_PREFIX,
    "FILTER", "exists(@risk_class)",
    "SCHEMA",
  ];
  for (const f of buildSchemaFields(schema)) {
    args.push(f.path, "AS", f.as, f.type);
    if (f.sortable) args.push("SORTABLE");
  }
  return args;
}

function isAlreadyExistsError(err) {
  const msg = String(err && err.message ? err.message : err);
  // RediSearch returns "Index already exists" for FT.CREATE on an existing
  // name. Handle both that and the generic "already exists" phrasing.
  return /already exists/i.test(msg);
}

function isUnknownIndexError(err) {
  const msg = String(err && err.message ? err.message : err);
  // RediSearch returns "Unknown Index name" / "Unknown index name" for
  // FT.DROPINDEX against a missing index — treat as success. Redis 8.x
  // surfaces the same condition as "SEARCH_INDEX_NOT_FOUND Index not found: …".
  return /unknown index/i.test(msg) || /no such index/i.test(msg) || /index not found/i.test(msg);
}

// ensureSensIndex — idempotently create idx:sens.
// Safe to call concurrently from multiple processes (api boot + CLI demo run);
// any caller that loses the race sees "already exists" and returns happily.
// Wave 5.83A — accepts an optional schema so the per-class per-tenor
// pre-weighted NUMERIC fields are included. Omit the schema (CLI demo path)
// to create the static TAG-only portion.
export async function ensureSensIndex(client, schema) {
  if (!client) throw new TypeError("ensureSensIndex: redis client required");
  const args = buildCreateArgs(schema);
  try {
    await client.call("FT.CREATE", ...args);
    return { created: true, name: IDX_NAME };
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      return { created: false, name: IDX_NAME };
    }
    throw err;
  }
}

// dropSensIndex — remove idx:sens. Idempotent: dropping a missing index is
// not an error (supports the demo "drop then recreate" flow without prechecks).
// Note: we do NOT pass DD — the underlying JSON docs are preserved, only the
// index is removed.
export async function dropSensIndex(client) {
  if (!client) throw new TypeError("dropSensIndex: redis client required");
  try {
    await client.call("FT.DROPINDEX", IDX_NAME);
    return { dropped: true, name: IDX_NAME };
  } catch (err) {
    if (isUnknownIndexError(err)) {
      return { dropped: false, name: IDX_NAME };
    }
    throw err;
  }
}

// Wave 7.0.2.A — slim RediSearch schema variant. Lives alongside the fat
// `idx:sens` during the lazy-math migration. Two differences from the fat
// schema:
//   1. Drops `trader` and `_calibration` TAGs — Phase 0 audit (Wave 7.0.0.A)
//      confirmed zero read sites in calc/api. Kept TAGs: risk_class, bucket,
//      sensitivity_type, book, trade_id, risk_factor, desk.
//   2. Indexes the RAW per-class/per-leg sensitivity values as `s_<class>_
//      <leg>[_<tenor>]` NUMERIC SORTABLE fields instead of the pre-weighted
//      `ws_*` set. The lazy-math fast path (Wave 7.0.2.B) APPLYs `@s_field *
//      <weight>` at query time so weight changes do not require a re-write.
// Prefix and FILTER mirror `idx:sens` because both indices read the same
// underlying `sens:<ulid>` / `sensh:<ulid>` HASH docs — the slim writer
// (Wave 7.0.1.B) flattens the additional `s_*` fields onto each row.
export const IDX_NAME_SLIM = "idx:sens:slim";

export const IDX_SLIM_SCHEMA_FIELDS = Object.freeze([
  { path: "risk_class", as: "risk_class", type: "TAG" },
  { path: "bucket", as: "bucket", type: "TAG" },
  { path: "sensitivity_type", as: "sensitivity_type", type: "TAG" },
  { path: "book", as: "book", type: "TAG" },
  { path: "trade_id", as: "trade_id", type: "TAG" },
  { path: "risk_factor", as: "risk_factor", type: "TAG" },
  { path: "desk", as: "desk", type: "TAG" },
]);

function rawTenorHashField(classLower, leg, tenor) {
  return `s_${classLower}_${leg}_${tenor}`;
}

// buildSlimSchemaFields — full ordered field list for slim FT.CREATE. Returns
// the slim TAG base plus dynamic per-class per-tenor (or scalar) raw NUMERIC
// SORTABLE fields derived from the schema. Mirrors buildSchemaFields'
// iteration shape so the per-tenor / scalar split stays in lockstep with the
// fat index. Pass no schema to get just the TAG base.
export function buildSlimSchemaFields(schema) {
  const out = IDX_SLIM_SCHEMA_FIELDS.slice();
  const riskClasses = schema && schema.risk_classes ? schema.risk_classes : null;
  if (!riskClasses) return out;
  for (const className of Object.keys(riskClasses)) {
    const cfg = riskClasses[className];
    if (!cfg) continue;
    const classLower = className.toLowerCase();
    const tenorNodes = cfg.tenor && Array.isArray(cfg.tenor.nodes) ? cfg.tenor.nodes : [];
    const isPerTenor = PER_TENOR_CLASSES.includes(className) && tenorNodes.length > 0;
    for (const { leg } of WS_LEGS) {
      if (isPerTenor) {
        for (const tenor of tenorNodes) {
          const name = rawTenorHashField(classLower, leg, tenor);
          out.push({ path: name, as: name, type: "NUMERIC", sortable: true });
        }
      } else {
        const name = `s_${classLower}_${leg}`;
        out.push({ path: name, as: name, type: "NUMERIC", sortable: true });
      }
    }
  }
  return out;
}

export function buildSlimCreateArgs(schema) {
  const args = [
    IDX_NAME_SLIM,
    "ON", "HASH",
    "PREFIX", "2", IDX_PREFIX, IDX_SHADOW_PREFIX,
    "FILTER", "exists(@risk_class)",
    "SCHEMA",
  ];
  for (const f of buildSlimSchemaFields(schema)) {
    args.push(f.path, "AS", f.as, f.type);
    if (f.sortable) args.push("SORTABLE");
  }
  return args;
}

// ensureSlimSensIndex — idempotently create idx:sens:slim. Safe to call
// concurrently from multiple processes; any caller that loses the race sees
// "already exists" and returns happily.
export async function ensureSlimSensIndex(client, schema) {
  if (!client) throw new TypeError("ensureSlimSensIndex: redis client required");
  const args = buildSlimCreateArgs(schema);
  try {
    await client.call("FT.CREATE", ...args);
    return { created: true, name: IDX_NAME_SLIM };
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      return { created: false, name: IDX_NAME_SLIM };
    }
    throw err;
  }
}

// dropSlimSensIndex — remove idx:sens:slim. Idempotent: dropping a missing
// index is not an error.
export async function dropSlimSensIndex(client) {
  if (!client) throw new TypeError("dropSlimSensIndex: redis client required");
  try {
    await client.call("FT.DROPINDEX", IDX_NAME_SLIM);
    return { dropped: true, name: IDX_NAME_SLIM };
  } catch (err) {
    if (isUnknownIndexError(err)) {
      return { dropped: false, name: IDX_NAME_SLIM };
    }
    throw err;
  }
}

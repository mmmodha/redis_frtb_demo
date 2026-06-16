// @frtb/rqe — Redis Query Engine index definitions for FRTB sensitivity pivots.
//
// Wave 2 locked contract (see spec.md "Wave 2 contracts"):
//   - Index name:  idx:sens
//   - Key prefix:  sens:           (matches sens:{risk_class:bucket}:{ulid})
//   - ON JSON, DIALECT 2
//   - Five mandatory TAG attributes: risk_class, bucket, sensitivity_type, book, trade_id
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
export const IDX_SCHEMA_FIELDS = Object.freeze([
  { path: "$.risk_class", as: "risk_class", type: "TAG" },
  { path: "$.bucket", as: "bucket", type: "TAG" },
  { path: "$.sensitivity_type", as: "sensitivity_type", type: "TAG" },
  { path: "$.book", as: "book", type: "TAG" },
  { path: "$.trade_id", as: "trade_id", type: "TAG" },
  { path: "$.risk_factor", as: "risk_factor", type: "TAG" },
  { path: "$.trader", as: "trader", type: "TAG" },
  { path: "$._calibration", as: "_calibration", type: "TAG" },
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

// Bracket-notation JSON path so digit-prefixed tenor labels ("3M", "10Y") are
// safe — dot notation `$.weighted_value.3M` is ambiguous to RediSearch's
// JSONPath parser.
function tenorJsonPath(root, tenor) {
  return `$.${root}["${tenor}"]`;
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
    for (const { leg, root, perTenorRoot } of WS_LEGS) {
      if (isPerTenor) {
        // Wave 5.83F — per-tenor leg now points at the dedicated
        // `*_per_tenor` JSONPath; the scalar `$.<root>` stays free for the
        // class-level NUMERIC field (used by Equity/FX) without colliding.
        for (const tenor of tenorNodes) {
          out.push({
            path: tenorJsonPath(perTenorRoot, tenor),
            as: `ws_${classLower}_${leg}_${tenor}`,
            type: "NUMERIC",
            sortable: true,
          });
        }
      } else {
        out.push({
          path: `$.${root}`,
          as: `ws_${classLower}_${leg}`,
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
export function buildCreateArgs(schema) {
  const args = [
    IDX_NAME,
    "ON", "JSON",
    "PREFIX", "1", IDX_PREFIX,
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

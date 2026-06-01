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
// Wave 5.17a — added `risk_factor` (HSBC tag dimension; pool of 16 per
// class). `trade_id` was already indexed and stays indexed.
export const IDX_SCHEMA_FIELDS = Object.freeze([
  { path: "$.risk_class", as: "risk_class", type: "TAG" },
  { path: "$.bucket", as: "bucket", type: "TAG" },
  { path: "$.sensitivity_type", as: "sensitivity_type", type: "TAG" },
  { path: "$.book", as: "book", type: "TAG" },
  { path: "$.trade_id", as: "trade_id", type: "TAG" },
  { path: "$.risk_factor", as: "risk_factor", type: "TAG" },
]);

// Builds the FT.CREATE argv (everything after the command name). Exposed so
// the CLI can echo the exact command it's about to run for the demo.
export function buildCreateArgs() {
  const args = [
    IDX_NAME,
    "ON", "JSON",
    "PREFIX", "1", IDX_PREFIX,
    "SCHEMA",
  ];
  for (const f of IDX_SCHEMA_FIELDS) {
    args.push(f.path, "AS", f.as, f.type);
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
  // FT.DROPINDEX against a missing index — treat as success.
  return /unknown index/i.test(msg) || /no such index/i.test(msg);
}

// ensureSensIndex — idempotently create idx:sens.
// Safe to call concurrently from multiple processes (api boot + CLI demo run);
// any caller that loses the race sees "already exists" and returns happily.
export async function ensureSensIndex(client) {
  if (!client) throw new TypeError("ensureSensIndex: redis client required");
  const args = buildCreateArgs();
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

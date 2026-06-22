// scripts/calc-smoke-1k.mjs — Wave 7.0.6.7
//
// 1K end-to-end smoke test for the post-Wave-6.6 tag-free key shapes.
// Validates that bulk-loaded slim docs + finalise-rollups + finalise-seen-sets
// + POST /calc/sbm produces non-zero charge numbers end-to-end. Catches
// anything the unit parity tests don't.
//
// Flow:
//   1. FLUSHDB on the target Redis.
//   2. POST `${apiBase}/api/admin/flush` to drive the api's bootstrap path
//      (rebuilds idx:sens + idx:sens:slim under whatever versioned names the
//      active target persisted; without this the calc precondition probe
//      503s with "no-data-or-index" on a freshly-flushed target).
//   3. Discover the live slim-index name via `bootstrap:schema-hash:<label>`;
//      fall back to base `idx:sens:slim` and ensure it exists when the api
//      process was started without ENABLE_SLIM_SENS_INDEX=1.
//   4. Pipeline-HSET `--rows` `sens:<id>` rows across GIRR + EQUITY × {Delta,
//      Vega, Curvature} × multiple buckets, using the same
//      `s_<class>_<leg>[_<tenor>]` shape the bulk-loader's `rowToHashFields`
//      emits. Bucket selection cycles within each (rc, sens) combo so every
//      bucket gets coverage instead of pinning to one.
//   5. Poll FT.SEARCH until indexing settles.
//   6. Spawn scripts/finalise-rollups.mjs (writes tag-free
//      `rollup:<rc>:<bkt>:<sens>[:tenor:<t>]` hashes).
//   7. Spawn scripts/finalise-seen-sets.mjs (writes tag-free
//      `seen:risk_class`, `seen:bucket:<rc>`, `seen:sens_type:<rc>:<bkt>`).
//   8. POST `${apiBase}/api/calc/sbm?nocache=1` for the chosen risk_class.
//   9. Assert HTTP 200, per_bucket length > 0, at least one bucket K_b > 0,
//      no NaN/null/undefined in any numeric field, total charge > 0 and finite.
//
// Usage:
//   node --env-file=.env.local scripts/calc-smoke-1k.mjs [opts]
//
// Options:
//   --redis <url>       Redis URL (default: $REDIS_URL or redis://localhost:6379).
//   --api-base <url>    API base URL (default: http://localhost:3000 — UI proxy,
//                       forwards /api/* to the underlying API on :8080).
//   --rows <n>          Rows to load (default: 1000).
//   --risk-class <rc>   risk_class for the calc assertion (default: GIRR).
//   --sens <type>       sensitivity_type for the calc assertion (default: Delta).
//
// Exits 0 with a one-line summary on success; non-zero with the full response
// body dumped to stderr on assertion failure.

import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema } from "@frtb/schema";
import { ensureSlimSensIndex, IDX_NAME_SLIM } from "@frtb/rqe";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = process.env.SCHEMA_FILE
  ? resolve(process.env.SCHEMA_FILE)
  : join(REPO_ROOT, "config/schema/frtb-default.yaml");

// Test-data shape — chosen to populate both per-tenor (GIRR) and scalar
// (EQUITY) slim-doc paths so the slim-index + finalise scripts get exercised
// on every leg + every reducer branch the calc kernel can take. Tenors are
// resolved from the schema at runtime so every per-tenor slim field declared
// by `buildSlimSchemaFields` has at least one populated doc — without this
// the RediSearch 2.x `@field+0` null-coerce idiom in finalise-rollups raises
// `Could not find the value for a parameter name` for the absent tenors.
const SENS_TYPES = ["Delta", "Vega", "Curvature"];
const RISK_PROFILE_BUCKETS = {
  GIRR: ["USD", "EUR", "GBP"],
  EQUITY: ["1", "2", "5"],
};

function buildRiskProfiles(schema) {
  const profiles = {};
  for (const rc of Object.keys(RISK_PROFILE_BUCKETS)) {
    const cls = schema.risk_classes[rc];
    if (!cls) continue;
    const tenorNodes = cls.tenor?.nodes ?? [];
    profiles[rc] = {
      buckets: RISK_PROFILE_BUCKETS[rc],
      tenors: tenorNodes.length > 0 ? tenorNodes : null,
      perTenor: tenorNodes.length > 0,
    };
  }
  return profiles;
}

function parseArgs(argv) {
  const out = {
    redis: process.env.REDIS_URL ?? "redis://localhost:6379",
    apiBase: "http://localhost:3000",
    rows: 1000,
    riskClass: "GIRR",
    sens: "Delta",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--redis": out.redis = next; i++; break;
      case "--api-base": out.apiBase = next.replace(/\/+$/, ""); i++; break;
      case "--rows": out.rows = Number(next); i++; break;
      case "--risk-class": out.riskClass = String(next).toUpperCase(); i++; break;
      case "--sens": out.sens = next; i++; break;
      case "-h":
      case "--help":
        process.stdout.write(
          "Usage: node scripts/calc-smoke-1k.mjs [--redis URL] [--api-base URL] " +
          "[--rows N] [--risk-class RC] [--sens TYPE]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!Number.isInteger(out.rows) || out.rows < 1) {
    throw new Error(`--rows must be a positive integer (got ${out.rows})`);
  }
  if (!SENS_TYPES.includes(out.sens)) {
    throw new Error(`--sens must be one of ${SENS_TYPES.join(", ")} (got ${out.sens})`);
  }
  if (!RISK_PROFILE_BUCKETS[out.riskClass]) {
    throw new Error(
      `--risk-class must be one of ${Object.keys(RISK_PROFILE_BUCKETS).join(", ")} (got ${out.riskClass})`,
    );
  }
  return out;
}

// Mirrors services/bulk-loader/src/worker.ts:rowToHashFields for the shapes
// this smoke generates. Kept inline so the script stays a leaf dependency.
function rowToHashFields(row) {
  const args = [];
  for (const k of ["risk_class", "bucket", "sensitivity_type", "book", "trade_id", "risk_factor", "desk"]) {
    const v = row[k];
    if (v !== undefined && v !== null) args.push(k, String(v));
  }
  const lower = String(row.risk_class).toLowerCase();
  const sens = row.sensitivity_type;
  const rv = row.risk_value;
  if (sens === "Curvature") {
    if (rv && typeof rv === "object" && typeof rv.cvr_up === "number" && typeof rv.cvr_down === "number") {
      args.push(`s_${lower}_cvr_up`, String(rv.cvr_up));
      args.push(`s_${lower}_cvr_down`, String(rv.cvr_down));
    } else if (rv && typeof rv === "object" && Array.isArray(rv.cvr_up) && Array.isArray(rv.cvr_down) && Array.isArray(row.tenor)) {
      const n = Math.min(rv.cvr_up.length, rv.cvr_down.length, row.tenor.length);
      for (let i = 0; i < n; i++) {
        args.push(`s_${lower}_cvr_up_${row.tenor[i]}`, String(rv.cvr_up[i]));
        args.push(`s_${lower}_cvr_down_${row.tenor[i]}`, String(rv.cvr_down[i]));
      }
    }
    return args;
  }
  const leg = sens === "Vega" ? "vega" : "delta";
  if (rv && typeof rv === "object" && !Array.isArray(rv)) {
    const keys = Object.keys(rv);
    if (keys.length === 1 && keys[0] === "spot" && typeof rv.spot === "number") {
      args.push(`s_${lower}_${leg}`, String(rv.spot));
    } else {
      for (const k of keys) {
        if (typeof rv[k] === "number") args.push(`s_${lower}_${leg}_${k}`, String(rv[k]));
      }
    }
  }
  return args;
}

// Deterministic-ish per-row sensitivity value. Magnitudes chosen so neither
// the Delta path (weight ~0.01 for GIRR, ~0.5 for EQUITY) nor the Curvature
// path collapses to numerical zero after weighting. `cycleSeq` is the per-
// (rc, sens) row count — using it for bucket selection guarantees every
// combo cycles through every bucket rather than pinning to one (which
// happens when seq advances by len(combos) between same-combo rows).
function makeRow(seq, cycleSeq, rc, profile, sens) {
  const id = randomUUID().replace(/-/g, "").toUpperCase().slice(0, 26);
  const bucket = profile.buckets[cycleSeq % profile.buckets.length];
  const base = {
    id,
    risk_class: rc,
    bucket,
    sensitivity_type: sens,
    book: `BOOK_${(seq % 4) + 1}`,
    trade_id: `T${seq.toString().padStart(6, "0")}`,
    risk_factor: `RF_${(seq % 8) + 1}`,
    desk: `DESK_${(seq % 3) + 1}`,
  };
  const mag = 1000 + ((seq * 37) % 500);
  if (sens === "Curvature") {
    if (profile.perTenor) {
      base.tenor = profile.tenors;
      base.risk_value = {
        cvr_up: profile.tenors.map((_, i) => mag * (i + 1)),
        cvr_down: profile.tenors.map((_, i) => -mag * (i + 1) * 0.6),
      };
    } else {
      base.risk_value = { cvr_up: mag, cvr_down: -mag * 0.6 };
    }
    return base;
  }
  if (profile.perTenor) {
    const rv = {};
    for (let i = 0; i < profile.tenors.length; i++) {
      rv[profile.tenors[i]] = mag * (i + 1) * (seq % 2 === 0 ? 1 : -1);
    }
    base.tenor = profile.tenors;
    base.risk_value = rv;
  } else {
    base.risk_value = { spot: mag * (seq % 2 === 0 ? 1 : -1) };
  }
  return base;
}

// Round-robin over (risk_class, sens_type) so every leg gets coverage on
// every bucket of every class within the row budget.
function* generateRows(total, profiles) {
  const classes = Object.keys(profiles);
  const combos = [];
  for (const rc of classes) for (const sens of SENS_TYPES) combos.push({ rc, sens });
  const cycleCounts = new Array(combos.length).fill(0);
  for (let seq = 0; seq < total; seq++) {
    const ci = seq % combos.length;
    const c = combos[ci];
    yield makeRow(seq, cycleCounts[ci]++, c.rc, profiles[c.rc], c.sens);
  }
}

async function pipelineLoad(client, rows, batchSize = 200) {
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const pipe = client.pipeline();
    for (const row of slice) {
      const fields = rowToHashFields(row);
      if (fields.length === 0) continue;
      pipe.call("HSET", `sens:${row.id}`, ...fields);
    }
    const results = await pipe.exec();
    for (const r of results ?? []) {
      if (r && r[0]) throw new Error(`HSET failed: ${r[0].message}`);
    }
    written += slice.length;
  }
  return written;
}

async function pollIndexCount(client, indexName, expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const reply = await client.call("FT.SEARCH", indexName, "*", "LIMIT", "0", "0");
    const count = Array.isArray(reply) ? Number(reply[0]) : Number(reply);
    if (Number.isFinite(count) && count >= expected) return count;
    last = count;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`FT.SEARCH ${indexName} did not reach ${expected} docs within ${timeoutMs}ms (last=${last})`);
}

function runChild(scriptPath, redisUrl, envOverrides = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, REDIS_URL: redisUrl, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); process.stderr.write(d); });
    child.stderr.on("data", (d) => { stderr += d.toString(); process.stderr.write(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${scriptPath} exited ${code}\n${stderr}`));
      else resolveP({ stdout, stderr });
    });
  });
}

async function httpJson(method, url, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  return { status: res.status, body: parsed };
}

async function callCalcSbm(apiBase, riskClass, sens) {
  return httpJson("POST", `${apiBase}/api/calc/sbm?nocache=1`, {
    risk_class: riskClass,
    sensitivity_type: sens,
  });
}

// Discover the live slim-index name by reading the bootstrap schema-hash key.
// Falls back to IDX_NAME_SLIM (base) when no hash is persisted — that path
// keeps the script working on pre-6.18i targets where the index lives under
// the unversioned name.
async function discoverSlimIndexName(client, targetLabel) {
  try {
    const reply = await client.call("GET", `bootstrap:schema-hash:${targetLabel}`);
    if (typeof reply === "string" && reply.length >= 7 && !reply.startsWith("legacy:")) {
      return `${IDX_NAME_SLIM}:v${reply.slice(0, 7)}`;
    }
  } catch { /* fall back to base */ }
  return IDX_NAME_SLIM;
}

// Returns null when every numeric field is finite; otherwise the first
// offending path so the failure message points operators at the right cell.
function findBadNumber(value, path = "$") {
  if (value === null) return `${path} is null`;
  if (value === undefined) return `${path} is undefined`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${path} is ${value}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = findBadNumber(value[i], `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const bad = findBadNumber(value[k], `${path}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.REDIS_URL = args.redis;

  const schema = loadSchema(SCHEMA_PATH);
  const profiles = buildRiskProfiles(schema);
  if (!profiles[args.riskClass]) {
    throw new Error(`schema has no risk_class '${args.riskClass}' — cannot generate test data`);
  }
  const client = createRedisClient({ commandTimeout: 35_000 });

  let lastResponse = null;
  try {
    process.stderr.write(`[smoke] FLUSHDB on ${args.redis.replace(/:\/\/[^@]+@/, "://***@")}\n`);
    await client.flushdb();

    // Trigger the API's bootstrap path so both the fat (idx:sens) and slim
    // (idx:sens:slim) indexes get rebuilt under whatever versioned names the
    // active target has persisted. Without this the calc precondition probe
    // (FT.INFO idx:sens num_docs) fires before bucket discovery runs and the
    // route 503s with "no-data-or-index" — see services/api/src/routes/calc.ts
    // line 597.
    process.stderr.write(`[smoke] POST ${args.apiBase}/api/admin/flush (FLUSHDB + bootstrap)\n`);
    const flush = await httpJson("POST", `${args.apiBase}/api/admin/flush`);
    if (flush.status !== 200 || !flush.body?.bootstrap?.ok) {
      throw new Error(`admin/flush failed: status=${flush.status} body=${JSON.stringify(flush.body)}`);
    }
    const targetLabel = flush.body.target_label;
    process.stderr.write(`[smoke]   target_label=${targetLabel} bootstrap_ms=${flush.body.ms}\n`);

    // Discover the live slim index name so the finalise scripts and the
    // FT.SEARCH polling target the index that's actually indexing our docs.
    // Bootstrap persists a versioned `idx:sens:slim:v<h>` when ENABLE_SLIM_
    // SENS_INDEX=1 on the api process; otherwise we fall back to the
    // unversioned base name and ensure it exists ourselves.
    let slimIndex = await discoverSlimIndexName(client, targetLabel);
    let slimPresent = true;
    try { await client.call("FT.INFO", slimIndex); } catch { slimPresent = false; }
    if (!slimPresent) {
      process.stderr.write(`[smoke]   ${slimIndex} not present — falling back to ${IDX_NAME_SLIM}\n`);
      slimIndex = IDX_NAME_SLIM;
      await ensureSlimSensIndex(client, schema);
    }
    process.stderr.write(`[smoke] slim index name: ${slimIndex}\n`);

    process.stderr.write(`[smoke] generating + HSET-loading ${args.rows} rows\n`);
    const rows = Array.from(generateRows(args.rows, profiles));
    const tLoad = Date.now();
    const written = await pipelineLoad(client, rows);
    process.stderr.write(`[smoke]   loaded ${written} rows in ${Date.now() - tLoad}ms\n`);

    process.stderr.write(`[smoke] polling FT.SEARCH ${slimIndex} for indexing to settle\n`);
    const indexed = await pollIndexCount(client, slimIndex, args.rows);
    process.stderr.write(`[smoke]   indexed ${indexed}\n`);

    process.stderr.write(`[smoke] running scripts/finalise-rollups.mjs (INDEX_NAME=${slimIndex})\n`);
    await runChild(join(REPO_ROOT, "scripts/finalise-rollups.mjs"), args.redis, { INDEX_NAME: slimIndex });

    process.stderr.write(`[smoke] running scripts/finalise-seen-sets.mjs (INDEX_NAME=${slimIndex})\n`);
    await runChild(join(REPO_ROOT, "scripts/finalise-seen-sets.mjs"), args.redis, { INDEX_NAME: slimIndex });

    // Audit counts for the completion report.
    const seenRcMembers = await client.smembers("seen:risk_class");
    const seenBucketSizes = {};
    for (const rc of seenRcMembers) {
      seenBucketSizes[rc] = await client.scard(`seen:bucket:${rc}`);
    }
    const rollupKeys = [];
    let cursor = "0";
    do {
      const [next, batch] = await client.scan(cursor, "MATCH", "rollup:*", "COUNT", "500");
      cursor = next;
      rollupKeys.push(...batch);
    } while (cursor !== "0");
    process.stderr.write(
      `[smoke] seen:risk_class=${seenRcMembers.length} ` +
      `seen:bucket=${JSON.stringify(seenBucketSizes)} ` +
      `rollups=${rollupKeys.length}\n`,
    );

    process.stderr.write(`[smoke] POST ${args.apiBase}/api/calc/sbm risk_class=${args.riskClass} sens=${args.sens}\n`);
    const resp = await callCalcSbm(args.apiBase, args.riskClass, args.sens);
    lastResponse = resp;
    assert(resp.status === 200, `expected HTTP 200, got ${resp.status}`);

    const body = resp.body;
    assert(Array.isArray(body.per_bucket), `response.per_bucket is not an array`);
    assert(body.per_bucket.length > 0, `response.per_bucket is empty`);

    const bad = findBadNumber(body.per_bucket, "per_bucket")
      ?? (typeof body.charge === "number" && Number.isFinite(body.charge) ? null : `charge=${body.charge}`);
    assert(!bad, `non-finite value found: ${bad}`);

    const anyPositive = body.per_bucket.some((b) => Number(b?.K_b) > 0);
    assert(anyPositive, `no bucket has K_b > 0 (per_bucket=${JSON.stringify(body.per_bucket).slice(0, 400)})`);
    assert(Number.isFinite(body.charge) && body.charge > 0, `total charge not > 0 (got ${body.charge})`);

    const firstBucket = body.per_bucket[0];
    process.stderr.write(
      `[smoke] first per_bucket entry: ${JSON.stringify(firstBucket).slice(0, 500)}\n`,
    );

    const buckets = body.per_bucket.map((b) => b.bucket).filter(Boolean);
    process.stdout.write(
      `smoke OK · risk_class=${args.riskClass} · sens=${args.sens} · ` +
      `buckets=${buckets.length} · total_charge=${body.charge.toFixed(4)}\n`,
    );
  } catch (err) {
    process.stderr.write(`[smoke] FAIL: ${err && err.message ? err.message : String(err)}\n`);
    if (lastResponse) {
      process.stderr.write(`[smoke] response status=${lastResponse.status}\n`);
      process.stderr.write(`[smoke] response body=${JSON.stringify(lastResponse.body, null, 2)}\n`);
    }
    process.exitCode = 1;
  } finally {
    await client.quit().catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke] FATAL: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});

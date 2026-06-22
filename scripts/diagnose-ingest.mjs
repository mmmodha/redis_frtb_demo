#!/usr/bin/env node
// scripts/diagnose-ingest.mjs — Wave 7.0.6.8
//
// Operator-side ingest throughput profiler. Answers "which bottleneck?"
// given a slow ~1k rows/s local ingest run: stream path vs bulk-loader,
// indexer-bound vs HSET-bound, single-shard vs misconfigured pool.
//
// Pre-flight (default, no writes):
//   - INFO server/clients, CLUSTER INFO, DBSIZE
//   - FT.INFO idx:sens:slim or idx:sens
//   - HTTP probe of bulk-loader (:8086) and api (:3000)
//
// Probe (--probe; FLUSHDB between windows):
//   A. Stream path  : POST /api/generator/start (if api up) for 30s
//   B. Bulk-loader  : POST /load/rows  (batchSize=500, concurrency=64) for 30s
//   Then FLUSHDB cleanup.
//
// Output is human-readable text on stdout. Designed for an interactive run.
// Secrets policy: REDIS_URL / password are never echoed.

import { createRedisClient } from "@frtb/redis-client";
import { ulid } from "ulid";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";

const DEFAULTS = {
  windowSec: 30,
  batchSize: 500,
  concurrency: 64,
  apiBase: "http://localhost:3000",
  bulkBase: "http://localhost:8086",
  probeTimeoutMs: 500,
};

function helpText() {
  return [
    "Usage: node scripts/diagnose-ingest.mjs [flags]",
    "",
    "  --redis URL              Redis URL (overrides REDIS_URL env)",
    "  --probe                  Opt in to the 60s controlled write probe",
    "  --yes                    Skip the confirmation prompt for --probe",
    "  --api-base URL           api base (default http://localhost:3000)",
    "  --bulk-loader-base URL   bulk-loader base (default http://localhost:8086)",
    "  --window-sec N           per-window seconds (default 30)",
    "  --batch-size N           bulk-loader batch (default 500)",
    "  --concurrency N          bulk-loader concurrency (default 64)",
    "  --help, -h               this help",
    "",
    "Default invocation runs PRE-FLIGHT ONLY — no DB mutation.",
    "--probe FLUSHDBs the target; intended for a clean-state operator run.",
  ].join("\n");
}

export function parseArgs(argv) {
  const args = {
    redis: null,
    probe: false,
    yes: false,
    apiBase: DEFAULTS.apiBase,
    bulkBase: DEFAULTS.bulkBase,
    windowSec: DEFAULTS.windowSec,
    batchSize: DEFAULTS.batchSize,
    concurrency: DEFAULTS.concurrency,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--redis") args.redis = next();
    else if (a === "--probe") args.probe = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--api-base") args.apiBase = next();
    else if (a === "--bulk-loader-base") args.bulkBase = next();
    else if (a === "--window-sec") args.windowSec = Number(next());
    else if (a === "--batch-size") args.batchSize = Number(next());
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a?.startsWith("--")) throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

// Parse a redis INFO blob (key:value\r\n lines, # comments).
function parseInfo(blob) {
  const out = {};
  for (const raw of String(blob ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const ix = line.indexOf(":");
    if (ix <= 0) continue;
    out[line.slice(0, ix)] = line.slice(ix + 1);
  }
  return out;
}

// Extract Δ HSET calls from `INFO commandstats`. Returns 0 if cmdstat_hset
// missing (e.g. cmdstats reset). Other writers (HMSET, HSETNX) are not
// counted — the bulk-loader pipeline uses HSET exclusively per worker.ts.
function hsetCallsFromInfo(blob) {
  const m = String(blob ?? "").match(/cmdstat_hset:calls=(\d+)/);
  return m ? Number(m[1]) : 0;
}

// FT.INFO returns a flat [k, v, k, v, ...] array. Surface the fields the
// task spec calls for; coerce numerics where the server returns strings.
function ftInfoToObject(arr) {
  if (!Array.isArray(arr)) return null;
  const o = {};
  for (let i = 0; i < arr.length - 1; i += 2) o[String(arr[i])] = arr[i + 1];
  const num = (k) => (o[k] != null ? Number(o[k]) : undefined);
  // attributes is a nested array; we only need its length for num_fields.
  const numFields = Array.isArray(o.attributes) ? o.attributes.length : num("num_fields");
  return {
    index_name: o.index_name,
    indexing: num("indexing"),
    num_docs: num("num_docs"),
    num_records: num("num_records"),
    total_indexing_time: num("total_indexing_time"),
    hash_indexing_failures: num("hash_indexing_failures"),
    num_fields: numFields,
  };
}

async function tryFtInfo(redis, name) {
  try {
    const raw = await redis.call("FT.INFO", name);
    return ftInfoToObject(raw);
  } catch {
    return null;
  }
}

async function httpProbe(url, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { up: true, status: res.status };
  } catch (err) {
    return { up: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(to);
  }
}


async function preflight({ redis, apiBase, bulkBase, probeTimeoutMs }) {
  const [serverInfoRaw, clientsInfoRaw, clusterInfoRaw, dbsize] = await Promise.all([
    redis.call("INFO", "server"),
    redis.call("INFO", "clients"),
    redis.call("CLUSTER", "INFO").catch(() => ""),
    redis.call("DBSIZE"),
  ]);
  const server = parseInfo(serverInfoRaw);
  const clients = parseInfo(clientsInfoRaw);
  const cluster = parseInfo(clusterInfoRaw);

  const [idxSlim, idxLegacy] = await Promise.all([
    tryFtInfo(redis, "idx:sens:slim"),
    tryFtInfo(redis, "idx:sens"),
  ]);
  const activeIndex = idxSlim ?? idxLegacy;

  const [bulkStatus, apiStatus] = await Promise.all([
    httpProbe(`${bulkBase.replace(/\/$/, "")}/load/status`, probeTimeoutMs),
    httpProbe(`${apiBase.replace(/\/$/, "")}/observability/keys?prefix=sens:`, probeTimeoutMs),
  ]);

  let mode;
  if (bulkStatus.up && apiStatus.up) mode = "bulk-loader";
  else if (!bulkStatus.up && apiStatus.up) mode = "stream-only";
  else mode = "unknown";

  return {
    redisVersion: server.redis_version ?? "unknown",
    role: server.role ?? "unknown",
    connectedClients: Number(clients.connected_clients ?? 0),
    clusterEnabled: cluster.cluster_enabled === "1",
    clusterKnownNodes: Number(cluster.cluster_known_nodes ?? 0),
    dbsize: Number(dbsize ?? 0),
    activeIndex,
    bulk: bulkStatus,
    api: apiStatus,
    mode,
  };
}

function printPreflight(pf) {
  const shardLabel = pf.clusterEnabled && pf.clusterKnownNodes > 1
    ? `clustered (${pf.clusterKnownNodes} nodes)`
    : "single-shard";
  const idxLine = pf.activeIndex
    ? `${pf.activeIndex.index_name} (num_docs=${pf.activeIndex.num_docs}, num_fields=${pf.activeIndex.num_fields}, indexing=${pf.activeIndex.indexing}, failures=${pf.activeIndex.hash_indexing_failures}, total_indexing_time=${pf.activeIndex.total_indexing_time})`
    : "NONE (neither idx:sens:slim nor idx:sens responded)";
  console.log("=== PRE-FLIGHT ===");
  console.log(`  redis           = ${pf.redisVersion}, ${pf.role}, ${shardLabel}`);
  console.log(`  connected_clients = ${pf.connectedClients}`);
  console.log(`  DBSIZE          = ${pf.dbsize}`);
  console.log(`  bulk-loader     = ${pf.bulk.up ? `up (${pf.bulk.status})` : `down (${pf.bulk.error ?? "no response"})`}`);
  console.log(`  api             = ${pf.api.up ? `up (${pf.api.status})` : `down (${pf.api.error ?? "no response"})`}`);
  console.log(`  active index    = ${idxLine}`);
  console.log(`  MODE            = ${pf.mode}`);
}

async function promptYes(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Sample {num_docs, hsetCalls, connectedClients, indexing} at a single
// point in time. Returns null on failure so the caller can fall back.
async function sample(redis, indexName) {
  const [ft, cmdstats, clientsRaw] = await Promise.all([
    tryFtInfo(redis, indexName),
    redis.call("INFO", "commandstats").catch(() => ""),
    redis.call("INFO", "clients").catch(() => ""),
  ]);
  return {
    t: Date.now(),
    numDocs: ft?.num_docs ?? 0,
    indexing: ft?.indexing ?? 0,
    hsetCalls: hsetCallsFromInfo(cmdstats),
    connectedClients: Number(parseInfo(clientsRaw).connected_clients ?? 0),
  };
}

// Builds a minimal slim-shape row matching services/bulk-loader/src/worker.ts
// Row interface — id + TAG fields + Delta scalar risk_value (so rowToHashFields
// produces a non-empty arglist).
function buildRow() {
  const id = ulid();
  return {
    id,
    risk_class: "GIRR",
    bucket: "USD",
    sensitivity_type: "Delta",
    book: "DESK_A",
    trade_id: `T${id.slice(-10)}`,
    risk_factor: `RF${id.slice(-6)}`,
    desk: "DESK_A",
    risk_value: 1.5,
  };
}


// Compute deltas between start/mid/end samples for the summary line.
function windowMetrics(s0, sMid, sEnd) {
  const elapsedSec = Math.max(0.001, (sEnd.t - s0.t) / 1000);
  const rowsPerSecIndex = (sEnd.numDocs - s0.numDocs) / elapsedSec;
  const rowsPerSecHset = (sEnd.hsetCalls - s0.hsetCalls) / elapsedSec;
  const indexLag = rowsPerSecHset - rowsPerSecIndex;
  return {
    elapsedSec,
    rowsPerSecIndex,
    rowsPerSecHset,
    indexLag,
    clientsMid: sMid.connectedClients,
    indexingAtEnd: sEnd.indexingAtEnd ?? sEnd.indexing,
    indexing: sEnd.indexing,
  };
}

// Window A — drive 30s via /api/generator/start (stream → ingest path).
// The endpoint is synchronous: it returns when stop_when trips, so the
// sample loop runs in parallel.
async function runStreamWindow({ redis, apiBase, windowSec, indexName }) {
  const url = `${apiBase.replace(/\/$/, "")}/api/generator/start`;
  const body = {
    rows: 10_000_000, // ceiling — elapsed_seconds is the real stop
    classes: ["GIRR"],
    sensitivity_types: ["Delta"],
    stop_when: { elapsed_seconds: windowSec },
  };
  const s0 = await sample(redis, indexName);
  const driverPromise = fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.text()).catch((e) => `driver error: ${e?.message ?? e}`);

  await delay((windowSec / 2) * 1000);
  const sMid = await sample(redis, indexName);
  await delay((windowSec / 2) * 1000);
  const sEnd = await sample(redis, indexName);
  const driverResponse = await driverPromise;
  return { ...windowMetrics(s0, sMid, sEnd), driverResponse };
}

// Window B — drive 30s via /load/rows (bulk-loader). Spawns `concurrency`
// in-flight POSTs at a time, each carrying `batchSize` rows. Each batch is
// a JSON array. Stops when the wall clock reaches windowSec.
async function runBulkLoaderWindow({ redis, bulkBase, windowSec, batchSize, concurrency, indexName }) {
  const url = `${bulkBase.replace(/\/$/, "")}/load/rows`;
  const deadline = Date.now() + windowSec * 1000;
  let posted = 0;
  let errors = 0;
  const s0 = await sample(redis, indexName);
  let sMid;
  const midDeadline = Date.now() + (windowSec / 2) * 1000;

  const oneBatch = async () => {
    while (Date.now() < deadline) {
      const rows = Array.from({ length: batchSize }, buildRow);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rows),
        });
        if (r.status >= 400) {
          errors++;
          // Back off briefly on 429/503 so the bulk-loader can drain.
          if (r.status === 429 || r.status === 503) await delay(25);
        } else {
          posted += rows.length;
        }
      } catch {
        errors++;
        await delay(25);
      }
      if (!sMid && Date.now() >= midDeadline) {
        // First worker past the mid-point captures the mid sample.
        sMid = await sample(redis, indexName).catch(() => null);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, oneBatch));
  if (!sMid) sMid = await sample(redis, indexName);
  const sEnd = await sample(redis, indexName);
  return { ...windowMetrics(s0, sMid, sEnd), posted, errors };
}

// Diagnosis heuristics per the task spec. Returns { bottleneck, fix }.
function diagnose({ pf, streamMetrics, bulkMetrics }) {
  const m = bulkMetrics ?? streamMetrics;
  if (!m) {
    return {
      bottleneck: "UNKNOWN",
      fix: "no probe ran; rerun with --probe --yes after starting the relevant ingest service",
    };
  }
  const hset = m.rowsPerSecHset;
  const idx = m.rowsPerSecIndex;
  const lag = m.indexLag;

  // INDEXER: writes outpacing the index by >50%.
  if (hset > 0 && lag > 0.5 * hset) {
    return {
      bottleneck: "INDEXER",
      fix: "RediSearch can't keep up — reduce SORTABLE fields or add shards",
    };
  }
  if (hset < 3000 && m.clientsMid <= 4) {
    return {
      bottleneck: "STREAM-CONSUMER",
      fix: "only one ingest consumer is reading the stream — scale ingest replicas or increase XREADGROUP concurrency",
    };
  }
  if (hset < 3000 && m.clientsMid >= 16) {
    return {
      bottleneck: "CONNECTION-POOL or SINGLE-SHARD",
      fix: "pool is full but throughput is flat — likely proxy pinning to one shard; check cluster topology",
    };
  }
  if (!bulkMetrics && streamMetrics) {
    return {
      bottleneck: "STREAM-PATH",
      fix: "you are on the stream path; start bulk-loader and re-run for direct HSET ingest",
    };
  }
  if (bulkMetrics && streamMetrics) {
    const ratio = streamMetrics.rowsPerSecIndex > 0
      ? bulkMetrics.rowsPerSecIndex / streamMetrics.rowsPerSecIndex
      : Infinity;
    if (ratio < 3) {
      return {
        bottleneck: "SINGLE-SHARD",
        fix: "bulk-loader is not >=3x faster than stream — no parallelism to gain locally; provision a clustered Redis target",
      };
    }
  }
  if (pf.clusterKnownNodes <= 1 && bulkMetrics && bulkMetrics.rowsPerSecHset < 10_000) {
    return {
      bottleneck: "SINGLE-SHARD",
      fix: "local single-shard Redis caps you regardless of pool size — provision a clustered target for higher throughput",
    };
  }
  return { bottleneck: "NONE-DETECTED", fix: "throughput looks healthy; investigate downstream consumers if calc is still slow" };
}


function formatRate(n) {
  if (!Number.isFinite(n)) return "0";
  return `${Math.round(n).toLocaleString("en-US")}`;
}

function printSummary({ pf, streamMetrics, bulkMetrics, dx, probeRan, state }) {
  console.log("");
  console.log("=== DIAGNOSTIC SUMMARY ===");
  const shardLabel = pf.clusterEnabled && pf.clusterKnownNodes > 1
    ? `clustered (${pf.clusterKnownNodes} nodes)`
    : "single-shard";
  const idxLabel = pf.activeIndex
    ? `${pf.activeIndex.index_name} (${pf.activeIndex.num_fields} fields)`
    : "NONE";
  console.log("Pre-flight:");
  console.log(`  redis           = ${pf.redisVersion}, ${shardLabel}`);
  console.log(`  bulk-loader     = ${pf.bulk.up ? "up" : "down"}`);
  console.log(`  api             = ${pf.api.up ? "up" : "down"}`);
  console.log(`  active index    = ${idxLabel}`);

  if (probeRan) {
    console.log("");
    console.log("Probe:");
    if (streamMetrics) {
      console.log(`  STREAM PATH     : ${formatRate(streamMetrics.rowsPerSecIndex)} rows/s index, ${formatRate(streamMetrics.rowsPerSecHset)} rows/s HSET, lag ${formatRate(streamMetrics.indexLag)}, clients ${streamMetrics.clientsMid}, indexing=${streamMetrics.indexing}`);
    } else {
      console.log("  STREAM PATH     : skipped (api not reachable)");
    }
    if (bulkMetrics) {
      console.log(`  BULK-LOADER     : ${formatRate(bulkMetrics.rowsPerSecIndex)} rows/s index, ${formatRate(bulkMetrics.rowsPerSecHset)} rows/s HSET, lag ${formatRate(bulkMetrics.indexLag)}, clients ${bulkMetrics.clientsMid}, indexing=${bulkMetrics.indexing}, posted=${bulkMetrics.posted}, errors=${bulkMetrics.errors}`);
    } else {
      console.log("  BULK-LOADER     : skipped (bulk-loader not reachable)");
    }
  }

  console.log("");
  console.log("Diagnosis:");
  console.log(`  bottleneck      = ${dx.bottleneck}`);
  console.log(`  recommended fix = ${dx.fix}`);
  console.log("");
  console.log(`DB state at exit  = ${state}`);
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`ERROR: ${e.message}\n${helpText()}`); process.exit(2); }
  if (args.help) { console.log(helpText()); process.exit(0); }

  const url = args.redis ?? process.env.REDIS_URL;
  if (!url) {
    console.error("ERROR: --redis URL or REDIS_URL env is required");
    process.exit(2);
  }

  const redis = createRedisClient({
    url,
    cluster: false,
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    commandTimeout: 10_000,
  });

  // Crash-safe state tracking: prints what we did before exit on any
  // signal/error path. Updated in-place as the probe progresses.
  let state = "untouched";
  const onExit = () => {
    console.error(`\n[diagnose-ingest] interrupted — DB state at exit: ${state}`);
  };
  process.on("SIGINT", () => { onExit(); process.exit(130); });
  process.on("SIGTERM", () => { onExit(); process.exit(143); });

  try {
    const pf = await preflight({
      redis,
      apiBase: args.apiBase,
      bulkBase: args.bulkBase,
      probeTimeoutMs: DEFAULTS.probeTimeoutMs,
    });
    printPreflight(pf);

    let streamMetrics = null;
    let bulkMetrics = null;
    let probeRan = false;

    if (args.probe) {
      if (!args.yes) {
        const ok = await promptYes(
          `\n--probe will FLUSHDB the target at ${url.replace(/\/\/[^@]+@/, "//<redacted>@")}. Continue? [y/N] `,
        );
        if (!ok) {
          console.log("aborted (no FLUSHDB executed)");
          await redis.quit().catch(() => undefined);
          process.exit(0);
        }
      }
      const indexName = pf.activeIndex?.index_name ?? "idx:sens:slim";

      console.log("\n>>> FLUSHDB before stream window");
      await redis.call("FLUSHDB");
      state = "flushed";

      if (pf.api.up) {
        console.log(`>>> Window A — stream path (${args.windowSec}s)`);
        try {
          streamMetrics = await runStreamWindow({
            redis, apiBase: args.apiBase, windowSec: args.windowSec, indexName,
          });
        } catch (err) {
          console.error(`stream window failed: ${err?.message ?? err}`);
        }
        state = "stream-half-loaded";
      } else {
        console.log(">>> Window A skipped: stream probe skipped — api not reachable");
      }

      console.log(">>> FLUSHDB between windows");
      await redis.call("FLUSHDB");
      state = "flushed";

      if (pf.bulk.up) {
        console.log(`>>> Window B — bulk-loader (${args.windowSec}s, batch=${args.batchSize}, concurrency=${args.concurrency})`);
        try {
          bulkMetrics = await runBulkLoaderWindow({
            redis, bulkBase: args.bulkBase, windowSec: args.windowSec,
            batchSize: args.batchSize, concurrency: args.concurrency,
            indexName,
          });
        } catch (err) {
          console.error(`bulk-loader window failed: ${err?.message ?? err}`);
        }
        state = "bulk-half-loaded";
      } else {
        console.log(">>> Window B skipped: bulk-loader not reachable");
      }

      console.log(">>> FLUSHDB cleanup");
      await redis.call("FLUSHDB");
      state = "flushed (cleanup complete)";
      probeRan = true;
    }

    const dx = diagnose({ pf, streamMetrics, bulkMetrics });
    printSummary({ pf, streamMetrics, bulkMetrics, dx, probeRan, state });
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
    return import.meta.url === argv1;
  } catch { return false; }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`FATAL: ${err?.message ?? err}`);
    process.exit(1);
  });
}

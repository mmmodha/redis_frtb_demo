#!/usr/bin/env node
import { Command } from "commander";
import { Redis, Cluster } from "ioredis";
import { createRedisClient, resolveRedisTarget } from "@frtb/redis-client";
import pino from "pino";
import { loadSchema } from "@frtb/schema";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRowGenerator } from "./row-generator.js";
import { createStreamProducer, type StreamProducer } from "./producer.js";
import { pickRiskClasses } from "./mix.js";
import { runGenerationInline } from "./coordinator.js";
import type { WorkerInitData, WorkerMessage } from "./worker.js";
// Wave 6.39.A — direct-write backend + env parsers.
import { createDirectWriter, type StorageFormat } from "./direct-writer.js";
import {
  loadDirectWriterHooks,
  resolveStorageFormatEnv,
  resolveGeneratorMode,
  resolveDistribution,
  resolveBulkLoadTarget,
  resolvePositiveIntEnv,
  type GeneratorMode,
} from "./direct-writer-bind.js";
// Wave 7.0.1.C — bulk-loader HTTP producer (`BULK_LOAD_TARGET=1` swaps it
// in). Imported eagerly so the dynamic-import latency doesn't show up on
// the hot path; the constructor is still gated on the env flag below.
import { createHttpProducer } from "./http-producer.js";
import { probeCluster, fallbackShape, BYTES_PER_ROW, type ClusterShape } from "./probe.js";
import {
  pickProfile,
  resolveDials,
  refuseOrGo,
  estimateDurationSec,
  type ProfileName,
  type ResolvedDials,
} from "./profile.js";
import {
  createStreamRouter,
  parseStreamShardsFlag,
  type StreamShardsConfig,
} from "@frtb/stream-router";
import { createStreamFlowControl } from "./flow-control.js";

// Wave 5.92C — default approximate MAXLEN per stream (~2 GB at ~1 KB/entry).
// Tune per cluster via --stream-maxlen / STREAM_MAXLEN env. Pass 0 to disable.
const DEFAULT_STREAM_MAXLEN = 2_000_000;

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// Wave 5.84B — connection-budget cap. Each worker owns its own ioredis
// client; for Redis Cluster ioredis additionally pools one connection per
// shard. Coordinator caps `--workers` at `(maxclients - HEADROOM) /
// (pipelinesPerWorker × shards)`. Headroom keeps room for the api connection,
// monitoring tools, and the coordinator's own probe client. Formula is
// surfaced in --workers help text + log-warned when the cap kicks in.
const MAX_WORKERS_HARD_CAP = 32;
const MAXCLIENTS_HEADROOM = 10;

interface CliOptions {
  rows: string;
  rate?: string;
  classes: string;
  seed?: string;
  schemaFile?: string;
  redisUrl?: string;
  stream: string;
  batchSize: string;
  // Wave 5.84A — bounded pipeline-window concurrency (1..8). Default 1 is
  // bit-identical to pre-5.84A single-in-flight behaviour.
  pipelineWindow: string;
  // Wave 5.84B — worker_threads shard-out. Default 1 is bit-identical to
  // pre-5.84B (skips the worker spawn entirely; runs the inline coordinator).
  workers: string;
  // Wave 5.84C — cluster-adaptive profile. `auto` probes the target and
  // picks small/medium/large based on shard count + host CPUs. Explicit
  // small/medium/large overrides autodetect; manual --workers /
  // --batch-size / --pipeline-window override the profile's dial values
  // (manual always wins — DoD #4).
  profile: string;
  // Wave 5.92A — hash-tag stream-shard fan-out. Positive integer (modulo-N
  // routing) or the literal "per-bucket" (one stream per hash-tag). Default
  // 1 keeps the pre-5.92 single-stream code path bit-identical. Manual
  // wins over the profile-resolved dial (DoD #4).
  streamShards?: string;
  // Wave 5.92C — approximate MAXLEN cap appended as `MAXLEN ~ N` on every
  // XADD. Default 2_000_000 (~2 GB at ~1 KB/entry). `0` disables the cap.
  streamMaxlen?: string;
  // Wave 5.96G-gen — CSV of sensitivity types to emit. Accepts Delta, Vega,
  // Curvature (case-insensitive). Wave 5.96J flipped the CLI default to
  // ["Delta","Vega","Curvature"] so any default operator regen populates all 9
  // Total SBM grid cells; the row-generator library default remains Delta+Vega.
  sensitivityTypes?: string;
  dryRun?: boolean;
  force?: boolean;
}

// Wave 5.84C — accepted --profile values.
const PROFILE_NAMES = new Set<string>(["auto", "small", "medium", "large"]);

// Wave 5.96G-gen — canonical sensitivity-type names. The row-generator's
// DEFAULT_SENSITIVITY_TYPES is ["Delta","Vega"]; Curvature is opt-in (shape A
// per docs/demo/curvature-scope.md §3a).
const VALID_SENSITIVITY_TYPES = ["Delta", "Vega", "Curvature"] as const;

// Wave 5.96G-gen — parse `--sensitivity-types Delta,vega,CURVATURE` into the
// canonical-cased array `["Delta","Vega","Curvature"]`. Case-insensitive
// accept, canonical-cased storage. Rejects empty tokens and any value outside
// the three valid names. Wave 5.96J — when the flag is omitted, returns all
// three types so a default regen fills every Total SBM grid cell.
function parseSensitivityTypes(csv: string | undefined): readonly string[] {
  if (csv === undefined) return ["Delta", "Vega", "Curvature"];
  const tokens = csv.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (tokens.length === 0) {
    throw new Error(`--sensitivity-types must list at least one of: ${VALID_SENSITIVITY_TYPES.join(", ")}`);
  }
  const canonical: string[] = [];
  for (const tok of tokens) {
    const match = VALID_SENSITIVITY_TYPES.find((v) => v.toLowerCase() === tok.toLowerCase());
    if (!match) {
      throw new Error(
        `--sensitivity-types: invalid value "${tok}". Allowed: ${VALID_SENSITIVITY_TYPES.join(", ")}`,
      );
    }
    if (!canonical.includes(match)) canonical.push(match);
  }
  return canonical;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("generator")
    .description("Synthetic FRTB-SA sensitivity generator → Redis Stream")
    .option("--rows <n>", "total rows to produce", "2000000")
    .option("--rate <n>", "max rows/sec (omit for unbounded)")
    .option("--classes <list>", "comma list or 'all'", "all")
    .option("--seed <s>", "PRNG seed", "0")
    .option("--schema-file <path>", "schema YAML override (else SCHEMA_FILE env)")
    .option("--redis-url <url>", "redis target URL override (else REDIS_URL env)")
    .option("--stream <key>", "target stream key", process.env.STREAM_KEY ?? "sensitivities:in")
    .option("--batch-size <n>", "XADD batch / pipeline size", "1000")
    .option("--pipeline-window <n>", "max pipeline.exec() calls in flight (1..8, default 1)", "1")
    .option(
      "--workers <n>",
      `worker_threads to shard the row loop across (1..${MAX_WORKERS_HARD_CAP}, default 1 = bit-identical to pre-5.84B)`,
      "1",
    )
    .option(
      "--profile <name>",
      "cluster-adaptive profile (auto|small|medium|large, default auto) — auto probes the target and picks dials based on shard count",
      "auto",
    )
    .option(
      "--stream-shards <n>",
      "hash-tag stream-shard fan-out: positive integer or \"per-bucket\" (default 1 = bit-identical to pre-5.92)",
    )
    .option(
      "--stream-maxlen <n>",
      `approximate MAXLEN cap per stream (XADD ... MAXLEN ~ N). 0 disables. Default ${DEFAULT_STREAM_MAXLEN} (or STREAM_MAXLEN env)`,
    )
    .option(
      "--sensitivity-types <csv>",
      `comma list of sensitivity types to emit (case-insensitive). Allowed: ${VALID_SENSITIVITY_TYPES.join(", ")}. Default: Delta,Vega,Curvature`,
    )
    .option("--dry-run", "probe target, print plan, exit 0 without writing any rows")
    .option("--force", "bypass the memory-cap refuse-or-go gate");

  program.parse(process.argv);
  const opts = program.opts<CliOptions>();

  const schemaPath = opts.schemaFile ?? process.env.SCHEMA_FILE;
  if (!schemaPath) {
    throw new Error("schema file path missing: pass --schema-file or set SCHEMA_FILE");
  }
  // Wave 6.39.F — one-shot tools resolve their Redis target from the api's
  // live active-target (matching long-running services), with REDIS_URL only
  // a bootstrap fallback. Precedence: --redis-url > active-target > REDIS_URL.
  // The resolver logs which tier won (host/port only — never the URL).
  const resolved = await resolveRedisTarget({
    explicitUrl: opts.redisUrl,
    apiBase: process.env.API_URL ?? process.env.API_BASE,
    token: process.env.INTERNAL_API_TOKEN,
    envRedisUrl: process.env.REDIS_URL,
    logger: log,
  });
  const redisUrl = resolved.url;
  if (!PROFILE_NAMES.has(opts.profile)) {
    throw new Error(`--profile must be one of auto|small|medium|large (got: ${opts.profile})`);
  }
  // Wave 5.96G-gen — resolve sensitivity types before any Redis connection so
  // an invalid flag fails fast (DoD #3).
  const sensitivityTypes = parseSensitivityTypes(opts.sensitivityTypes);

  const schema = loadSchema(schemaPath);
  const classes = pickRiskClasses(schema, opts.classes);
  const totalRows = Number(opts.rows);
  const rate = opts.rate ? Number(opts.rate) : undefined;
  const baseSeed = opts.seed ?? "0";

  // Wave 5.84C — probe the target once, resolve the profile + dials, and
  // print the plan. Manual --workers/--batch-size/--pipeline-window flags
  // override the profile's dials (manual always wins). Probe failure falls
  // back to a conservative `small` profile with a warn log (DoD #7).
  const workersExplicit = program.getOptionValueSource("workers") === "cli";
  const batchExplicit = program.getOptionValueSource("batchSize") === "cli";
  const pipelineExplicit = program.getOptionValueSource("pipelineWindow") === "cli";
  const streamShardsExplicit = opts.streamShards !== undefined;
  const hostCores = Math.max(1, availableParallelism());
  const shape = await probeForCli(redisUrl);
  const profileName: ProfileName = opts.profile === "auto" ? pickProfile(shape) : (opts.profile as ProfileName);
  const dials = resolveDials(profileName, shape, hostCores, {
    workers: workersExplicit ? Math.max(1, Math.min(MAX_WORKERS_HARD_CAP, Math.floor(Number(opts.workers)))) : undefined,
    batchSize: batchExplicit ? Number(opts.batchSize) : undefined,
    pipelineWindow: pipelineExplicit ? Number(opts.pipelineWindow) : undefined,
    // Wave 5.92A — parse the optional --stream-shards flag (positive int or
    // "per-bucket"). Throws on garbage so misconfig surfaces at boot rather
    // than silently routing everything to one stream.
    streamShards: streamShardsExplicit ? parseStreamShardsFlag(opts.streamShards) : undefined,
  });
  // Clamp profile-resolved workers to the hard cap; manual values already
  // clamped above so the explicit operator choice is preserved end-to-end.
  const requestedWorkers = Math.max(1, Math.min(MAX_WORKERS_HARD_CAP, dials.workers));
  const batchSize = dials.batchSize;
  const pipelineWindow = dials.pipelineWindow;
  const streamShards: StreamShardsConfig = dials.streamShards;
  // Wave 5.92C — resolve approximate MAXLEN cap: --stream-maxlen > STREAM_MAXLEN
  // env > default 2_000_000. `0` opts out (no MAXLEN args on XADD). Threaded
  // through every producer (inline + worker) so the holding shards are
  // protected from OOM if consumers fall behind.
  const streamMaxLen = resolveStreamMaxLen(opts.streamMaxlen);
  const gate = refuseOrGo(shape, totalRows);
  printPlan({ shape, dials, hostCores, rows: totalRows, profileRequested: opts.profile, gate });

  if (!gate.allowed && !opts.force) {
    log.error(
      { estimatedBytes: gate.estimatedBytes, maxmemoryBytes: gate.maxmemoryBytes, thresholdBytes: gate.thresholdBytes },
      `refusing: estimated ${formatBytes(gate.estimatedBytes)} > 50% of cluster maxmemory ` +
      `(${formatBytes(gate.maxmemoryBytes)}). Re-run with --force to bypass.`,
    );
    process.exit(2);
  }
  if (opts.dryRun) {
    log.info({}, "dry-run: plan printed, no rows produced");
    return;
  }

  // Wave 6.39.A — read backend / distribution / storage-format from env so
  // the existing CLI surface (--rows, --workers, etc.) stays untouched.
  // Defaults: GENERATOR_MODE=stream (unchanged), DISTRIBUTION=undefined
  // (legacy schema-aware draw), STORAGE_FORMAT=hash-sidetable.
  const mode: GeneratorMode = resolveGeneratorMode(process.env.GENERATOR_MODE);
  const distribution = resolveDistribution(process.env.DISTRIBUTION);
  const storageFormat: StorageFormat = mode === "direct"
    ? await resolveStorageFormatEnv(process.env.STORAGE_FORMAT)
    : "hash-sidetable";
  // Wave 7.0.1.C — bulk-loader HTTP target. When BULK_LOAD_TARGET resolves
  // to an enabled URL, the generator swaps the XADD producer for the HTTP
  // producer (POST /load/rows). Default off keeps the pre-wave XADD path
  // bit-identical. Mutually exclusive with GENERATOR_MODE=direct (direct
  // writes to Redis from the generator process; the HTTP path delegates to
  // the bulk-loader service) — we error fast rather than silently picking.
  const bulkLoadTarget = resolveBulkLoadTarget(process.env.BULK_LOAD_TARGET);
  if (bulkLoadTarget && mode === "direct") {
    throw new Error("BULK_LOAD_TARGET is mutually exclusive with GENERATOR_MODE=direct");
  }
  const httpInFlight = resolvePositiveIntEnv(process.env.GENERATOR_INFLIGHT, 64);

  log.info(
    { totalRows, classes, schemaPath, stream: opts.stream, workers: requestedWorkers, profile: profileName, mode, distribution, storageFormat, bulkLoadTarget: bulkLoadTarget ? redacted(bulkLoadTarget) : null },
    "generator starting",
  );
  const start = Date.now();

  if (requestedWorkers === 1) {
    // Bit-equivalence path — single inline coordinator with the original
    // seed (no `:w0` suffix), exactly the pre-5.84B XADD command sequence.
    // The workers.test.ts canary guards this byte-for-byte against the
    // pre-wave inline loop shape. Wave 5.92A — only thread a router when
    // streamShards !== 1; the N=1 / per-bucket=false branch leaves producer
    // construction byte-for-byte identical to pre-5.92 (no router arg).
    const generator = createRowGenerator(schema, { seed: baseSeed, sensitivityTypes, distribution });
    let producer: StreamProducer;
    let client: Redis | Cluster | undefined;
    if (bulkLoadTarget) {
      // Wave 7.0.1.C — HTTP producer does not need a Redis client (rows go
      // to the bulk-loader over HTTP). We skip createClient entirely so the
      // generator's connection budget stays unaffected.
      producer = createHttpProducer({
        url: bulkLoadTarget,
        batchSize,
        maxInFlight: httpInFlight,
        logger: log,
      }) as unknown as StreamProducer;
    } else if (mode === "direct") {
      client = createClient(redisUrl);
      const hooks = await loadDirectWriterHooks();
      producer = createDirectWriter(client, {
        schema, storageFormat, batchSize, hooks,
      }) as unknown as StreamProducer;
    } else {
      client = createClient(redisUrl);
      const router = streamShards === 1 ? undefined : createStreamRouter(opts.stream, streamShards);
      const flowControl = createStreamFlowControl(client, {}, log);
      producer = createStreamProducer(client, {
        stream: opts.stream, batchSize, pipelineWindow, router,
        streamMaxLen: streamMaxLen > 0 ? streamMaxLen : undefined,
        flowControl,
      });
    }
    try {
      await runGenerationInline({
        totalRows, classes, offset: 0, stride: 1,
        generator, producer, rate,
      });
      // Wave 7.0.1.C — HTTP producer needs an explicit close() to drain
      // in-flight POSTs (flush() inside runGenerationInline already empties
      // the row buffer, but close() also releases waiters + surfaces any
      // background error). Legacy XADD/direct paths are bit-identical to
      // pre-7.0.1.C (no close() call) so the workers.test.ts canary holds.
      if (bulkLoadTarget) await producer.close();
    } finally {
      if (client) await closeClient(client);
    }
    logDone(producer.rowsSent, producer.byClass, start);
    return;
  }

  // Multi-worker path. Coordinator owns: connection-budget cap, worker spawn,
  // SharedArrayBuffer cancel propagation, postMessage progress aggregation,
  // and aggregate logging.
  // Wave 7.0.1.C — when BULK_LOAD_TARGET is set every worker uses the HTTP
  // producer, so the maxclients-derived cap (which models Redis connections
  // per worker) does not apply: each worker holds zero Redis connections.
  // Still respect GENERATOR_WORKERS / --workers as the operator's request.
  const cappedWorkers = bulkLoadTarget
    ? requestedWorkers
    : await capWorkersForCluster(redisUrl, requestedWorkers, pipelineWindow);
  if (cappedWorkers < requestedWorkers) {
    log.warn(
      { requested: requestedWorkers, capped: cappedWorkers, pipelineWindow, headroom: MAXCLIENTS_HEADROOM },
      `--workers ${requestedWorkers} would exceed maxclients budget; capped to ${cappedWorkers}. ` +
      `Formula: floor((maxclients - ${MAXCLIENTS_HEADROOM}) / (workers × pipelineWindow × shards))`,
    );
  }
  await runWithWorkers({
    schemaPath, redisUrl, stream: opts.stream, batchSize, pipelineWindow,
    baseSeed, totalRows, classes, totalWorkers: cappedWorkers, rate, start,
    streamShards, streamMaxLen, sensitivityTypes,
    mode, distribution, storageFormat,
    bulkLoadTarget, httpInFlight,
  });
}



// Wave 5.92C — resolve approximate MAXLEN cap: explicit --stream-maxlen >
// STREAM_MAXLEN env > DEFAULT_STREAM_MAXLEN. `0` or negative disables the
// cap so XADD command sequence stays bit-identical to pre-5.92C (used for
// the canary harness / opt-out). Garbage env values fall back to default
// rather than silently disabling — a typo must not OOM the host.
function resolveStreamMaxLen(explicit: string | undefined): number {
  const raw = explicit ?? process.env.STREAM_MAXLEN;
  if (raw === undefined || raw === "") return DEFAULT_STREAM_MAXLEN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STREAM_MAXLEN;
  return Math.floor(n);
}

// ─── helpers ──────────────────────────────────────────────────────────────

function logDone(rowsSent: number, byClass: Record<string, number>, start: number): void {
  const elapsed = (Date.now() - start) / 1000;
  const rps = Math.round(rowsSent / Math.max(elapsed, 0.001));
  log.info(
    { elapsed, rowsSent, byClass, rps },
    `done — produced ${rowsSent} rows in ${elapsed.toFixed(2)}s (${rps} rows/sec)`,
  );
}

interface RunWithWorkersOpts {
  schemaPath: string;
  redisUrl: string;
  stream: string;
  batchSize: number;
  pipelineWindow: number;
  baseSeed: string;
  totalRows: number;
  classes: string[];
  totalWorkers: number;
  rate?: number;
  start: number;
  // Wave 5.92A — hash-tag fan-out config threaded through to each worker
  // (workers build their own router locally — routers are not serialisable
  // across postMessage).
  streamShards: StreamShardsConfig;
  // Wave 5.92C — approximate XADD MAXLEN cap. 0 means opt out (no cap).
  streamMaxLen: number;
  // Wave 5.96G-gen — canonical-cased sensitivity types to emit per row.
  sensitivityTypes: readonly string[];
  // Wave 6.39.A — direct-write plumbing. `mode` defaults to "stream"
  // (worker-side default if undefined), `distribution` undefined preserves
  // legacy schema-aware draw; `storageFormat` is consumed only in direct
  // mode and ignored otherwise.
  mode: GeneratorMode;
  distribution: "uniform" | "realistic" | "pareto" | undefined;
  storageFormat: StorageFormat;
  // Wave 7.0.1.C — bulk-loader HTTP target + per-worker in-flight cap.
  // When `bulkLoadTarget` is undefined every worker falls back to the
  // pre-7.0.1.C XADD/direct path (bit-identical to the workers.test.ts
  // canary). When set, every worker swaps in the HTTP producer.
  bulkLoadTarget: string | undefined;
  httpInFlight: number;
}

async function runWithWorkers(opts: RunWithWorkersOpts): Promise<void> {
  const cancelBuffer = new SharedArrayBuffer(4);
  const cancelView = new Int32Array(cancelBuffer);
  const perWorkerRows = new Int32Array(opts.totalWorkers);
  const perWorkerByClass: Array<Record<string, number>> = [];
  let aggregatedTotal = 0;
  // Progress logger — flushes once per second so a long run shows liveness
  // without flooding stdout. The aggregator latches the monotonic sum across
  // per-worker latest snapshots (DoD #5).
  const progressTimer = setInterval(() => {
    let s = 0;
    for (let i = 0; i < opts.totalWorkers; i++) s += perWorkerRows[i]!;
    if (s > aggregatedTotal) aggregatedTotal = s;
    log.info({ rowsSent: aggregatedTotal, of: opts.totalRows }, "generator progress");
  }, 1000);
  progressTimer.unref?.();

  // Resolve worker entry via this module's URL. We point at a tiny `.mjs`
  // shim that calls tsx's `register()` API before dynamic-importing the
  // TypeScript worker — `--import tsx` alone does NOT register the loader
  // inside worker threads (auto-register is gated by `isMainThread`).
  const workerEntry = resolve(dirname(fileURLToPath(import.meta.url)), "worker-entry.mjs");
  const workerPromises: Promise<{ idx: number; rowsSent: number; byClass: Record<string, number>; cancelled: boolean }>[] = [];
  let firstError: Error | null = null;
  // Graceful cancel on SIGINT/SIGTERM — flip the shared flag so all workers
  // exit ≤200 ms (DoD #3) instead of being killed mid-pipeline.
  const onSignal = (): void => { Atomics.store(cancelView, 0, 1); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  for (let w = 0; w < opts.totalWorkers; w++) {
    const init: WorkerInitData = {
      schemaPath: opts.schemaPath,
      redisUrl: opts.redisUrl,
      stream: opts.stream,
      batchSize: opts.batchSize,
      pipelineWindow: opts.pipelineWindow,
      streamShards: opts.streamShards,
      streamMaxLen: opts.streamMaxLen,
      sensitivityTypes: [...opts.sensitivityTypes],
      seed: `${opts.baseSeed}:w${w}`,
      totalRows: opts.totalRows,
      workerIdx: w,
      totalWorkers: opts.totalWorkers,
      classes: opts.classes,
      cancelBuffer,
      rate: opts.rate,
      progressBatchSize: 1000,
      mode: opts.mode,
      distribution: opts.distribution,
      storageFormat: opts.storageFormat,
      bulkLoadTarget: opts.bulkLoadTarget,
      httpInFlight: opts.httpInFlight,
    };
    const worker = new Worker(workerEntry, {
      workerData: init,
    });
    workerPromises.push(new Promise((resolveP, rejectP) => {
      worker.on("message", (msg: WorkerMessage) => {
        if (msg.type === "progress") {
          perWorkerRows[msg.workerIdx] = msg.rowsSent;
        } else if (msg.type === "done") {
          perWorkerRows[msg.workerIdx] = msg.rowsSent;
          perWorkerByClass[msg.workerIdx] = msg.byClass;
          resolveP({ idx: msg.workerIdx, rowsSent: msg.rowsSent, byClass: msg.byClass, cancelled: msg.cancelled });
        } else if (msg.type === "error") {
          if (!firstError) firstError = new Error(`worker ${msg.workerIdx}: ${msg.message}`);
          Atomics.store(cancelView, 0, 1);
          rejectP(firstError);
        }
      });
      worker.on("error", (err) => {
        if (!firstError) firstError = err;
        Atomics.store(cancelView, 0, 1);
        rejectP(err);
      });
      worker.on("exit", (code) => {
        if (code !== 0 && !firstError) {
          firstError = new Error(`worker ${w} exited with code ${code}`);
          rejectP(firstError);
        }
      });
    }));
  }

  try {
    const results = await Promise.all(workerPromises);
    clearInterval(progressTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Aggregate final counts. byClass is summed across workers; rowsSent is
    // the total XADDed (== sum of per-worker rowsSent, by construction).
    let totalRows = 0;
    const byClass: Record<string, number> = {};
    for (const r of results) {
      totalRows += r.rowsSent;
      for (const [k, v] of Object.entries(r.byClass)) byClass[k] = (byClass[k] ?? 0) + v;
    }
    logDone(totalRows, byClass, opts.start);
  } catch (err) {
    clearInterval(progressTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    throw err;
  }
}

// Cap `--workers` to (maxclients - headroom) / (workers × pipelineWindow ×
// shards). For non-cluster Redis, shards=1 and the probe is a CONFIG GET
// maxclients on the single node. For Cluster, ioredis pools one connection
// per shard per worker — multiply accordingly. On any probe failure we leave
// the requested count unchanged (operator-explicit choice wins).
async function capWorkersForCluster(
  redisUrl: string, requested: number, pipelineWindow: number,
): Promise<number> {
  let probeClient: Redis | Cluster | null = null;
  try {
    probeClient = createClient(redisUrl);
    let maxclients = 0;
    let shards = 1;
    if (probeClient instanceof Cluster) {
      const nodes = probeClient.nodes("master");
      shards = Math.max(1, nodes.length);
      const replies = await Promise.allSettled(nodes.map((n) => n.config("GET", "maxclients")));
      const vals: number[] = [];
      for (const r of replies) {
        if (r.status === "fulfilled" && Array.isArray(r.value) && r.value.length >= 2) {
          const n = Number(r.value[1]);
          if (Number.isFinite(n) && n > 0) vals.push(n);
        }
      }
      maxclients = vals.length > 0 ? Math.min(...vals) : 0;
    } else {
      const reply = (await probeClient.config("GET", "maxclients")) as unknown;
      if (Array.isArray(reply) && reply.length >= 2) {
        const n = Number(reply[1]);
        if (Number.isFinite(n) && n > 0) maxclients = n;
      }
    }
    if (maxclients <= 0) return requested;
    const perWorker = Math.max(1, pipelineWindow) * shards;
    const cap = Math.max(1, Math.floor((maxclients - MAXCLIENTS_HEADROOM) / perWorker));
    return Math.min(requested, cap);
  } catch {
    return requested;
  } finally {
    if (probeClient) await probeClient.quit().catch(() => undefined);
  }
}

function createClient(url: string): Redis | Cluster {
  // Wave 5.2: route through the shared cluster-aware helper (honours
  // REDIS_CLUSTER / REDIS_TLS env). The legacy `redis-cluster://` prefix
  // remains an explicit-override escape hatch for back-compat with tests.
  if (url.startsWith("redis-cluster://")) {
    const stripped = url.replace("redis-cluster://", "redis://");
    return new Cluster([stripped]);
  }
  return createRedisClient({ url });
}

async function closeClient(client: Redis | Cluster): Promise<void> {
  await client.quit().catch(() => undefined);
}

// Wave 5.84C — probe wrapper used by the CLI entry path. Opens a transient
// probe client, runs probeCluster(), and always closes — any failure
// returns the conservative fallback shape with a warn-log so the run can
// still proceed (DoD #7).
async function probeForCli(redisUrl: string): Promise<ClusterShape> {
  let client: Redis | Cluster | null = null;
  try {
    client = createClient(redisUrl);
    const shape = await probeCluster(client);
    if (shape.fallback) {
      log.warn({ redisUrl: redacted(redisUrl) }, "probe returned fallback shape; using conservative `small` defaults");
    }
    return shape;
  } catch (err) {
    log.warn(
      { err: String(err), redisUrl: redacted(redisUrl) },
      "cluster probe failed; falling back to conservative `small` profile (DoD #7)",
    );
    return fallbackShape();
  } finally {
    if (client) await client.quit().catch(() => undefined);
  }
}

// Wave 5.84C — plan block printed for any CLI invocation (dry-run + real
// run). Mirrors the structured `plan` object the api emits in its seed SSE
// frame. Uses pino's structured-log machinery so callers can pipe through
// `pino-pretty` or jq; the human label fields are concise enough to be
// readable in raw JSON too.
interface PrintPlanArgs {
  shape: ClusterShape;
  dials: ResolvedDials;
  hostCores: number;
  rows: number;
  profileRequested: string;
  gate: ReturnType<typeof refuseOrGo>;
}
function printPlan(a: PrintPlanArgs): void {
  const durationSec = estimateDurationSec(a.rows, a.dials.workers);
  log.info(
    {
      plan: {
        profile: a.dials.profile,
        profile_requested: a.profileRequested,
        shape: {
          mode: a.shape.mode,
          shards: a.shape.shards,
          maxclients: a.shape.maxclients,
          maxmemory_bytes: a.shape.maxmemoryBytes,
          used_memory_bytes: a.shape.usedMemoryBytes,
          fallback: !!a.shape.fallback,
        },
        host_cores: a.hostCores,
        dials: {
          workers: a.dials.workers,
          batch_size: a.dials.batchSize,
          pipeline_window: a.dials.pipelineWindow,
          stream_shards: a.dials.streamShards,
        },
        overrides: a.dials.overrides,
        rows: a.rows,
        bytes_per_row: BYTES_PER_ROW,
        estimated_bytes: a.gate.estimatedBytes,
        memory_gate: {
          allowed: a.gate.allowed,
          threshold_bytes: a.gate.thresholdBytes,
        },
        estimated_duration_sec: Math.round(durationSec * 100) / 100,
      },
    },
    `plan — profile=${a.dials.profile} (requested=${a.profileRequested}) ` +
    `shape=${a.shape.mode}/${a.shape.shards}sh ` +
    `dials=workers:${a.dials.workers} batch:${a.dials.batchSize} window:${a.dials.pipelineWindow} ` +
    `streamShards:${a.dials.streamShards} ` +
    `rows=${a.rows} est=${formatBytes(a.gate.estimatedBytes)} ` +
    `dur~${durationSec.toFixed(1)}s`,
  );
}

// Wave 5.84C — pretty-print a byte count for the plan block / refuse-or-go
// error line. Conservative rounding (1 decimal place) keeps the line
// concise; we never display fractional bytes.
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Strip credentials from the redis URL for log emission.
function redacted(url: string): string {
  try { return new URL(url).host; } catch { return "redis"; }
}

main().catch((err) => {
  log.error({ err: String(err), stack: (err as Error).stack }, "generator failed");
  process.exit(1);
});

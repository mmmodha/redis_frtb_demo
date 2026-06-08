#!/usr/bin/env node
import { Command } from "commander";
import { Redis, Cluster } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import pino from "pino";
import { loadSchema } from "@frtb/schema";
import { Worker } from "node:worker_threads";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRowGenerator } from "./row-generator.js";
import { createStreamProducer } from "./producer.js";
import { pickRiskClasses } from "./mix.js";
import { runGenerationInline } from "./coordinator.js";
import type { WorkerInitData, WorkerMessage } from "./worker.js";

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
    );

  program.parse(process.argv);
  const opts = program.opts<CliOptions>();

  const schemaPath = opts.schemaFile ?? process.env.SCHEMA_FILE;
  if (!schemaPath) {
    throw new Error("schema file path missing: pass --schema-file or set SCHEMA_FILE");
  }
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("redis URL missing: pass --redis-url or set REDIS_URL");
  }

  const schema = loadSchema(schemaPath);
  const classes = pickRiskClasses(schema, opts.classes);
  const totalRows = Number(opts.rows);
  const batchSize = Number(opts.batchSize);
  const pipelineWindow = Number(opts.pipelineWindow);
  const rate = opts.rate ? Number(opts.rate) : undefined;
  const requestedWorkers = Math.max(1, Math.min(MAX_WORKERS_HARD_CAP, Math.floor(Number(opts.workers))));
  const baseSeed = opts.seed ?? "0";

  log.info({ totalRows, classes, schemaPath, stream: opts.stream, workers: requestedWorkers }, "generator starting");
  const start = Date.now();

  if (requestedWorkers === 1) {
    // Bit-equivalence path — single inline coordinator with the original
    // seed (no `:w0` suffix), exactly the pre-5.84B XADD command sequence.
    // The workers.test.ts canary guards this byte-for-byte against the
    // pre-wave inline loop shape.
    const client = createClient(redisUrl);
    const generator = createRowGenerator(schema, { seed: baseSeed });
    const producer = createStreamProducer(client, { stream: opts.stream, batchSize, pipelineWindow });
    try {
      await runGenerationInline({
        totalRows, classes, offset: 0, stride: 1,
        generator, producer, rate,
      });
    } finally {
      await closeClient(client);
    }
    logDone(producer.rowsSent, producer.byClass, start);
    return;
  }

  // Multi-worker path. Coordinator owns: connection-budget cap, worker spawn,
  // SharedArrayBuffer cancel propagation, postMessage progress aggregation,
  // and aggregate logging.
  const cappedWorkers = await capWorkersForCluster(redisUrl, requestedWorkers, pipelineWindow);
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
  });
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

  // Resolve worker.ts via this module's URL — tsx executes .ts directly in
  // the worker via the same loader as the parent.
  const workerEntry = resolve(dirname(fileURLToPath(import.meta.url)), "worker.ts");
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
      seed: `${opts.baseSeed}:w${w}`,
      totalRows: opts.totalRows,
      workerIdx: w,
      totalWorkers: opts.totalWorkers,
      classes: opts.classes,
      cancelBuffer,
      rate: opts.rate,
      progressBatchSize: 1000,
    };
    const worker = new Worker(workerEntry, {
      workerData: init,
      execArgv: ["--import", "tsx"],
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

main().catch((err) => {
  log.error({ err: String(err), stack: (err as Error).stack }, "generator failed");
  process.exit(1);
});

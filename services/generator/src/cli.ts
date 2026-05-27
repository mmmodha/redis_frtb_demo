#!/usr/bin/env node
import { Command } from "commander";
import { Redis, Cluster } from "ioredis";
import pino from "pino";
import { loadSchema } from "@frtb/schema";
import { createRowGenerator } from "./row-generator.js";
import { createStreamProducer } from "./producer.js";
import { pickRiskClasses } from "./mix.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

interface CliOptions {
  rows: string;
  rate?: string;
  classes: string;
  seed?: string;
  schemaFile?: string;
  redisUrl?: string;
  stream: string;
  batchSize: string;
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
    .option("--batch-size <n>", "XADD batch / pipeline size", "1000");

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
  const rate = opts.rate ? Number(opts.rate) : undefined;

  const client = createClient(redisUrl);
  const generator = createRowGenerator(schema, { seed: opts.seed });
  const producer = createStreamProducer(client, { stream: opts.stream, batchSize });

  log.info({ totalRows, classes, schemaPath, stream: opts.stream }, "generator starting");
  const start = Date.now();

  for (let i = 0; i < totalRows; i++) {
    const cls = classes[i % classes.length]!;
    const row = generator.generate(cls);
    await producer.add(row);
    if (rate && i > 0 && i % 1000 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      const expected = i / rate;
      if (elapsed < expected) {
        await sleep((expected - elapsed) * 1000);
      }
    }
  }
  await producer.flush();
  const elapsed = (Date.now() - start) / 1000;
  const rps = Math.round(producer.rowsSent / Math.max(elapsed, 0.001));
  log.info(
    { elapsed, rowsSent: producer.rowsSent, byClass: producer.byClass, rps },
    `done — produced ${producer.rowsSent} rows in ${elapsed.toFixed(2)}s (${rps} rows/sec)`
  );
  await closeClient(client);
}

function createClient(url: string): Redis | Cluster {
  if (url.startsWith("redis-cluster://")) {
    const stripped = url.replace("redis-cluster://", "redis://");
    return new Cluster([stripped]);
  }
  return new Redis(url);
}

async function closeClient(client: Redis | Cluster): Promise<void> {
  await client.quit().catch(() => undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log.error({ err: String(err), stack: (err as Error).stack }, "generator failed");
  process.exit(1);
});

// Wave 5.16e2 one-off typed-ingest helper. Mirrors services/generator/src/cli.ts
// but exposes `--types <list>` (the generator CLI hardcodes Delta+Vega; the
// row-generator API already supports `sensitivityTypes`). Lives under docs/
// to honour the "no src/ change" scope. Pushes N rows of the requested type
// into `sensitivities:in`; the live ingest service drains the stream as usual.
// Secrets policy: REDIS_URL / password / username never echoed.
import { Command } from "commander";
import { Redis, Cluster } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema } from "@frtb/schema";
import { createRowGenerator } from "../../../../services/generator/src/row-generator.js";
import { createStreamProducer } from "../../../../services/generator/src/producer.js";
import { pickRiskClasses } from "../../../../services/generator/src/mix.js";

interface Opts {
  rows: string;
  classes: string;
  types: string;
  seed: string;
  schemaFile?: string;
  redisUrl?: string;
  stream: string;
  batchSize: string;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .option("--rows <n>", "rows to produce", "2000")
    .option("--classes <list>", "comma list", "GIRR,EQUITY,FX")
    .option("--types <list>", "sensitivity_type comma list", "Delta,Vega")
    .option("--seed <s>", "PRNG seed", "0")
    .option("--schema-file <p>", "schema YAML")
    .option("--redis-url <u>", "redis URL")
    .option("--stream <k>", "stream key", process.env.STREAM_KEY ?? "sensitivities:in")
    .option("--batch-size <n>", "pipeline size", "500");
  program.parse(process.argv);
  const opts = program.opts<Opts>();

  const schemaPath = opts.schemaFile ?? process.env.SCHEMA_FILE;
  if (!schemaPath) throw new Error("--schema-file or SCHEMA_FILE required");
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL;
  if (!redisUrl) throw new Error("--redis-url or REDIS_URL required");

  const schema = loadSchema(schemaPath);
  const classes = pickRiskClasses(schema, opts.classes);
  const sensitivityTypes = opts.types.split(",").map((s) => s.trim()).filter(Boolean);
  const totalRows = Number(opts.rows);
  const batchSize = Number(opts.batchSize);

  const client = createClient(redisUrl);
  const generator = createRowGenerator(schema, { seed: opts.seed, sensitivityTypes });
  const producer = createStreamProducer(client, { stream: opts.stream, batchSize });

  const t0 = Date.now();
  for (let i = 0; i < totalRows; i++) {
    const cls = classes[i % classes.length]!;
    await producer.add(generator.generate(cls));
  }
  await producer.flush();
  const elapsed = (Date.now() - t0) / 1000;
  const rps = Math.round(producer.rowsSent / Math.max(elapsed, 0.001));
  console.log(JSON.stringify({
    rowsSent: producer.rowsSent,
    elapsed,
    rps,
    byClass: producer.byClass,
    sensitivityTypes,
  }, null, 2));
  await closeClient(client);
}

function createClient(url: string): Redis | Cluster {
  if (url.startsWith("redis-cluster://")) {
    return new Cluster([url.replace("redis-cluster://", "redis://")]);
  }
  return createRedisClient({ url });
}

async function closeClient(client: Redis | Cluster): Promise<void> {
  await client.quit().catch(() => undefined);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});

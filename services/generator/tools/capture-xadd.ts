// Wave 5.84D — XADD-sequence capture helper. Drives the row-generator + a
// stub pipeline against a fixed seed/schema and prints the deterministic
// XADD field-value sequence to stdout as JSONL. The bench harness
// (bench-generator.mjs) consumes this output to compute a SHA256 and diff
// against the stored fixture, enforcing the pre/post-5.84 byte-equivalence
// invariant required by DoD #3.
//
// Run via: node --import tsx services/generator/tools/capture-xadd.ts \
//   --schema-file <path> --seed <s> --rows <n> --classes <list>
//
// Output: one JSON array per XADD on stdout (field-value list, with the
// monotonic `_id` field+value pair stripped so the capture is reproducible
// across wall-clock-dependent ulid timestamps).

import { loadSchema } from "@frtb/schema";
import { createRowGenerator } from "../src/row-generator.ts";
import { createStreamProducer } from "../src/producer.ts";
import { runGenerationInline } from "../src/coordinator.ts";
import { pickRiskClasses } from "../src/mix.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

const schemaPath = arg("--schema-file");
const seed = arg("--seed", "42")!;
const rows = Number(arg("--rows", "1000"));
const classes = arg("--classes", "all")!;
const batchSize = Number(arg("--batch-size", "1000"));
if (!schemaPath) {
  process.stderr.write("capture-xadd: --schema-file is required\n");
  process.exit(2);
}

// In-memory stub pipeline — captures every XADD args tuple. Mirrors the
// stub used by services/generator/tests/workers.test.ts (the canary), so a
// passing fixture diff here proves the same invariant the unit test guards.
interface StubExec { batches: string[][][]; flushed: boolean }
function stubClient(execs: StubExec) {
  return {
    pipeline() {
      const buf: string[][] = [];
      return {
        xadd(...args: string[]) { buf.push(args); return this; },
        async exec() {
          execs.batches.push(buf);
          return buf.map(() => [null, "0-0"] as [Error | null, unknown]);
        },
      };
    },
  } as never;
}

// Strip `_id <value>` pair from each XADD args tuple (ulid-monotonic, not
// reproducible). Matches `stripId` in workers.test.ts so the canary and
// this capture stay aligned.
function stripId(xaddArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < xaddArgs.length; i++) {
    if (xaddArgs[i] === "_id") { i++; continue; }
    out.push(xaddArgs[i]!);
  }
  return out;
}

async function main(): Promise<void> {
  const schema = loadSchema(schemaPath!);
  const pickedClasses = pickRiskClasses(schema, classes);
  const execs: StubExec = { batches: [], flushed: false };
  const client = stubClient(execs);
  const gen = createRowGenerator(schema, { seed });
  const prod = createStreamProducer(client, { stream: "bench:capture", batchSize });
  await runGenerationInline({
    totalRows: rows,
    classes: pickedClasses,
    offset: 0,
    stride: 1,
    generator: gen,
    producer: prod,
  });
  execs.flushed = true;
  // Emit one JSON line per XADD command. Stable ordering — caller pipes to
  // sha256sum / diff without further normalization.
  const out = process.stdout;
  for (const batch of execs.batches) {
    for (const xadd of batch) {
      out.write(JSON.stringify(stripId(xadd)));
      out.write("\n");
    }
  }
}

main().catch((err) => {
  process.stderr.write(`capture-xadd: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

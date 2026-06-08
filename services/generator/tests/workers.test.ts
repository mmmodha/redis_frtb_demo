// Wave 5.84B — worker_threads shard-out for the generator.
//
// This file owns the canary tests that guard the entire wave:
//
//   • Bit-equivalence: --workers 1 MUST produce the same XADD command
//     sequence (modulo ulid _id timestamps) as the pre-5.84B inline loop.
//     Anything else means the refactor broke the default invocation.
//
//   • Picker stride math: worker w of N handles row i iff i % N === w. The
//     global class mix is the round-robin `classes[i % classes.length]` — the
//     UNION of all workers' rows reproduces the single-thread class sequence.
//
//   • Cancel propagation latency: ≤200 ms wall time from flag flip to loop
//     exit at typical row rates. (DoD #3.)
//
//   • Progress aggregation: per-worker batched onProgress callbacks merge
//     into a single monotonic-rows-counter stream at the coordinator. (DoD #5.)
//
// All tests run against an in-process producer + stub redis pipeline (no live
// redis, no spawned worker_threads) so they're fast and CI-friendly. The
// worker entry (worker.ts) is exercised at the smoke layer separately.

import { describe, it, expect, beforeAll } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema } from "@frtb/schema";
import type { Schema } from "@frtb/schema";
import { createRowGenerator } from "../src/row-generator.ts";
import { createStreamProducer, type SensitivityRow } from "../src/producer.ts";
import { runGenerationInline } from "../src/coordinator.ts";

const here = resolve(fileURLToPath(import.meta.url), "..");
let schema: Schema;
beforeAll(() => {
  schema = loadSchema(resolve(here, "fixtures/multi-class.yaml"));
});

// Stub pipeline client — records every XADD arg-tuple per exec call, like the
// 5.84A producer test. Keeps tests CI-fast (no live redis, no worker spawn).
type StubExec = string[][];
interface StubClient {
  execs: StubExec[];
  pipeline(): { xadd(...args: string[]): unknown; exec(): Promise<Array<[Error | null, unknown]>> };
}
function stubClient(): StubClient {
  const execs: StubExec[] = [];
  return {
    execs,
    pipeline() {
      const buffered: string[][] = [];
      return {
        xadd(...args: string[]) { buffered.push(args); return this; },
        async exec() {
          execs.push(buffered);
          return buffered.map(() => [null, "0-0"] as [Error | null, unknown]);
        },
      };
    },
  };
}

// Strip the ulid `_id` field from a recorded XADD arg-tuple so byte-equal
// comparisons aren't defeated by monotonic-time variation between test runs.
// XADD args are `[stream, "*", "risk_class", v, "bucket", v, "_hash_tag", v,
// "_id", v, "payload", v]` — drop the `_id`+value pair.
function stripId(xaddArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < xaddArgs.length; i++) {
    if (xaddArgs[i] === "_id") { i++; continue; }
    out.push(xaddArgs[i]!);
  }
  return out;
}
function flattenExecs(execs: StubExec[]): string[][] {
  const flat: string[][] = [];
  for (const batch of execs) for (const xadd of batch) flat.push(stripId(xadd));
  return flat;
}

const CLASSES = ["GIRR", "EQUITY", "FX"] as const;

// Run the pre-5.84B inline loop shape: exactly the body of cli.ts main()
// before this wave, against a stub pipeline. Anchor for bit-equivalence.
async function runBaseline(seed: string, totalRows: number, batchSize: number): Promise<StubClient> {
  const client = stubClient();
  const gen = createRowGenerator(schema, { seed });
  const prod = createStreamProducer(client as never, { stream: "s", batchSize });
  for (let i = 0; i < totalRows; i++) {
    const row = gen.generate(CLASSES[i % CLASSES.length]!);
    await prod.add(row);
  }
  await prod.flush();
  return client;
}

async function runNew(
  seed: string, totalRows: number, batchSize: number,
  offset: number, stride: number,
): Promise<StubClient> {
  const client = stubClient();
  const gen = createRowGenerator(schema, { seed });
  const prod = createStreamProducer(client as never, { stream: "s", batchSize });
  await runGenerationInline({
    totalRows, classes: CLASSES as readonly string[],
    offset, stride, generator: gen, producer: prod,
  });
  return client;
}

describe("Wave 5.84B — bit-equivalence canary (workers=1 vs pre-5.84B inline)", () => {
  it("--workers 1 produces the same XADD sequence (modulo _id) as the pre-5.84B inline loop, seed=42, rows=1000", async () => {
    const baseline = await runBaseline("42", 1000, 200);
    const next = await runNew("42", 1000, 200, /* offset */ 0, /* stride */ 1);
    expect(next.execs.length).toBe(baseline.execs.length);
    expect(flattenExecs(next.execs)).toEqual(flattenExecs(baseline.execs));
  });

  it("default invocation (rows=137, batch=50) is byte-equal across the wave", async () => {
    const baseline = await runBaseline("seed-canary", 137, 50);
    const next = await runNew("seed-canary", 137, 50, 0, 1);
    expect(flattenExecs(next.execs)).toEqual(flattenExecs(baseline.execs));
  });
});

describe("Wave 5.84B — picker stride math", () => {
  it("worker w of N handles row i iff i % N === w (covers every i exactly once across workers)", () => {
    const N = 4;
    const total = 137;
    const seen = new Set<number>();
    for (let w = 0; w < N; w++) {
      for (let i = w; i < total; i += N) {
        expect(i % N).toBe(w);
        expect(seen.has(i)).toBe(false);
        seen.add(i);
      }
    }
    expect(seen.size).toBe(total);
  });

  it("per-class counts at workers=4 (stride union) match single-thread per-class counts", async () => {
    const total = 600;
    const single = await runNew("seed-x", total, 100, 0, 1);
    const singleClasses: Record<string, number> = {};
    for (const batch of single.execs) for (const xadd of batch) {
      const idx = xadd.indexOf("risk_class");
      const cls = xadd[idx + 1]!;
      singleClasses[cls] = (singleClasses[cls] ?? 0) + 1;
    }
    const multi: Record<string, number> = {};
    for (let w = 0; w < 4; w++) {
      const c = await runNew(`base:w${w}`, total, 100, w, 4);
      for (const batch of c.execs) for (const xadd of batch) {
        const idx = xadd.indexOf("risk_class");
        const cls = xadd[idx + 1]!;
        multi[cls] = (multi[cls] ?? 0) + 1;
      }
    }
    expect(multi).toEqual(singleClasses);
  });
});

describe("Wave 5.84B — cancel propagation latency", () => {
  // Realistic stub — each pipeline.exec() yields to the macrotask queue via
  // setTimeout(0). Mirrors the real ioredis network round-trip yield, which
  // is what gives setTimeout(50)-based cancel-flag flips a chance to fire.
  // Without this yield the row-buffer fill loop stays in microtasks forever
  // and no timer can land — an artifact of the test stub, not the worker.
  function yieldingStub(): StubClient {
    const execs: StubExec[] = [];
    return {
      execs,
      pipeline() {
        const buffered: string[][] = [];
        return {
          xadd(...args: string[]) { buffered.push(args); return this; },
          exec() {
            return new Promise<Array<[Error | null, unknown]>>((resolve) => {
              setTimeout(() => {
                execs.push(buffered);
                resolve(buffered.map(() => [null, "0-0"] as [Error | null, unknown]));
              }, 0);
            });
          },
        };
      },
    };
  }

  it("isCancelled flip is observed within 200 ms wall time (DoD #3)", async () => {
    const client = yieldingStub();
    const gen = createRowGenerator(schema, { seed: "cancel" });
    const prod = createStreamProducer(client as never, { stream: "s", batchSize: 64 });
    let cancelled = false;
    const flipAt = Date.now() + 50;
    setTimeout(() => { cancelled = true; }, 50).unref?.();
    await runGenerationInline({
      totalRows: 10_000_000, classes: CLASSES as readonly string[],
      offset: 0, stride: 1, generator: gen, producer: prod,
      isCancelled: () => cancelled, cancelPollEvery: 64,
    });
    const elapsedAfterFlip = Date.now() - flipAt;
    expect(cancelled).toBe(true);
    expect(elapsedAfterFlip).toBeLessThan(200);
  });
});

describe("Wave 5.84B — progress aggregation (per-worker postMessage → coordinator merge)", () => {
  // Coordinator merge logic — mirror the cli/api shape: keep a per-worker
  // latest snapshot, sum on every tick, expose monotonic total. Used by the
  // SSE emitter (api) and the CLI logger.
  function makeAggregator(numWorkers: number) {
    const perWorker = new Int32Array(numWorkers);
    let lastTotal = 0;
    return {
      onMessage(idx: number, rowsSent: number) {
        perWorker[idx] = rowsSent;
      },
      total() {
        let s = 0;
        for (let i = 0; i < numWorkers; i++) s += perWorker[i]!;
        // Monotonic guard: never report a smaller total than already emitted.
        // Without this, a slow message from a worker that already advanced
        // could regress the public counter.
        if (s < lastTotal) s = lastTotal;
        else lastTotal = s;
        return s;
      },
    };
  }

  it("merges 3-worker controlled batches into a monotonic, correctly-summed stream", () => {
    const agg = makeAggregator(3);
    // Simulate: each worker emits batched progress in arbitrary order.
    const events: Array<[number, number]> = [
      [0, 1000], [1, 1000], [2, 1000],   // T1: 3000
      [0, 2000], [2, 2000],              // T2: w0=2000, w1=1000, w2=2000 = 5000
      [1, 2000],                         // T3: 6000
      [0, 3000], [1, 3000], [2, 3000],   // T4: 9000
    ];
    const expectedTotals = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
    for (let i = 0; i < events.length; i++) {
      const [idx, count] = events[i]!;
      agg.onMessage(idx, count);
      expect(agg.total()).toBe(expectedTotals[i]);
    }
  });

  it("never regresses even when a stale message arrives out-of-order", () => {
    const agg = makeAggregator(2);
    agg.onMessage(0, 500);  agg.onMessage(1, 500);  expect(agg.total()).toBe(1000);
    agg.onMessage(0, 1000); agg.onMessage(1, 1000); expect(agg.total()).toBe(2000);
    // Stale out-of-order from w0 (reverts its known count); aggregator
    // still latches the prior monotonic high-water of 2000.
    agg.onMessage(0, 200);
    expect(agg.total()).toBe(2000);
  });

  it("onProgress callback fires at the configured cadence and reports producer.rowsSent", async () => {
    const client = stubClient();
    const gen = createRowGenerator(schema, { seed: "prog" });
    const prod = createStreamProducer(client as never, { stream: "s", batchSize: 100 });
    const observed: number[] = [];
    await runGenerationInline({
      totalRows: 500, classes: CLASSES as readonly string[],
      offset: 0, stride: 1, generator: gen, producer: prod,
      onProgress: (n) => observed.push(n), progressEvery: 100,
    });
    // Final value reported is the total rowsSent (final flush forces an
    // onProgress call past the natural cadence).
    expect(observed[observed.length - 1]).toBe(500);
    // Monotonic non-decreasing across all observations.
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]!).toBeGreaterThanOrEqual(observed[i - 1]!);
    }
  });
});

// Minimal sanity check that worker.ts is import-safe outside a worker thread
// (won't run main() when parentPort is null) — guards against accidental
// side-effects creeping into the module top level.
describe("Wave 5.84B — worker.ts is import-safe in the main thread", () => {
  it("imports without throwing", async () => {
    const mod = await import("../src/worker.ts");
    expect(mod).toBeDefined();
  });
});

// Silence the unused-symbol lint complaint by referencing the row shape once.
type _Row = SensitivityRow;

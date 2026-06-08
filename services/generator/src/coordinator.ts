// Wave 5.84B — shared row-loop helper used by BOTH the in-process inline path
// (cli `--workers 1`, api small-batch top-up) AND the per-worker entry
// (`worker.ts`). Single code path keeps the `--workers 1` bit-equivalence
// canary trivially true: a workers=1 run skips the worker_threads spawn and
// runs this helper directly with the original seed and stride=1.
//
// CRITICAL invariants:
//   1. Picker stride: row `i` is handled by this caller iff `i % stride ===
//      offset`. Offset=0 / stride=1 is the single-thread case (every row).
//   2. The risk-class for row `i` is always `classes[i % classes.length]`
//      (round-robin), regardless of stride. This preserves the global class
//      mix across all workers — DoD #2.
//   3. Cancel flag is polled at `cancelPollEvery` row boundaries so a
//      coordinator that flips the flag is observed within ≤200 ms wall time
//      at typical row rates (DoD #3).

import type { RowGenerator } from "./row-generator.ts";
import type { StreamProducer } from "./producer.ts";

export interface RunInlineOptions {
  totalRows: number;
  classes: readonly string[];
  /** Picker stride. Worker w of N uses { offset: w, stride: N }. Single-thread = { 0, 1 }. */
  offset: number;
  stride: number;
  generator: RowGenerator;
  producer: StreamProducer;
  /**
   * Optional cancel probe — returns true if the run must abort. Polled once
   * every `cancelPollEvery` iterations (default 1024). Workers wire this to
   * `Atomics.load(int32, 0) !== 0` against a SharedArrayBuffer.
   */
  isCancelled?: () => boolean;
  cancelPollEvery?: number;
  /**
   * Optional rate-limit (rows/sec, GLOBAL across all stride workers). Mirrors
   * the pre-5.84B CLI `--rate` behaviour at workers=1 (this caller divides
   * the budget by stride internally so the aggregate matches).
   */
  rate?: number;
  /**
   * Optional progress callback — invoked every `progressEvery` ADDed rows
   * with the current `producer.rowsSent`. Workers use this to postMessage
   * batched counts to the coordinator (DoD #5).
   */
  onProgress?: (rowsSent: number) => void;
  progressEvery?: number;
}

export interface RunInlineResult {
  rowsSent: number;
  byClass: Record<string, number>;
  cancelled: boolean;
}

export async function runGenerationInline(
  opts: RunInlineOptions,
): Promise<RunInlineResult> {
  const {
    totalRows,
    classes,
    offset,
    stride,
    generator,
    producer,
    isCancelled,
    cancelPollEvery = 1024,
    rate,
    onProgress,
    progressEvery = 1000,
  } = opts;
  if (stride < 1) throw new Error("stride must be >= 1");
  if (offset < 0 || offset >= stride) throw new Error("offset must be in [0, stride)");
  if (classes.length === 0) throw new Error("classes must be non-empty");

  // Per-worker rate budget: each worker handles 1/stride of rows, so its
  // per-second cap is rate/stride. Aggregate rate across workers ≈ original.
  const localRate = rate ? rate / stride : undefined;
  const start = Date.now();
  let localCount = 0;
  let cancelled = false;
  for (let i = offset; i < totalRows; i += stride) {
    if (isCancelled && (localCount & (cancelPollEvery - 1)) === 0 && isCancelled()) {
      cancelled = true;
      break;
    }
    const cls = classes[i % classes.length]!;
    const row = generator.generate(cls);
    await producer.add(row);
    localCount++;
    if (onProgress && localCount % progressEvery === 0) {
      onProgress(producer.rowsSent);
    }
    if (localRate && localCount % 1000 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      const expected = localCount / localRate;
      if (elapsed < expected) {
        await sleep((expected - elapsed) * 1000);
      }
    }
  }
  await producer.flush();
  if (onProgress) onProgress(producer.rowsSent);
  return { rowsSent: producer.rowsSent, byClass: producer.byClass, cancelled };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

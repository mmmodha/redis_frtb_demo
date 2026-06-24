import { describe, it, expect } from "vitest";
import { computeBulkRunDone } from "../../src/lib/bulkIngestProgress";

describe("computeBulkRunDone", () => {
  it("uses rows_sent when index count is pre-existing", () => {
    const done = computeBulkRunDone({
      rowsTotal: 1_000_000,
      rowsSent: 42_000,
      indexCount: 1_000_000,
      baseline: { indexCountAtStart: 1_000_000, flushedAtStart: 500_000 },
      totalFlushed: 542_000,
    });
    expect(done).toBe(42_000);
  });

  it("uses indexed delta from baseline", () => {
    const done = computeBulkRunDone({
      rowsTotal: 10_000,
      rowsSent: 2_000,
      indexCount: 3_000,
      baseline: { indexCountAtStart: 0, flushedAtStart: 0 },
      totalFlushed: 2_500,
    });
    expect(done).toBe(3_000);
  });

  it("caps at rows_total", () => {
    const done = computeBulkRunDone({
      rowsTotal: 1_000,
      rowsSent: 5_000,
      indexCount: 5_000,
      baseline: { indexCountAtStart: 0, flushedAtStart: null },
      totalFlushed: 5_000,
    });
    expect(done).toBe(1_000);
  });
});

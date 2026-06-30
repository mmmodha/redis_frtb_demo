import { describe, it, expect } from "vitest";
import { mergeRunHistory } from "../../src/lib/ingestRunHistory";
import type { IngestRunHistoryEntry } from "../../src/lib/ingestRunHistoryDisplay";

function entry(id: string, started: string): IngestRunHistoryEntry {
  return {
    run_id: id,
    status: "done",
    rows_total: 1000,
    rows_sent: 1000,
    rows_written: 1000,
    rows_skipped: 0,
    avg_producer_rps: 100,
    avg_write_rps: 100,
    duration_ms: 10_000,
    started_at_iso: started,
    ended_at_iso: started,
    bulk_loader_base: "http://bl:8086",
    workers: 2,
    batch_size: 500,
    concurrency: 32,
  };
}

describe("mergeRunHistory", () => {
  it("prefers API entries over local duplicates and sorts newest first", () => {
    const local = [entry("A", "2026-01-01T00:00:00Z")];
    const api = [entry("A", "2026-01-01T00:00:00Z"), entry("B", "2026-01-02T00:00:00Z")];
    const merged = mergeRunHistory(api, local);
    expect(merged.map((r) => r.run_id)).toEqual(["B", "A"]);
  });
});

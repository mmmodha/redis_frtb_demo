import { describe, it, expect, beforeEach } from "vitest";
import {
  avgRps,
  buildHistoryEntry,
  pushRunHistory,
  listRunHistory,
  getRunHistoryEntry,
  _testResetRunHistory,
  type BulkRunHistorySource,
} from "../src/lib/ingest-run-history.ts";

const baseRecord: BulkRunHistorySource = {
  run_id: "01HIST",
  status: "done",
  rows_total: 10_000,
  rows_sent: 10_000,
  rows_skipped: 0,
  batch_size: 500,
  concurrency: 32,
  workers: 2,
  started_at_iso: "2026-06-23T10:00:00.000Z",
  ms: 5000,
  bulk_loader_base: "http://bulk-loader:8086",
  flushed_at_start: 100,
};

describe("ingest-run-history", () => {
  beforeEach(() => { _testResetRunHistory(); });

  it("avgRps computes rows per second from duration", () => {
    expect(avgRps(10_000, 5000)).toBe(2000);
    expect(avgRps(0, 5000)).toBe(0);
    expect(avgRps(100, 0)).toBe(0);
  });

  it("buildHistoryEntry captures transfer stats and endpoint", () => {
    const entry = buildHistoryEntry(baseRecord, 9800, "2026-06-23T10:00:05.000Z");
    expect(entry.rows_written).toBe(9800);
    expect(entry.avg_write_rps).toBe(1960);
    expect(entry.avg_producer_rps).toBe(2000);
    expect(entry.bulk_loader_base).toBe("http://bulk-loader:8086");
    expect(entry.ended_at_iso).toBe("2026-06-23T10:00:05.000Z");
  });

  it("pushRunHistory keeps newest first and caps size", () => {
    for (let i = 0; i < 30; i++) {
      pushRunHistory(buildHistoryEntry(
        { ...baseRecord, run_id: `RUN${i}` },
        1000,
        "2026-06-23T10:00:05.000Z",
      ));
    }
    const list = listRunHistory();
    expect(list.length).toBe(25);
    expect(list[0]!.run_id).toBe("RUN29");
    expect(getRunHistoryEntry("RUN29")).toBeDefined();
    expect(getRunHistoryEntry("RUN0")).toBeUndefined();
  });
});

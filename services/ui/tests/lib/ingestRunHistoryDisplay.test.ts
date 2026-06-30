import { describe, it, expect } from "vitest";
import {
  formatDurationMs,
  formatEndpoint,
  formatHistoryDateGroupLabel,
  groupIngestRunsByDate,
  statusLabel,
} from "../../src/lib/ingestRunHistoryDisplay";
import type { IngestRunHistoryEntry } from "../../src/lib/ingestRunHistoryDisplay";

const baseRun = (overrides: Partial<IngestRunHistoryEntry> = {}): IngestRunHistoryEntry => ({
  run_id: "01HIST",
  status: "done",
  rows_total: 10_000,
  rows_sent: 10_000,
  rows_written: 9800,
  rows_skipped: 0,
  avg_producer_rps: 2000,
  avg_write_rps: 1960,
  duration_ms: 5000,
  started_at_iso: "2026-06-23T10:00:00.000Z",
  ended_at_iso: "2026-06-23T10:00:05.000Z",
  bulk_loader_base: "http://bulk-loader:8086",
  workers: 2,
  batch_size: 500,
  concurrency: 32,
  ...overrides,
});

describe("ingestRunHistoryDisplay", () => {
  it("formatDurationMs renders seconds and minutes", () => {
    expect(formatDurationMs(4500)).toBe("5s");
    expect(formatDurationMs(125_000)).toBe("2m 5s");
  });

  it("formatEndpoint shortens bulk loader URL", () => {
    expect(formatEndpoint("http://bulk-loader:8086/")).toBe("bulk-loader:8086");
  });

  it("statusLabel maps terminal states", () => {
    expect(statusLabel("done")).toBe("Completed");
    expect(statusLabel("cancelled")).toBe("Cancelled");
    expect(statusLabel("error")).toBe("Failed");
  });

  it("formatHistoryDateGroupLabel uses Today and Yesterday", () => {
    const now = new Date("2026-06-23T12:00:00.000Z");
    expect(formatHistoryDateGroupLabel("2026-06-23", now)).toBe("Today");
    expect(formatHistoryDateGroupLabel("2026-06-22", now)).toBe("Yesterday");
  });

  it("groupIngestRunsByDate buckets runs newest date first", () => {
    const now = new Date("2026-06-23T12:00:00.000Z");
    const runs = [
      baseRun({ run_id: "A", started_at_iso: "2026-06-22T15:00:00.000Z" }),
      baseRun({ run_id: "B", started_at_iso: "2026-06-23T08:00:00.000Z" }),
      baseRun({ run_id: "C", started_at_iso: "2026-06-23T10:00:00.000Z" }),
    ];
    const groups = groupIngestRunsByDate(runs, now);
    expect(groups).toHaveLength(2);
    const today = groups[0]!;
    const yesterday = groups[1]!;
    expect(today.label).toBe("Today");
    expect(today.runs.map((r) => r.run_id)).toEqual(["B", "C"]);
    expect(yesterday.label).toBe("Yesterday");
    expect(yesterday.runs.map((r) => r.run_id)).toEqual(["A"]);
  });
});

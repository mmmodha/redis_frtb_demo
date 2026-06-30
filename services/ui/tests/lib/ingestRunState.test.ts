import { describe, it, expect } from "vitest";
import {
  monotonicWritten,
  shouldPollRun,
  runUiPhaseForStatus,
  shouldShowProgressCard,
  formatRunSummary,
  elapsedMsSince,
  effectiveRunWritten,
  pickRunWriteRps,
  ingestStallHint,
  pickHistoryRowsWritten,
} from "../../src/lib/ingestRunState";

describe("ingestRunState", () => {
  it("monotonicWritten never decreases", () => {
    expect(monotonicWritten(9000, 8500)).toBe(9000);
    expect(monotonicWritten(9000, 9500)).toBe(9500);
    expect(monotonicWritten(0, 100)).toBe(100);
  });

  it("shouldPollRun is true only while running", () => {
    expect(shouldPollRun("running")).toBe(true);
    expect(shouldPollRun("summary")).toBe(false);
    expect(shouldPollRun("hidden")).toBe(false);
  });

  it("runUiPhaseForStatus maps terminal states to summary", () => {
    expect(runUiPhaseForStatus("running")).toBe("running");
    expect(runUiPhaseForStatus("done")).toBe("summary");
    expect(runUiPhaseForStatus("cancelled")).toBe("summary");
    expect(runUiPhaseForStatus("error")).toBe("summary");
  });

  it("shouldShowProgressCard during running and brief summary only", () => {
    expect(shouldShowProgressCard("running")).toBe(true);
    expect(shouldShowProgressCard("summary")).toBe(true);
    expect(shouldShowProgressCard("hidden")).toBe(false);
  });

  it("formatRunSummary uses human row count and seconds", () => {
    expect(formatRunSummary(10_000, 4200)).toBe("Done — 10,000 rows in 4s");
  });

  it("elapsedMsSince computes from ISO start time", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(start) + 3500;
    expect(elapsedMsSince(start, now)).toBe(3500);
  });

  it("effectiveRunWritten uses best run-scoped signal while producing", () => {
    expect(effectiveRunWritten(
      { status: "running", rows_total: 10_000, rows_sent: 0, rows_written: 6500, phase: "producing" },
      6500,
    )).toBe(6500);
    expect(effectiveRunWritten(
      { status: "running", rows_total: 10_000, rows_sent: 0, rows_written: 6500, phase: "producing", retries_total: 10 },
      6500,
    )).toBe(0);
    expect(effectiveRunWritten(
      { status: "running", rows_total: 1_000_000, rows_sent: 200_000, rows_written: 450_000, phase: "producing" },
      450_000,
    )).toBe(450_000);
  });

  it("effectiveRunWritten uses flush delta during writing phase", () => {
    expect(effectiveRunWritten(
      { status: "running", rows_total: 10_000, rows_sent: 4000, rows_written: 0, phase: "writing" },
      3500,
    )).toBe(4000);
    expect(effectiveRunWritten(
      { status: "running", rows_total: 10_000, rows_sent: 8000, rows_written: 0, phase: "writing" },
      0,
    )).toBe(8000);
  });

  it("effectiveRunWritten uses rows_total when done and producers finished", () => {
    expect(effectiveRunWritten(
      { status: "done", rows_total: 10_000, rows_sent: 10_000, rows_written: 0, phase: "writing" },
      0,
    )).toBe(10_000);
  });

  it("effectiveRunWritten prefers flush delta when run completes", () => {
    expect(effectiveRunWritten(
      { status: "done", rows_total: 10_000, rows_sent: 10_000, rows_written: 9800 },
      9800,
    )).toBe(10_000);
  });

  it("pickRunWriteRps uses the best live signal", () => {
    expect(pickRunWriteRps(
      { status: "running", rows_per_sec_write: 1200, rows_per_sec_producer: 8000 },
      500,
    )).toBe(8000);
    expect(pickRunWriteRps({ status: "done" }, 500)).toBe(0);
  });

  it("ingestStallHint surfaces bulk-loader retries when write rate is zero", () => {
    expect(ingestStallHint({ status: "running", retries_total: 10 }, 0))
      .toMatch(/not accepting rows/i);
    expect(ingestStallHint({ status: "running", retries_total: 0 }, 1200)).toBeNull();
  });

  it("pickHistoryRowsWritten prefers producer count when flush delta is zero", () => {
    expect(pickHistoryRowsWritten(
      { rows_total: 10_000, rows_sent: 10_000, rows_written: 0 },
      0,
    )).toBe(10_000);
    expect(pickHistoryRowsWritten(
      { rows_total: 10_000, rows_sent: 10_000, rows_written: 0 },
      6_500,
    )).toBe(10_000);
  });
});

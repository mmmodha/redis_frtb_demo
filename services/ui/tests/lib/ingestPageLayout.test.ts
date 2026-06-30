import { describe, it, expect } from "vitest";
import {
  deriveIngestPageMode,
  canChangePreset,
  canStartRun,
  shouldShowPresetPicker,
  shouldShowProgress,
  shouldShowSummary,
  shouldShowWriteRate,
  ingestRunZoneTitle,
} from "../../src/lib/ingestPageLayout";

describe("ingestPageLayout", () => {
  it("derives page mode from run phase and start inflight", () => {
    expect(deriveIngestPageMode("hidden", false)).toBe("idle");
    expect(deriveIngestPageMode("hidden", true)).toBe("starting");
    expect(deriveIngestPageMode("running", false)).toBe("running");
    expect(deriveIngestPageMode("summary", false)).toBe("summary");
  });

  it("locks preset picker while starting or running", () => {
    expect(canChangePreset("idle")).toBe(true);
    expect(canChangePreset("starting")).toBe(false);
    expect(canChangePreset("running")).toBe(false);
    expect(canChangePreset("summary")).toBe(false);
  });

  it("only allows start when idle and target is not blocked", () => {
    expect(canStartRun("idle", false)).toBe(true);
    expect(canStartRun("idle", true)).toBe(false);
    expect(canStartRun("running", false)).toBe(false);
  });

  it("shows presets during idle and starting only", () => {
    expect(shouldShowPresetPicker("idle")).toBe(true);
    expect(shouldShowPresetPicker("starting")).toBe(true);
    expect(shouldShowPresetPicker("running")).toBe(false);
    expect(shouldShowPresetPicker("summary")).toBe(false);
  });

  it("shows progress and write rate only while running", () => {
    expect(shouldShowProgress("running")).toBe(true);
    expect(shouldShowProgress("idle")).toBe(false);
    expect(shouldShowWriteRate("running")).toBe(true);
    expect(shouldShowWriteRate("idle")).toBe(false);
  });

  it("shows summary only in summary mode", () => {
    expect(shouldShowSummary("summary")).toBe(true);
    expect(shouldShowSummary("idle")).toBe(false);
  });

  it("titles the run zone by mode", () => {
    expect(ingestRunZoneTitle("idle")).toBe("Start ingest");
    expect(ingestRunZoneTitle("starting")).toBe("Starting…");
    expect(ingestRunZoneTitle("running")).toBe("Ingesting");
    expect(ingestRunZoneTitle("summary")).toBe("Complete");
  });
});

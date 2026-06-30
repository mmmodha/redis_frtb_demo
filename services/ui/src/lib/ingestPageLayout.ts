import type { RunUiPhase } from "./ingestRunState";

/** High-level page mode — drives what the operator sees in the primary run zone. */
export type IngestPageMode = "idle" | "starting" | "running" | "summary";

export function deriveIngestPageMode(
  runPhase: RunUiPhase,
  presetInflight: boolean,
): IngestPageMode {
  if (presetInflight) return "starting";
  if (runPhase === "running") return "running";
  if (runPhase === "summary") return "summary";
  return "idle";
}

export function canChangePreset(mode: IngestPageMode): boolean {
  return mode === "idle";
}

export function canStartRun(mode: IngestPageMode, targetBlocked: boolean): boolean {
  return mode === "idle" && !targetBlocked;
}

export function shouldShowPresetPicker(mode: IngestPageMode): boolean {
  return mode === "idle" || mode === "starting";
}

export function shouldShowProgress(mode: IngestPageMode): boolean {
  return mode === "running";
}

export function shouldShowSummary(mode: IngestPageMode): boolean {
  return mode === "summary";
}

export function shouldShowWriteRate(mode: IngestPageMode): boolean {
  return mode === "running";
}

export function ingestRunZoneTitle(mode: IngestPageMode): string {
  switch (mode) {
    case "running": return "Ingesting";
    case "summary": return "Complete";
    case "starting": return "Starting…";
    default: return "Start ingest";
  }
}

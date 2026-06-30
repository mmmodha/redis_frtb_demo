export type RunPresetKey = "quick" | "demo" | "medium" | "large" | "xl" | "overnight" | "xxl" | "enterprise";

export interface RunPreset {
  key: RunPresetKey;
  label: string;
  rows: number;
  description: string;
}

export const RUN_PRESETS: Record<RunPresetKey, RunPreset> = {
  quick:     { key: "quick",     label: "10K",   rows: 10_000,      description: "Sanity check — seconds" },
  demo:      { key: "demo",      label: "100K",  rows: 100_000,     description: "Short demo dataset" },
  medium:    { key: "medium",    label: "1M",    rows: 1_000_000,   description: "Typical benchmark size" },
  large:     { key: "large",     label: "10M",   rows: 10_000_000,  description: "Large benchmark" },
  xl:        { key: "xl",        label: "50M",   rows: 50_000_000,  description: "Extended soak" },
  overnight: { key: "overnight", label: "100M",  rows: 100_000_000, description: "Overnight-scale load" },
  xxl:       { key: "xxl",       label: "200M",  rows: 200_000_000, description: "Maximum stress profile" },
  enterprise: { key: "enterprise", label: "400M", rows: 400_000_000, description: "Redis Enterprise demo scale" },
};

export const PRESET_TIERS: { id: string; label: string; keys: RunPresetKey[] }[] = [
  { id: "smoke", label: "Smoke test", keys: ["quick", "demo"] },
  { id: "benchmark", label: "Benchmark", keys: ["medium", "large"] },
  { id: "stress", label: "Stress", keys: ["xl", "overnight", "xxl", "enterprise"] },
];

export const RUN_PRESET_ORDER: RunPresetKey[] = [
  "quick", "demo", "medium", "large", "xl", "overnight", "xxl", "enterprise",
];

/** Docker-friendly worker count by preset size (1M → 4, 10M → 6, etc.). */
export function suggestWorkersForPreset(key: RunPresetKey): number {
  const rows = RUN_PRESETS[key].rows;
  if (rows <= 100_000) return 2;
  if (rows <= 1_000_000) return 4;
  if (rows <= 10_000_000) return 6;
  if (rows <= 100_000_000) return 8;
  return 8;
}

// Wave 5.84C — cluster-adaptive profile. Maps a ClusterShape + host CPU
// count to a profile name (small/medium/large) and emits the concrete dial
// values (workers / batch-size / pipeline-window). Manual flag overrides
// merge on top via `resolveDials` so manual always wins (DoD #4).
//
// Profile table (matches the task note's informational table):
//   small  : standalone OR 1 master shard      → workers=1, batch=500,  window=1
//   medium : 2..3 master shards                → workers=2, batch=1500, window=2
//   large  : 4+  master shards                 → workers=min(shards,cpus), batch=2000, window=2

import { BYTES_PER_ROW, type ClusterShape } from "./probe.ts";

export type ProfileName = "small" | "medium" | "large";

export interface ProfileDials {
  workers: number;
  batchSize: number;
  pipelineWindow: number;
}

export interface ResolvedDials extends ProfileDials {
  /** Profile picked (or explicitly requested). */
  profile: ProfileName;
  /** Which dials were overridden manually (manual always wins — DoD #4). */
  overrides: { workers: boolean; batchSize: boolean; pipelineWindow: boolean };
}

// Auto-select a profile from the probed shape. Used when --profile=auto.
export function pickProfile(shape: ClusterShape): ProfileName {
  if (shape.mode === "standalone" || shape.shards <= 1) return "small";
  if (shape.shards <= 3) return "medium";
  return "large";
}

// Emit the concrete dials for a given profile + shape + host CPU count.
// `large` caps workers at `min(shards, hostCores)` per the task spec.
export function profileDials(name: ProfileName, shape: ClusterShape, hostCores: number): ProfileDials {
  switch (name) {
    case "small":  return { workers: 1, batchSize: 500,  pipelineWindow: 1 };
    case "medium": return { workers: 2, batchSize: 1500, pipelineWindow: 2 };
    case "large":  return { workers: Math.max(1, Math.min(shape.shards, Math.max(1, hostCores))), batchSize: 2000, pipelineWindow: 2 };
  }
}

// Merge manual overrides on top of profile dials. Each `manual.*` is the
// raw value or undefined; undefined means "no override, use the profile's
// dial". Manual always wins (DoD #4) — no clamping here so the explicit
// operator choice is preserved end-to-end.
export function resolveDials(
  profile: ProfileName, shape: ClusterShape, hostCores: number,
  manual: Partial<ProfileDials> = {},
): ResolvedDials {
  const base = profileDials(profile, shape, hostCores);
  return {
    profile,
    workers: manual.workers ?? base.workers,
    batchSize: manual.batchSize ?? base.batchSize,
    pipelineWindow: manual.pipelineWindow ?? base.pipelineWindow,
    overrides: {
      workers: manual.workers !== undefined,
      batchSize: manual.batchSize !== undefined,
      pipelineWindow: manual.pipelineWindow !== undefined,
    },
  };
}

export interface RefuseOrGoResult {
  /** True when the run is safe to start (or maxmemory is uncapped/unknown). */
  allowed: boolean;
  /** Estimated bytes the run will add to the target. */
  estimatedBytes: number;
  /** Per-row estimate used (BYTES_PER_ROW). */
  bytesPerRow: number;
  /** Aggregate maxmemory across master shards (bytes); 0 when no cap. */
  maxmemoryBytes: number;
  /** Threshold = 50% of maxmemoryBytes (0 when no cap). */
  thresholdBytes: number;
}

// Refuse-or-go: requested rows × BYTES_PER_ROW > 50% of cluster maxmemory ⇒
// allowed=false unless the caller bypasses via --force. When maxmemoryBytes
// is 0 (no cap configured / probe failed) the check is skipped and the run
// proceeds.
export function refuseOrGo(shape: ClusterShape, rows: number, bytesPerRow: number = BYTES_PER_ROW): RefuseOrGoResult {
  const estimatedBytes = bytesPerRow * Math.max(0, rows);
  if (shape.maxmemoryBytes <= 0) {
    return { allowed: true, estimatedBytes, bytesPerRow, maxmemoryBytes: 0, thresholdBytes: 0 };
  }
  const thresholdBytes = Math.floor(shape.maxmemoryBytes / 2);
  return { allowed: estimatedBytes <= thresholdBytes, estimatedBytes, bytesPerRow, maxmemoryBytes: shape.maxmemoryBytes, thresholdBytes };
}

// Very rough estimated duration in seconds — used only for the plan block
// (human-readable). Assumes ~30k rows/sec/worker as a conservative floor
// (the throughput.test row builder alone hits ≥200k/s; the producer is the
// bottleneck). Never returns NaN/Infinity for callers' formatting.
export function estimateDurationSec(rows: number, workers: number): number {
  const throughputFloor = 30_000;
  const perSec = Math.max(1, workers) * throughputFloor;
  const sec = rows / perSec;
  return Number.isFinite(sec) ? sec : 0;
}

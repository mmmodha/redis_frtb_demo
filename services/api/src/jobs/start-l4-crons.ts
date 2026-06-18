// Wave 6.39.C-fix — Layer 4 boot wiring.
//
// 6.39.C shipped the drift detector, snapshot job, and stream-retention
// computation as units, but no boot path invoked them — /admin/drift-status
// and /admin/snapshots stayed empty in production and the dynamic
// computeMaxLen value was never pushed back into Redis. This module wires
// all three into the post-listen boot hook, reading interval + cap config
// from env so a single DISABLE_L4_CRONS=1 toggle skips registration (used
// by SMOKE=1 / single-shot test runs / boot-smoke regression tests).
//
// Trim path chosen: (b) periodic XTRIM. Keeps the change isolated from the
// generator XADD call sites (which 6.39.A locked) and from routes/generator
// (where the DEFAULT_STREAM_MAXLEN = 2_000_000 fallback already protects
// the active-run window). The cap is re-read per tick so a runtime change
// to INGEST_PEAK_RATE_PER_SEC / INGEST_STREAM_MAXLEN takes effect on the
// next tick without restart.

import type { RedisLike } from "../redis-like.ts";
import {
  startDriftDetectorCron,
  type DriftSensitivity,
} from "./drift-detector.ts";
import { startSnapshotCron } from "./snapshot.ts";
import { computeMaxLen, DEFAULT_STREAM_KEY } from "./stream-retention.ts";

export interface StartL4CronsOpts {
  redis: RedisLike;
  // Production wires this to the same FT.AGGREGATE bridge admin.ts uses for
  // /admin/reconcile-bucket; tests supply a fixture. Defaults to 0 so a
  // schema-less boot still ticks the detector (the tick itself is the
  // "did the job run" signal feeding /metrics).
  recomputeSum?: (
    rc: string,
    bucket: string,
    sens: DriftSensitivity,
  ) => Promise<number>;
  log?: { error: (obj: Record<string, unknown>) => void };
  // Test seam — overrides process.env for the env reads below so tests can
  // exercise both the kill switch and the interval defaults without
  // mutating the actual process env.
  env?: NodeJS.ProcessEnv;
}

export interface L4CronsHandle {
  stop: () => void;
  registered: { drift: boolean; snapshot: boolean; streamTrim: boolean };
}

export function startL4Crons(opts: StartL4CronsOpts): L4CronsHandle {
  const env = opts.env ?? process.env;
  if (env.DISABLE_L4_CRONS === "1") {
    return {
      stop: () => undefined,
      registered: { drift: false, snapshot: false, streamTrim: false },
    };
  }

  const driftMin = Number(env.DRIFT_CHECK_INTERVAL_MIN ?? "15");
  const snapMin = Number(env.SNAPSHOT_INTERVAL_MIN ?? "60");
  const trimMin = Number(env.STREAM_TRIM_INTERVAL_MIN ?? "60");

  const sens = (env.DRIFT_SENSITIVITY ?? "Delta") as DriftSensitivity;
  const stopDrift = startDriftDetectorCron({
    redis: opts.redis,
    sensitivityType: sens,
    intervalMs: Math.max(1, driftMin * 60_000),
    recomputeSum: opts.recomputeSum ?? (async () => 0),
    log: opts.log,
  });

  const stopSnap = startSnapshotCron({
    redis: opts.redis,
    intervalMs: Math.max(1, snapMin * 60_000),
    log: opts.log,
  });

  // Path (b) — periodic XTRIM. Explicit INGEST_STREAM_MAXLEN wins; otherwise
  // we derive from peak rate via computeMaxLen (same formula the admin
  // /admin/stream-status surface reports, so the displayed cap matches the
  // enforced cap). Zero / missing cap → skip XTRIM (we never want to call
  // XTRIM ~ 0, which would drain the stream).
  const streamKey = env.STREAM_KEY ?? DEFAULT_STREAM_KEY;
  const getCap = (): number => {
    const explicit = Number(env.INGEST_STREAM_MAXLEN ?? "0");
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const peak = Number(env.INGEST_PEAK_RATE_PER_SEC ?? "0");
    return computeMaxLen(peak);
  };
  const trimTick = async (): Promise<void> => {
    const cap = getCap();
    if (!Number.isFinite(cap) || cap <= 0) return;
    try {
      await opts.redis.call(
        "XTRIM",
        streamKey,
        "MAXLEN",
        "~",
        String(cap),
      );
    } catch (err) {
      opts.log?.error?.({ event: "stream_trim_tick_failed", err: String(err) });
    }
  };
  const trimHandle = setInterval(() => {
    void trimTick();
  }, Math.max(1, trimMin * 60_000));

  return {
    stop: () => {
      stopDrift();
      stopSnap();
      clearInterval(trimHandle);
    },
    registered: { drift: true, snapshot: true, streamTrim: true },
  };
}

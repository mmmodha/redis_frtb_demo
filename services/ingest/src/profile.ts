// Wave 6.15a — env-flag-gated per-runner hot-path profiler.
//
// Activated only when INGEST_PROFILE=1. When unset, the consumer never
// constructs a RunnerProfile so all timer branches in processBatch fall
// through their `if (profile)` guards — keeping the hot path byte-identical
// to the pre-6.15a behaviour. Use process.hrtime.bigint() (nanosecond
// monotonic) for the timers — Date.now() is millisecond-quantised and would
// bucket sub-ms steps into 0.

import pino from "pino";

export const PROFILE_ENABLED: boolean = process.env.INGEST_PROFILE === "1";

const REPORT_INTERVAL_MS = Number(process.env.INGEST_PROFILE_INTERVAL_MS ?? "5000");

const profileLog = PROFILE_ENABLED ? pino({ level: "info", name: "ingest-profile" }) : null;

// Steps we time around. `fetch` is the XREADGROUP await; `parse` is
// fieldsToMap+buildDoc+enrichDoc+JSON.stringify per row; `pipe_build` is the
// in-memory pipeline.call queueing per row (write + ack); `pipe_exec` is the
// final await pipeline.exec() round-trip for the whole batch.
type Step = "fetch" | "parse" | "pipe_build" | "pipe_exec";

export interface RunnerProfile {
  // Per-row counters. rows_read = entries returned by XREADGROUP;
  // rows_applied = entries that produced a JSON.SET (not malformed);
  // rows_acked = entries XACKed (malformed + applied both count).
  recordRowsRead(n: number): void;
  recordRowsApplied(n: number): void;
  recordRowsAcked(n: number): void;
  // Per-step nanosecond timings. Caller passes a bigint delta from a
  // matching hrtime.bigint() pair — see processBatch.
  recordStep(step: Step, ns: bigint): void;
  // Flush a single roll-up line and reset the window counters.
  emitWindowSummary(): void;
  // Final consolidated summary for the lifetime of this runner.
  emitFinalSummary(): void;
  // Start/stop the 5s reporter timer.
  start(): void;
  stop(): void;
  // For tests.
  readonly snapshot: {
    readonly totals: { rows_read: number; rows_applied: number; rows_acked: number };
    readonly stepNsTotal: Record<Step, bigint>;
  };
}

interface Window {
  rows_read: number;
  rows_applied: number;
  rows_acked: number;
  step_ns: { fetch: bigint; parse: bigint; pipe_build: bigint; pipe_exec: bigint };
  wall_start_ns: bigint;
}

function makeWindow(): Window {
  return {
    rows_read: 0, rows_applied: 0, rows_acked: 0,
    step_ns: { fetch: 0n, parse: 0n, pipe_build: 0n, pipe_exec: 0n },
    wall_start_ns: process.hrtime.bigint(),
  };
}

export function createRunnerProfile(shardLabel: string): RunnerProfile {
  // Window is the rolling 5s bucket; totals accumulate for the lifetime
  // summary emitted on stop(). step_ns_total mirrors window.step_ns but
  // never resets so the final per-step ms/row average is over the full run.
  let win: Window = makeWindow();
  const totals = { rows_read: 0, rows_applied: 0, rows_acked: 0 };
  const stepNsTotal: Record<Step, bigint> = { fetch: 0n, parse: 0n, pipe_build: 0n, pipe_exec: 0n };
  const runStartNs = process.hrtime.bigint();
  let timer: NodeJS.Timeout | null = null;

  const nsToMs = (ns: bigint): number => Number(ns) / 1_000_000;
  const msPerRow = (ns: bigint, rows: number): number =>
    rows > 0 ? nsToMs(ns) / rows : 0;

  function emitWindowSummary(): void {
    if (!profileLog) return;
    const nowNs = process.hrtime.bigint();
    const wallNs = nowNs - win.wall_start_ns;
    const workNs = win.step_ns.fetch + win.step_ns.parse + win.step_ns.pipe_build + win.step_ns.pipe_exec;
    const idleNs = wallNs > workNs ? wallNs - workNs : 0n;
    const wallMs = nsToMs(wallNs);
    const rps = wallMs > 0 ? Math.round((win.rows_applied / wallMs) * 1000) : 0;
    profileLog.info({
      shard_id: shardLabel,
      window_ms: Math.round(wallMs),
      rows_read: win.rows_read,
      rows_applied: win.rows_applied,
      rows_acked: win.rows_acked,
      rps,
      ms_per_row: {
        fetch: +msPerRow(win.step_ns.fetch, win.rows_applied).toFixed(4),
        parse: +msPerRow(win.step_ns.parse, win.rows_applied).toFixed(4),
        pipe_build: +msPerRow(win.step_ns.pipe_build, win.rows_applied).toFixed(4),
        pipe_exec: +msPerRow(win.step_ns.pipe_exec, win.rows_applied).toFixed(4),
      },
      idle_ms: Math.round(nsToMs(idleNs)),
      idle_pct: wallNs > 0n ? +(Number(idleNs) * 100 / Number(wallNs)).toFixed(1) : 0,
    }, "ingest profile 5s window");
    win = makeWindow();
  }

  function emitFinalSummary(): void {
    if (!profileLog) return;
    const nowNs = process.hrtime.bigint();
    const wallNs = nowNs - runStartNs;
    const workNs = stepNsTotal.fetch + stepNsTotal.parse + stepNsTotal.pipe_build + stepNsTotal.pipe_exec;
    const idleNs = wallNs > workNs ? wallNs - workNs : 0n;
    const wallMs = nsToMs(wallNs);
    const rps = wallMs > 0 ? Math.round((totals.rows_applied / wallMs) * 1000) : 0;
    profileLog.info({
      shard_id: shardLabel,
      kind: "final",
      run_ms: Math.round(wallMs),
      rows_read: totals.rows_read,
      rows_applied: totals.rows_applied,
      rows_acked: totals.rows_acked,
      rps_avg: rps,
      ms_per_row: {
        fetch: +msPerRow(stepNsTotal.fetch, totals.rows_applied).toFixed(4),
        parse: +msPerRow(stepNsTotal.parse, totals.rows_applied).toFixed(4),
        pipe_build: +msPerRow(stepNsTotal.pipe_build, totals.rows_applied).toFixed(4),
        pipe_exec: +msPerRow(stepNsTotal.pipe_exec, totals.rows_applied).toFixed(4),
      },
      idle_ms: Math.round(nsToMs(idleNs)),
      idle_pct: wallNs > 0n ? +(Number(idleNs) * 100 / Number(wallNs)).toFixed(1) : 0,
    }, "ingest profile final");
  }

  return {
    recordRowsRead(n) { win.rows_read += n; totals.rows_read += n; },
    recordRowsApplied(n) { win.rows_applied += n; totals.rows_applied += n; },
    recordRowsAcked(n) { win.rows_acked += n; totals.rows_acked += n; },
    recordStep(step, ns) { win.step_ns[step] += ns; stepNsTotal[step] += ns; },
    emitWindowSummary, emitFinalSummary,
    start() {
      if (timer) return;
      timer = setInterval(emitWindowSummary, REPORT_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    get snapshot() { return { totals, stepNsTotal }; },
  };
}

// Wave 5.92C — producer-side stream backpressure (XLEN credit gate).
//
// These tests drive `createStreamFlowControl` against a stub XLEN client that
// returns scripted values per call, so the pause/resume state machine can be
// exercised deterministically without a live redis.

import { describe, it, expect } from "vitest";
import { createStreamFlowControl, DEFAULT_FLOW_CONTROL } from "../src/flow-control.ts";

interface RecordedLog { level: "info" | "warn"; obj: Record<string, unknown>; msg: string }

function captureLogger() {
  const lines: RecordedLog[] = [];
  return {
    lines,
    info(obj: object, msg: string) { lines.push({ level: "info", obj: obj as Record<string, unknown>, msg }); },
    warn(obj: object, msg: string) { lines.push({ level: "warn", obj: obj as Record<string, unknown>, msg }); },
  };
}

// XLEN stub — script per-stream return values; calls beyond the script reuse
// the last value (steady state). Tracks the call count per stream so the
// re-poll loop can be inspected.
function stubXlenClient(script: Record<string, number[]>) {
  const calls: Record<string, number> = {};
  return {
    calls,
    async xlen(key: string): Promise<number> {
      calls[key] = (calls[key] ?? 0) + 1;
      const seq = script[key] ?? [0];
      const idx = Math.min(calls[key]! - 1, seq.length - 1);
      return seq[idx]!;
    },
  };
}

describe("createStreamFlowControl", () => {
  it("no-ops below the row-check threshold (XLEN is not polled)", async () => {
    const client = stubXlenClient({});
    const log = captureLogger();
    const fc = createStreamFlowControl(client, { flowCheckEveryRows: 1000 }, log);
    await fc.afterBatch("s", 100);
    await fc.afterBatch("s", 100);
    expect(client.calls.s).toBeUndefined();
    expect(fc.isPaused).toBe(false);
    expect(log.lines).toHaveLength(0);
  });

  it("polls XLEN once every flowCheckEveryRows accumulated rows", async () => {
    const client = stubXlenClient({ s: [50] });
    const log = captureLogger();
    const fc = createStreamFlowControl(client, { flowCheckEveryRows: 1000, pauseAboveLen: 10_000, resumeBelowLen: 5_000 }, log);
    for (let i = 0; i < 9; i++) await fc.afterBatch("s", 100);
    expect(client.calls.s).toBeUndefined();
    await fc.afterBatch("s", 100);
    expect(client.calls.s).toBe(1);
    expect(fc.xlens.s).toBe(50);
    expect(fc.isPaused).toBe(false);
  });

  it("pauses producer when XLEN exceeds pauseAboveLen and resumes once back under resumeBelowLen", async () => {
    // Poll 1: 2_000_000 (>1.5M) ⇒ pause. Poll 2: 1_800_000 (still above resume=1M) ⇒ stay paused.
    // Poll 3: 900_000 (<1M) ⇒ resume.
    const client = stubXlenClient({ s: [2_000_000, 1_800_000, 900_000] });
    const log = captureLogger();
    const fc = createStreamFlowControl(
      client,
      { flowCheckEveryRows: 1000, pauseAboveLen: 1_500_000, resumeBelowLen: 1_000_000, pauseSleepMs: 1 },
      log,
    );
    await fc.afterBatch("s", 1000);
    expect(client.calls.s).toBe(3);
    expect(fc.isPaused).toBe(false);
    const warns = log.lines.filter((l) => l.level === "warn");
    const resumes = log.lines.filter((l) => l.obj.evt === "stream-backpressure-resume");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj.evt).toBe("stream-backpressure-pause");
    expect(warns[0]!.obj.stream).toBe("s");
    expect(warns[0]!.obj.xlen).toBe(2_000_000);
    expect(resumes).toHaveLength(1);
  });

  it("logs pause + resume exactly once per transition (no log spam during sustained pause)", async () => {
    // 5 polls above resume threshold, then 1 below — only one pause line +
    // one resume line should be emitted (DoD #4).
    const client = stubXlenClient({ s: [2_000_000, 1_900_000, 1_800_000, 1_700_000, 1_600_000, 900_000] });
    const log = captureLogger();
    const fc = createStreamFlowControl(
      client,
      { flowCheckEveryRows: 100, pauseAboveLen: 1_500_000, resumeBelowLen: 1_000_000, pauseSleepMs: 1 },
      log,
    );
    await fc.afterBatch("s", 100);
    const pauseLines = log.lines.filter((l) => l.obj.evt === "stream-backpressure-pause");
    const resumeLines = log.lines.filter((l) => l.obj.evt === "stream-backpressure-resume");
    expect(pauseLines).toHaveLength(1);
    expect(resumeLines).toHaveLength(1);
    expect(client.calls.s).toBe(6);
  });

  it("multi-stream: pauses on the offending stream and only resumes when ALL streams drop under threshold", async () => {
    // Stream A is the trigger (>pause). Stream B stays high through the
    // re-poll loop and only drops below resume on poll 3.
    const client = stubXlenClient({
      a: [2_000_000, 500_000, 500_000],
      b: [800_000, 1_200_000, 900_000],
    });
    const log = captureLogger();
    const fc = createStreamFlowControl(
      client,
      { flowCheckEveryRows: 100, pauseAboveLen: 1_500_000, resumeBelowLen: 1_000_000, pauseSleepMs: 1 },
      log,
    );
    await fc.afterBatch("a", 50);
    await fc.afterBatch("b", 50);
    expect(client.calls.a).toBe(3);
    expect(client.calls.b).toBe(3);
    expect(fc.isPaused).toBe(false);
    expect(log.lines.filter((l) => l.obj.evt === "stream-backpressure-pause")).toHaveLength(1);
    expect(log.lines.filter((l) => l.obj.evt === "stream-backpressure-resume")).toHaveLength(1);
  });

  it("emits a per-poll `stream-xlen` info line so observability sees backpressure snapshots", async () => {
    const client = stubXlenClient({ s: [42] });
    const log = captureLogger();
    const fc = createStreamFlowControl(client, { flowCheckEveryRows: 100, pauseAboveLen: 1000, resumeBelowLen: 500 }, log);
    await fc.afterBatch("s", 100);
    const snapshots = log.lines.filter((l) => l.obj.evt === "stream-xlen");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.obj.xlens).toEqual({ s: 42 });
  });

  it("rejects misconfigured thresholds (resume >= pause)", () => {
    const client = stubXlenClient({});
    const log = captureLogger();
    expect(() =>
      createStreamFlowControl(client, { pauseAboveLen: 1000, resumeBelowLen: 1000 }, log),
    ).toThrow(/resumeBelowLen.*pauseAboveLen/);
  });

  it("DEFAULT_FLOW_CONTROL matches the wave 5.92C spec (pause=1.5M, resume=1M, check=50k)", () => {
    expect(DEFAULT_FLOW_CONTROL.flowCheckEveryRows).toBe(50_000);
    expect(DEFAULT_FLOW_CONTROL.pauseAboveLen).toBe(1_500_000);
    expect(DEFAULT_FLOW_CONTROL.resumeBelowLen).toBe(1_000_000);
  });
});

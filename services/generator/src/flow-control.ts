// Wave 5.92C — producer-side stream backpressure.
//
// Polls XLEN on each stream the producer has touched and pauses XADD with a
// short sleep when any stream's length exceeds `pauseAboveLen`. Resumes once
// every known stream is back under `resumeBelowLen`. This is a producer-side
// credit/window — Redis itself does not block; we just stop calling XADD.
//
// Pause + resume are logged exactly once per transition (DoD #4) — the
// per-poll `evt: "stream-xlen"` line is the metrics surface (DoD: surface
// xlen for observability) and is separate from the transition lines so log
// readers can distinguish a sustained pause from continuous re-checks.

import type { Redis, Cluster } from "ioredis";

export interface FlowControlOptions {
  /** How many ADDed rows between XLEN polls. Default 50_000. */
  flowCheckEveryRows?: number;
  /** Pause XADD when any stream's XLEN > this value. Default 1_500_000. */
  pauseAboveLen?: number;
  /** Resume XADD only when every stream's XLEN < this value. Default 1_000_000. */
  resumeBelowLen?: number;
  /** Sleep between re-polls while paused. Default 100 ms. */
  pauseSleepMs?: number;
}

export interface FlowControlLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface StreamFlowControl {
  /** Called by the producer after each successful XADD batch. May sleep. */
  afterBatch(streamKey: string, batchSize: number): Promise<void>;
  /** Latest known per-stream XLEN snapshot (last successful poll). */
  readonly xlens: Readonly<Record<string, number>>;
  /** True while the producer is being held in the pause loop. */
  readonly isPaused: boolean;
}

export const DEFAULT_FLOW_CONTROL: Required<FlowControlOptions> = {
  flowCheckEveryRows: 50_000,
  pauseAboveLen: 1_500_000,
  resumeBelowLen: 1_000_000,
  pauseSleepMs: 100,
};

type XlenClient = Pick<Redis | Cluster, "xlen">;

export function createStreamFlowControl(
  client: XlenClient,
  options: FlowControlOptions,
  log: FlowControlLogger,
): StreamFlowControl {
  const o = { ...DEFAULT_FLOW_CONTROL, ...options };
  if (o.resumeBelowLen >= o.pauseAboveLen) {
    throw new Error(
      `flow-control: resumeBelowLen (${o.resumeBelowLen}) must be < pauseAboveLen (${o.pauseAboveLen})`,
    );
  }
  const xlens: Record<string, number> = {};
  const knownStreams = new Set<string>();
  let rowsSinceCheck = 0;
  let paused = false;

  async function pollAll(): Promise<{ maxLen: number; offending: string | null }> {
    const keys = [...knownStreams];
    if (keys.length === 0) return { maxLen: 0, offending: null };
    const results = await Promise.allSettled(keys.map((k) => client.xlen(k)));
    let max = 0;
    let offending: string | null = null;
    for (let i = 0; i < keys.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") {
        const n = Number(r.value) || 0;
        xlens[keys[i]!] = n;
        if (n > max) { max = n; offending = keys[i]!; }
      }
    }
    log.info({ evt: "stream-xlen", xlens: { ...xlens } }, "stream xlen poll");
    return { maxLen: max, offending };
  }

  async function gate(): Promise<void> {
    const first = await pollAll();
    if (first.maxLen <= o.pauseAboveLen) return;
    if (!paused) {
      paused = true;
      log.warn(
        {
          evt: "stream-backpressure-pause",
          stream: first.offending,
          xlen: first.maxLen,
          pause_above: o.pauseAboveLen,
        },
        `stream backpressure: ${first.offending} xlen=${first.maxLen} > ${o.pauseAboveLen}; pausing XADD`,
      );
    }
    // Re-poll loop: no additional log lines per check so a sustained pause
    // does not flood stdout (DoD #4 — single line per transition).
    while (true) {
      await sleep(o.pauseSleepMs);
      const next = await pollAll();
      if (next.maxLen < o.resumeBelowLen) break;
    }
    paused = false;
    log.info(
      { evt: "stream-backpressure-resume", resume_below: o.resumeBelowLen, xlens: { ...xlens } },
      `stream backpressure resumed (all streams < ${o.resumeBelowLen})`,
    );
  }

  return {
    async afterBatch(streamKey: string, batchSize: number): Promise<void> {
      knownStreams.add(streamKey);
      rowsSinceCheck += batchSize;
      if (rowsSinceCheck >= o.flowCheckEveryRows) {
        rowsSinceCheck = 0;
        await gate();
      }
    },
    get xlens() { return xlens; },
    get isPaused() { return paused; },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

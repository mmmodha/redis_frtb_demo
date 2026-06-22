// Wave 7.0.1.B — worker unit tests.
//
// Covers the Definition-of-Done bullets that are worker-local:
//   • Slim HSET argv shape (TAGs + s_* NUMERICs; no weighted_*, no per-tenor
//     JSON, no trader / _calibration).
//   • Batch-full and idle-timeout flush triggers.
//   • Transient error → retry with bounded attempts → dead-letter.
//   • Permanent error (WRONGTYPE) → immediate dead-letter.
//   • Per-worker metrics: queued, flushed, errors, dead_lettered, last latency.

import { describe, it, expect } from "vitest";
import { createWorker, rowToHashFields, isPermanentError, isOomError, type Row } from "../src/worker.ts";
import { FakeWriteClient } from "./helpers/fake-write-client.ts";

function girrDeltaPerTenor(id: string, tenors: Record<string, number>): Row {
  return {
    id,
    risk_class: "GIRR",
    bucket: "USD",
    sensitivity_type: "Delta",
    book: "B1",
    trade_id: "T1",
    risk_factor: "RF1",
    desk: "D1",
    risk_value: tenors,
  };
}

describe("rowToHashFields — slim contract", () => {
  it("emits the 7 TAG fields and skips trader / _calibration", () => {
    const row = girrDeltaPerTenor("u1", { "3M": 0.1, "6M": 0.2 });
    // intentionally include the dropped fields to prove they get filtered
    (row as Record<string, unknown>).trader = "Alice";
    (row as Record<string, unknown>)._calibration = "demo";
    const args = rowToHashFields(row);
    const fields: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) fields[args[i] as string] = args[i + 1] as string;
    expect(fields.risk_class).toBe("GIRR");
    expect(fields.bucket).toBe("USD");
    expect(fields.sensitivity_type).toBe("Delta");
    expect(fields.book).toBe("B1");
    expect(fields.trade_id).toBe("T1");
    expect(fields.risk_factor).toBe("RF1");
    expect(fields.desk).toBe("D1");
    expect(fields.trader).toBeUndefined();
    expect(fields._calibration).toBeUndefined();
  });

  it("GIRR Delta per-tenor → s_girr_delta_<tenor>", () => {
    const args = rowToHashFields(girrDeltaPerTenor("u1", { "3M": 0.1, "30Y": -0.2 }));
    expect(args).toContain("s_girr_delta_3M");
    expect(args).toContain("0.1");
    expect(args).toContain("s_girr_delta_30Y");
    expect(args).toContain("-0.2");
    // No weighted_* and no scalar `weighted_value`.
    expect(args.some((a) => /^weighted_/.test(a))).toBe(false);
    expect(args.some((a) => a === "weighted_value")).toBe(false);
  });

  it("EQUITY Delta scalar `{spot}` → s_equity_delta", () => {
    const args = rowToHashFields({
      id: "u2", risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta",
      risk_value: { spot: 5.0 },
    });
    expect(args).toContain("s_equity_delta");
    expect(args).toContain("5");
  });

  it("FX Delta scalar `{spot}` → s_fx_delta", () => {
    const args = rowToHashFields({
      id: "u3", risk_class: "FX", bucket: "USDEUR", sensitivity_type: "Delta",
      risk_value: { spot: 1.25 },
    });
    expect(args).toContain("s_fx_delta");
    expect(args).toContain("1.25");
  });

  it("GIRR Vega per-tenor → s_girr_vega_<tenor>", () => {
    const args = rowToHashFields({
      id: "u4", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Vega",
      risk_value: { "3M": 0.3 },
    });
    expect(args).toContain("s_girr_vega_3M");
  });

  it("Equity Curvature scalar → s_equity_cvr_up / s_equity_cvr_down", () => {
    const args = rowToHashFields({
      id: "u5", risk_class: "EQUITY", bucket: "1", sensitivity_type: "Curvature",
      risk_value: { cvr_up: 0.4, cvr_down: -0.3 },
    });
    expect(args).toContain("s_equity_cvr_up");
    expect(args).toContain("0.4");
    expect(args).toContain("s_equity_cvr_down");
    expect(args).toContain("-0.3");
  });

  it("GIRR Curvature per-tenor → s_girr_cvr_{up,down}_<tenor>", () => {
    const args = rowToHashFields({
      id: "u6", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Curvature",
      risk_value: { cvr_up: [0.1, 0.2], cvr_down: [-0.1, -0.2] },
      tenor: ["3M", "6M"],
    });
    expect(args).toContain("s_girr_cvr_up_3M");
    expect(args).toContain("s_girr_cvr_up_6M");
    expect(args).toContain("s_girr_cvr_down_3M");
    expect(args).toContain("s_girr_cvr_down_6M");
  });
});

// Wave 7.0.6.14 — writer-side dense zero-pad. The slim-index FT.AGGREGATE
// LOAD on RediSearch 2.10 raises "Could not find the value …" when a per-
// tenor field is missing from every doc in the response set; padding at
// write time keeps the field present (always "0") without touching calc.
describe("rowToHashFields — per-tenor zero-pad (Wave 7.0.6.14)", () => {
  const GIRR_TENORS: readonly string[] = ["3M", "6M", "1Y", "5Y", "10Y"];
  const tenorsByClass = new Map<string, readonly string[]>([
    ["GIRR", GIRR_TENORS],
  ]);

  function toMap(args: string[]): Record<string, string> {
    const m: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) m[args[i] as string] = args[i + 1] as string;
    return m;
  }

  it("GIRR Delta — pads missing tenors to 0 and preserves real values", () => {
    const args = rowToHashFields(
      girrDeltaPerTenor("u1", { "3M": 0.1, "6M": 0.2 }),
      tenorsByClass,
    );
    const f = toMap(args);
    expect(f.s_girr_delta_3M).toBe("0.1");
    expect(f.s_girr_delta_6M).toBe("0.2");
    expect(f.s_girr_delta_1Y).toBe("0");
    expect(f.s_girr_delta_5Y).toBe("0");
    expect(f.s_girr_delta_10Y).toBe("0");
    // Only `delta` legs — never pad vega/curvature for a Delta row.
    expect(args.some((a) => /^s_girr_vega_/.test(a))).toBe(false);
    expect(args.some((a) => /^s_girr_cvr_/.test(a))).toBe(false);
  });

  it("GIRR Vega — pads missing vega tenors only", () => {
    const args = rowToHashFields(
      {
        id: "u2", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Vega",
        risk_value: { "3M": 0.3 },
      },
      tenorsByClass,
    );
    const f = toMap(args);
    expect(f.s_girr_vega_3M).toBe("0.3");
    expect(f.s_girr_vega_6M).toBe("0");
    expect(f.s_girr_vega_1Y).toBe("0");
    expect(f.s_girr_vega_5Y).toBe("0");
    expect(f.s_girr_vega_10Y).toBe("0");
    expect(args.some((a) => /^s_girr_delta_/.test(a))).toBe(false);
    expect(args.some((a) => /^s_girr_cvr_/.test(a))).toBe(false);
  });

  it("GIRR Curvature — pads BOTH cvr_up and cvr_down per tenor", () => {
    const args = rowToHashFields(
      {
        id: "u3", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Curvature",
        risk_value: { cvr_up: [0.1, 0.2], cvr_down: [-0.1, -0.2] },
        tenor: ["3M", "6M"],
      },
      tenorsByClass,
    );
    const f = toMap(args);
    expect(f.s_girr_cvr_up_3M).toBe("0.1");
    expect(f.s_girr_cvr_up_6M).toBe("0.2");
    expect(f.s_girr_cvr_down_3M).toBe("-0.1");
    expect(f.s_girr_cvr_down_6M).toBe("-0.2");
    for (const t of ["1Y", "5Y", "10Y"]) {
      expect(f[`s_girr_cvr_up_${t}`]).toBe("0");
      expect(f[`s_girr_cvr_down_${t}`]).toBe("0");
    }
    // No delta/vega pollution on a Curvature row.
    expect(args.some((a) => /^s_girr_delta_/.test(a))).toBe(false);
    expect(args.some((a) => /^s_girr_vega_/.test(a))).toBe(false);
  });

  it("EQUITY Delta scalar — class absent from map → no padding emitted", () => {
    const args = rowToHashFields(
      {
        id: "u4", risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta",
        risk_value: { spot: 5 },
      },
      tenorsByClass,
    );
    expect(args).toContain("s_equity_delta");
    expect(args).toContain("5");
    // No per-tenor padding for scalar classes.
    expect(args.some((a) => /^s_equity_delta_/.test(a))).toBe(false);
    // Padding never invents fields for other classes.
    expect(args.some((a) => /^s_girr_/.test(a))).toBe(false);
  });

  it("class present in map but with empty tenor list → no padding", () => {
    const emptyMap = new Map<string, readonly string[]>([["EQUITY", []]]);
    const args = rowToHashFields(
      {
        id: "u5", risk_class: "EQUITY", bucket: "1", sensitivity_type: "Delta",
        risk_value: { spot: 5 },
      },
      emptyMap,
    );
    expect(args).toContain("s_equity_delta");
    expect(args.some((a) => /^s_equity_delta_/.test(a))).toBe(false);
  });

  it("does not overwrite a real per-tenor value with 0", () => {
    const args = rowToHashFields(
      girrDeltaPerTenor("u6", { "5Y": 0.42 }),
      tenorsByClass,
    );
    const f = toMap(args);
    expect(f.s_girr_delta_5Y).toBe("0.42");
    expect(f.s_girr_delta_3M).toBe("0");
    expect(f.s_girr_delta_6M).toBe("0");
    expect(f.s_girr_delta_1Y).toBe("0");
    expect(f.s_girr_delta_10Y).toBe("0");
  });

  it("calling without tenorsByClass leaves output identical to the unpadded path", () => {
    const row = girrDeltaPerTenor("u7", { "3M": 0.1 });
    const without = rowToHashFields(row);
    const withMap = rowToHashFields(row, new Map());
    expect(without).toEqual(withMap);
    // And no `0` padding appears.
    expect(without.some((a) => /^s_girr_delta_(6M|1Y|5Y|10Y)$/.test(a))).toBe(false);
  });

  it("empty TAG fields still filter out (pad does not synthesize empty TAGs)", () => {
    // Row missing optional TAGs (book/desk/etc.). Pad should not invent TAGs.
    const args = rowToHashFields(
      {
        id: "u8", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
        risk_value: { "3M": 0.1 },
      },
      tenorsByClass,
    );
    const f = toMap(args);
    expect(f.book).toBeUndefined();
    expect(f.desk).toBeUndefined();
    expect(f.trade_id).toBeUndefined();
    // …but per-tenor pad is still present.
    expect(f.s_girr_delta_10Y).toBe("0");
  });
});

describe("isPermanentError", () => {
  it("flags WRONGTYPE / syntax error / Protocol error as permanent", () => {
    expect(isPermanentError(new Error("WRONGTYPE Operation against a key …"))).toBe(true);
    expect(isPermanentError(new Error("ERR syntax error"))).toBe(true);
    expect(isPermanentError(new Error("Protocol error: unexpected"))).toBe(true);
  });
  it("leaves connection / busy errors as transient", () => {
    expect(isPermanentError(new Error("Connection is closed."))).toBe(false);
    expect(isPermanentError(new Error("LOADING Redis is loading"))).toBe(false);
    expect(isPermanentError(new Error("MASTERDOWN Link with MASTER is down"))).toBe(false);
  });
});

describe("createWorker — flush triggers", () => {
  it("flushes when batch is full (batchSize=3)", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 3, idleFlushMs: 0 });
    w.push(girrDeltaPerTenor("u1", { "3M": 0.1 }));
    w.push(girrDeltaPerTenor("u2", { "3M": 0.2 }));
    expect(client.hsets).toHaveLength(0); // not yet full
    w.push(girrDeltaPerTenor("u3", { "3M": 0.3 }));
    await w.drain();
    expect(client.hsets).toHaveLength(3);
    expect(client.hsets[0]?.key).toBe("sens:u1");
    expect(w.metrics().flushed).toBe(3);
    expect(w.metrics().queued).toBe(3);
    await w.stop();
  });

  it("flushes after idleFlushMs of inactivity", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 100, idleFlushMs: 20 });
    w.push(girrDeltaPerTenor("u1", { "3M": 0.1 }));
    expect(client.hsets).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 60));
    await w.drain();
    expect(client.hsets).toHaveLength(1);
    expect(w.metrics().lastFlushAt).not.toBeNull();
    expect(w.metrics().lastFlushLatencyMs).not.toBeNull();
    await w.stop();
  });

  it("drain() flushes any remaining buffered rows", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 100, idleFlushMs: 60_000 });
    w.push(girrDeltaPerTenor("u1", { "3M": 0.1 }));
    w.push(girrDeltaPerTenor("u2", { "3M": 0.2 }));
    await w.drain();
    expect(client.hsets).toHaveLength(2);
    await w.stop();
  });
});

describe("createWorker — error handling", () => {
  it("dead-letters a WRONGTYPE row immediately (no retry)", async () => {
    const client = new FakeWriteClient();
    client.nextReplies = [[new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), null]];
    const w = createWorker({ id: 1, client, batchSize: 1, idleFlushMs: 0, maxRetries: 3 });
    w.push(girrDeltaPerTenor("bad", { "3M": 1 }));
    await w.drain();
    expect(w.metrics().errors).toBe(1);
    expect(w.metrics().deadLettered).toBe(1);
    expect(w.metrics().retries).toBe(0);
    expect(client.xadds).toHaveLength(1);
    // First XADD arg is the stream name
    expect(client.xadds[0]?.args[1]).toBe("bulk-loader:dead");
    await w.stop();
  });

  it("retries a transient error up to maxRetries then dead-letters", async () => {
    const client = new FakeWriteClient();
    const transient = new Error("Connection is closed.");
    // Three failing exec replies → exceed maxRetries=3 → dead-letter
    let calls = 0;
    const origPipeline = client.pipeline.bind(client);
    client.pipeline = () => {
      calls++;
      client.nextReplies = [[transient, null]];
      return origPipeline();
    };
    const w = createWorker({ id: 2, client, batchSize: 1, idleFlushMs: 0, maxRetries: 3 });
    w.push(girrDeltaPerTenor("retryMe", { "3M": 1 }));
    await w.drain();
    // 3 attempts total: first + 2 retries before dead-letter on the 3rd error
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(w.metrics().errors).toBe(3);
    expect(w.metrics().retries).toBe(2);
    expect(w.metrics().deadLettered).toBe(1);
    expect(client.xadds).toHaveLength(1);
    await w.stop();
  });

  it("whole-pipeline exec failure is treated as transient per row", async () => {
    const client = new FakeWriteClient();
    client.failNextExec = new Error("Stream isn't writeable");
    const w = createWorker({ id: 3, client, batchSize: 2, idleFlushMs: 0, maxRetries: 3 });
    w.push(girrDeltaPerTenor("a", { "3M": 1 }));
    w.push(girrDeltaPerTenor("b", { "3M": 2 }));
    // Wait a tick; the first exec throws so both rows requeue. The next
    // exec succeeds and commits them.
    await new Promise((r) => setTimeout(r, 10));
    await w.drain();
    expect(client.hsets.length).toBe(2);
    expect(w.metrics().retries).toBeGreaterThanOrEqual(2);
    expect(w.metrics().flushed).toBe(2);
    expect(w.metrics().deadLettered).toBe(0);
    await w.stop();
  });
});

describe("Wave 7.0.6.17 — isOomError + oom_rejected counter", () => {
  const OOM_MSG = "OOM command not allowed when used memory > 'maxmemory'.";
  const OOM_MSG_NO_PERIOD = "OOM command not allowed when used memory > 'maxmemory'";

  it("isOomError matches the exact Redis OOM string (with + without trailing period)", () => {
    expect(isOomError(new Error(OOM_MSG))).toBe(true);
    expect(isOomError(new Error(OOM_MSG_NO_PERIOD))).toBe(true);
    expect(isOomError(new Error("OOM something else"))).toBe(false);
    expect(isOomError(new Error("ERR generic"))).toBe(false);
    expect(isOomError(new Error("Connection is closed."))).toBe(false);
  });

  it("increments oom_rejected alongside errors when the pipeline reply matches OOM", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 1, idleFlushMs: 0, maxRetries: 1 });
    client.nextReplies = [[new Error(OOM_MSG), null]];
    w.push({
      id: "uOOM", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
      risk_value: { "3M": 0.1 },
    });
    await w.drain();
    const m = w.metrics();
    expect(m.errors).toBe(1);
    expect(m.oomRejected).toBe(1);
    // OOM is transient → with maxRetries=1, the first attempt counts as the
    // only attempt and the row is dead-lettered.
    expect(m.deadLettered).toBe(1);
    await w.stop();
  });

  it("does NOT increment oom_rejected for generic ReplyError or network errors", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 2, idleFlushMs: 0, maxRetries: 1 });
    client.nextReplies = [
      [new Error("WRONGTYPE Operation against a key"), null],
      [new Error("Connection is closed."), null],
    ];
    w.push({ id: "u1", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1 } });
    w.push({ id: "u2", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta", risk_value: { "3M": 0.1 } });
    await w.drain();
    const m = w.metrics();
    expect(m.errors).toBe(2);
    expect(m.oomRejected).toBe(0);
    await w.stop();
  });

  it("rate-limits identical OOM warns to one full + one summary per window", async () => {
    const client = new FakeWriteClient();
    const warns: Array<{ obj: object; msg: string }> = [];
    const logger = {
      warn: (obj: object, msg: string) => { warns.push({ obj, msg }); },
    };
    // 50ms window so the test can cross it without sleeping forever.
    const windowMs = 50;
    const w = createWorker({
      id: 0, client, batchSize: 1, idleFlushMs: 0,
      maxRetries: 1, logger, oomLogWindowMs: windowMs,
    });
    for (let i = 0; i < 5; i++) {
      client.nextReplies = [[new Error(OOM_MSG), null]];
      w.push({
        id: `u${i}`, risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
        risk_value: { "3M": 0.1 },
      });
      await w.drain();
    }
    // First OOM logs full detail; the next four are folded silently into the
    // same 50ms window. Dead-letter XADD warnings only fire when XADD itself
    // throws — FakeWriteClient.call returns "1-0" so we never see those here.
    const oomWarns = warns.filter((w) => w.msg === "OOM rejected");
    const summaryWarns = warns.filter((w) => w.msg === "OOM rejected (sustained)");
    expect(oomWarns.length).toBe(1);
    expect(summaryWarns.length).toBe(0); // window still open
    expect(w.metrics().oomRejected).toBe(5);

    // Cross the window, then trigger one more OOM — the prior summary fires.
    await new Promise((r) => setTimeout(r, windowMs + 10));
    client.nextReplies = [[new Error(OOM_MSG), null]];
    w.push({
      id: "uLate", risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
      risk_value: { "3M": 0.1 },
    });
    await w.drain();
    const summary2 = warns.filter((w) => w.msg === "OOM rejected (sustained)");
    expect(summary2.length).toBe(1);
    // count = total occurrences in the closed window (5 = 1 full-detail + 4 folded).
    expect((summary2[0]?.obj as { count?: number }).count).toBe(5);
    // Plus a fresh full-detail warn for the new first occurrence.
    const oomWarns2 = warns.filter((w) => w.msg === "OOM rejected");
    expect(oomWarns2.length).toBe(2);

    await w.stop();
  });

  it("stop() flushes any pending OOM window summary", async () => {
    const client = new FakeWriteClient();
    const warns: Array<{ obj: object; msg: string }> = [];
    const logger = {
      warn: (obj: object, msg: string) => { warns.push({ obj, msg }); },
    };
    const w = createWorker({
      id: 0, client, batchSize: 1, idleFlushMs: 0,
      maxRetries: 1, logger, oomLogWindowMs: 60_000,
    });
    for (let i = 0; i < 3; i++) {
      client.nextReplies = [[new Error(OOM_MSG), null]];
      w.push({
        id: `u${i}`, risk_class: "GIRR", bucket: "USD", sensitivity_type: "Delta",
        risk_value: { "3M": 0.1 },
      });
      await w.drain();
    }
    await w.stop();
    const summaryWarns = warns.filter((w) => w.msg === "OOM rejected (sustained)");
    expect(summaryWarns.length).toBe(1);
    // 3 OOMs total in the window: 1 full-detail + 2 folded into the summary.
    expect((summaryWarns[0]?.obj as { count?: number }).count).toBe(3);
  });
});

describe("createWorker — key shape", () => {
  it("writes sens:<ulid> WITH NO `{...}` hash tag", async () => {
    const client = new FakeWriteClient();
    const w = createWorker({ id: 0, client, batchSize: 1, idleFlushMs: 0 });
    w.push(girrDeltaPerTenor("01HZA00000000000000000", { "3M": 0.1 }));
    await w.drain();
    const key = client.hsets[0]?.key ?? "";
    expect(key).toBe("sens:01HZA00000000000000000");
    expect(key).not.toMatch(/[{}]/);
    await w.stop();
  });
});

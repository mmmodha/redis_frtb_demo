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
import { createWorker, rowToHashFields, isPermanentError, type Row } from "../src/worker.ts";
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

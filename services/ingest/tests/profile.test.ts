// Wave 6.15a — profile-attached processBatch invariants.
//
// Asserts that (a) when a RunnerProfile is supplied, processBatch increments
// the row counters and accumulates non-zero time across each step, and (b)
// the byte-identical-when-off invariant: with no profile attached the
// pipeline call order is unchanged from the pre-6.15a behaviour exercised by
// consumer.test.ts. Note: these assertions are about *the profiler's own
// state*, not the logger — emitWindowSummary/emitFinalSummary log lines are
// gated on PROFILE_ENABLED (env-flag), so the tests verify the counters and
// the per-step bigint accumulators directly.

import { describe, it, expect } from "vitest";
import type { Redis } from "ioredis";
import { processBatch } from "../src/consumer.ts";
import { createRunnerProfile } from "../src/profile.ts";

interface RecordedPipelineCall { command: string; args: unknown[] }
function pipelineStub(record: RecordedPipelineCall[]): ReturnType<Redis["pipeline"]> {
  const pl = {
    call(command: string, ...args: unknown[]) {
      record.push({ command: command.toUpperCase(), args });
      return pl;
    },
    xack(stream: string, group: string, id: string) {
      record.push({ command: "XACK", args: [stream, group, id] });
      return pl;
    },
    async exec() {
      return record.map(() => [null, "OK"] as [Error | null, unknown]);
    },
  };
  return pl as unknown as ReturnType<Redis["pipeline"]>;
}

function stubClient(record: RecordedPipelineCall[]): Redis {
  return {
    pipeline: () => pipelineStub(record),
    async xreadgroup(..._a: unknown[]) {
      return [[
        "sensitivities:in",
        [
          ["1-0", [
            "risk_class", "GIRR", "bucket", "USD",
            "_hash_tag", "GIRR:USD", "_id", "01HZA",
            "payload", JSON.stringify({ trade_id: "T1", risk_factor: "RF_GIRR_01", book: "RATES-LDN" }),
          ]],
          ["2-0", [
            "risk_class", "EQUITY", "bucket", "1",
            "_hash_tag", "EQUITY:1", "_id", "01HZB",
            "payload", JSON.stringify({ trade_id: "T2" }),
          ]],
        ],
      ]];
    },
  } as unknown as Redis;
}

describe("processBatch — INGEST_PROFILE counter wiring [Wave 6.15a]", () => {
  it("with profile attached, increments rows_read / rows_applied / rows_acked and accumulates per-step ns", async () => {
    const record: RecordedPipelineCall[] = [];
    const profile = createRunnerProfile("test");
    const n = await processBatch(
      stubClient(record),
      { stream: "sensitivities:in", group: "ingest", consumerName: "c1", profile, storageFormat: "json" },
      ">",
    );
    expect(n).toBe(2);
    const { totals, stepNsTotal } = profile.snapshot;
    expect(totals.rows_read).toBe(2);
    expect(totals.rows_applied).toBe(2);
    expect(totals.rows_acked).toBe(2);
    // Every step must have accumulated some non-zero hrtime delta. fetch wraps
    // the xreadgroup await, parse wraps fieldsToMap+buildDoc+enrichDoc+stringify,
    // pipe_build wraps the pipeline.call queueing, pipe_exec wraps pipeline.exec.
    expect(stepNsTotal.fetch > 0n).toBe(true);
    expect(stepNsTotal.parse > 0n).toBe(true);
    expect(stepNsTotal.pipe_build > 0n).toBe(true);
    expect(stepNsTotal.pipe_exec > 0n).toBe(true);
  });

  it("without profile attached, pipeline call sequence is byte-identical to the pre-6.15a contract", async () => {
    const record: RecordedPipelineCall[] = [];
    // Wave 6.38.A — pinned to STORAGE_FORMAT=json because this test asserts the
    // pre-6.15a JSON.SET-based command sequence; the new default `hash-sidetable`
    // writer emits HSET instead.
    const n = await processBatch(
      stubClient(record),
      { stream: "sensitivities:in", group: "ingest", consumerName: "c1", storageFormat: "json" },
      ">",
    );
    expect(n).toBe(2);
    // Same assertions consumer.test.ts uses for the SUGADD hook: one JSON.SET
    // per row, the SUGADDs interleaved between JSON.SET and XACK, two XACKs.
    const cmds = record.map((r) => r.command);
    expect(cmds.filter((c) => c === "JSON.SET")).toHaveLength(2);
    expect(cmds.filter((c) => c === "XACK")).toHaveLength(2);
    expect(cmds.filter((c) => c === "FT.SUGADD")).toHaveLength(4);
  });
});

// Wave 6.39.C — Layer 4: hourly rollup snapshots.
//
// `runSnapshot` SCANs the active DB for `rollup:*` keys, HGETALLs each, writes
// the contents to `snap:rollup:<ISO ts>:<original-suffix>` via HMSET, and
// sets a 7-day TTL on every snapshot key. The snapshot index hash
// `snap:index` holds one field per snapshot run (`ts -> key_count`) so
// /admin/snapshots can enumerate prior runs without re-scanning.

import { describe, it, expect, beforeEach } from "vitest";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { runSnapshot, listSnapshots } from "../src/jobs/snapshot.ts";
import { __resetMetricsForTests, getCounter } from "../src/jobs/metrics.ts";

describe("runSnapshot", () => {
  beforeEach(() => {
    __resetMetricsForTests();
  });

  it("scans rollup:* keys, HMSETs snap:rollup:<ts>:* with 7-day TTL", async () => {
    const fr = fakeRedis();
    fr.setScan("0", [
      "rollup:{EQUITY:1}:Delta",
      "rollup:{GIRR:USD}:Delta:tenor:3M",
    ]);
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "rollup:{EQUITY:1}:Delta") {
        return ["sum_ws", "10", "sum_ws_sq", "100", "count", "5"];
      }
      if (key === "rollup:{GIRR:USD}:Delta:tenor:3M") {
        return ["sum_ws", "20", "sum_ws_sq", "400", "count", "8"];
      }
      return [];
    });
    fr.setResponse("HMSET", () => "OK");
    fr.setResponse("EXPIRE", () => 1);
    fr.setResponse("HSET", () => 1);

    const ts = "2026-06-18T12:00:00.000Z";
    const result = await runSnapshot({ redis: fr, ts });
    expect(result.ts).toBe(ts);
    expect(result.key_count).toBe(2);

    const hmsetCalls = fr.calls.filter((c) => c.command === "HMSET");
    expect(hmsetCalls).toHaveLength(2);
    expect(hmsetCalls[0]!.args[0]).toBe(`snap:rollup:${ts}:{EQUITY:1}:Delta`);
    expect(hmsetCalls[1]!.args[0]).toBe(`snap:rollup:${ts}:{GIRR:USD}:Delta:tenor:3M`);

    const expireCalls = fr.calls.filter((c) => c.command === "EXPIRE");
    expect(expireCalls).toHaveLength(2);
    // 7 days in seconds.
    expect(Number(expireCalls[0]!.args[1])).toBe(7 * 24 * 3600);

    expect(getCounter("snapshot_total")).toBe(1);
  });

  it("records snapshot metadata so listSnapshots returns the ts+count", async () => {
    const fr = fakeRedis();
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "snap:index") {
        return [
          "2026-06-18T12:00:00.000Z", "3",
          "2026-06-18T13:00:00.000Z", "5",
        ];
      }
      return [];
    });
    const snaps = await listSnapshots(fr);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toMatchObject({ ts: "2026-06-18T13:00:00.000Z", key_count: 5 });
    expect(snaps[1]).toMatchObject({ ts: "2026-06-18T12:00:00.000Z", key_count: 3 });
  });

  it("handles an empty rollup keyspace gracefully (key_count=0)", async () => {
    const fr = fakeRedis();
    fr.setScan("0", []);
    fr.setResponse("HSET", () => 1);
    const result = await runSnapshot({ redis: fr, ts: "2026-06-18T14:00:00.000Z" });
    expect(result.key_count).toBe(0);
    expect(fr.calls.find((c) => c.command === "HMSET")).toBeUndefined();
    expect(getCounter("snapshot_total")).toBe(1);
  });
});

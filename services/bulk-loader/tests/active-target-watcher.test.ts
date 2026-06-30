// Wave 7.0.6.17 — bulk-loader active-target watcher unit tests.
//
// Covers:
//   • onSwitch fires on first successful poll (prev=null).
//   • onSwitch fires when `version` bumps; no-fire when version unchanged.
//   • onPoll fires on every successful poll.
//   • slow onSwitch handler does not double-fire on the next tick.
//   • Errors from the api are swallowed (warn) — the watcher keeps polling.
//   • Bearer token is sent on the Authorization header.

import { describe, it, expect, vi } from "vitest";
import { createActiveTargetWatcher } from "../src/active-target-watcher.ts";
import type { ActiveTargetFull } from "@frtb/redis-client";

function makeTarget(version: number, label = "localcluster"): ActiveTargetFull {
  return { host: "127.0.0.1", port: 12000, tls: false, db: 0, label, version };
}

function mockFetch(queue: Array<ActiveTargetFull | Error>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const next = queue.shift();
    if (next === undefined) throw new Error("mock fetch: queue exhausted");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

describe("active-target watcher — Wave 7.0.6.17", () => {
  it("fires onSwitch on the first successful poll with prev=null and sets onPoll", async () => {
    const { fetchImpl, calls } = mockFetch([makeTarget(1)]);
    const onSwitch = vi.fn();
    const onPoll = vi.fn();
    const w = createActiveTargetWatcher({
      apiBase: "http://api:8080", token: "tok", pollMs: 60_000,
      fetchImpl, onSwitch, onPoll, logger: { info: () => { }, warn: () => { } },
    });
    await w.pollOnce();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0]![1]).toBeNull(); // prev
    expect((onSwitch.mock.calls[0]![0] as ActiveTargetFull).version).toBe(1);
    expect(onPoll).toHaveBeenCalledTimes(1);
    expect(calls[0]?.url).toBe("http://api:8080/internal/redis/active-target/full");
    expect(calls[0]?.headers.Authorization || calls[0]?.headers.authorization).toBe("Bearer tok");
    await w.stop();
  });

  it("fires onSwitch on version bumps and skips when version is unchanged", async () => {
    const { fetchImpl } = mockFetch([makeTarget(1), makeTarget(1), makeTarget(2)]);
    const onSwitch = vi.fn();
    const onPoll = vi.fn();
    const w = createActiveTargetWatcher({
      apiBase: "http://api:8080", token: "tok", pollMs: 60_000,
      fetchImpl, onSwitch, onPoll, logger: { info: () => { }, warn: () => { } },
    });
    await w.pollOnce(); // version 1 → switch
    await w.pollOnce(); // version 1 → no switch
    await w.pollOnce(); // version 2 → switch
    expect(onSwitch).toHaveBeenCalledTimes(2);
    expect((onSwitch.mock.calls[1]![0] as ActiveTargetFull).version).toBe(2);
    expect((onSwitch.mock.calls[1]![1] as ActiveTargetFull).version).toBe(1);
    expect(onPoll).toHaveBeenCalledTimes(3);
    await w.stop();
  });

  it("serialises ticks so a slow onSwitch handler does not double-fire", async () => {
    const { fetchImpl } = mockFetch([makeTarget(1), makeTarget(2), makeTarget(3)]);
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });
    const onSwitch = vi.fn(async () => { await block; });
    const w = createActiveTargetWatcher({
      apiBase: "http://api:8080", token: "tok", pollMs: 60_000,
      fetchImpl, onSwitch, logger: { info: () => { }, warn: () => { } },
    });
    const first = w.pollOnce();
    // Yield until the first poll enters onSwitch (fetch + applySwitch are async).
    for (let i = 0; i < 50 && onSwitch.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    const second = await w.pollOnce(); // should no-op while first is parked
    expect(second).toBeUndefined();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    release();
    await first;
    await w.stop();
  });

  it("swallows fetch errors and keeps polling", async () => {
    const { fetchImpl } = mockFetch([new Error("ECONNREFUSED"), makeTarget(4)]);
    const onSwitch = vi.fn();
    const warns: Array<{ obj: object; msg: string }> = [];
    const w = createActiveTargetWatcher({
      apiBase: "http://api:8080", token: "tok", pollMs: 60_000,
      fetchImpl, onSwitch,
      logger: { info: () => { }, warn: (obj, msg) => warns.push({ obj, msg }) },
    });
    await w.pollOnce(); // errors
    await w.pollOnce(); // succeeds
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(warns.some((w) => w.msg.includes("poll failed"))).toBe(true);
    await w.stop();
  });
});

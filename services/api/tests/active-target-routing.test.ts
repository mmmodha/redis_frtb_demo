// Wave 5.16t — verifies api routes follow the active-target singleton
// per-request, that translateRedisError turns "missing data" Redis errors
// into 412 with a friendly bootstrap-aware body, that /calc/sbm surfaces
// the empty-result note when the index is populated but the requested
// risk_class has no buckets, and that the bootstrap-status endpoint
// reflects scheduleBootstrap progress on active-target changes.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";
import {
  resetBootstrapStatusForTests,
  setBootstrapRunnerForTests,
  setDebounceMsForTests,
  getBootstrapStatus,
} from "../src/bootstrap-status.ts";
import {
  setActiveTarget,
  resetActiveTarget,
  type ActiveTarget,
} from "../src/active-target.ts";
import { __resetCalcCacheForTests } from "../src/sbm/calc-cache.ts";

function ftAggregateReply(buckets: string[]): unknown[] {
  const out: unknown[] = [buckets.length];
  for (const b of buckets) out.push(["bucket", b]);
  return out;
}

function ftSearchReply(total: number): unknown[] {
  return [total];
}

const TARGET_A: ActiveTarget = { host: "10.0.0.1", port: 6379, tls: false, db: 0, label: "target-A" };
const TARGET_B: ActiveTarget = { host: "10.0.0.2", port: 6379, tls: false, db: 0, label: "target-B" };

describe("Wave 5.16t — api routes follow active-target per-request", () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(() => {
    resetActiveTarget();
    resetBootstrapStatusForTests();
    __resetCalcCacheForTests();
    delete process.env.REDIS_URL;
  });

  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
    resetBootstrapStatusForTests();
  });

  it("/pivot resolves redis via opts.getRedis on every request (per-request retargeting)", async () => {
    const fr1 = fakeRedis();
    const fr2 = fakeRedis();
    fr1.setResponse("FT.SEARCH", ftSearchReply(0));
    fr2.setResponse("FT.SEARCH", ftSearchReply(0));
    let current: FakeRedis = fr1;
    app = await createServer({ getRedis: () => current });

    await app.inject({ method: "GET", url: "/pivot" });
    expect(fr1.calls.filter((c) => c.command === "FT.SEARCH")).toHaveLength(1);
    expect(fr2.calls.filter((c) => c.command === "FT.SEARCH")).toHaveLength(0);

    current = fr2; // simulate active-target switch between requests
    await app.inject({ method: "GET", url: "/pivot" });
    expect(fr1.calls.filter((c) => c.command === "FT.SEARCH")).toHaveLength(1);
    expect(fr2.calls.filter((c) => c.command === "FT.SEARCH")).toHaveLength(1);
  });

  it("/calc/sbm resolves redis via opts.getRedis on every request", async () => {
    const fr1 = fakeRedis();
    const fr2 = fakeRedis();
    fr1.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr1.setResponse("FCALL", ["K_b", "3", "S_b", "3", "count", "1", "ms", "1"]);
    fr2.setResponse("FT.AGGREGATE", ftAggregateReply(["EUR-IRS"]));
    fr2.setResponse("FCALL", ["K_b", "4", "S_b", "4", "count", "1", "ms", "1"]);
    let current: FakeRedis = fr1;
    app = await createServer({
      getRedis: () => current,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const r1 = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(r1.statusCode).toBe(200);
    expect(fr1.calls.filter((c) => c.command === "FCALL")).toHaveLength(1);
    expect(fr2.calls.filter((c) => c.command === "FCALL")).toHaveLength(0);

    current = fr2;
    // Wave 5.83C-2 — vary sensitivity_type so the response cache miss path
    // exercises the swapped `current` redis. With identical body this call
    // would hit the in-process cache from r1 and never consult fr2.
    const r2 = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Vega" },
    });
    expect(r2.statusCode).toBe(200);
    expect(fr2.calls.filter((c) => c.command === "FCALL")).toHaveLength(1);
  });

  it("/observability/keys resolves redis via opts.getRedis on every request", async () => {
    const fr1 = fakeRedis();
    const fr2 = fakeRedis();
    fr1.setScan("0", ["sens:a"]);
    fr2.setScan("0", ["sens:b"]);
    let current: FakeRedis = fr1;
    app = await createServer({ getRedis: () => current });

    await app.inject({ method: "GET", url: "/observability/keys" });
    expect(fr1.calls.filter((c) => c.command === "SCAN")).toHaveLength(1);
    expect(fr2.calls.filter((c) => c.command === "SCAN")).toHaveLength(0);

    current = fr2;
    await app.inject({ method: "GET", url: "/observability/keys" });
    expect(fr2.calls.filter((c) => c.command === "SCAN")).toHaveLength(1);
  });

  it("translateRedisError: 'Unknown Index name' → 412 with bootstrap-required body on /pivot", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SEARCH", () => { throw new Error("Unknown Index name"); });
    setActiveTarget(TARGET_A);
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/pivot" });
    expect(res.statusCode).toBe(412);
    const body = res.json();
    expect(body.error).toContain("idx:sens not found on 'target-A'");
    expect(body.error).toContain("bootstrap required");
    expect(body.target_label).toBe("target-A");
    expect(body.bootstrap_phase).toBe("idle");
  });

  // Wave 6.09 — Redis 8.x replaces the legacy "Unknown Index name" with
  // "SEARCH_INDEX_NOT_FOUND Index not found: …". translateRedisError must
  // recognise the new phrasing or /pivot 500s on a fresh Redis 8 deploy.
  it("translateRedisError: 'SEARCH_INDEX_NOT_FOUND Index not found' → 412 idx:sens body on /pivot", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.SEARCH", () => {
      throw new Error("SEARCH_INDEX_NOT_FOUND Index not found: idx:sens");
    });
    setActiveTarget(TARGET_A);
    app = await createServer({ redis: fr });

    const res = await app.inject({ method: "GET", url: "/pivot" });
    expect(res.statusCode).toBe(412);
    const body = res.json();
    expect(body.error).toContain("idx:sens not found on 'target-A'");
    expect(body.error).toContain("bootstrap required");
    expect(body.target_label).toBe("target-A");
    expect(body.bootstrap_phase).toBe("idle");
  });

  it("translateRedisError: 'Function not found' on FCALL → 412 with frtb-library body on /calc/sbm", async () => {
    const fr = fakeRedis();
    fr.setResponse("FT.AGGREGATE", ftAggregateReply(["USD-IRS"]));
    fr.setResponse("FCALL", () => { throw new Error("ERR Function not found"); });
    setActiveTarget(TARGET_B);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(412);
    const body = res.json();
    expect(body.error).toContain("frtb Lua library not loaded on 'target-B'");
    expect(body.target_label).toBe("target-B");
    expect(body.bootstrap_phase).toBe("idle");
  });

  it("/calc/sbm returns friendly note when index is populated but risk_class has no buckets", async () => {
    const fr = fakeRedis();
    // Discovery returns zero buckets for the requested risk_class…
    fr.setResponse("FT.AGGREGATE", ftAggregateReply([]));
    // …but the populated-index probe sees a non-zero num_docs (other classes
    // exist on the target), so we fall through to the empty-note path.
    fr.setResponse("FT.INFO", ["num_docs", "42"]);
    setActiveTarget(TARGET_A);
    app = await createServer({
      redis: fr,
      correlations: { GIRR: { kind: "constant", value: 0 } },
    });

    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.charge).toBe(0);
    expect(body.per_bucket).toEqual([]);
    expect(body.ok).toBe(true);
    expect(body.note).toContain("No sensitivities on 'target-A'");
    expect(body.note).toContain("ingest data");
  });

  it("GET /redis/active-target/bootstrap-status returns the current bootstrap snapshot", async () => {
    app = await createServer({ redis: fakeRedis() });
    const res = await app.inject({ method: "GET", url: "/redis/active-target/bootstrap-status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phase).toBe("idle");
  });

  // Wave 5.16y — Test C: when an earlier bootstrap attempt failed against an
  // unreachable/unauthenticated target, a subsequent activation of an
  // authenticated reachable target must transition the bootstrap-status
  // from "failed" → "running" → "ready" — not stay stuck at "failed".
  it("bootstrap-status: failed (target A) → running → ready (target B) on re-activation", async () => {
    setDebounceMsForTests(5);

    // Runner #1 rejects (simulating NOAUTH against an unauthenticated target).
    let resolveB: (() => void) | null = null;
    let callCount = 0;
    setBootstrapRunnerForTests(() => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(new Error("NOAUTH Authentication required"));
      return new Promise<void>((r) => { resolveB = r; });
    });

    const fakeSchema = { risk_classes: [] } as unknown as Parameters<typeof createServer>[0]["schema"];
    app = await createServer({ redis: fakeRedis(), schema: fakeSchema });

    setActiveTarget(TARGET_A);
    await new Promise((r) => setTimeout(r, 30));
    const failed = await app.inject({ method: "GET", url: "/redis/active-target/bootstrap-status" });
    expect(failed.json().phase).toBe("failed");
    expect(failed.json().target_label).toBe("target-A");

    // Activate target B. Synchronously the status should flip to "running"
    // (Wave 5.16y: scheduleBootstrap no longer waits for the debounce to
    // clear stale "failed" state).
    setActiveTarget(TARGET_B);
    const afterSwitch = await app.inject({ method: "GET", url: "/redis/active-target/bootstrap-status" });
    expect(afterSwitch.json().phase).toBe("running");
    expect(afterSwitch.json().target_label).toBe("target-B");

    // Wait past the debounce so the runner actually fires, then resolve it
    // and verify the final "ready" state for target-B.
    await new Promise((r) => setTimeout(r, 30));
    expect(callCount).toBe(2);
    resolveB!();
    await new Promise((r) => setTimeout(r, 10));
    const ready = await app.inject({ method: "GET", url: "/redis/active-target/bootstrap-status" });
    expect(ready.json().phase).toBe("ready");
    expect(ready.json().target_label).toBe("target-B");
  });

  it("scheduleBootstrap fires on setActiveTarget and bootstrap-status reflects running → ready", async () => {
    setDebounceMsForTests(5);
    let runnerCalls = 0;
    let resolveRunner: (() => void) | null = null;
    setBootstrapRunnerForTests(() => {
      runnerCalls += 1;
      return new Promise<void>((resolve) => { resolveRunner = resolve; });
    });

    // Mock schema is just an object — bootstrap runner is fully stubbed above.
    const fakeSchema = { risk_classes: [] } as unknown as Parameters<typeof createServer>[0]["schema"];
    app = await createServer({ redis: fakeRedis(), schema: fakeSchema });

    setActiveTarget(TARGET_A);
    // Wait past debounce window.
    await new Promise((r) => setTimeout(r, 30));
    expect(runnerCalls).toBe(1);

    const running = await app.inject({ method: "GET", url: "/redis/active-target/bootstrap-status" });
    expect(running.json().phase).toBe("running");
    expect(running.json().target_label).toBe("target-A");

    // Resolve the runner — status should flip to ready.
    resolveRunner!();
    await new Promise((r) => setTimeout(r, 10));
    const ready = await app.inject({ method: "GET", url: "/redis/active-target/bootstrap-status" });
    expect(ready.json().phase).toBe("ready");
    expect(ready.json().target_label).toBe("target-A");

    expect(getBootstrapStatus().phase).toBe("ready");
  });
});

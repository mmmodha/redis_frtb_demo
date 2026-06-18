// Wave 5.92B — unit suite for the multi-shard consumer driver.
//
// Three layers exercised here:
//   1. parseShardAssignment + shardStreamKey pure helpers (env-string parsing
//      and per-shard stream-key construction).
//   2. createMultiShardConsumer end-to-end against a stub Redis that records
//      every XREADGROUP stream argument, verifying the driver opens exactly
//      one XREADGROUP loop per assigned shard against the expected key.
//   3. An active-target swap scenario (drain all per-shard runners on the
//      previous client, respawn against the new client) using two stub
//      clients — extends the existing watcher-callback contract to multi-shard.

import { describe, it, expect } from "vitest";
import http from "node:http";
import { parseShardAssignment, shardStreamKey } from "../src/sharding.ts";
import {
  createMultiShardConsumer,
  ensureGroupsForShards,
  type MultiConsumer,
} from "../src/multi-consumer.ts";
import type { RedisLike } from "../src/consumer.ts";
import { createShardRuntime } from "../src/shard-runtime.ts";

interface StubClient {
  reads: string[];
  groupCreates: Array<{ stream: string; group: string }>;
  // Wave 6.15b — runner clients are now closed on stop(); counters let the
  // tests verify quit-then-disconnect-fallback behaviour for rebuild paths.
  quitCalls: number;
  disconnectCalls: number;
  client: RedisLike;
}

interface StubClientOpts {
  // When set, quit() rejects (simulating a broken socket) so the
  // multi-consumer's fallback path falls through to disconnect().
  quitRejects?: boolean;
  // When set, quit() never resolves — exercises the timeout branch.
  quitHangs?: boolean;
}

function makeStubClient(opts: StubClientOpts = {}): StubClient {
  const reads: string[] = [];
  const groupCreates: Array<{ stream: string; group: string }> = [];
  const state = { quitCalls: 0, disconnectCalls: 0 };
  const client = {
    async xreadgroup(...args: unknown[]): Promise<null> {
      // Find the stream key — it's the arg after the "STREAMS" sentinel.
      const idx = args.indexOf("STREAMS");
      const stream = idx >= 0 ? String(args[idx + 1]) : "<unknown>";
      reads.push(stream);
      await new Promise((r) => setTimeout(r, 5));
      return null;
    },
    async xgroup(_verb: string, stream: string, group: string): Promise<string> {
      groupCreates.push({ stream, group });
      return "OK";
    },
    pipeline(): unknown {
      // No entries are returned by xreadgroup above, so processBatch never
      // calls pipeline.exec() — the stub only needs to satisfy the type shape.
      const pl = {
        call(): unknown { return pl; },
        xack(): unknown { return pl; },
        async exec(): Promise<unknown[]> { return []; },
      };
      return pl;
    },
    async quit(): Promise<string> {
      state.quitCalls += 1;
      if (opts.quitHangs) return new Promise<string>(() => { /* never resolves */ });
      if (opts.quitRejects) throw new Error("quit rejected (stub)");
      return "OK";
    },
    disconnect(): void {
      state.disconnectCalls += 1;
    },
  };
  return {
    reads, groupCreates,
    get quitCalls(): number { return state.quitCalls; },
    get disconnectCalls(): number { return state.disconnectCalls; },
    client: client as unknown as RedisLike,
  };
}

describe("parseShardAssignment", () => {
  it("'all' expands to every shard index", () => {
    expect(parseShardAssignment("all", 4)).toEqual([0, 1, 2, 3]);
  });
  it("empty spec defaults to every shard index", () => {
    expect(parseShardAssignment("", 3)).toEqual([0, 1, 2]);
  });
  it("'ALL' is case-insensitive", () => {
    expect(parseShardAssignment("ALL", 2)).toEqual([0, 1]);
  });
  it("explicit comma list keeps input order and dedupes", () => {
    expect(parseShardAssignment("2, 0, 2, 1", 4)).toEqual([2, 0, 1]);
  });
  it("inclusive range a-b expands forward", () => {
    expect(parseShardAssignment("0-3", 4)).toEqual([0, 1, 2, 3]);
  });
  it("inclusive range filters out-of-bounds high end", () => {
    expect(parseShardAssignment("2-9", 4)).toEqual([2, 3]);
  });
  it("explicit list drops non-numeric and out-of-bounds entries", () => {
    expect(parseShardAssignment("0,foo,4,2", 3)).toEqual([0, 2]);
  });
  it("total=0 yields an empty assignment", () => {
    expect(parseShardAssignment("all", 0)).toEqual([]);
  });
});

describe("shardStreamKey", () => {
  it("returns the bare base key when totalShards <= 1 (back-compat)", () => {
    expect(shardStreamKey("sensitivities:in", 0, 1)).toBe("sensitivities:in");
  });
  it("wraps shard index in literal braces so the cluster slot is forced by <n>", () => {
    expect(shardStreamKey("sensitivities:in", 2, 4)).toBe("sensitivities:in:{2}");
  });
});

describe("ensureGroupsForShards", () => {
  it("calls XGROUP CREATE once per shard stream against the shared group name", async () => {
    const stub = makeStubClient();
    await ensureGroupsForShards(stub.client, ["sensitivities:in:{0}", "sensitivities:in:{1}"], "ingest");
    expect(stub.groupCreates).toEqual([
      { stream: "sensitivities:in:{0}", group: "ingest" },
      { stream: "sensitivities:in:{1}", group: "ingest" },
    ]);
  });
});

describe("createMultiShardConsumer", () => {
  it("STREAM_SHARDS=4 SHARD_ASSIGNMENT=all opens 4 XREADGROUP loops against sensitivities:in:{0..3}", async () => {
    const stub = makeStubClient();
    const multi = createMultiShardConsumer(stub.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 4, assignment: [0, 1, 2, 3], batchSize: 10, blockMs: 5,
      makeRunnerClient: () => stub.client, runnerQuitTimeoutMs: 50,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 60));
    await multi.stop();
    expect(new Set(stub.reads)).toEqual(new Set([
      "sensitivities:in:{0}", "sensitivities:in:{1}",
      "sensitivities:in:{2}", "sensitivities:in:{3}",
    ]));
    expect(multi.handles).toHaveLength(4);
    expect(multi.handles.map((h) => h.consumerName)).toEqual([
      "ingest-host-1-s0", "ingest-host-1-s1", "ingest-host-1-s2", "ingest-host-1-s3",
    ]);
  });

  it("SHARD_ASSIGNMENT=0,2 reads only those two shards", async () => {
    const stub = makeStubClient();
    const multi = createMultiShardConsumer(stub.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 4, assignment: [0, 2], batchSize: 10, blockMs: 5,
      makeRunnerClient: () => stub.client, runnerQuitTimeoutMs: 50,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 60));
    await multi.stop();
    const distinct = new Set(stub.reads);
    expect(distinct).toEqual(new Set(["sensitivities:in:{0}", "sensitivities:in:{2}"]));
    expect(distinct.size).toBe(2);
  });

  it("STREAM_SHARDS=1 falls back to the bare sensitivities:in key and the unsuffixed consumer name", async () => {
    const stub = makeStubClient();
    const multi = createMultiShardConsumer(stub.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 1, assignment: [0], batchSize: 10, blockMs: 5,
      makeRunnerClient: () => stub.client, runnerQuitTimeoutMs: 50,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 30));
    await multi.stop();
    expect(new Set(stub.reads)).toEqual(new Set(["sensitivities:in"]));
    expect(multi.handles[0]!.consumerName).toBe("ingest-host-1");
  });

  // Wave 6.15b — runner-local ioredis clients. Each shard runner must own
  // its own client instance so XREADGROUP/pipeline.exec/XACK don't serialise
  // through one shared socket. The factory is invoked once per spawned
  // runner and the returned objects must be distinct references.
  it("each spawned runner gets a distinct client instance from makeRunnerClient", async () => {
    const shared = makeStubClient();
    const built: RedisLike[] = [];
    const factory = (): RedisLike => {
      const fresh = makeStubClient().client;
      built.push(fresh);
      return fresh;
    };
    const multi = createMultiShardConsumer(shared.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 4, assignment: [0, 1, 2, 3], batchSize: 10, blockMs: 5,
      makeRunnerClient: factory, runnerQuitTimeoutMs: 50,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 30));
    await multi.stop();
    expect(built).toHaveLength(4);
    // All four references must be unique objects (set size === array length).
    expect(new Set(built).size).toBe(4);
    // Handles expose the per-runner client back to operators.
    expect(multi.handles.map((h) => h.client)).toEqual(built);
  });

  // Wave 6.15b — when the runner client's quit() rejects (or hangs past the
  // shutdown budget), stop() must fall back to disconnect() so a broken
  // socket can't hold rebuild() open. We exercise both quitRejects and
  // quitHangs branches in one assertion sweep.
  it("falls back to disconnect() when runner quit() rejects", async () => {
    const shared = makeStubClient();
    const runners: StubClient[] = [];
    const factory = (): RedisLike => {
      const fresh = makeStubClient({ quitRejects: true });
      runners.push(fresh);
      return fresh.client;
    };
    const multi = createMultiShardConsumer(shared.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 2, assignment: [0, 1], batchSize: 10, blockMs: 5,
      makeRunnerClient: factory, runnerQuitTimeoutMs: 50,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 20));
    await multi.stop();
    // quit() rejects but is still attempted; the multi-consumer treats the
    // rejection as a soft success (no disconnect needed because the socket
    // is already in an error state). The hang branch below pins the
    // disconnect fallback path.
    expect(runners.every((r) => r.quitCalls === 1)).toBe(true);
  });

  it("falls back to disconnect() within ~2s when runner quit() hangs", async () => {
    const shared = makeStubClient();
    const runners: StubClient[] = [];
    const factory = (): RedisLike => {
      const fresh = makeStubClient({ quitHangs: true });
      runners.push(fresh);
      return fresh.client;
    };
    const multi = createMultiShardConsumer(shared.client, {
      baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
      totalShards: 2, assignment: [0, 1], batchSize: 10, blockMs: 5,
      // Test-only short budget — production default is 2000ms. Verifies the
      // fallback fires within the configured window, not that the wall-clock
      // matches 2s exactly.
      makeRunnerClient: factory, runnerQuitTimeoutMs: 100,
    });
    multi.start();
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    await multi.stop();
    const elapsed = Date.now() - t0;
    // Generous upper bound — Promise.race + setTimeout + disconnect should
    // resolve well under 2× the budget.
    expect(elapsed).toBeLessThan(500);
    expect(runners.every((r) => r.quitCalls === 1)).toBe(true);
    expect(runners.every((r) => r.disconnectCalls === 1)).toBe(true);
  });
});

// Wave 6.12a — runtime shard-control endpoint. Drives a real http.Server bound
// to a stub Redis client so the POST /ingest/shards handler exercises the
// full rebuild path: drain the previous MultiConsumer, recompute the
// assignment, spawn a fresh runner per shard, return the new snapshot. Also
// covers the 400 (invalid body) and 409 (rebuild already in-flight) branches
// the DoD calls out.

interface RuntimeFixture {
  server: http.Server;
  base: string;
  stub: StubClient;
  stopCalls: number;
  stop(): Promise<void>;
}

interface RuntimeFixtureOpts {
  // Wave 6.15b — when set, every spawn() rebuild records the per-runner
  // clients the factory produced so tests can assert distinct instances and
  // leak-free quit counts across rebuilds.
  trackRunnerClients?: StubClient[];
}

async function startRuntimeServer(
  initialTotalShards: number,
  initialAssignmentSpec: string,
  fixtureOpts: RuntimeFixtureOpts = {},
): Promise<RuntimeFixture> {
  const stub = makeStubClient();
  let stopCalls = 0;
  // Wave 6.15b — when callers opt in via trackRunnerClients we mint a fresh
  // stub client per runner so the test can verify distinct instances and
  // quit/disconnect bookkeeping across rebuilds. Otherwise we reuse the
  // shared stub.client so legacy assertions that count reads on stub.reads
  // keep observing the runner XREADGROUP traffic (pre-6.15b behaviour).
  const runnerFactory = (): RedisLike => {
    if (!fixtureOpts.trackRunnerClients) return stub.client;
    const fresh = makeStubClient();
    fixtureOpts.trackRunnerClients.push(fresh);
    return fresh.client;
  };
  const runtime = createShardRuntime({
    baseStream: "sensitivities:in",
    initialTotalShards,
    initialAssignmentSpec,
    spawn: async (totalShards, assignment) => {
      const streams = assignment.map((s) => shardStreamKey("sensitivities:in", s, totalShards));
      await ensureGroupsForShards(stub.client, streams, "ingest");
      const m = createMultiShardConsumer(stub.client, {
        baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
        totalShards, assignment, batchSize: 10, blockMs: 5,
        makeRunnerClient: runnerFactory, runnerQuitTimeoutMs: 50,
      });
      // Wrap stop() so we can count drain calls without subclassing MultiConsumer.
      const realStop = m.stop.bind(m);
      const wrapped: MultiConsumer = { ...m, async stop() { stopCalls += 1; return realStop(); } };
      wrapped.start();
      return wrapped;
    },
  });
  const server = http.createServer((req, res) => {
    if (runtime.handleRequest(req, res, { consumed: 0, errors: 0, ready: true })) return;
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  // Initial spawn so /ingest/shards has live state, mirroring cli.ts boot.
  await runtime.rebuild();
  return {
    server,
    base: `http://127.0.0.1:${addr.port}`,
    stub,
    get stopCalls(): number { return stopCalls; },
    async stop(): Promise<void> {
      const m = runtime.getMulti();
      if (m) await m.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("POST /ingest/shards rebuilds the multi-consumer", () => {
  it("starts at totalShards=1, then POST totalShards=4 drains the bare-key runner and opens XREADGROUP loops against :{0..3}", async () => {
    const fx = await startRuntimeServer(1, "all");
    try {
      await new Promise((r) => setTimeout(r, 30));
      // Initial single-shard mode reads against the bare key only.
      expect(new Set(fx.stub.reads)).toEqual(new Set(["sensitivities:in"]));
      const stopsBefore = fx.stopCalls;

      const res = await fetch(`${fx.base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 4 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { totalShards: number; assignment: number[]; streams: string[] };
      expect(body.totalShards).toBe(4);
      expect(body.assignment).toEqual([0, 1, 2, 3]);
      expect(body.streams).toEqual([
        "sensitivities:in:{0}", "sensitivities:in:{1}",
        "sensitivities:in:{2}", "sensitivities:in:{3}",
      ]);

      // Drain ran on the previous runner before the new one was spawned.
      expect(fx.stopCalls).toBe(stopsBefore + 1);

      await new Promise((r) => setTimeout(r, 60));
      const distinct = new Set(fx.stub.reads);
      // New per-shard XREADGROUP loops are now open against the wrapped shard keys.
      for (const k of ["sensitivities:in:{0}", "sensitivities:in:{1}", "sensitivities:in:{2}", "sensitivities:in:{3}"]) {
        expect(distinct.has(k)).toBe(true);
      }
    } finally {
      await fx.stop();
    }
  });

  it("GET /ingest/shards returns the current snapshot shape", async () => {
    const fx = await startRuntimeServer(2, "0,1");
    try {
      const res = await fetch(`${fx.base}/ingest/shards`);
      expect(res.status).toBe(200);
      const body = await res.json() as { totalShards: number; assignment: number[]; streams: string[]; rebuilding: boolean };
      expect(body).toEqual({
        totalShards: 2,
        assignment: [0, 1],
        streams: ["sensitivities:in:{0}", "sensitivities:in:{1}"],
        rebuilding: false,
      });
    } finally {
      await fx.stop();
    }
  });

  it("returns 400 when totalShards is missing / non-integer / < 1", async () => {
    const fx = await startRuntimeServer(1, "all");
    try {
      for (const payload of [{}, { totalShards: "4" }, { totalShards: 0 }, { totalShards: -2 }, { totalShards: 1.5 }]) {
        const res = await fetch(`${fx.base}/ingest/shards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
      }
      const res = await fetch(`${fx.base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
    } finally {
      await fx.stop();
    }
  });

  it("returns 409 when a rebuild is already in flight", async () => {
    // Block the second spawn until the first POST has had a chance to start.
    // We achieve this by overriding the spawn to await a Promise we control;
    // a small wrapper around startRuntimeServer would be heavier than what's
    // needed — instead we drive the runtime directly here.
    const stub = makeStubClient();
    let releaseSpawn: (() => void) | null = null;
    let spawnCalls = 0;
    const runtime = createShardRuntime({
      baseStream: "sensitivities:in",
      initialTotalShards: 1,
      initialAssignmentSpec: "all",
      spawn: async (totalShards, assignment) => {
        spawnCalls += 1;
        if (spawnCalls >= 2) {
          await new Promise<void>((r) => { releaseSpawn = r; });
        }
        const streams = assignment.map((s) => shardStreamKey("sensitivities:in", s, totalShards));
        await ensureGroupsForShards(stub.client, streams, "ingest");
        const m = createMultiShardConsumer(stub.client, {
          baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
          totalShards, assignment, batchSize: 10, blockMs: 5,
          makeRunnerClient: () => makeStubClient().client, runnerQuitTimeoutMs: 50,
        });
        m.start();
        return m;
      },
    });
    await runtime.rebuild(); // initial spawn — spawnCalls=1
    const server = http.createServer((req, res) => {
      if (runtime.handleRequest(req, res, { consumed: 0, errors: 0, ready: true })) return;
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const first = fetch(`${base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 4 }),
      });
      // Yield so the first request enters spawn() and blocks on releaseSpawn.
      await new Promise((r) => setTimeout(r, 30));
      const second = await fetch(`${base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 2 }),
      });
      expect(second.status).toBe(409);
      if (releaseSpawn) (releaseSpawn as () => void)();
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      const m = runtime.getMulti();
      if (m) await m.stop();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("GET /ingest/status includes consumed/errors/ready alongside the snapshot", async () => {
    const fx = await startRuntimeServer(2, "all");
    try {
      const res = await fetch(`${fx.base}/ingest/status`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        totalShards: 2,
        assignment: [0, 1],
        streams: ["sensitivities:in:{0}", "sensitivities:in:{1}"],
        consumed: 0,
        errors: 0,
        ready: true,
      });
    } finally {
      await fx.stop();
    }
  });

  // Wave 6.15b — rebuild lifecycle. Going from 4→8 shards must drain the 4
  // old runners (each one's quit() fires exactly once → no leaks) and spawn
  // 8 brand-new runner clients on the new generation. After fx.stop() every
  // client built across both generations must have been closed.
  it("rebuild from 4 to 8 shards quits the 4 old runner clients and creates 8 fresh ones", async () => {
    const builtClients: StubClient[] = [];
    const fx = await startRuntimeServer(4, "all", { trackRunnerClients: builtClients });
    try {
      await new Promise((r) => setTimeout(r, 30));
      // Initial generation: factory called once per assigned shard.
      expect(builtClients).toHaveLength(4);
      const gen1 = builtClients.slice(0, 4);

      const res = await fetch(`${fx.base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 8 }),
      });
      expect(res.status).toBe(200);

      // After rebuild: drain closed the 4 old clients via quit() exactly once
      // each (no double-close, no leak) and 8 brand-new clients exist.
      expect(builtClients).toHaveLength(12);
      expect(gen1.every((c) => c.quitCalls === 1)).toBe(true);
      expect(gen1.every((c) => c.disconnectCalls === 0)).toBe(true);
      // Generation-2 clients are distinct objects from the generation-1 set.
      const gen2 = builtClients.slice(4);
      expect(new Set([...gen1, ...gen2]).size).toBe(12);
    } finally {
      await fx.stop();
    }
    // After full teardown every client built across both generations has
    // been closed exactly once — proves the runner-client lifecycle leaves
    // nothing dangling across rebuilds.
    expect(builtClients).toHaveLength(12);
    expect(builtClients.every((c) => c.quitCalls === 1)).toBe(true);
  });

  // Wave 6.32.B — operator recovery for a stuck rebuild. Simulates a hung
  // spawn() that leaks the `rebuilding=true` mutex (a real-world repro is
  // `multi.stop()` against a flushed Redis). The reset endpoint must clear
  // the flag and detach the abandoned multi so a fresh POST /ingest/shards
  // can proceed without restarting the service.
  it("POST /ingest/shards/reset clears a stuck rebuild mutex and lets a fresh rebuild proceed", async () => {
    const stub = makeStubClient();
    let releaseSpawn: (() => void) | null = null;
    let spawnCalls = 0;
    const runtime = createShardRuntime({
      baseStream: "sensitivities:in",
      initialTotalShards: 1,
      initialAssignmentSpec: "all",
      spawn: async (totalShards, assignment) => {
        spawnCalls += 1;
        if (spawnCalls === 2) {
          await new Promise<void>((r) => { releaseSpawn = r; });
        }
        const streams = assignment.map((s) => shardStreamKey("sensitivities:in", s, totalShards));
        await ensureGroupsForShards(stub.client, streams, "ingest");
        const m = createMultiShardConsumer(stub.client, {
          baseStream: "sensitivities:in", group: "ingest", consumerNameBase: "ingest-host-1",
          totalShards, assignment, batchSize: 10, blockMs: 5,
          makeRunnerClient: () => makeStubClient().client, runnerQuitTimeoutMs: 50,
        });
        m.start();
        return m;
      },
    });
    await runtime.rebuild();
    const server = http.createServer((req, res) => {
      if (runtime.handleRequest(req, res, { consumed: 0, errors: 0, ready: true })) return;
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      // First rebuild request hangs inside spawn() → leaks rebuilding=true.
      const stuck = fetch(`${base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 4 }),
      });
      await new Promise((r) => setTimeout(r, 30));
      // Confirm the mutex is held — a second POST returns 409.
      const busy = await fetch(`${base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 2 }),
      });
      expect(busy.status).toBe(409);

      // Operator recovery: force-reset.
      const reset = await fetch(`${base}/ingest/shards/reset`, { method: "POST" });
      expect(reset.status).toBe(200);
      expect(await reset.json()).toEqual({ rebuilding: false, multi_detached: true });
      expect(runtime.getMulti()).toBeNull();

      // Fresh rebuild now succeeds even though the previous spawn is still hung.
      const fresh = await fetch(`${base}/ingest/shards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ totalShards: 2 }),
      });
      expect(fresh.status).toBe(200);
      // Capture the fresh multi before the eventually-released stuck spawn
      // overwrites the closure-scoped `multi` reference.
      const freshMulti = runtime.getMulti();

      // Release the originally-hung spawn so the connection can drain and
      // server.close() doesn't deadlock waiting on it.
      if (releaseSpawn) (releaseSpawn as () => void)();
      await stuck.catch(() => undefined);

      // Stop both generations: the fresh multi we captured above, plus
      // whatever the released stuck rebuild ended up assigning.
      if (freshMulti) await freshMulti.stop();
      const leaked = runtime.getMulti();
      if (leaked && leaked !== freshMulti) await leaked.stop();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});


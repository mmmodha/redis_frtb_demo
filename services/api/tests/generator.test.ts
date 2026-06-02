import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, type Schema } from "@frtb/schema";
import { createServer } from "../src/server.ts";
import {
  _testInsertActiveRun,
  _testGetActiveRun,
  _testResetActiveRuns,
} from "../src/routes/generator.ts";
import { fakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";

// Re-use the generator's multi-class fixture (GIRR / EQUITY / FX). Sharing the
// fixture keeps the api side honest about schema shape — if the generator
// package ever changes its expected schema layout the route test will fail
// alongside the generator unit tests.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function loadFixtureSchema(): Schema {
  return loadSchema(
    resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"),
  );
}

// Extends fakeRedis with the .pipeline() surface the @frtb/generator
// StreamProducer uses (`client.pipeline().xadd(...).exec()`). The recorder
// keeps the list of XADD invocations against any stream key so the tests can
// assert the exact rows queued.
interface XaddRecord {
  stream: string;
  fields: Record<string, string>;
}
interface PipelineFakeRedis extends FakeRedis {
  xadds: XaddRecord[];
  pipeline(): {
    xadd(stream: string, id: string, ...fields: string[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]>>;
  };
}

function pipelineFakeRedis(): PipelineFakeRedis {
  const base = fakeRedis();
  const xadds: XaddRecord[] = [];
  const pr = base as PipelineFakeRedis;
  pr.xadds = xadds;
  pr.pipeline = () => {
    const buffered: XaddRecord[] = [];
    return {
      xadd(stream: string, _id: string, ...fields: string[]) {
        const map: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          map[fields[i]!] = fields[i + 1]!;
        }
        buffered.push({ stream, fields: map });
        return this;
      },
      async exec() {
        for (const rec of buffered) xadds.push(rec);
        return buffered.map(() => [null, "0-0"] as [Error | null, unknown]);
      },
    };
  };
  return pr;
}

describe("POST /generator/start — in-process synthetic row producer", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => {
    if (app) await app.close();
  });

  it("happy path: 50 rows → 50 XADDs against sensitivities:in, ok:true response", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 50, seed: "wave-5.16p-test" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.rows_queued).toBe(50);
    expect(typeof body.run_id).toBe("string");
    expect(body.run_id.length).toBeGreaterThan(0);
    expect(body.classes).toEqual(["GIRR", "EQUITY", "FX"]);
    expect(body.sensitivity_types).toEqual(["Delta", "Vega"]);
    expect(typeof body.ms).toBe("number");

    // Exactly 50 XADDs all against the default stream.
    expect(fr.xadds).toHaveLength(50);
    for (const rec of fr.xadds) {
      expect(rec.stream).toBe("sensitivities:in");
      expect(rec.fields).toHaveProperty("risk_class");
      expect(rec.fields).toHaveProperty("bucket");
      expect(rec.fields).toHaveProperty("payload");
    }
  });

  // Wave 5.20c — the hard MAX_ROWS cap is removed; the cluster sanity check
  // in the UI is the user-facing guardrail. Structural validation still
  // rejects negative / non-integer / non-finite rows.
  // NaN/Infinity round-trip as `null` through JSON, so we test only values
  // that actually reach the handler unchanged: negative, zero, non-integer,
  // and a non-numeric string.
  it.each([
    { rows: -1, label: "negative" },
    { rows: 0, label: "zero" },
    { rows: 1.5, label: "non-integer" },
    { rows: "many" as unknown as number, label: "non-numeric" },
  ])("rejects rows=$label with 400 and emits no XADDs", async ({ rows }) => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/rows must be a positive integer/i);
    expect(fr.xadds).toHaveLength(0);
  });

  it("accepts large row counts (no hard ceiling — sanity check is the guardrail)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    // 5000 used to be rejected by MAX_ROWS=2000; now it succeeds.
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows_queued).toBe(5000);
    expect(fr.xadds).toHaveLength(5000);
  });

  it("rejects unknown risk class with 400 and emits no XADDs", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { classes: ["BOGUS"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown risk class: BOGUS/);
    expect(fr.xadds).toHaveLength(0);
  });

  it("defaults: empty body → 200 rows across GIRR/EQUITY/FX round-robin", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows_queued).toBe(200);
    expect(fr.xadds).toHaveLength(200);

    const byClass: Record<string, number> = {};
    for (const rec of fr.xadds) {
      const rc = rec.fields.risk_class!;
      byClass[rc] = (byClass[rc] ?? 0) + 1;
    }
    // Round-robin across the three default classes — every class must appear
    // at least once; with 200 rows and 3 classes we expect roughly 67/67/66.
    expect(byClass.GIRR).toBeGreaterThan(0);
    expect(byClass.EQUITY).toBeGreaterThan(0);
    expect(byClass.FX).toBeGreaterThan(0);
  });

  it("returns 503 when schema is not loaded (api boot incomplete)", async () => {
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr }); // no schema

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/schema not loaded/i);
    expect(fr.xadds).toHaveLength(0);
  });
});

// Wave 5.20c — SSE streaming variant + server-side cancellation.
//
// `payloadAsStream: true` returns a Node Readable from which we can collect
// SSE frames as they arrive; the request handler keeps writing until it
// calls `reply.raw.end()` (completion / cancellation / error).
function parseSseFrames(buf: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const chunk of buf.split("\n\n")) {
    const line = chunk.trim();
    if (!line.startsWith("data:")) continue;
    const json = line.replace(/^data:\s?/, "");
    try { frames.push(JSON.parse(json) as Record<string, unknown>); }
    catch { /* skip malformed */ }
  }
  return frames;
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  let buf = "";
  for await (const chunk of stream) buf += String(chunk);
  return buf;
}

// Wraps the fake pipeline so `pipeline.exec()` yields a real macrotask
// between batches. This lets concurrent `app.inject` calls (e.g. the cancel
// endpoint) land between batches so the generation loop sees the flag flip.
function delayedPipelineFakeRedis(): PipelineFakeRedis {
  const base = pipelineFakeRedis();
  const origPipeline = base.pipeline.bind(base);
  base.pipeline = () => {
    const p = origPipeline();
    const origExec = p.exec.bind(p);
    p.exec = async () => {
      await new Promise<void>((r) => setImmediate(r));
      return origExec();
    };
    return p;
  };
  return base;
}

// Wave 5.40a — slower variant for timing-sensitive detached-run tests. Adds
// a real timeout between batches so the run stays "running" long enough for
// the test to observe orphan-discovery / cancel / status-while-running.
function slowPipelineFakeRedis(perBatchMs = 5): PipelineFakeRedis {
  const base = pipelineFakeRedis();
  const origPipeline = base.pipeline.bind(base);
  base.pipeline = () => {
    const p = origPipeline();
    const origExec = p.exec.bind(p);
    p.exec = async () => {
      await new Promise<void>((r) => setTimeout(r, perBatchMs));
      return origExec();
    };
    return p;
  };
  return base;
}

describe("POST /generator/start/stream (Wave 5.20c) — SSE progress + cancellation", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => { if (app) await app.close(); });

  it("emits a seed frame, ≥1 progress frame, and a terminal frame on completion", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 50, seed: "wave-5.20c-test" },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^text\/event-stream/);

    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const frames = parseSseFrames(body);
    expect(frames.length).toBeGreaterThanOrEqual(2); // seed + terminal at minimum
    const first = frames[0]!;
    expect(typeof first.run_id).toBe("string");
    expect(first.rows_total).toBe(50);
    expect(first.rows_done).toBe(0);

    const terminal = frames[frames.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.cancelled).toBe(false);
    expect(terminal.rows_queued).toBe(50);
    expect(terminal.run_id).toBe(first.run_id);
    expect(typeof terminal.ms).toBe("number");

    expect(fr.xadds).toHaveLength(50);
  });

  // Wave 5.21c — regression: the previous implementation listened on
  // `req.raw` for `close`/`error`, which Fastify fires as soon as the
  // inbound JSON body finishes parsing. That flipped `cancelFlag` before
  // the generation loop even started, so a default 200-row run terminated
  // with `rows_queued: 1, cancelled: true`. Listening on `reply.raw`
  // instead keys cancellation to the actual response socket.
  it("completes a 200-row default run without firing cancel", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: {},
      headers: { accept: "text/event-stream", "content-type": "application/json" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);

    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const frames = parseSseFrames(body);
    const terminal = frames[frames.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.cancelled).toBe(false);
    expect(terminal.rows_queued).toBe(200);
    expect(fr.xadds).toHaveLength(200);
  });

  it("cancel endpoint flips the flag → terminal frame is cancelled:true", async () => {
    const schema = loadFixtureSchema();
    const fr = delayedPipelineFakeRedis();
    app = await createServer({ redis: fr, schema, generatorSseProgressIntervalMs: 5 });

    // Start the stream; with batchSize=200 + setImmediate per exec, 600 rows
    // means at least one yield point where the cancel inject can land.
    const streamPromise = app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 600 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    // Yield so the route handler hijacks + writes the seed frame.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const res = await streamPromise;
    const stream = res.stream() as unknown as NodeJS.ReadableStream;

    // Read the seed frame to extract run_id, then issue cancel.
    let pre = "";
    let runId: string | undefined;
    const onData = (chunk: Buffer | string): void => {
      pre += chunk.toString();
      if (!runId) {
        const frames = parseSseFrames(pre);
        if (frames.length > 0 && typeof frames[0]!.run_id === "string") {
          runId = frames[0]!.run_id as string;
          stream.removeListener?.("data", onData);
        }
      }
    };
    stream.on("data", onData);
    // Wait until run_id is captured (or timeout).
    for (let i = 0; i < 50 && !runId; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(runId).toBeTruthy();

    const cancelRes = await app.inject({
      method: "POST",
      url: `/generator/cancel/${runId}`,
    });
    expect(cancelRes.statusCode).toBe(200);
    const cancelJson = cancelRes.json();
    expect(cancelJson).toEqual({ ok: true, cancelled: true, run_id: runId });

    const tail = await collectStream(stream);
    const frames = parseSseFrames(pre + tail);
    const terminal = frames[frames.length - 1]!;
    expect(terminal.done).toBe(true);
    expect(terminal.cancelled).toBe(true);
    expect(terminal.run_id).toBe(runId);
    // The cancel landed before all 600 rows were written.
    expect(terminal.rows_queued).toBeLessThan(600);
  });

  it("cancel returns 404 for an unknown run_id", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/cancel/01HXNOTAREALID",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: "unknown run_id" });
  });

  // Wave 5.40a — refresh-survival. The old behaviour (client-disconnect
  // flipped cancelFlag) is reversed: a client disconnect now ONLY stops
  // writing SSE frames; the detached generator loop keeps producing rows
  // until natural completion. The client recovers via /generator/runs/:id/status.
  it("client-disconnect does NOT halt the run server-side (refresh-survival)", async () => {
    const schema = loadFixtureSchema();
    const fr = delayedPipelineFakeRedis();
    app = await createServer({ redis: fr, schema, generatorSseProgressIntervalMs: 5 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    const http = await import("node:http");
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/generator/start/stream",
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
    });
    req.write(JSON.stringify({ rows: 600 }));
    req.end();

    const res = await new Promise<import("http").IncomingMessage>((resolveRes) => req.on("response", resolveRes));
    let buf = "";
    let runId: string | undefined;
    await new Promise<void>((r) => {
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        const frames = parseSseFrames(buf);
        if (frames.length >= 1 && typeof frames[0]!.run_id === "string") {
          runId = frames[0]!.run_id as string;
          // Abort the client connection mid-run.
          req.destroy();
          r();
        }
      });
    });
    expect(runId).toBeTruthy();

    // Run continues server-side. Poll /runs/:id/status until it reaches
    // terminal "done". With 600 rows + setImmediate per batch we expect
    // completion within a few hundred ms.
    let statusJson: { status?: string; rows_done?: number; rows_total?: number } | null = null;
    for (let i = 0; i < 100; i++) {
      const statusRes = await app.inject({ method: "GET", url: `/generator/runs/${runId}/status` });
      expect(statusRes.statusCode).toBe(200);
      statusJson = statusRes.json() as typeof statusJson;
      if (statusJson?.status === "done") break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(statusJson?.status).toBe("done");
    expect(statusJson?.rows_done).toBe(600);
    expect(statusJson?.rows_total).toBe(600);
    // All 600 rows actually queued, despite the client disconnect.
    expect(fr.xadds.length).toBe(600);
  });

  it("GET /generator/runs/:id/status returns 404 for an unknown id", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({ method: "GET", url: "/generator/runs/01HXNOTAREAL/status" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/unknown run_id/);
  });

  it("GET /generator/runs/:id/status reflects running progress before completion", async () => {
    const schema = loadFixtureSchema();
    const fr = delayedPipelineFakeRedis();
    app = await createServer({ redis: fr, schema, generatorSseProgressIntervalMs: 5 });

    const streamPromise = app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 600 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    const streamRes = await streamPromise;
    const stream = streamRes.stream() as unknown as NodeJS.ReadableStream;

    let pre = "";
    let runId: string | undefined;
    const onData = (chunk: Buffer | string): void => {
      pre += chunk.toString();
      if (!runId) {
        const frames = parseSseFrames(pre);
        if (frames.length > 0 && typeof frames[0]!.run_id === "string") {
          runId = frames[0]!.run_id as string;
        }
      }
    };
    stream.on("data", onData);
    for (let i = 0; i < 50 && !runId; i++) await new Promise<void>((r) => setImmediate(r));
    expect(runId).toBeTruthy();

    // Poll status while the run is still in flight.
    let sawRunning = false;
    for (let i = 0; i < 50; i++) {
      const statusRes = await app.inject({ method: "GET", url: `/generator/runs/${runId}/status` });
      expect(statusRes.statusCode).toBe(200);
      const j = statusRes.json();
      expect(j.run_id).toBe(runId);
      expect(j.rows_total).toBe(600);
      expect(typeof j.rows_done).toBe("number");
      if (j.status === "running") sawRunning = true;
      if (j.status === "done") break;
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(sawRunning).toBe(true);
    // Drain to let the run finish so afterEach close is clean.
    await collectStream(stream);
  });

  it("GET /generator/runs lists active runs", async () => {
    const schema = loadFixtureSchema();
    const fr = delayedPipelineFakeRedis();
    app = await createServer({ redis: fr, schema, generatorSseProgressIntervalMs: 5 });

    const streamPromise = app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 600 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    const streamRes = await streamPromise;
    const stream = streamRes.stream() as unknown as NodeJS.ReadableStream;

    let pre = "";
    let runId: string | undefined;
    stream.on("data", (chunk: Buffer | string) => {
      pre += chunk.toString();
      if (!runId) {
        const frames = parseSseFrames(pre);
        if (frames.length > 0 && typeof frames[0]!.run_id === "string") {
          runId = frames[0]!.run_id as string;
        }
      }
    });
    for (let i = 0; i < 50 && !runId; i++) await new Promise<void>((r) => setImmediate(r));
    expect(runId).toBeTruthy();

    const runsRes = await app.inject({ method: "GET", url: "/generator/runs" });
    expect(runsRes.statusCode).toBe(200);
    const j = runsRes.json() as { active: Array<{ run_id: string; status: string }> };
    expect(Array.isArray(j.active)).toBe(true);
    const found = j.active.find((e) => e.run_id === runId);
    expect(found).toBeTruthy();
    expect(found!.status).toBe("running");

    await collectStream(stream);
  });

  it("GET /generator/runs returns active runs after client disconnect (orphan discovery)", async () => {
    const schema = loadFixtureSchema();
    // Use the slow pipeline so the run stays "running" long enough for the
    // post-disconnect /runs probe to observe it.
    const fr = slowPipelineFakeRedis(5);
    app = await createServer({ redis: fr, schema, generatorSseProgressIntervalMs: 5 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    const http = await import("node:http");
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/generator/start/stream",
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
    });
    req.write(JSON.stringify({ rows: 2000 }));
    req.end();

    const res = await new Promise<import("http").IncomingMessage>((resolveRes) => req.on("response", resolveRes));
    let buf = "";
    let runId: string | undefined;
    await new Promise<void>((r) => {
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        const frames = parseSseFrames(buf);
        if (frames.length >= 1 && typeof frames[0]!.run_id === "string") {
          runId = frames[0]!.run_id as string;
          req.destroy();
          r();
        }
      });
    });
    expect(runId).toBeTruthy();

    // Give the server a tick to notice the close — run should still be running.
    await new Promise<void>((r) => setTimeout(r, 10));
    const runsRes = await app.inject({ method: "GET", url: "/generator/runs" });
    expect(runsRes.statusCode).toBe(200);
    const j = runsRes.json() as { active: Array<{ run_id: string; status: string }> };
    const found = j.active.find((e) => e.run_id === runId);
    expect(found).toBeTruthy();
    expect(found!.status).toBe("running");

    // Let the run finish so the afterEach close is clean.
    for (let i = 0; i < 100; i++) {
      const st = await app.inject({ method: "GET", url: `/generator/runs/${runId}/status` });
      if (st.statusCode === 200 && (st.json() as { status: string }).status === "done") break;
      await new Promise<void>((r) => setTimeout(r, 20));
    }
  });

  it("terminal-grace: status is queryable after completion, then evicted", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({
      redis: fr,
      schema,
      generatorSseProgressIntervalMs: 5,
      generatorTerminalGraceMs: 100,
    });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 10, seed: "wave-5.40a-grace" },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const frames = parseSseFrames(body);
    const runId = frames[0]!.run_id as string;
    expect(typeof runId).toBe("string");

    // Immediately after completion, the entry is still queryable.
    const inGrace = await app.inject({ method: "GET", url: `/generator/runs/${runId}/status` });
    expect(inGrace.statusCode).toBe(200);
    const inGraceJson = inGrace.json();
    expect(inGraceJson.status).toBe("done");
    expect(inGraceJson.rows_done).toBe(10);

    // After the grace window, the entry is evicted → 404.
    await new Promise<void>((r) => setTimeout(r, 200));
    const evicted = await app.inject({ method: "GET", url: `/generator/runs/${runId}/status` });
    expect(evicted.statusCode).toBe(404);
  });

  it("POST /generator/cancel works for a detached run (no SSE client attached)", async () => {
    const schema = loadFixtureSchema();
    // Slower pipeline + larger row count so cancel definitively lands before
    // the natural completion of the detached run.
    const fr = slowPipelineFakeRedis(5);
    app = await createServer({
      redis: fr,
      schema,
      generatorSseProgressIntervalMs: 5,
      generatorTerminalGraceMs: 5_000,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    const http = await import("node:http");
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/generator/start/stream",
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
    });
    req.write(JSON.stringify({ rows: 5000 }));
    req.end();

    const res = await new Promise<import("http").IncomingMessage>((resolveRes) => req.on("response", resolveRes));
    let buf = "";
    let runId: string | undefined;
    await new Promise<void>((r) => {
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        const frames = parseSseFrames(buf);
        if (frames.length >= 1 && typeof frames[0]!.run_id === "string") {
          runId = frames[0]!.run_id as string;
          req.destroy();
          r();
        }
      });
    });
    expect(runId).toBeTruthy();
    // Brief pause so the server actually has the run going.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Cancel the detached run — there is no SSE client attached.
    const cancelRes = await app.inject({ method: "POST", url: `/generator/cancel/${runId}` });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json()).toEqual({ ok: true, cancelled: true, run_id: runId });

    // Poll until terminal.
    let finalStatus: string | undefined;
    let finalRowsDone = -1;
    for (let i = 0; i < 100; i++) {
      const st = await app.inject({ method: "GET", url: `/generator/runs/${runId}/status` });
      if (st.statusCode === 200) {
        const j = st.json() as { status: string; rows_done: number };
        finalStatus = j.status;
        finalRowsDone = j.rows_done;
        if (j.status !== "running") break;
      }
      await new Promise<void>((r) => setTimeout(r, 20));
    }
    expect(finalStatus).toBe("cancelled");
    // Cancel landed before all rows were written.
    expect(finalRowsDone).toBeLessThan(5000);
    expect(fr.xadds.length).toBeLessThan(5000);
  });
});

// Wave 5.44 — POST /admin/cancel-all-runs. Iterates the module-local
// `activeRuns` registry and flips the cancel flag on every entry currently
// `status === "running"`. Tests use the `_testInsertActiveRun` helper to seed
// the registry deterministically (SSE-driven setup is timing-sensitive and
// the route's behaviour is a pure scan of a Map).
describe("POST /admin/cancel-all-runs (Wave 5.44) — admin stop all generator runs", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => { _testResetActiveRuns(); });
  afterEach(async () => { if (app) await app.close(); _testResetActiveRuns(); });

  it("returns ok:true with cancelled:0 and empty run_ids when no runs are active", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cancelled: 0, run_ids: [] });
  });

  it("flips cancelFlag on every running entry and returns each run_id", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const flagA = { cancelled: false };
    const flagB = { cancelled: false };
    _testInsertActiveRun({ run_id: "run-A", status: "running", cancelFlag: flagA });
    _testInsertActiveRun({ run_id: "run-B", status: "running", cancelFlag: flagB });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cancelled: number; run_ids: string[] };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(2);
    expect(body.run_ids.sort()).toEqual(["run-A", "run-B"]);

    expect(_testGetActiveRun("run-A")!.cancelFlag.cancelled).toBe(true);
    expect(_testGetActiveRun("run-B")!.cancelFlag.cancelled).toBe(true);
  });

  it("only cancels entries with status='running' — already-terminal runs are left alone", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const flagRunning = { cancelled: false };
    const flagDone = { cancelled: false };
    _testInsertActiveRun({ run_id: "run-live", status: "running", cancelFlag: flagRunning });
    _testInsertActiveRun({ run_id: "run-done", status: "done", cancelFlag: flagDone });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cancelled: number; run_ids: string[] };
    expect(body.cancelled).toBe(1);
    expect(body.run_ids).toEqual(["run-live"]);

    expect(_testGetActiveRun("run-live")!.cancelFlag.cancelled).toBe(true);
    // The already-terminal entry is untouched.
    expect(_testGetActiveRun("run-done")!.cancelFlag.cancelled).toBe(false);
  });

  it("is idempotent — a follow-up call after every run is cancelled returns cancelled:0", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    _testInsertActiveRun({ run_id: "run-1", status: "running", cancelFlag: { cancelled: false } });
    _testInsertActiveRun({ run_id: "run-2", status: "running", cancelFlag: { cancelled: false } });

    const first = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect((first.json() as { cancelled: number }).cancelled).toBe(2);

    // Status is still "running" (the detached loop hasn't observed the flag
    // yet); the route must skip these on the second call so we don't
    // double-count an already-cancelled run.
    const second = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, cancelled: 0, run_ids: [] });
  });
});

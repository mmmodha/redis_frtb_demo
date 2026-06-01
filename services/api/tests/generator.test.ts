import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, type Schema } from "@frtb/schema";
import { createServer } from "../src/server.ts";
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

  it("client-disconnect halts the run server-side", async () => {
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
    req.write(JSON.stringify({ rows: 2000 }));
    req.end();

    const res = await new Promise<import("http").IncomingMessage>((resolveRes) => req.on("response", resolveRes));
    let buf = "";
    await new Promise<void>((r) => {
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        if (parseSseFrames(buf).length >= 1) {
          // Abort the client connection.
          req.destroy();
          r();
        }
      });
    });
    // Give the server time to notice the close + drain.
    await new Promise<void>((r) => setTimeout(r, 50));
    const xaddsAtClose = fr.xadds.length;
    await new Promise<void>((r) => setTimeout(r, 100));
    // No further XADDs after the client disconnected.
    expect(fr.xadds.length).toBe(xaddsAtClose);
    expect(fr.xadds.length).toBeLessThan(2000);
  });
});

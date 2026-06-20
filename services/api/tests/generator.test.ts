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
    xadd(stream: string, ...rest: string[]): unknown;
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
      // Wave 5.92C-fix — XADD args may now include `MAXLEN ~ N` before the
      // `*` id placeholder. Locate `*` and map field pairs from after it so
      // the recorder is robust whether or not the route passes streamMaxLen.
      xadd(stream: string, ...rest: string[]) {
        const starIdx = rest.indexOf("*");
        const fields = starIdx >= 0 ? rest.slice(starIdx + 1) : rest.slice(1);
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
    expect(body.sensitivity_types).toEqual(["Delta", "Vega", "Curvature"]);
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

  // Wave 5.92C-fix — body's `stream_maxlen` must be threaded into
  // createStreamProducer so XADDs carry `MAXLEN ~ N`. Verifies the call-site
  // wiring at services/api/src/routes/generator.ts via the raw XADD args
  // (a separate raw-args recorder so the existing field-pair recorder is
  // untouched).
  it("threads stream_maxlen into createStreamProducer (XADD carries MAXLEN ~ N)", async () => {
    const schema = loadFixtureSchema();
    const base = fakeRedis() as FakeRedis & {
      pipeline: () => { xadd: (...args: string[]) => unknown; exec: () => Promise<Array<[Error | null, unknown]>> };
      xaddArgs: string[][];
    };
    base.xaddArgs = [];
    base.pipeline = () => {
      const buffered: string[][] = [];
      return {
        xadd(...args: string[]) { buffered.push(args); return this; },
        async exec() {
          for (const a of buffered) base.xaddArgs.push(a);
          return buffered.map(() => [null, "0-0"] as [Error | null, unknown]);
        },
      };
    };
    app = await createServer({ redis: base, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 5, stream_maxlen: 1000, seed: "wave-5.92C-fix" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows_queued).toBe(5);
    expect(base.xaddArgs.length).toBe(5);
    for (const args of base.xaddArgs) {
      expect(args[0]).toBe("sensitivities:in");
      expect(args[1]).toBe("MAXLEN");
      expect(args[2]).toBe("~");
      expect(args[3]).toBe("1000");
      expect(args[4]).toBe("*");
    }
  });

  // Wave 5.92C-fix — `stream_maxlen: 0` opts out (bit-identical to pre-5.92C
  // XADD command sequence: `XADD <key> * <fields...>`, no MAXLEN args).
  it("stream_maxlen=0 disables MAXLEN args (pre-5.92C XADD sequence)", async () => {
    const schema = loadFixtureSchema();
    const base = fakeRedis() as FakeRedis & {
      pipeline: () => { xadd: (...args: string[]) => unknown; exec: () => Promise<Array<[Error | null, unknown]>> };
      xaddArgs: string[][];
    };
    base.xaddArgs = [];
    base.pipeline = () => {
      const buffered: string[][] = [];
      return {
        xadd(...args: string[]) { buffered.push(args); return this; },
        async exec() {
          for (const a of buffered) base.xaddArgs.push(a);
          return buffered.map(() => [null, "0-0"] as [Error | null, unknown]);
        },
      };
    };
    app = await createServer({ redis: base, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 3, stream_maxlen: 0, seed: "wave-5.92C-fix" },
    });
    expect(res.statusCode).toBe(200);
    for (const args of base.xaddArgs) {
      expect(args[0]).toBe("sensitivities:in");
      expect(args[1]).toBe("*");
      expect(args).not.toContain("MAXLEN");
    }
  });

  // Wave 5.92C-fix — validation: stream_maxlen must be a non-negative integer.
  it("rejects stream_maxlen with negative / non-integer values (400)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    for (const bad of [-1, 1.5, "many"] as Array<number | string>) {
      const res = await app.inject({
        method: "POST",
        url: "/generator/start",
        payload: { rows: 5, stream_maxlen: bad as unknown as number },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/stream_maxlen/i);
    }
  });

  // Wave 6.13b — body's `defer_trim: true` must thread through both routes
  // so the producer omits per-XADD `MAXLEN ~ N` args during the run and
  // issues one `XTRIM <stream> MAXLEN ~ <cap>` per active stream key on
  // close(). Verifies the call-site wiring at services/api/src/routes/
  // generator.ts via the raw XADD + XTRIM args.
  it("defer_trim=true threads through: XADDs omit MAXLEN, close() issues XTRIM with cap", async () => {
    const schema = loadFixtureSchema();
    const base = fakeRedis() as FakeRedis & {
      pipeline: () => {
        xadd: (...args: string[]) => unknown;
        xtrim: (...args: string[]) => unknown;
        exec: () => Promise<Array<[Error | null, unknown]>>;
      };
      xaddArgs: string[][];
      xtrimArgs: string[][];
    };
    base.xaddArgs = [];
    base.xtrimArgs = [];
    base.pipeline = () => {
      const xadds: string[][] = [];
      const xtrims: string[][] = [];
      return {
        xadd(...args: string[]) { xadds.push(args); return this; },
        xtrim(...args: string[]) { xtrims.push(args); return this; },
        async exec() {
          for (const a of xadds) base.xaddArgs.push(a);
          for (const a of xtrims) base.xtrimArgs.push(a);
          return [...xadds, ...xtrims].map(() => [null, "0-0"] as [Error | null, unknown]);
        },
      };
    };
    app = await createServer({ redis: base, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 7, stream_maxlen: 1234, defer_trim: true, seed: "wave-6.13b" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows_queued).toBe(7);
    expect(base.xaddArgs.length).toBe(7);
    // Every XADD goes straight `XADD sensitivities:in * ...` — no MAXLEN
    // args sneaked in between the key and `*`.
    for (const args of base.xaddArgs) {
      expect(args[0]).toBe("sensitivities:in");
      expect(args[1]).toBe("*");
      expect(args).not.toContain("MAXLEN");
    }
    // close() must dispatch exactly one XTRIM with the deferred cap.
    expect(base.xtrimArgs).toEqual([["sensitivities:in", "MAXLEN", "~", "1234"]]);
  });

  // Wave 6.13b — validation: `defer_trim` must be a strict boolean. Numbers,
  // strings, and null are rejected at the route boundary (400).
  it("rejects defer_trim with non-boolean values (400)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    for (const bad of [1, 0, "true", "false", null] as Array<unknown>) {
      const res = await app.inject({
        method: "POST",
        url: "/generator/start",
        payload: { rows: 5, defer_trim: bad as boolean },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/defer_trim/);
    }
  });

  // Wave 5.92C-fix — validation: flow_control cross-field invariant must
  // be enforced at the route boundary (resumeBelowLen < pauseAboveLen).
  it("rejects flow_control with resumeBelowLen >= pauseAboveLen (400)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 5, flow_control: { pauseAboveLen: 100, resumeBelowLen: 200 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/resumeBelowLen/);
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

  // Wave 5.84C — seed SSE frame carries the resolved `plan` (shape +
  // dials) so the UI can show the chosen profile from frame 0. The fake
  // redis has no CLUSTER INFO / CONFIG GET responses set → the probe
  // catches each and falls back; pickProfile returns `small`.
  it("seed frame includes a plan object with the resolved profile + dials (Wave 5.84C)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 25 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const frames = parseSseFrames(body);
    const seed = frames[0]!;
    expect(seed.plan).toBeDefined();
    const plan = seed.plan as Record<string, unknown>;
    expect(plan.profile).toBe("small");
    expect(plan.profile_requested).toBe("auto");
    expect((plan.shape as Record<string, unknown>).mode).toBe("standalone");
    expect((plan.shape as Record<string, unknown>).shards).toBe(1);
    // Wave 5.94 raised the `small` profile dials (workers:1→2, batch:500→2000,
    // window:1→4) — the seed frame surfaces whatever resolveDials() emits, so
    // this assertion pins the post-5.94 values. Independent of host CPU count
    // (small never scales with cores; only `large` uses hostCores).
    expect((plan.dials as Record<string, unknown>).workers).toBe(2);
    expect((plan.dials as Record<string, unknown>).batch_size).toBe(2000);
    expect((plan.dials as Record<string, unknown>).pipeline_window).toBe(4);
    expect(plan.bytes_per_row).toBe(2048);
    expect(plan.rows).toBe(25);
  });

  // Wave 5.84C — explicit profile in the body overrides auto-pick; manual
  // batch_size in the same body overrides the profile's dial (DoD #4).
  it("explicit profile=medium + manual batch_size overrides the dial (Wave 5.84C)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 10, profile: "medium", batch_size: 333 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const seed = parseSseFrames(body)[0]!;
    const plan = seed.plan as Record<string, unknown>;
    expect(plan.profile).toBe("medium");
    expect(plan.profile_requested).toBe("medium");
    const dials = plan.dials as Record<string, unknown>;
    expect(dials.batch_size).toBe(333);
    // Wave 6.13a — fakeRedis probes as standalone (no CLUSTER INFO stub) →
    // shape.shards=1 → medium streamShards collapses to 1 (fan-out=1) →
    // resolved pipeline_window is the fan-out=1 default (4), not the
    // fan-out>1 default (8).
    expect(dials.pipeline_window).toBe(4);
    expect((plan.overrides as Record<string, unknown>).batchSize).toBe(true);
  });

  // Wave 5.84C — invalid profile value → 400.
  it("rejects an unknown profile with 400 (Wave 5.84C)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 10, profile: "xlarge" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/profile must be one of/i);
  });

  // Wave 6.11b — manual stream_shards on a standalone-presenting target
  // surfaces a soft warning on the plan response (Redis Enterprise DMC
  // proxy case). Cluster-presenting targets get no warning.
  it("plan response carries a warning when shape=standalone and stream_shards is set (Wave 6.11b)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    // Default fake redis throws on CLUSTER INFO → probeForApi falls back to
    // shape.mode = "standalone", matching the seed-plan test above.
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 25, stream_shards: 16 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const seed = parseSseFrames(body)[0]!;
    const plan = seed.plan as Record<string, unknown>;
    expect((plan.shape as Record<string, unknown>).mode).toBe("standalone");
    expect(Array.isArray(plan.warnings)).toBe(true);
    const warnings = plan.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/standalone/i);
    expect(warnings[0]).toMatch(/16/);
  });

  it("plan response carries no warning when shape=cluster, even with stream_shards set (Wave 6.11b)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    // Stub CLUSTER INFO so the probe reports cluster mode (3 shards).
    fr.setResponse("CLUSTER", "cluster_enabled:1\r\ncluster_state:ok\r\ncluster_size:3\r\n");
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 25, stream_shards: 16 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const seed = parseSseFrames(body)[0]!;
    const plan = seed.plan as Record<string, unknown>;
    expect((plan.shape as Record<string, unknown>).mode).toBe("cluster");
    expect(plan.warnings).toBeUndefined();
  });

  // Wave 6.12c — GET /generator/runs/:id/status returns the resolved
  // `dials` block (workers, batch_size, pipeline_window, stream_shards)
  // populated from the same object the SSE seed frame carries, so a
  // refresh after the seed frame is gone can still confirm the plan.
  it("GET /generator/runs/:id/status returns the resolved dials block (Wave 6.12c)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 25, stream_shards: 16 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    const body = await collectStream(res.stream() as unknown as NodeJS.ReadableStream);
    const frames = parseSseFrames(body);
    const seed = frames[0]!;
    const runId = seed.run_id as string;
    const seedDials = (seed.plan as Record<string, unknown>).dials as Record<string, unknown>;

    const statusRes = await app.inject({ method: "GET", url: `/generator/runs/${runId}/status` });
    expect(statusRes.statusCode).toBe(200);
    const statusJson = statusRes.json() as Record<string, unknown>;
    expect(statusJson.dials).toBeDefined();
    const dials = statusJson.dials as Record<string, unknown>;
    expect(dials.stream_shards).toBe(16);
    // Resolved dials must match the seed-frame plan dials byte-for-byte so
    // the UI can switch between the seed frame and the status endpoint
    // without drift.
    expect(dials.workers).toBe(seedDials.workers);
    expect(dials.batch_size).toBe(seedDials.batch_size);
    expect(dials.pipeline_window).toBe(seedDials.pipeline_window);
    expect(dials.stream_shards).toBe(seedDials.stream_shards);
  });

  // Wave 6.12c — the non-streaming /generator/start path has no seed
  // frame and never populates ActiveRun.dials, so the response body shape
  // must stay unchanged (no `dials` key sneaking into the JSON response).
  it("non-streaming /generator/start response shape stays unchanged — no dials key (Wave 6.12c)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.dials).toBeUndefined();
  });

  // Wave 6.12c — boot log line for a streaming run includes both
  // stream_shards and stream_maxlen so .run/logs/api.log shows the
  // resolved fan-out shape (the per-MAXLEN log in runGeneratorLoop
  // never carried stream_shards). Uses the calc-sbm.test pattern of
  // swapping app.log.info for a capturing spy without flipping
  // `logger: true` (which would spam stdout for the whole suite).
  it("boot log line includes stream_shards alongside stream_maxlen (Wave 6.12c)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    const infos: unknown[] = [];
    (app.log as unknown as { info: (obj: unknown, msg?: string) => void }).info = (obj: unknown) => {
      infos.push(obj);
    };

    const res = await app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 10, stream_shards: 8 },
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    await collectStream(res.stream() as unknown as NodeJS.ReadableStream);

    const bootHit = infos.find(
      (i) => typeof i === "object" && i !== null
        && (i as { evt?: string }).evt === "generator-stream"
        && typeof (i as { stream_shards?: unknown }).stream_shards === "number",
    ) as Record<string, unknown> | undefined;
    expect(bootHit).toBeDefined();
    expect(bootHit!.stream_shards).toBe(8);
    // Default DEFAULT_STREAM_MAXLEN (2_000_000) is in effect when the body
    // omits stream_maxlen; mirrors the const in services/api/src/routes/generator.ts.
    expect(bootHit!.stream_maxlen).toBe(2_000_000);
    expect(typeof bootHit!.run_id).toBe("string");
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
    // means at least one yield point where the cancel inject can land. Wave
    // 5.84A bumped DEFAULT_BATCH_SIZE to 1000 so this test now pins the small
    // batch via the new body field (also covers the validated batch_size).
    const streamPromise = app.inject({
      method: "POST",
      url: "/generator/start/stream",
      payload: { rows: 600, batch_size: 200 },
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
describe("POST /admin/cancel-all-runs (Wave 5.44 / 6.44.E) — admin stop all generator runs", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => { _testResetActiveRuns(); });
  afterEach(async () => { if (app) await app.close(); _testResetActiveRuns(); });

  // Wave 6.44.E — every cancel-all-runs call now also proxies to ingest's
  // /ingest/halt-and-flush. These tests inject a stub fetch via INGEST_URL
  // override + a custom server option so we can assert both the cancel
  // bookkeeping AND the flush summary in the response, without standing up
  // a real ingest service. cancelDrainMs is dialled down to keep the suite
  // fast (the detached producer loop is never actually running in-test).
  const FLUSH_OK = { ok: true, streams_trimmed: 4, docs_cleared: 12, elapsed_ms: 7 };

  function makeIngestFetchStub(reply: { ok: boolean; status?: number; body: unknown }): {
    impl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit | undefined }>;
  } {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const impl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, init });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? (reply.ok ? 200 : 500),
        headers: { "content-type": "application/json" },
      });
    };
    return { impl, calls };
  }

  it("returns ok:true cancelled:0 plus the flush summary when no runs are active", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeIngestFetchStub({ ok: true, body: FLUSH_OK });
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cancelled: 0, run_ids: [], flush: FLUSH_OK });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe("http://stub-ingest:8083/ingest/halt-and-flush");
    expect((stub.calls[0]!.init as RequestInit).method).toBe("POST");
  });

  it("flips cancelFlag on every running entry and returns each run_id alongside the flush summary", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeIngestFetchStub({ ok: true, body: FLUSH_OK });
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    const flagA = { cancelled: false };
    const flagB = { cancelled: false };
    _testInsertActiveRun({ run_id: "run-A", status: "running", cancelFlag: flagA });
    _testInsertActiveRun({ run_id: "run-B", status: "running", cancelFlag: flagB });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cancelled: number; run_ids: string[]; flush: typeof FLUSH_OK };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(2);
    expect(body.run_ids.sort()).toEqual(["run-A", "run-B"]);
    expect(body.flush).toEqual(FLUSH_OK);

    expect(_testGetActiveRun("run-A")!.cancelFlag.cancelled).toBe(true);
    expect(_testGetActiveRun("run-B")!.cancelFlag.cancelled).toBe(true);
  });

  it("only cancels entries with status='running' — already-terminal runs are left alone", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeIngestFetchStub({ ok: true, body: FLUSH_OK });
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    const flagRunning = { cancelled: false };
    const flagDone = { cancelled: false };
    _testInsertActiveRun({ run_id: "run-live", status: "running", cancelFlag: flagRunning });
    _testInsertActiveRun({ run_id: "run-done", status: "done", cancelFlag: flagDone });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cancelled: number; run_ids: string[]; flush: typeof FLUSH_OK };
    expect(body.cancelled).toBe(1);
    expect(body.run_ids).toEqual(["run-live"]);
    expect(body.flush).toEqual(FLUSH_OK);

    expect(_testGetActiveRun("run-live")!.cancelFlag.cancelled).toBe(true);
    // The already-terminal entry is untouched.
    expect(_testGetActiveRun("run-done")!.cancelFlag.cancelled).toBe(false);
  });

  it("is idempotent — a follow-up call after every run is cancelled returns cancelled:0 but still flushes", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeIngestFetchStub({ ok: true, body: FLUSH_OK });
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    _testInsertActiveRun({ run_id: "run-1", status: "running", cancelFlag: { cancelled: false } });
    _testInsertActiveRun({ run_id: "run-2", status: "running", cancelFlag: { cancelled: false } });

    const first = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect((first.json() as { cancelled: number }).cancelled).toBe(2);

    // Wave 6.44.F — after the drain window expires the route force-marks
    // both entries `status="cancelled"`; the second call skips them on the
    // `status === "running"` filter so the cancelled count stays at 0. The
    // flush still runs and is idempotent on the ingest side too — DoD #2.
    const second = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, cancelled: 0, run_ids: [], flush: FLUSH_OK });
    expect(stub.calls).toHaveLength(2);
  });

  // Wave 6.44.F — DoD #2: immediately after cancel-all-runs returns 200,
  // GET /generator/runs/:id/status for every previously-active run_id must
  // return `{status:"cancelled"}` — not `{status:"running"}` and not 404.
  // The detached producer loop never observes the flag in this test (no
  // producer is running), so the route must force-mark each entry terminal
  // after the drain window expires.
  it("(6.44.F) force-marks entries cancelled after drain so /generator/runs/:id/status reports terminal immediately", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeIngestFetchStub({ ok: true, body: FLUSH_OK });
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    _testInsertActiveRun({ run_id: "run-stuck-1", status: "running", cancelFlag: { cancelled: false } });
    _testInsertActiveRun({ run_id: "run-stuck-2", status: "running", cancelFlag: { cancelled: false } });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { cancelled: number }).cancelled).toBe(2);

    // Registry-level invariant: both entries are terminal with cancel
    // bookkeeping populated.
    for (const id of ["run-stuck-1", "run-stuck-2"]) {
      const entry = _testGetActiveRun(id);
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("cancelled");
      expect(entry!.stop_reason).toBe("cancelled");
      expect(typeof entry!.terminal_at_ms).toBe("number");
      expect(entry!.cancelFlag.cancelled).toBe(true);
    }

    // Status-route invariant: the UI's polling sees `{status:"cancelled"}`
    // immediately, not `{status:"running"}` and not 404.
    for (const id of ["run-stuck-1", "run-stuck-2"]) {
      const statusRes = await app.inject({ method: "GET", url: `/generator/runs/${id}/status` });
      expect(statusRes.statusCode).toBe(200);
      const body = statusRes.json() as { status: string; stop_reason?: string };
      expect(body.status).toBe("cancelled");
      expect(body.stop_reason).toBe("cancelled");
    }
  });

  // Wave 6.44.E DoD #4 — ingest unreachable must NOT 5xx; cancel flags must
  // still be set and `flush: null` surfaces so the UI can render a partial-
  // success banner.
  it("returns flush:null with 200 when ingest is unreachable (cancel flags still set)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const impl: typeof fetch = async () => { throw new Error("ECONNREFUSED stub"); };
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: impl, generatorCancelDrainMs: 10 });

    _testInsertActiveRun({ run_id: "run-X", status: "running", cancelFlag: { cancelled: false } });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cancelled: number; run_ids: string[]; flush: unknown };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(1);
    expect(body.run_ids).toEqual(["run-X"]);
    expect(body.flush).toBeNull();
    expect(_testGetActiveRun("run-X")!.cancelFlag.cancelled).toBe(true);
  });

  it("returns flush:null when ingest replies non-2xx (cancel still succeeds)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeIngestFetchStub({ ok: false, status: 504, body: { ok: false, error: "halt-and-flush timed out", stage: "drain" } });
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    const res = await app.inject({ method: "POST", url: "/admin/cancel-all-runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { flush: unknown };
    expect(body.flush).toBeNull();
  });
});

// Wave 6.53.A — POST /admin/stop-runs is the non-destructive split of the
// /admin/cancel-all-runs escape hatch. It runs the same cancel-flag + drain
// + force-terminal bookkeeping but must NOT call /ingest/halt-and-flush
// (the destructive XTRIM + SCAN/UNLINK stays behind /admin/flush). The UI
// "Stop generators" button hits this route; the legacy /admin/cancel-all-runs
// stays wired for backward compat with external callers / the admin CLI.
describe("POST /admin/stop-runs (Wave 6.53.A) — non-destructive stop generators", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(() => { _testResetActiveRuns(); });
  afterEach(async () => { if (app) await app.close(); _testResetActiveRuns(); });

  // Spy fetch — the route must NOT call it. Records every URL so the
  // assertion can name the offending one if a regression sneaks the
  // halt-and-flush back in.
  function makeNoCallFetchStub(): {
    impl: typeof fetch;
    calls: Array<{ url: string }>;
  } {
    const calls: Array<{ url: string }> = [];
    const impl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url });
      // Defensive: if the route ever did call us, return a shape that
      // would surface in the response so the failure is loud.
      return new Response(JSON.stringify({ ok: true, streams_trimmed: 99, docs_cleared: 99 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { impl, calls };
  }

  it("returns ok:true cancelled:0 with no flush field and no ingest call when no runs are active", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeNoCallFetchStub();
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    const res = await app.inject({ method: "POST", url: "/admin/stop-runs" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, cancelled: 0, run_ids: [] });
    // DoD: the destructive path is NOT invoked from /admin/stop-runs.
    expect(stub.calls).toHaveLength(0);
  });

  it("flips cancelFlag on every running entry, returns run_ids, and does NOT call /ingest/halt-and-flush", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeNoCallFetchStub();
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    const flagA = { cancelled: false };
    const flagB = { cancelled: false };
    _testInsertActiveRun({ run_id: "run-A", status: "running", cancelFlag: flagA });
    _testInsertActiveRun({ run_id: "run-B", status: "running", cancelFlag: flagB });

    const res = await app.inject({ method: "POST", url: "/admin/stop-runs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; cancelled: number; run_ids: string[]; flush?: unknown };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(2);
    expect(body.run_ids.sort()).toEqual(["run-A", "run-B"]);
    // Response shape must NOT carry a `flush` field — the UI client type
    // (StopAllRunsResponse) intentionally omits it so a misleading
    // "flushed N streams" banner can't render.
    expect("flush" in body).toBe(false);

    expect(_testGetActiveRun("run-A")!.cancelFlag.cancelled).toBe(true);
    expect(_testGetActiveRun("run-B")!.cancelFlag.cancelled).toBe(true);

    // DoD: no halt-and-flush invocation against ingest, ever.
    expect(stub.calls.find((c) => /\/ingest\/halt-and-flush$/.test(c.url))).toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it("force-marks entries cancelled after drain so /generator/runs/:id/status reports terminal immediately", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    const stub = makeNoCallFetchStub();
    app = await createServer({ redis: fr, schema, ingestBase: "http://stub-ingest:8083", generatorFetchImpl: stub.impl, generatorCancelDrainMs: 10 });

    _testInsertActiveRun({ run_id: "run-stuck", status: "running", cancelFlag: { cancelled: false } });

    const res = await app.inject({ method: "POST", url: "/admin/stop-runs" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { cancelled: number }).cancelled).toBe(1);

    const entry = _testGetActiveRun("run-stuck");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("cancelled");
    expect(entry!.stop_reason).toBe("cancelled");
    expect(typeof entry!.terminal_at_ms).toBe("number");
    expect(entry!.cancelFlag.cancelled).toBe(true);

    const statusRes = await app.inject({ method: "GET", url: "/generator/runs/run-stuck/status" });
    expect(statusRes.statusCode).toBe(200);
    const statusBody = statusRes.json() as { status: string; stop_reason?: string };
    expect(statusBody.status).toBe("cancelled");
    expect(statusBody.stop_reason).toBe("cancelled");

    // Still no halt-and-flush — even after the force-terminal path runs.
    expect(stub.calls).toHaveLength(0);
  });
});

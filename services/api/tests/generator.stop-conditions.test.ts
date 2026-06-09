// Wave 5.47c — optional stop conditions (rows / memory_pct / elapsed_seconds)
// on /generator/start and /generator/start/stream. Whichever condition trips
// first halts the loop and surfaces `stop_reason` on the terminal frame /
// status entry. This file exercises validation + the row-stop happy path; the
// elapsed/memory paths use the same picker shape and are smoke-checked through
// the non-streaming /start route to keep the suite fast and deterministic.

import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSchema, type Schema } from "@frtb/schema";
import { createServer } from "../src/server.ts";
import { fakeRedis, type FakeRedis } from "./helpers/fake-redis.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function loadFixtureSchema(): Schema {
  return loadSchema(
    resolve(__dirname, "../../generator/tests/fixtures/multi-class.yaml"),
  );
}

// Pipeline-recording fake mirrors the one in generator.class-split.test.ts so
// xadd calls are surfaced without booting real Redis.
interface XaddRecord { stream: string; fields: Record<string, string> }
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
      // Wave 5.92C-fix — skip past optional MAXLEN ~ N args by locating the
      // `*` id placeholder before mapping field pairs.
      xadd(stream: string, ...rest: string[]) {
        const starIdx = rest.indexOf("*");
        const fields = starIdx >= 0 ? rest.slice(starIdx + 1) : rest.slice(1);
        const map: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
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

describe("POST /generator/start — stop_when validation (Wave 5.47c)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => { if (app) await app.close(); });

  it("rejects empty stop_when with 400", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 10, stop_when: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least one condition/);
  });

  it("rejects negative stop_when.rows", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { stop_when: { rows: -5 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/stop_when\.rows must be a positive integer/);
  });

  it("rejects NaN / non-integer stop_when.memory_pct", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 10, stop_when: { memory_pct: Number.NaN } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/memory_pct/);
  });

  it("rejects out-of-range memory_pct (>95)", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 10, stop_when: { memory_pct: 99 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/1\.\.95/);
  });

  it("rejects elapsed_seconds == 0", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 10, stop_when: { elapsed_seconds: 0 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/elapsed_seconds/);
  });

  it("rejects class_split + stop_when.rows mismatch (sum != stop_when.rows)", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: {
        class_split: { GIRR: 30, FX: 20 },
        stop_when: { rows: 100 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/class_split totals 50 but stop_when\.rows is 100/);
  });

  it("rejects rows + stop_when.rows mismatch", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 100, stop_when: { rows: 50 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/rows is 100 but stop_when\.rows is 50/);
  });
});

describe("POST /generator/start — stop_when row-stop happy path (Wave 5.47c)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => { if (app) await app.close(); });

  it("stop_when:{rows:50} stops at exactly 50 and reports stop_reason='rows'", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { stop_when: { rows: 50 }, seed: "wave-5.47c-rows" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.rows_queued).toBe(50);
    expect(body.stop_reason).toBe("rows");
    expect(fr.xadds).toHaveLength(50);
  });

  it("no stop_when ⇒ defaults to existing rows behaviour and stop_reason='rows'", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 12, seed: "wave-5.47c-default" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows_queued).toBe(12);
    expect(body.stop_reason).toBe("rows");
  });

  it("elapsed_seconds halts the loop early; terminal frame has stop_reason='elapsed'", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });
    const t0 = Date.now();
    // Pick a tiny elapsed_seconds (the validator allows finite positive
    // floats) and a very large row target so the elapsed-check trips before
    // the row loop drains. 0.05s is small enough that the fixture generator
    // can't queue ~2M rows in time.
    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 2_000_000, stop_when: { elapsed_seconds: 0.05 }, seed: "wave-5.47c-elapsed" },
    });
    const wall = Date.now() - t0;
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stop_reason).toBe("elapsed");
    expect(body.rows_queued).toBeLessThan(2_000_000);
    // Gives a generous upper bound; the loop should halt within ~1s of t0
    // even with CI noise.
    expect(wall).toBeLessThan(5_000);
  }, 10_000);
});

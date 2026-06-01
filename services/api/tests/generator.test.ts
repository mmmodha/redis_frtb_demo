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

  it("rejects rows > 2000 with 400 and emits no XADDs", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 5000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/rows must be/i);
    expect(fr.xadds).toHaveLength(0);
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

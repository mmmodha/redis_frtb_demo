// Wave 5.47d — explicit per-class row counts via `class_split`. When present,
// the generator draws each class exactly the configured count, interleaved
// Bresenham-style so progress events see a consistent mix instead of
// "all GIRR then all FX". This test exercises both the body validation and
// the actual row sequence produced.

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

// Same pipeline-recording shim as generator.test.ts — kept local so the tests
// stay independent.
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
      // Wave 5.92C-fix — locate `*` id placeholder so optional MAXLEN ~ N
      // args (added when the route resolves a non-zero stream_maxlen) do
      // not shift the field-pair mapping.
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

describe("POST /generator/start — class_split (Wave 5.47d)", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  afterEach(async () => { if (app) await app.close(); });

  it("explicit { GIRR: 100, FX: 50 } produces exactly 150 rows with correct per-class counts", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const res = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { class_split: { GIRR: 100, FX: 50 }, seed: "wave-5.47d-test" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.rows_queued).toBe(150);
    expect(body.classes).toEqual(["GIRR", "FX"]);

    expect(fr.xadds).toHaveLength(150);
    const counts: Record<string, number> = {};
    for (const rec of fr.xadds) {
      const rc = rec.fields.risk_class!;
      counts[rc] = (counts[rc] ?? 0) + 1;
    }
    expect(counts).toEqual({ GIRR: 100, FX: 50 });
  });

  it("interleaves classes (not block-sorted: at least one GIRR appears before the last FX)", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { class_split: { GIRR: 100, FX: 50 } },
    });
    const seq = fr.xadds.map((r) => r.fields.risk_class!);
    // Block-sorted would be 100 GIRRs then 50 FXs. The interleaver must put
    // FX rows mixed throughout. Concretely, no contiguous run of one class
    // should exceed ceil(150/50) + a small slack = 5.
    let runLen = 1;
    let maxRun = 1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === seq[i - 1]) { runLen += 1; maxRun = Math.max(maxRun, runLen); }
      else runLen = 1;
    }
    expect(maxRun).toBeLessThan(10);
    // And the first half should already contain both classes.
    const firstHalf = new Set(seq.slice(0, 75));
    expect(firstHalf.has("GIRR")).toBe(true);
    expect(firstHalf.has("FX")).toBe(true);
  });

  it("class_split + matching rows is accepted; mismatched rows → 400 with hint", async () => {
    const schema = loadFixtureSchema();
    app = await createServer({ redis: pipelineFakeRedis(), schema });

    const ok = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 150, class_split: { GIRR: 100, FX: 50 } },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: "POST",
      url: "/generator/start",
      payload: { rows: 200, class_split: { GIRR: 100, FX: 50 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/class_split totals 150 but rows is 200/);
  });

  it("rejects empty map, negative count, non-integer count, and unknown class", async () => {
    const schema = loadFixtureSchema();
    const fr = pipelineFakeRedis();
    app = await createServer({ redis: fr, schema });

    const empty = await app.inject({ method: "POST", url: "/generator/start", payload: { class_split: {} } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toMatch(/class_split cannot be empty/);

    const neg = await app.inject({ method: "POST", url: "/generator/start", payload: { class_split: { GIRR: -1 } } });
    expect(neg.statusCode).toBe(400);
    expect(neg.json().error).toMatch(/class_split\[GIRR\] must be a non-negative integer/);

    const frac = await app.inject({ method: "POST", url: "/generator/start", payload: { class_split: { GIRR: 1.5 } } });
    expect(frac.statusCode).toBe(400);
    expect(frac.json().error).toMatch(/non-negative integer/);

    const unknown = await app.inject({ method: "POST", url: "/generator/start", payload: { class_split: { BOGUS: 10 } } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatch(/unknown risk class: BOGUS/);

    expect(fr.xadds).toHaveLength(0);
  });
});

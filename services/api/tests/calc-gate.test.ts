// Wave 6.39.B — CALC_ALLOW_FT_AGGREGATE gate. When disabled (default in
// prod), any /calc/sbm path that would fall through to the FT.AGGREGATE
// fast path (because the rollup HASH is missing for the discovered
// bucket) must return 412 `fallback-disabled` with a hint pointing the
// operator at /admin/calc-coverage. The rollup fast-fast path is unchanged
// — only the FT.AGGREGATE fallback is gated.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer } from "../src/server.ts";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { resetActiveTarget } from "../src/active-target.ts";
import { CALC_DATA_VERSION_KEY } from "../src/sbm/calc-cache.ts";

function primeCommon(fr: ReturnType<typeof fakeRedis>): void {
  fr.setResponse("GET", (args: unknown[]) =>
    args[0] === CALC_DATA_VERSION_KEY ? null : null,
  );
  // Bucket discovery: one bucket, USD-IRS
  fr.setResponse("SMEMBERS", () => ["USD-IRS"]);
  // FT.INFO carries num_docs>0 so the no-data-or-index branch doesn't fire
  fr.setResponse("FT.INFO", () => ["num_docs", "1000"]);
  // Rollup HGETALL: empty → tryRollupReadout returns null → calc would
  // fall through to FT.AGGREGATE.
  fr.setResponse("HGETALL", () => []);
}

describe("Wave 6.39.B — /calc/sbm gate", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  const PREV_GATE = process.env.CALC_ALLOW_FT_AGGREGATE;
  const PREV_FAST = process.env.CALC_FAST_PATH;
  const PREV_ROLLUP = process.env.CALC_ROLLUP_PATH;
  const PREV_FCALL = process.env.CALC_FCALL_FALLBACK;

  beforeEach(() => {
    // Force the production path: fast path on, rollup on (so missing
    // rollup falls through to gated FT.AGGREGATE), FCALL fallback off.
    process.env.CALC_FAST_PATH = "1";
    process.env.CALC_ROLLUP_PATH = "1";
    process.env.CALC_FCALL_FALLBACK = "0";
  });

  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
    if (PREV_GATE === undefined) delete process.env.CALC_ALLOW_FT_AGGREGATE;
    else process.env.CALC_ALLOW_FT_AGGREGATE = PREV_GATE;
    if (PREV_FAST === undefined) delete process.env.CALC_FAST_PATH;
    else process.env.CALC_FAST_PATH = PREV_FAST;
    if (PREV_ROLLUP === undefined) delete process.env.CALC_ROLLUP_PATH;
    else process.env.CALC_ROLLUP_PATH = PREV_ROLLUP;
    if (PREV_FCALL === undefined) delete process.env.CALC_FCALL_FALLBACK;
    else process.env.CALC_FCALL_FALLBACK = PREV_FCALL;
  });

  it("returns 412 fallback-disabled when CALC_ALLOW_FT_AGGREGATE=false and rollup is missing", async () => {
    process.env.CALC_ALLOW_FT_AGGREGATE = "false";
    const fr = fakeRedis();
    primeCommon(fr);
    // Minimal schema so the fast path can resolve fields
    const stubSchema = {
      risk_classes: { EQUITY: { intra_bucket_correlation_ref: "equity_rho" } },
      correlations: { equity_rho: { kind: "constant", value: 0.5 } },
      risk_weights: {},
    } as unknown as Parameters<typeof createServer>[0]["schema"];
    app = await createServer({
      redis: fr,
      schema: stubSchema,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" },
      correlations: { EQUITY: { kind: "constant", value: 0.15 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "EQUITY", sensitivity_type: "delta" },
    });
    expect(res.statusCode).toBe(412);
    const body = res.json();
    expect(body.error).toBe("fallback-disabled");
    expect(String(body.hint ?? "")).toMatch(/calc-coverage/);
  });

  it("falls through to FT.AGGREGATE normally when CALC_ALLOW_FT_AGGREGATE=true", async () => {
    process.env.CALC_ALLOW_FT_AGGREGATE = "true";
    const fr = fakeRedis();
    primeCommon(fr);
    // FT.AGGREGATE returns a fast-path aggregate row for the bucket
    fr.setResponse("FT.AGGREGATE", () => [
      1,
      [
        "bucket", "USD-IRS",
        "sum_d_ws_equity_delta", "1.5",
        "sum_d_ws_equity_delta_sq", "2.25",
        "row_count", "1",
      ],
    ]);
    const stubSchema = {
      risk_classes: { EQUITY: { intra_bucket_correlation_ref: "equity_rho" } },
      correlations: { equity_rho: { kind: "constant", value: 0.5 } },
      risk_weights: {},
    } as unknown as Parameters<typeof createServer>[0]["schema"];
    app = await createServer({
      redis: fr,
      schema: stubSchema,
      activeTarget: { host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" },
      correlations: { EQUITY: { kind: "constant", value: 0.15 } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/calc/sbm",
      payload: { risk_class: "EQUITY", sensitivity_type: "delta" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.engine).toBe("ft_aggregate");
    expect(typeof body.charge).toBe("number");
  });
});

// Wave 6.39.B — GET /admin/calc-coverage. Walks the materialized discovery
// sets (`seen:risk_class` → `seen:bucket:{<rc>}` → `seen:sens_type:{<rc>:<bkt>}`,
// maintained by Wave 6.24 ingest) and reports per-tuple rollup presence
// plus the contributing-doc count from the rollup HASH so operators can see
// at a glance which (rc, bucket, sens_type) cells will satisfy /calc on the
// rollup fast-fast path vs. fall back to FT.AGGREGATE (which is gated by
// CALC_ALLOW_FT_AGGREGATE per the same wave).

import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { registerAdminCalcRoutes } from "../src/routes/admin-calc.ts";
import { resetActiveTarget, setActiveTarget } from "../src/active-target.ts";

describe("Wave 6.39.B — GET /admin/calc-coverage", () => {
  let app: ReturnType<typeof Fastify>;
  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
  });

  it("walks seen:* sets and reports per-tuple rollup presence + sens_doc_count", async () => {
    const fr = fakeRedis();
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" });

    // Discovery sets: one rc (EQUITY), two buckets (B1, B2), with one
    // sens_type each (Delta). B1 has a populated rollup (count=5); B2 has
    // no rollup hash yet (rollup_present=false, sens_doc_count=0).
    fr.setResponse("SMEMBERS", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return ["EQUITY"];
      if (key === "seen:bucket:{EQUITY}") return ["B1", "B2"];
      if (key === "seen:sens_type:{EQUITY:B1}") return ["Delta"];
      if (key === "seen:sens_type:{EQUITY:B2}") return ["Delta"];
      return [];
    });
    fr.setResponse("HGETALL", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "rollup:{EQUITY:B1}:Delta") return ["sum_ws", "1.5", "sum_ws_sq", "2.25", "count", "5"];
      return []; // B2 — missing rollup
    });

    app = Fastify();
    registerAdminCalcRoutes(app, () => fr);
    const res = await app.inject({ method: "GET", url: "/admin/calc-coverage" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coverage).toBeInstanceOf(Array);
    expect(body.coverage).toHaveLength(2);
    expect(body.coverage).toContainEqual({
      risk_class: "EQUITY",
      bucket: "B1",
      sens_type: "Delta",
      rollup_present: true,
      sens_doc_count: 5,
    });
    expect(body.coverage).toContainEqual({
      risk_class: "EQUITY",
      bucket: "B2",
      sens_type: "Delta",
      rollup_present: false,
      sens_doc_count: 0,
    });
    // Summary surface for the UI banner
    expect(body.summary).toEqual({ total: 2, present: 1, missing: 1 });
  });

  it("returns an empty coverage list when seen:risk_class is empty", async () => {
    const fr = fakeRedis();
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" });
    fr.setResponse("SMEMBERS", () => []);
    app = Fastify();
    registerAdminCalcRoutes(app, () => fr);
    const res = await app.inject({ method: "GET", url: "/admin/calc-coverage" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ coverage: [], summary: { total: 0, present: 0, missing: 0 } });
  });

  it("handles perTenor (GIRR) rollups by detecting any tenor variant", async () => {
    const fr = fakeRedis();
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" });
    fr.setResponse("SMEMBERS", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "seen:risk_class") return ["GIRR"];
      if (key === "seen:bucket:{GIRR}") return ["USD"];
      if (key === "seen:sens_type:{GIRR:USD}") return ["Delta"];
      return [];
    });
    // GIRR base rollup is empty; rely on SCAN to find per-tenor variants
    fr.setResponse("HGETALL", () => []);
    fr.setResponse("SCAN", (args: unknown[]) => {
      // SCAN cursor 0 MATCH rollup:{GIRR:USD}:Delta:tenor:* COUNT 100
      const match = String(args[2] ?? "");
      if (match.startsWith("rollup:{GIRR:USD}:Delta:tenor:")) {
        return ["0", ["rollup:{GIRR:USD}:Delta:tenor:3M", "rollup:{GIRR:USD}:Delta:tenor:6M"]];
      }
      return ["0", []];
    });
    // Per-tenor rollup HGET on `count` for sum
    fr.setResponse("HGET", (args: unknown[]) => {
      const key = String(args[0]);
      if (key === "rollup:{GIRR:USD}:Delta:tenor:3M") return "2";
      if (key === "rollup:{GIRR:USD}:Delta:tenor:6M") return "3";
      return null;
    });
    app = Fastify();
    registerAdminCalcRoutes(app, () => fr);
    const res = await app.inject({ method: "GET", url: "/admin/calc-coverage" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coverage).toEqual([
      { risk_class: "GIRR", bucket: "USD", sens_type: "Delta", rollup_present: true, sens_doc_count: 5 },
    ]);
  });
});

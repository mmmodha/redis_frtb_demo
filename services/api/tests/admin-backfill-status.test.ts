// Wave 6.39.B — GET /admin/backfill-status. The full backfill loop
// (post-bootstrap scan + targeted FT.AGGREGATE batches) is deferred to a
// Followup task; this turn only ships the route surface with the
// documented JSON shape so the UI's progress card can wire in advance and
// the operator can confirm the surface is reserved.

import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { fakeRedis } from "./helpers/fake-redis.ts";
import { registerAdminCalcRoutes } from "../src/routes/admin-calc.ts";
import { resetActiveTarget, setActiveTarget } from "../src/active-target.ts";

describe("Wave 6.39.B — GET /admin/backfill-status", () => {
  let app: ReturnType<typeof Fastify>;
  afterEach(async () => {
    if (app) await app.close();
    resetActiveTarget();
  });

  it("returns the documented progress shape with status=not-implemented", async () => {
    const fr = fakeRedis();
    setActiveTarget({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "primary" });
    app = Fastify();
    registerAdminCalcRoutes(app, () => fr);
    const res = await app.inject({ method: "GET", url: "/admin/backfill-status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      total: 0,
      completed: 0,
      in_flight: 0,
      failed: 0,
      eta_ms: 0,
      status: "not-implemented",
    });
  });
});

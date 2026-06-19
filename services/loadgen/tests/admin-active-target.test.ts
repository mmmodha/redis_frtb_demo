// Wave 6.43.B.3 — POST /admin/active-target/{prepare,commit} contract tests
// for the loadgen service. Prepare halts the runner (idempotent via
// runner.stop()); commit invokes a caller-supplied callback (production wires
// the active-target watcher's pollOnce).

import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "../src/server.ts";

async function mkApp(extra: Parameters<typeof createServer>[0] = {}): Promise<FastifyInstance> {
  return createServer({
    apiBase: "http://127.0.0.1:1",
    fetch: async () => new Response("{}", { status: 200 }),
    ...extra,
  });
}

describe("POST /admin/active-target/prepare (loadgen)", () => {
  it("returns 200 + phase=drained when no token is configured (dev mode)", async () => {
    const app = await mkApp();
    try {
      const res = await app.inject({
        method: "POST", url: "/admin/active-target/prepare",
        payload: { switch_id: "s1", target: { label: "x" } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, switch_id: "s1", phase: "drained" });
    } finally { await app.close(); }
  });

  it("rejects with 401 when bearer is missing or wrong", async () => {
    const app = await mkApp({ internalToken: "tok" });
    try {
      const noAuth = await app.inject({ method: "POST", url: "/admin/active-target/prepare", payload: {} });
      expect(noAuth.statusCode).toBe(401);
      const badAuth = await app.inject({
        method: "POST", url: "/admin/active-target/prepare",
        headers: { authorization: "Bearer wrong" }, payload: {},
      });
      expect(badAuth.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("accepts the configured bearer", async () => {
    const app = await mkApp({ internalToken: "tok" });
    try {
      const ok = await app.inject({
        method: "POST", url: "/admin/active-target/prepare",
        headers: { authorization: "Bearer tok" }, payload: { switch_id: "s2" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, phase: "drained", switch_id: "s2" });
    } finally { await app.close(); }
  });

  it("stops the runner — loadgenIsRunning() reads false after prepare", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const app = await mkApp({ fetch: fetchMock });
    try {
      const started = await app.inject({
        method: "POST", url: "/loadgen/start",
        payload: { concurrency: 2, duration_sec: 60, mix: { pivot: 1, calc: 0 } },
      });
      expect(started.statusCode).toBe(202);
      // Yield once so the worker loop actually fires a request before stop.
      await new Promise((r) => setTimeout(r, 10));
      expect(app.loadgenIsRunning()).toBe(true);

      const prepared = await app.inject({
        method: "POST", url: "/admin/active-target/prepare", payload: { switch_id: "s3" },
      });
      expect(prepared.statusCode).toBe(200);
      expect(app.loadgenIsRunning()).toBe(false);
    } finally { await app.close(); }
  });
});

describe("POST /admin/active-target/commit (loadgen)", () => {
  it("invokes commitSwitch and returns phase=committed", async () => {
    let invoked = 0;
    const app = await mkApp({ commitSwitch: async () => { invoked++; } });
    try {
      const res = await app.inject({
        method: "POST", url: "/admin/active-target/commit",
        payload: { switch_id: "s4", target: { label: "new" } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, switch_id: "s4", phase: "committed" });
      expect(invoked).toBe(1);
    } finally { await app.close(); }
  });

  it("rejects with 401 when bearer is missing", async () => {
    const app = await mkApp({ internalToken: "tok" });
    try {
      const res = await app.inject({ method: "POST", url: "/admin/active-target/commit", payload: {} });
      expect(res.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("returns 500 when commitSwitch throws", async () => {
    const app = await mkApp({ commitSwitch: async () => { throw new Error("kaboom"); } });
    try {
      const res = await app.inject({
        method: "POST", url: "/admin/active-target/commit", payload: { switch_id: "s5" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ ok: false, switch_id: "s5" });
    } finally { await app.close(); }
  });
});

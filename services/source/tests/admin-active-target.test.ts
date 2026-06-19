// Wave 6.43.B.3 — POST /admin/active-target/{prepare,commit} contract tests
// for the source service. Mirrors the ingest active-target endpoint test:
// bearer auth, drain timeout → 504, commit invokes the watcher pollOnce.

import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadSchema } from "@frtb/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type CreateServerOpts } from "../src/server.ts";
import { createSourceStore } from "../src/store.ts";
import { makeFakeRedis } from "./helpers/fake-redis.ts";

const SCHEMA = resolve(
  fileURLToPath(import.meta.url), "..", "..", "..", "..",
  "config/schema/frtb-default.yaml",
);

async function mkApp(extra: Partial<CreateServerOpts> = {}): Promise<FastifyInstance> {
  const redis = makeFakeRedis();
  const store = createSourceStore({ redis });
  return createServer({
    redis, store, schema: loadSchema(SCHEMA),
    uploadDir: "/tmp/admin-active-target-test",
    ...extra,
  });
}

describe("POST /admin/active-target/prepare (source)", () => {
  it("returns 200 + phase=drained when no token is configured (dev mode)", async () => {
    const app = await mkApp({});
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
      const noAuth = await app.inject({
        method: "POST", url: "/admin/active-target/prepare", payload: { switch_id: "s1" },
      });
      expect(noAuth.statusCode).toBe(401);
      const badAuth = await app.inject({
        method: "POST", url: "/admin/active-target/prepare",
        headers: { authorization: "Bearer wrong" }, payload: { switch_id: "s1" },
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

  it("returns 504 when prepareSwitch exceeds its timeout", async () => {
    const app = await mkApp({
      prepareSwitch: () => new Promise<void>(() => { /* hang */ }),
      // 10 ms keeps the test fast; production default is 30 s.
      prepareTimeoutMs: 10,
    });
    try {
      const res = await app.inject({
        method: "POST", url: "/admin/active-target/prepare", payload: { switch_id: "s3" },
      });
      expect(res.statusCode).toBe(504);
      expect(res.json()).toMatchObject({ ok: false, switch_id: "s3" });
    } finally { await app.close(); }
  });
});

describe("POST /admin/active-target/commit (source)", () => {
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

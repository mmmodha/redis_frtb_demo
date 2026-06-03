import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { createStore, type ConnectionsStore } from "../src/store.ts";
import { resetActiveTarget } from "../src/active-target.ts";

const KEY = "test-master-key";

async function freshStore(): Promise<ConnectionsStore> {
  const filePath = join(mkdtempSync(join(tmpdir(), "frtb-api-")), "connections.enc.json");
  return createStore({ filePath, masterKey: KEY });
}

describe("/connections HTTP routes", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let store: ConnectionsStore;

  beforeEach(async () => {
    resetActiveTarget();
    store = await freshStore();
    app = await createServer({
      store,
      // tester injected so we don't require a real Redis to test the test action
      tester: async (profile) => ({
        ok: true,
        latency_ms: 1,
        modules: [
          { name: "JSON", present: true },
          { name: "Search", present: true },
          { name: "Time Series", present: true },
          { name: "Probabilistic", present: true },
        ],
        errors: [],
      }),
    });
  });
  afterEach(async () => {
    await app.close();
    resetActiveTarget();
  });

  it("POST /connections creates a profile and never returns the password", async () => {
    const res = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.example.com", port: 12000, password: "SECRET-XYZ" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.password).toBe("***");
    expect(JSON.stringify(body)).not.toContain("SECRET-XYZ");
  });

  it("GET /connections lists profiles with passwords redacted", async () => {
    await app.inject({ method: "POST", url: "/connections", payload: { name: "a", host: "h1", port: 1, password: "PA" } });
    await app.inject({ method: "POST", url: "/connections", payload: { name: "b", host: "h2", port: 2, password: "PB" } });
    const res = await app.inject({ method: "GET", url: "/connections" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    for (const p of body) expect(p.password).toBe("***");
    expect(JSON.stringify(body)).not.toContain("PA");
    expect(JSON.stringify(body)).not.toContain("PB");
  });

  it("GET /connections/:id returns 404 for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/connections/unknown-id" });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /connections/:id updates host and password without returning the new password", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "h", port: 1, password: "OLD" },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { host: "newhost", password: "NEW-SECRET" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.host).toBe("newhost");
    expect(body.password).toBe("***");
    expect(JSON.stringify(body)).not.toContain("NEW-SECRET");
  });

  it("DELETE /connections/:id removes the profile", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections", payload: { name: "demo", host: "h", port: 1 },
    });
    const id = created.json().id;
    const res = await app.inject({ method: "DELETE", url: `/connections/${id}` });
    expect(res.statusCode).toBe(204);
    const get = await app.inject({ method: "GET", url: `/connections/${id}` });
    expect(get.statusCode).toBe(404);
  });

  it("POST /connections/:id/test runs the injected tester and returns result without creds", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections", payload: { name: "demo", host: "h", port: 1, password: "PW" },
    });
    const id = created.json().id;
    const res = await app.inject({ method: "POST", url: `/connections/${id}/test` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.modules.find((m: { name: string }) => m.name === "JSON").present).toBe(true);
    expect(body.modules.map((m: { name: string }) => m.name)).toEqual([
      "JSON", "Search", "Time Series", "Probabilistic",
    ]);
    expect(JSON.stringify(body)).not.toContain("PW");
  });

  it("POST /connections/:id/activate sets the active target and exposes it via /redis/active-target", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, password: "PW", tls: { enabled: true } },
    });
    const id = created.json().id;
    const act = await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    expect(act.statusCode).toBe(200);
    const target = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(target.statusCode).toBe(200);
    const body = target.json();
    expect(body).toMatchObject({ host: "rs.demo", port: 12000, tls: true, label: "demo" });
    expect(body.password).toBeUndefined();
  });

  it("GET /connections/active returns the active profile redacted", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections", payload: { name: "demo", host: "h", port: 1, password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    const res = await app.inject({ method: "GET", url: "/connections/active" });
    expect(res.statusCode).toBe(200);
    expect(res.json().password).toBe("***");
  });

  it("GET /connections/active returns 404 when nothing is active", async () => {
    const res = await app.inject({ method: "GET", url: "/connections/active" });
    expect(res.statusCode).toBe(404);
  });

  it("Wave 5.59: editing the active profile updates the active-target singleton label", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    const before = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(before.json().label).toBe("demo");

    const put = await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { name: "demo-renamed" },
    });
    expect(put.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(after.json()).toMatchObject({ host: "rs.demo", port: 12000, label: "demo-renamed" });
  });

  it("Wave 5.59: editing the active profile's host propagates to the singleton", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "old-host", port: 12000, password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });

    const patch = await app.inject({
      method: "PATCH", url: `/connections/${id}`,
      payload: { host: "new-host", port: 13000 },
    });
    expect(patch.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(after.json()).toMatchObject({ host: "new-host", port: 13000, label: "demo" });
  });

  it("Wave 5.59: editing a NON-active profile does NOT mutate the singleton", async () => {
    const a = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "active-one", host: "rs.active", port: 12000, password: "PW" },
    });
    const b = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "other-one", host: "rs.other", port: 12001, password: "PW" },
    });
    const activeId = a.json().id;
    const otherId = b.json().id;
    await app.inject({ method: "POST", url: `/connections/${activeId}/activate` });
    const before = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(before.json()).toMatchObject({ host: "rs.active", port: 12000, label: "active-one" });

    const put = await app.inject({
      method: "PUT", url: `/connections/${otherId}`,
      payload: { name: "other-renamed", host: "rs.other-new" },
    });
    expect(put.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/redis/active-target" });
    // Singleton is untouched — still the active profile's identity.
    expect(after.json()).toMatchObject({ host: "rs.active", port: 12000, label: "active-one" });
  });

  it("Wave 5.59: identity-changing edit on the active profile is blocked while inflight ops exist (409)", async () => {
    const { register, resetInflightRegistryForTests } = await import("../src/inflight-registry.ts");
    resetInflightRegistryForTests();
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    const handle = register("loadgen", "loadgen-1");

    try {
      // Identity-changing edit (host) is blocked.
      const blocked = await app.inject({
        method: "PUT", url: `/connections/${id}`,
        payload: { host: "rs.new-host" },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({
        error: expect.stringMatching(/in flight/i),
        inflight: expect.arrayContaining([expect.objectContaining({ label: "loadgen-1" })]),
      });
      // Name-only edit is allowed through unchanged.
      const allowed = await app.inject({
        method: "PUT", url: `/connections/${id}`,
        payload: { name: "demo-renamed" },
      });
      expect(allowed.statusCode).toBe(200);
      const after = await app.inject({ method: "GET", url: "/redis/active-target" });
      expect(after.json().label).toBe("demo-renamed");
    } finally {
      handle.release();
      resetInflightRegistryForTests();
    }
  });

  it("GET /redis/active-target falls back to default when nothing is active (per existing contract)", async () => {
    const res = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.label).toBe("default");
    expect(body.password).toBeUndefined();
  });
});

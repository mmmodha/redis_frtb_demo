// Wave 5.16u — internal full-credential target endpoint.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { createStore, type ConnectionsStore } from "../src/store.ts";
import { resetActiveTarget } from "../src/active-target.ts";
import { resetInternalTargetVersionForTests } from "../src/routes/internal-target.ts";

const KEY = "test-master-key";

async function freshStore(): Promise<ConnectionsStore> {
  const filePath = join(mkdtempSync(join(tmpdir(), "frtb-api-itok-")), "connections.enc.json");
  return createStore({ filePath, masterKey: KEY });
}

describe("GET /internal/redis/active-target/full", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let store: ConnectionsStore;
  const originalToken = process.env.INTERNAL_API_TOKEN;

  beforeEach(async () => {
    resetActiveTarget();
    resetInternalTargetVersionForTests();
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    store = await freshStore();
    app = await createServer({ store });
  });

  afterEach(async () => {
    await app.close();
    resetActiveTarget();
    if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = originalToken;
  });

  it("returns full credentials (including password) and a version, with valid bearer", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/connections",
      payload: { name: "rs-demo", host: "rs.example.com", port: 12000, password: "PWD-XYZ", tls: { enabled: true } },
    });
    const id = created.json().id;
    const act = await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    expect(act.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer test-internal-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      host: "rs.example.com",
      port: 12000,
      tls: true,
      db: 0,
      label: "rs-demo",
      password: "PWD-XYZ",
    });
    expect(typeof body.version).toBe("number");
    expect(body.version).toBeGreaterThanOrEqual(2); // bumped at least once by activate
  });

  it("bumps version on every setActiveTarget call", async () => {
    const a = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "a", host: "h1", port: 1, password: "P1" },
    });
    const b = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "b", host: "h2", port: 2, password: "P2" },
    });
    const idA = a.json().id;
    const idB = b.json().id;
    await app.inject({ method: "POST", url: `/connections/${idA}/activate` });
    const r1 = await app.inject({
      method: "GET", url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer test-internal-token" },
    });
    const v1 = r1.json().version as number;
    await app.inject({ method: "POST", url: `/connections/${idB}/activate` });
    const r2 = await app.inject({
      method: "GET", url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer test-internal-token" },
    });
    const v2 = r2.json().version as number;
    expect(v2).toBeGreaterThan(v1);
    expect(r2.json().label).toBe("b");
    expect(r2.json().password).toBe("P2");
  });

  it("returns 401 when the bearer header is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/redis/active-target/full" });
    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(res.json())).not.toContain("test-internal-token");
  });

  it("returns 401 when the bearer token does not match", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  // Wave 5.16y — Test B: after `/connections/:id/activate`, the public
  // `/redis/active-target` and the internal `/internal/redis/active-target/full`
  // endpoints must agree on label/host/port/tls/db. Public never carries the
  // password; internal does. Drift between the two was the primary symptom
  // that motivated this wave.
  it("public + internal endpoints return the same identity after activate", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/connections",
      payload: {
        name: "live-standalone",
        host: "rs.live",
        port: 6390,
        password: "PW-LIVE",
        tls: { enabled: false },
        db: 0,
      },
    });
    const id = created.json().id;
    const act = await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    expect(act.statusCode).toBe(200);

    const pub = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(pub.statusCode).toBe(200);
    const publicBody = pub.json();

    const internal = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer test-internal-token" },
    });
    expect(internal.statusCode).toBe(200);
    const internalBody = internal.json();

    // Identity fields must match across both endpoints.
    expect(publicBody.label).toBe(internalBody.label);
    expect(publicBody.host).toBe(internalBody.host);
    expect(publicBody.port).toBe(internalBody.port);
    expect(publicBody.tls).toBe(internalBody.tls);
    expect(publicBody.db).toBe(internalBody.db);
    expect(publicBody.label).toBe("live-standalone");

    // Public must NOT leak the password under any key. Internal must include it.
    expect(publicBody.password).toBeUndefined();
    expect(JSON.stringify(publicBody)).not.toContain("PW-LIVE");
    expect(internalBody.password).toBe("PW-LIVE");
  });

  // Wave 5.99B — the source watcher's defaultRedisFactory branches strictly on
  // `clusterMode === true`. The wire format MUST therefore carry an explicit
  // boolean (not omitted, not stringified) so legacy ActiveTarget payloads
  // without a clusterMode field default to false and the proxy-endpoint /
  // Enterprise-style single-node path stays bit-for-bit identical to Wave 5.99.
  it("surfaces clusterMode as a boolean on the standalone path", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/connections",
      payload: {
        name: "live-standalone",
        host: "rs.live",
        port: 6390,
        password: "PW-LIVE",
        tls: { enabled: false },
        db: 0,
      },
    });
    const id = created.json().id;
    const act = await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    expect(act.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer test-internal-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("clusterMode");
    expect(body.clusterMode).toBe(false);
    expect(typeof body.clusterMode).toBe("boolean");
  });

  it("surfaces clusterMode: true when the active connection was registered with clusterMode: true", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/connections",
      payload: {
        name: "live-cluster",
        host: "rs.cluster",
        port: 6391,
        password: "PW-CLUSTER",
        clusterMode: true,
      },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });

    const res = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer test-internal-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().clusterMode).toBe(true);
  });

  it("returns 503 when INTERNAL_API_TOKEN is not configured", async () => {
    await app.close();
    delete process.env.INTERNAL_API_TOKEN;
    app = await createServer({ store });
    const res = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/full",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "INTERNAL_API_TOKEN not configured" });
  });
});

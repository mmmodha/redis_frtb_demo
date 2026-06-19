// Wave 5.16u — internal full-credential target endpoint.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { createStore, type ConnectionsStore } from "../src/store.ts";
import {
  resetActiveTarget,
  setActiveTarget,
  __setSwitchPublisherForTests,
  __resetSwitchStateForTests,
} from "../src/active-target.ts";
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

// Wave 6.43.B.1 — switch coordinator: prepare/commit handoff plus the ACK
// ingress (`POST /internal/redis/active-target/ack`) and status surface
// (`GET /internal/redis/active-target/switch-status`). Subscribers ship in
// 6.43.B.2/3; these tests drive the coordinator via the test seam.
describe("Wave 6.43.B.1 — switch coordinator", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let store: ConnectionsStore;
  const originalToken = process.env.INTERNAL_API_TOKEN;
  const originalKnown = process.env.KNOWN_SERVICES;
  const originalDrainMs = process.env.SWITCH_DRAIN_TIMEOUT_MS;
  const AUTH = { authorization: "Bearer test-internal-token" } as const;

  beforeEach(async () => {
    resetActiveTarget();
    resetInternalTargetVersionForTests();
    __resetSwitchStateForTests();
    __setSwitchPublisherForTests(null);
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    process.env.KNOWN_SERVICES = "ingest,source,loadgen";
    store = await freshStore();
    app = await createServer({ store });
    // Seed an initial active target so the next setActiveTarget triggers the
    // prepare/commit path (first-ever set takes the fast path by design).
    setActiveTarget({ host: "old.host", port: 6379, tls: false, db: 0, label: "old" });
  });

  afterEach(async () => {
    __setSwitchPublisherForTests(null);
    __resetSwitchStateForTests();
    await app.close();
    resetActiveTarget();
    if (originalToken === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = originalToken;
    if (originalKnown === undefined) delete process.env.KNOWN_SERVICES;
    else process.env.KNOWN_SERVICES = originalKnown;
    if (originalDrainMs === undefined) delete process.env.SWITCH_DRAIN_TIMEOUT_MS;
    else process.env.SWITCH_DRAIN_TIMEOUT_MS = originalDrainMs;
  });

  it("happy path: 3 services ACK drained → switch commits and per-service progresses to committed on commit ACKs", async () => {
    // Capture the switch_id from the prepare publish; deliver ACKs from
    // three known services so the drain wait resolves quickly.
    let switchId: string | null = null;
    const publishes: Array<{ channel: string; payload: unknown; kind: string }> = [];
    __setSwitchPublisherForTests(async (channel, payload, kind) => {
      const parsed = JSON.parse(payload) as { switch_id: string };
      publishes.push({ channel, payload: JSON.parse(payload), kind });
      if (channel === "intent:active-target:prepare") {
        switchId = parsed.switch_id;
        // Fire ACKs from the three known services on the next tick so the
        // coordinator has already entered `draining` when they arrive.
        queueMicrotask(() => {
          for (const svc of ["ingest", "source", "loadgen"]) {
            void app.inject({
              method: "POST",
              url: "/internal/redis/active-target/ack",
              headers: AUTH,
              payload: { switch_id: switchId, service: svc, phase: "drained", ok: true },
            });
          }
        });
      }
      return 3;
    });
    await setActiveTarget({ host: "new.host", port: 6379, tls: false, db: 0, label: "new" });
    // After commit each service reports a commit ACK.
    expect(switchId).not.toBeNull();
    for (const svc of ["ingest", "source", "loadgen"]) {
      const r = await app.inject({
        method: "POST",
        url: "/internal/redis/active-target/ack",
        headers: AUTH,
        payload: { switch_id: switchId, service: svc, phase: "committed", ok: true },
      });
      expect(r.statusCode).toBe(200);
    }
    const status = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/switch-status",
      headers: AUTH,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.current_switch_id).toBe(switchId);
    expect(body.phase).toBe("committed");
    const phasesByName = Object.fromEntries(
      body.per_service.map((s: { name: string; phase: string }) => [s.name, s.phase]),
    );
    expect(phasesByName).toEqual({ ingest: "committed", source: "committed", loadgen: "committed" });
    expect(publishes.map((p) => p.channel)).toEqual([
      "intent:active-target:prepare",
      "intent:active-target:commit",
    ]);
  });

  it("missing-ACK timeout: 1 service never ACKs → switch commits at the configured timeout, marked drain_timeout", async () => {
    process.env.SWITCH_DRAIN_TIMEOUT_MS = "60";
    let switchId: string | null = null;
    __setSwitchPublisherForTests(async (channel, payload) => {
      const parsed = JSON.parse(payload) as { switch_id: string };
      if (channel === "intent:active-target:prepare") {
        switchId = parsed.switch_id;
        queueMicrotask(() => {
          for (const svc of ["ingest", "source"]) {
            void app.inject({
              method: "POST",
              url: "/internal/redis/active-target/ack",
              headers: AUTH,
              payload: { switch_id: switchId, service: svc, phase: "drained", ok: true },
            });
          }
        });
      }
      return 3;
    });
    const t0 = Date.now();
    await setActiveTarget({ host: "n2", port: 6379, tls: false, db: 0, label: "n2" });
    const elapsed = Date.now() - t0;
    // Drain window is 60ms; commit must fire within a generous bound and not
    // earlier than the timeout if loadgen never ACKs.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1000);
    const status = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/switch-status",
      headers: AUTH,
    });
    const body = status.json();
    expect(body.phase).toBe("committed");
    const phasesByName = Object.fromEntries(
      body.per_service.map((s: { name: string; phase: string }) => [s.name, s.phase]),
    );
    expect(phasesByName.ingest).toBe("drained");
    expect(phasesByName.source).toBe("drained");
    expect(phasesByName.loadgen).toBe("drain_timeout");
  });

  it("stale switch_id: ACK is rejected with 409 superseded and status is unchanged", async () => {
    let switchId: string | null = null;
    __setSwitchPublisherForTests(async (channel, payload) => {
      const parsed = JSON.parse(payload) as { switch_id: string };
      if (channel === "intent:active-target:prepare") {
        switchId = parsed.switch_id;
        queueMicrotask(() => {
          for (const svc of ["ingest", "source", "loadgen"]) {
            void app.inject({
              method: "POST",
              url: "/internal/redis/active-target/ack",
              headers: AUTH,
              payload: { switch_id: switchId, service: svc, phase: "drained", ok: true },
            });
          }
        });
      }
      return 3;
    });
    await setActiveTarget({ host: "n1", port: 6379, tls: false, db: 0, label: "n1" });
    const firstSwitchId = switchId;
    // Trigger a second switch; the first switch_id is now stale.
    await setActiveTarget({ host: "n2", port: 6379, tls: false, db: 0, label: "n2" });
    const statusBefore = (await app.inject({
      method: "GET", url: "/internal/redis/active-target/switch-status", headers: AUTH,
    })).json();
    const lateAck = await app.inject({
      method: "POST",
      url: "/internal/redis/active-target/ack",
      headers: AUTH,
      payload: { switch_id: firstSwitchId, service: "ingest", phase: "committed", ok: true },
    });
    expect(lateAck.statusCode).toBe(409);
    expect(lateAck.json()).toEqual({ error: "superseded" });
    const statusAfter = (await app.inject({
      method: "GET", url: "/internal/redis/active-target/switch-status", headers: AUTH,
    })).json();
    expect(statusAfter).toEqual(statusBefore);
  });

  it("malformed ACK is rejected with 400 and a reason", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: "/internal/redis/active-target/ack",
      headers: AUTH,
      payload: { switch_id: 123, service: "ingest", phase: "drained", ok: true },
    });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toBe("malformed");

    const r2 = await app.inject({
      method: "POST",
      url: "/internal/redis/active-target/ack",
      headers: AUTH,
      payload: { switch_id: "x", service: "ingest", phase: "garbage", ok: true },
    });
    expect(r2.statusCode).toBe(400);

    const r3 = await app.inject({
      method: "POST",
      url: "/internal/redis/active-target/ack",
      headers: AUTH,
      payload: { switch_id: "x", service: "ingest", phase: "drained", ok: "yes" },
    });
    expect(r3.statusCode).toBe(400);
  });

  it("ACK + status endpoints require bearer auth", async () => {
    const ack = await app.inject({
      method: "POST",
      url: "/internal/redis/active-target/ack",
      payload: { switch_id: "x", service: "ingest", phase: "drained", ok: true },
    });
    expect(ack.statusCode).toBe(401);
    const status = await app.inject({
      method: "GET",
      url: "/internal/redis/active-target/switch-status",
    });
    expect(status.statusCode).toBe(401);
  });
});

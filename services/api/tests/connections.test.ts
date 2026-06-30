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
    // Wave 6.55.G — password sentinels include lowercase characters so they
    // cannot collide with a Crockford-base32 ULID id (which is uppercase-only
    // `[0-9A-HJKMNP-TV-Z]`). The previous "PA"/"PB" sentinels flaked roughly
    // once per 1024 generated ULIDs when the random tail happened to contain
    // those two adjacent characters.
    const pwA = "pa-secret-leak";
    const pwB = "pb-secret-leak";
    await app.inject({ method: "POST", url: "/connections", payload: { name: "a", host: "h1", port: 1, password: pwA } });
    await app.inject({ method: "POST", url: "/connections", payload: { name: "b", host: "h2", port: 2, password: pwB } });
    const res = await app.inject({ method: "GET", url: "/connections" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    for (const p of body) expect(p.password).toBe("***");
    expect(JSON.stringify(body)).not.toContain(pwA);
    expect(JSON.stringify(body)).not.toContain(pwB);
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

  it("POST /connections/probe runs tester without persisting a profile", async () => {
    let testerCalled = false;
    const probeApp = await createServer({
      store,
      tester: async (profile) => {
        testerCalled = true;
        expect(profile.host).toBe("rs.probe");
        expect(profile.port).toBe(12000);
        expect(profile.password).toBe("probe-secret");
        return {
          ok: true,
          latency_ms: 2,
          modules: [{ name: "JSON", present: true }],
          errors: [],
        };
      },
    });
    const res = await probeApp.inject({
      method: "POST",
      url: "/connections/probe",
      payload: { name: "draft", host: "rs.probe", port: 12000, password: "probe-secret" },
    });
    await probeApp.close();
    expect(res.statusCode).toBe(200);
    expect(testerCalled).toBe(true);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain("probe-secret");
    const list = await app.inject({ method: "GET", url: "/connections" });
    expect(list.json()).toHaveLength(0);
  });

  it("POST /connections/probe returns 400 when host or port is invalid", async () => {
    const badHost = await app.inject({
      method: "POST",
      url: "/connections/probe",
      payload: { name: "x", host: "", port: 12000 },
    });
    expect(badHost.statusCode).toBe(400);
    const badPort = await app.inject({
      method: "POST",
      url: "/connections/probe",
      payload: { name: "x", host: "h", port: 0 },
    });
    expect(badPort.statusCode).toBe(400);
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

  it("GET /redis/active-target returns 503 when nothing is active (UI-first bootstrap)", async () => {
    const res = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/no active target/i);
  });

  describe("Wave 5.60 — duplicate-endpoint guard", () => {
    it("POST duplicate (host, port, db) → 409 with duplicate-endpoint payload", async () => {
      const first = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "first", host: "rs.demo", port: 12000, db: 0 },
      });
      expect(first.statusCode).toBe(201);
      const firstId = first.json().id;

      const dup = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "dup", host: "rs.demo", port: 12000, db: 0 },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({
        error: "duplicate-endpoint",
        existing_id: firstId,
        existing_name: "first",
        host: "rs.demo",
        port: 12000,
        db: 0,
      });
    });

    it("first POST of a unique endpoint still works", async () => {
      const res = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "unique", host: "rs.unique", port: 12000 },
      });
      expect(res.statusCode).toBe(201);
    });

    it("PUT changing host to an existing endpoint → 409", async () => {
      const a = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "a", host: "rs.a", port: 12000 },
      });
      const b = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "b", host: "rs.b", port: 12000 },
      });
      const aId = a.json().id;
      const bId = b.json().id;

      const put = await app.inject({
        method: "PUT", url: `/connections/${bId}`,
        payload: { host: "rs.a" },
      });
      expect(put.statusCode).toBe(409);
      expect(put.json()).toMatchObject({
        error: "duplicate-endpoint",
        existing_id: aId,
        existing_name: "a",
      });
    });

    it("PUT to the same endpoint (no host/port/db change) on the SAME profile → 200", async () => {
      const created = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "demo", host: "rs.demo", port: 12000 },
      });
      const id = created.json().id;
      const put = await app.inject({
        method: "PUT", url: `/connections/${id}`,
        payload: { name: "demo-renamed" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().name).toBe("demo-renamed");
    });

    it("case-insensitive host match (REDIS-1.LAB vs redis-1.lab) → 409", async () => {
      await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "lower", host: "redis-1.lab", port: 12000 },
      });
      const dup = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "upper", host: "REDIS-1.LAB", port: 12000 },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe("duplicate-endpoint");
    });

    it("whitespace-trim in host comparison → 409", async () => {
      await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "clean", host: "rs.demo", port: 12000 },
      });
      const dup = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "padded", host: "  rs.demo  ", port: 12000 },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe("duplicate-endpoint");
    });

    it("missing-db vs db:0 treated as equal → 409", async () => {
      await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "no-db", host: "rs.demo", port: 12000 }, // db missing
      });
      const dup = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "db-zero", host: "rs.demo", port: 12000, db: 0 },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe("duplicate-endpoint");
    });

    it("inflight 409 payload remains distinguishable from duplicate-endpoint", async () => {
      const { register, resetInflightRegistryForTests } = await import("../src/inflight-registry.ts");
      resetInflightRegistryForTests();
      const created = await app.inject({
        method: "POST", url: "/connections",
        payload: { name: "demo", host: "rs.demo", port: 12000 },
      });
      const id = created.json().id;
      await app.inject({ method: "POST", url: `/connections/${id}/activate` });
      const handle = register("loadgen", "loadgen-1");
      try {
        const blocked = await app.inject({
          method: "PUT", url: `/connections/${id}`,
          payload: { host: "rs.new-host" },
        });
        expect(blocked.statusCode).toBe(409);
        // The inflight payload uses `inflight` array, not `error: "duplicate-endpoint"`.
        const body = blocked.json();
        expect(body.error).not.toBe("duplicate-endpoint");
        expect(Array.isArray(body.inflight)).toBe(true);
      } finally {
        handle.release();
        resetInflightRegistryForTests();
      }
    });
  });
});


// Wave 5.62 — renaming the active connection profile must NOT re-trigger the
// "Bootstrapping…" banner. The bootstrap scheduler subscribes to active-target
// listeners, so the route must use the silent setActiveTargetLabel helper for
// pure renames and only call activateProfileTarget (which fires listeners)
// when identity (host/port/tls/db/clusterMode) actually changes.
describe("Wave 5.62 — rename does not re-trigger bootstrap banner", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let store: ConnectionsStore;

  beforeEach(async () => {
    const { resetBootstrapStatusForTests, setBootstrapRunnerForTests, setDebounceMsForTests } =
      await import("../src/bootstrap-status.ts");
    resetActiveTarget();
    resetBootstrapStatusForTests();
    setDebounceMsForTests(5);
    // Stub the bootstrap runner so we don't touch a real Redis. Resolves
    // immediately so the status reaches "ready" after the debounce window.
    setBootstrapRunnerForTests(() => Promise.resolve());
    store = await freshStore();
    const fakeSchema = { risk_classes: [] } as unknown as Parameters<typeof createServer>[0]["schema"];
    app = await createServer({
      store,
      schema: fakeSchema,
      // Any non-null redis client satisfies scheduleBootstrap's guard;
      // routes that need a real client aren't exercised in these tests.
      redis: {} as unknown as Parameters<typeof createServer>[0]["redis"],
    });
  });

  afterEach(async () => {
    const { resetBootstrapStatusForTests, setBootstrapRunnerForTests } =
      await import("../src/bootstrap-status.ts");
    await app.close();
    resetActiveTarget();
    resetBootstrapStatusForTests();
    setBootstrapRunnerForTests(null);
  });

  it("PUT { name } on the active profile does not flip bootstrap-status.phase to 'running'", async () => {
    const { getBootstrapStatus } = await import("../src/bootstrap-status.ts");
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    // Wait past debounce so the initial activation's bootstrap resolves to ready.
    await new Promise((r) => setTimeout(r, 30));
    expect(getBootstrapStatus().phase).toBe("ready");

    const phaseBefore = getBootstrapStatus().phase;
    const put = await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { name: "demo-renamed" },
    });
    expect(put.statusCode).toBe(200);
    // Synchronously after the rename, phase must NOT have flipped to "running".
    expect(getBootstrapStatus().phase).toBe(phaseBefore);
    // And after the debounce window would have fired, still no flip.
    await new Promise((r) => setTimeout(r, 30));
    expect(getBootstrapStatus().phase).toBe("ready");
  });

  it("PUT { host } on the active profile DOES schedule bootstrap (regression for identity edits)", async () => {
    const { getBootstrapStatus, markBootstrapStatusReady } = await import("../src/bootstrap-status.ts");
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    await new Promise((r) => setTimeout(r, 30));
    // Force a known "ready" baseline tied to a different label so the next
    // schedule call doesn't short-circuit on the same-label ready guard.
    markBootstrapStatusReady("baseline");

    const put = await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { host: "rs.new-host" },
    });
    expect(put.statusCode).toBe(200);
    // Identity change → listener fires → scheduleBootstrap flips synchronously
    // to "running" before the debounce timer dispatches the runner.
    const after = getBootstrapStatus();
    expect(after.phase).toBe("running");
    expect(after.target_label).toBe("demo");
  });

  it("GET /redis/active-target reflects the new label after a rename", async () => {
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { name: "demo-renamed" },
    });
    const target = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(target.json()).toMatchObject({ host: "rs.demo", port: 12000, label: "demo-renamed" });
  });

  // Wave 5.65 — the UI's updateConnection() submits the full form body on
  // every save (name, host, port, username, …), only conditionally omitting
  // password. The 5.62 check used `!== undefined`, so echoed-but-unchanged
  // username re-triggered bootstrap on every rename. These cases pin the
  // value-based comparison: presence alone is not enough, the value must
  // actually differ from the stored profile.
  it("echoed username with name-only change does NOT re-trigger bootstrap", async () => {
    const { getBootstrapStatus } = await import("../src/bootstrap-status.ts");
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, username: "default", password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    await new Promise((r) => setTimeout(r, 30));
    expect(getBootstrapStatus().phase).toBe("ready");

    const put = await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { name: "demo-renamed", username: "default", port: 12000, host: "rs.demo" },
    });
    expect(put.statusCode).toBe(200);
    expect(getBootstrapStatus().phase).not.toBe("running");
    await new Promise((r) => setTimeout(r, 30));
    expect(getBootstrapStatus().phase).not.toBe("running");
    const target = await app.inject({ method: "GET", url: "/redis/active-target" });
    expect(target.json().label).toBe("demo-renamed");
  });

  it("genuine username change DOES trigger bootstrap", async () => {
    const { getBootstrapStatus, markBootstrapStatusReady } =
      await import("../src/bootstrap-status.ts");
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, username: "default", password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    await new Promise((r) => setTimeout(r, 30));
    markBootstrapStatusReady("baseline");

    const put = await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { username: "new-user" },
    });
    expect(put.statusCode).toBe(200);
    expect(getBootstrapStatus().phase).toBe("running");
  });

  it("empty password string is treated as no-change (does not trigger bootstrap)", async () => {
    const { getBootstrapStatus } = await import("../src/bootstrap-status.ts");
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, username: "default", password: "PW" },
    });
    const id = created.json().id;
    await app.inject({ method: "POST", url: `/connections/${id}/activate` });
    await new Promise((r) => setTimeout(r, 30));
    expect(getBootstrapStatus().phase).toBe("ready");

    const put = await app.inject({
      method: "PUT", url: `/connections/${id}`,
      payload: { name: "x", password: "" },
    });
    expect(put.statusCode).toBe(200);
    expect(getBootstrapStatus().phase).not.toBe("running");
  });
});

// Wave 5.16w — tests for the in-flight registry + activation lockout +
// /inflight surface. Covers:
//   1. register / release / count semantics
//   2. list() entries carry started_at
//   3. activation lockout: 409 when registry non-empty, 200 when empty
//   4. stale eviction: entries older than INFLIGHT_STALE_MS do NOT block
//      activation; they appear in the `stale` payload instead
//   5. SSE /inflight/stream emits a `change` event when a handle is registered

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.ts";
import { createStore, type ConnectionsStore } from "../src/store.ts";
import { resetActiveTarget, getActiveTarget } from "../src/active-target.ts";
import * as inflight from "../src/inflight-registry.ts";

const KEY = "test-master-key";

async function freshStore(): Promise<ConnectionsStore> {
  const filePath = join(mkdtempSync(join(tmpdir(), "frtb-api-inflight-")), "connections.enc.json");
  return createStore({ filePath, masterKey: KEY });
}

describe("inflight-registry singleton", () => {
  beforeEach(() => {
    inflight.resetInflightRegistryForTests();
  });

  it("register returns a unique handle; count grows; release decrements", () => {
    expect(inflight.count()).toBe(0);
    const a = inflight.register("loadgen", "run-a");
    const b = inflight.register("ingest", "src-01");
    expect(a.id).not.toBe(b.id);
    expect(inflight.count()).toBe(2);
    a.release();
    expect(inflight.count()).toBe(1);
    b.release();
    expect(inflight.count()).toBe(0);
    // Double-release is a no-op.
    a.release();
    expect(inflight.count()).toBe(0);
  });

  it("list returns entries with started_at populated", () => {
    const before = Date.now();
    const h = inflight.register("loadgen", "demo");
    const after = Date.now();
    const items = inflight.list();
    expect(items).toHaveLength(1);
    const entry = items[0]!;
    expect(entry.id).toBe(h.id);
    expect(entry.kind).toBe("loadgen");
    expect(entry.label).toBe("demo");
    expect(entry.started_at).toBeGreaterThanOrEqual(before);
    expect(entry.started_at).toBeLessThanOrEqual(after);
  });

  it("onChange fires synchronously on register and release", () => {
    const counts: number[] = [];
    const unsub = inflight.onChange((snap) => counts.push(snap.count));
    const h = inflight.register("loadgen", "x");
    h.release();
    unsub();
    expect(counts).toEqual([1, 0]);
  });
});

describe("activation lockout", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let store: ConnectionsStore;
  let connectionId: string;

  beforeEach(async () => {
    inflight.resetInflightRegistryForTests();
    resetActiveTarget();
    store = await freshStore();
    app = await createServer({ store });
    const created = await app.inject({
      method: "POST", url: "/connections",
      payload: { name: "demo", host: "rs.demo", port: 12000, password: "PW" },
    });
    connectionId = created.json().id;
  });
  afterEach(async () => {
    await app.close();
    inflight.resetInflightRegistryForTests();
    resetActiveTarget();
  });

  it("blocks /connections/:id/activate with 409 when registry is non-empty", async () => {
    const handle = inflight.register("loadgen", "blocking-run");
    const labelBefore = getActiveTarget().label;
    const res = await app.inject({ method: "POST", url: `/connections/${connectionId}/activate` });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toMatch(/operations in flight/i);
    expect(Array.isArray(body.inflight)).toBe(true);
    expect(body.inflight).toHaveLength(1);
    expect(body.inflight[0]).toMatchObject({ kind: "loadgen", label: "blocking-run" });
    expect(body.stale).toEqual([]);
    // Active target unchanged.
    expect(getActiveTarget().label).toBe(labelBefore);
    handle.release();
  });

  it("allows activation once registry empties", async () => {
    const res = await app.inject({ method: "POST", url: `/connections/${connectionId}/activate` });
    expect(res.statusCode).toBe(200);
    expect(getActiveTarget().label).toBe("demo");
  });

  it("stale entries do NOT block activation but appear in /inflight stale list", async () => {
    // Manually inject a stale entry using the registered handle's bookkeeping —
    // because INFLIGHT_STALE_MS defaults to 60s we backdate started_at via the
    // register opt. (The stale check uses Date.now() - INFLIGHT_STALE_MS.)
    const _stale = inflight.register("ingest", "old-run", { started_at: Date.now() - 120_000 });
    expect(inflight.count()).toBe(0);
    const snap = await app.inject({ method: "GET", url: "/inflight" });
    expect(snap.statusCode).toBe(200);
    const sb = snap.json();
    expect(sb.count).toBe(0);
    expect(sb.items).toEqual([]);
    expect(sb.stale).toHaveLength(1);
    expect(sb.stale[0]).toMatchObject({ kind: "ingest", label: "old-run" });
    // Activation succeeds.
    const act = await app.inject({ method: "POST", url: `/connections/${connectionId}/activate` });
    expect(act.statusCode).toBe(200);
  });
});

describe("GET /inflight + GET /inflight/stream", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeEach(async () => {
    inflight.resetInflightRegistryForTests();
    app = await createServer({});
  });
  afterEach(async () => {
    await app.close();
    inflight.resetInflightRegistryForTests();
  });

  it("GET /inflight returns the current snapshot", async () => {
    const empty = await app.inject({ method: "GET", url: "/inflight" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ count: 0, items: [], stale: [] });
    const h = inflight.register("loadgen", "demo");
    const after = await app.inject({ method: "GET", url: "/inflight" });
    expect(after.json().count).toBe(1);
    h.release();
  });

  it("SSE: a change event arrives within 500ms of register()", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/inflight/stream",
      headers: { accept: "text/event-stream" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^text\/event-stream/);
    const stream = res.stream() as unknown as NodeJS.ReadableStream;
    let buf = "";
    const got = new Promise<string>((resolveDone) => {
      const onData = (chunk: Buffer | string): void => {
        buf += chunk.toString();
        // Wait for the second `event: change` (first is initial snapshot).
        const matches = buf.match(/event: change/g);
        if (matches && matches.length >= 2) {
          stream.removeListener?.("data", onData);
          resolveDone(buf);
        }
      };
      stream.on("data", onData);
      setTimeout(() => {
        stream.removeListener?.("data", onData);
        resolveDone(buf);
      }, 500);
    });
    // Register after subscribing.
    const h = inflight.register("loadgen", "sse-trigger");
    const out = await got;
    h.release();
    expect(out).toMatch(/event: change/);
    expect(out).toMatch(/"label":"sse-trigger"/);
  });
});

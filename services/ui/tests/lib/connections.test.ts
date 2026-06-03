// Wave 3.5A — RED tests for the typed Connections api client.
//
// Drives the shape of services/ui/src/lib/connections.ts: it must wrap the
// Wave 2 api endpoints (`/redis/active-target`, `/connections*`) with
// passwords ONLY ever flowing outbound (POST/PUT body) — never returned to
// the UI by the server, never asserted on in the response shape.

import { describe, it, expect, afterEach } from "vitest";
import {
  getActiveTarget,
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  activateConnection,
  InflightConflictError,
} from "../../src/lib/connections";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type FetchCall = { url: string; init?: RequestInit };

function recorder(body: unknown, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return new Response(body == null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

describe("lib/connections api client", () => {
  it("getActiveTarget GETs /redis/active-target and returns the typed object", async () => {
    const { calls } = recorder({ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" });
    const t = await getActiveTarget();
    expect(t).toEqual({ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" });
    expect(calls[0]!.url).toMatch(/\/redis\/active-target$/);
  });

  it("listConnections GETs /connections and parses the array body", async () => {
    const profiles = [
      { id: "01J", name: "demo-cluster", host: "h1", port: 12000, tls: { enabled: true }, created_at: "t", updated_at: "t" },
      { id: "01K", name: "scale-cluster", host: "h2", port: 12001, tls: { enabled: false }, created_at: "t", updated_at: "t" },
    ];
    const { calls } = recorder(profiles);
    const list = await listConnections();
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe("01J");
    expect(calls[0]!.url).toMatch(/\/connections$/);
  });

  it("createConnection POSTs /connections with a JSON body that includes the password", async () => {
    const { calls } = recorder({
      id: "01N", name: "demo-cluster", host: "h1", port: 12000, tls: { enabled: true },
      created_at: "t", updated_at: "t",
    }, 201);
    const created = await createConnection({
      name: "demo-cluster", host: "h1", port: 12000,
      username: "default", password: "s3cret", tls: { enabled: true },
    });
    expect(created.id).toBe("01N");
    expect(calls[0]!.url).toMatch(/\/connections$/);
    expect(calls[0]!.init?.method).toBe("POST");
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.password).toBe("s3cret");
    expect(sent.host).toBe("h1");
    expect(sent.tls).toEqual({ enabled: true });
  });

  it("updateConnection PUTs /connections/:id with a partial body and OMITS empty password", async () => {
    const { calls } = recorder({
      id: "01N", name: "demo-cluster-renamed", host: "h1", port: 12000, tls: { enabled: true },
      created_at: "t", updated_at: "u",
    });
    await updateConnection("01N", { name: "demo-cluster-renamed", password: "" });
    expect(calls[0]!.url).toMatch(/\/connections\/01N$/);
    expect(calls[0]!.init?.method).toBe("PUT");
    const sent = JSON.parse(String(calls[0]!.init?.body));
    expect(sent.name).toBe("demo-cluster-renamed");
    expect(sent).not.toHaveProperty("password");
  });

  it("deleteConnection DELETEs /connections/:id and resolves on 204", async () => {
    const { calls } = recorder(null, 204);
    await expect(deleteConnection("01N")).resolves.toBeUndefined();
    expect(calls[0]!.url).toMatch(/\/connections\/01N$/);
    expect(calls[0]!.init?.method).toBe("DELETE");
  });

  it("testConnection POSTs /connections/:id/test and returns ok+latency+modules", async () => {
    const body = {
      ok: true, latency_ms: 12,
      modules: [
        { name: "JSON", present: true },
        { name: "Search", present: true },
        { name: "Time Series", present: true },
        { name: "Probabilistic", present: false },
      ],
      errors: [],
    };
    const { calls } = recorder(body);
    const r = await testConnection("01N");
    expect(r.ok).toBe(true);
    expect(r.latency_ms).toBe(12);
    expect(r.modules?.find((m) => m.name === "JSON")?.present).toBe(true);
    expect(r.modules?.find((m) => m.name === "Probabilistic")?.present).toBe(false);
    expect(calls[0]!.url).toMatch(/\/connections\/01N\/test$/);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("activateConnection POSTs /connections/:id/activate and returns the (now-active) profile", async () => {
    const { calls } = recorder({
      id: "01N", name: "demo-cluster", host: "h1", port: 12000, tls: { enabled: true },
      created_at: "t", updated_at: "u",
    });
    const p = await activateConnection("01N");
    expect(p.id).toBe("01N");
    expect(calls[0]!.url).toMatch(/\/connections\/01N\/activate$/);
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("activateConnection throws InflightConflictError on 409 with parsed inflight+stale lists", async () => {
    // Wave 5.16z2 — api refuses activation while runs are in flight; the
    // client must surface the typed error so the panel can render a per-row
    // \"N runs still in flight (…)\" message.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: "in flight",
      inflight: [
        { id: "lg1", kind: "loadgen", label: "loadgen-1", started_at: 1 },
        { id: "in3", kind: "ingest", label: "ingest-3", started_at: 2 },
      ],
      stale: [{ id: "stale-9", kind: "loadgen", label: "old", started_at: 0 }],
    }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch;
    let caught: unknown = null;
    try { await activateConnection("01N"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(InflightConflictError);
    const err = caught as InflightConflictError;
    expect(err.inflight).toHaveLength(2);
    expect(err.inflight.map((i) => i.label)).toEqual(["loadgen-1", "ingest-3"]);
    expect(err.stale).toHaveLength(1);
    expect(err.stale[0]!.label).toBe("old");
  });

  it("throws on non-2xx responses (so the panel can show its error state)", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(listConnections()).rejects.toThrow();
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(testConnection("x")).rejects.toThrow();
  });
});

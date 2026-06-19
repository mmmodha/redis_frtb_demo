// Wave 6.39.D — typed clients for the Layer 4 admin endpoints surfaced
// by Waves 6.39.B and 6.39.C. Each test asserts URL + method shape and the
// reconcile path also exercises header propagation + 401 surfacing.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  getCalcCoverage,
  getDriftStatus,
  getSnapshots,
  getStreamStatus,
  postReconcileBucket,
  loadAdminToken,
  saveAdminToken,
  clearAdminToken,
  ADMIN_TOKEN_STORAGE_KEY,
} from "../../src/lib/admin";

// Node 22's experimental globalThis.localStorage shadows jsdom's so the
// standard API is unavailable by default; stub a small in-memory Storage
// for the token-persistence test.
function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    removeItem(k: string) { map.delete(k); },
    setItem(k: string, v: string) { map.set(k, String(v)); },
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

function mockJson(body: unknown, init: { status?: number; method?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, opts?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init: opts });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

describe("lib/admin", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
  });

  it("getCalcCoverage GETs /admin/calc-coverage and returns shape", async () => {
    const calls = mockJson({ coverage: [{ risk_class: "GIRR", bucket: "1", sens_type: "Delta", rollup_present: true, sens_doc_count: 7 }], summary: { total: 1, present: 1, missing: 0 } });
    const r = await getCalcCoverage();
    expect(calls[0]!.url).toMatch(/\/admin\/calc-coverage$/);
    expect(r.coverage[0]!.risk_class).toBe("GIRR");
    expect(r.summary.present).toBe(1);
  });

  it("getDriftStatus GETs /admin/drift-status", async () => {
    const calls = mockJson({ threshold_pct: 0.01, results: [{ ts: "2026-06-18T00:00:00Z", bucket: "1", risk_class: "GIRR", sensitivity_type: "Delta", rollup_sum: 1, recomputed_sum: 1, drift_pct: 0, status: "ok" }] });
    const r = await getDriftStatus();
    expect(calls[0]!.url).toMatch(/\/admin\/drift-status$/);
    expect(r.threshold_pct).toBe(0.01);
    expect(r.results[0]!.status).toBe("ok");
  });

  it("getSnapshots GETs /admin/snapshots", async () => {
    const calls = mockJson({ snapshots: [{ ts: "2026-06-18T01:00:00Z", key_count: 42 }] });
    const r = await getSnapshots();
    expect(calls[0]!.url).toMatch(/\/admin\/snapshots$/);
    expect(r.snapshots[0]!.key_count).toBe(42);
  });

  it("getStreamStatus GETs /admin/stream-status", async () => {
    const calls = mockJson({ stream_key: "sensitivities:in", xlen: 1000, maxlen: 2_000_000, peak_rate_per_sec: 50, retention_hours_now: 5.5, retention_hours_at_cap: 96 });
    const r = await getStreamStatus();
    expect(calls[0]!.url).toMatch(/\/admin\/stream-status$/);
    expect(r.xlen).toBe(1000);
    expect(r.maxlen).toBe(2_000_000);
  });

  it("postReconcileBucket POSTs with x-admin-token header + JSON body", async () => {
    const calls = mockJson({ ok: true, before_sum: 1, after_sum: 1, drift_pct: 0, risk_class: "GIRR", bucket: "1", sensitivity_type: "Delta" });
    const r = await postReconcileBucket({ risk_class: "GIRR", bucket: "1", sensitivity_type: "Delta", admin_token: "secret" });
    expect(calls[0]!.url).toMatch(/\/admin\/reconcile-bucket$/);
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit | undefined);
    expect(headers.get("x-admin-token")).toBe("secret");
    expect(headers.get("content-type")).toMatch(/application\/json/);
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ risk_class: "GIRR", bucket: "1", sensitivity_type: "Delta" });
    expect(r.ok).toBe(true);
  });

  it("postReconcileBucket surfaces 401 with the server's error string", async () => {
    mockJson({ error: "unauthorized" }, { status: 401 });
    await expect(
      postReconcileBucket({ risk_class: "GIRR", bucket: "1", sensitivity_type: "Delta", admin_token: "bogus" }),
    ).rejects.toThrow(/401|unauthorized/i);
  });

  it("saveAdminToken/loadAdminToken/clearAdminToken round-trip via localStorage", () => {
    expect(loadAdminToken()).toBe("");
    saveAdminToken("abc");
    expect(loadAdminToken()).toBe("abc");
    expect(window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBe("abc");
    clearAdminToken();
    expect(loadAdminToken()).toBe("");
  });

  it("getCalcCoverage throws on non-2xx", async () => {
    mockJson({ error: "no active target" }, { status: 503 });
    await expect(getCalcCoverage()).rejects.toThrow(/503/);
  });
});

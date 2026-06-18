// Wave 6.39.D — Admin route wires all six observability widgets and renders
// them under a top-level page heading.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const originalFetch = globalThis.fetch;

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

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function routeFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/admin/calc-coverage")) {
      return new Response(JSON.stringify({
        coverage: [{ risk_class: "GIRR", bucket: "1", sens_type: "Delta", rollup_present: true, sens_doc_count: 1 }],
        summary: { total: 1, present: 1, missing: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/admin/backfill-status")) {
      return new Response(JSON.stringify({ total: 0, completed: 0, in_flight: 0, failed: 0, eta_ms: 0, status: "not-implemented" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/admin/drift-status")) {
      return new Response(JSON.stringify({ threshold_pct: 0.01, results: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/admin/snapshots")) {
      return new Response(JSON.stringify({ snapshots: [{ ts: "2026-06-18T00:00:00Z", key_count: 10 }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/admin/stream-status")) {
      return new Response(JSON.stringify({
        stream_key: "sensitivities:in", xlen: 100, maxlen: 2_000_000,
        peak_rate_per_sec: 1, retention_hours_now: 1, retention_hours_at_cap: 96,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("<Admin /> route", () => {
  it("renders an h1 'Admin' heading", async () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    routeFetch();
    const { Admin } = await import("../../src/routes/Admin");
    render(<MemoryRouter><Admin /></MemoryRouter>);
    expect(screen.getByRole("heading", { name: /^admin$/i, level: 1 })).toBeInTheDocument();
  });

  it("renders all six admin widgets", async () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    routeFetch();
    const { Admin } = await import("../../src/routes/Admin");
    render(<MemoryRouter><Admin /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: /^calc coverage$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^backfill$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^drift$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^snapshots$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^stream status$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^reconcile bucket$/i, level: 2 })).toBeInTheDocument();
  });
});

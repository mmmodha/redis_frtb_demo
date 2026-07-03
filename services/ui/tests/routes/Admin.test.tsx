// Wave 6.39.D — Admin route wires all five observability widgets and renders
// them under a top-level page heading.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    if (url.endsWith("/admin/ingest-capacity-test")) {
      return new Response(JSON.stringify({
        ok: true,
        target_label: "redis-primary",
        deployment: {
          cores: 8,
          recommended_max_workers: 6,
          bulk_loader_pool_size: 16,
          bulk_loader_replicas: 4,
          recommended_bulk_loader_replicas: 5,
          shards: null,
        },
        worker_sweep: [2, 4],
        rows_per_step: 50000,
        steps: [
          { workers: 2, gen_rps: 40000, write_rps: 39000, throttled_samples: 0, total_samples: 10, recent_429_max: 0, duration_ms: 1200, rows_sent: 50000, verdict: "optimal" },
          { workers: 4, gen_rps: 42000, write_rps: 35000, throttled_samples: 2, total_samples: 10, recent_429_max: 1, duration_ms: 1100, rows_sent: 50000, verdict: "saturated" },
        ],
        recommended_workers: 2,
        bottleneck: "bulk_loader_queue",
        notes: ["test note"],
        total_ms: 5000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/admin/calc-jobs")) {
      return new Response(JSON.stringify({ active: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/admin/recent-errors")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/admin/logs")) {
      return new Response(JSON.stringify({
        tail: 200,
        count: 1,
        docker_hint: "docker compose logs api --tail=500",
        items: [{ ts: "2026-06-23T12:00:00.000Z", level: "info", msg: "test line" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/admin/debug-bundle")) {
      return new Response(JSON.stringify({
        generated_at: new Date().toISOString(),
        target: { host: "127.0.0.1", port: 6379, label: "test", version: 1 },
        bootstrap: { phase: "ready", target_label: "test", err: null, server_ready: true, server_boot_err: null },
        backpressure: { heavy_inflight: 0, heavy_limit: 4, light_inflight: 0, light_limit: 8 },
        runtime_pools: { heavy_calc: 2, heavy_ingest: 2, light: 4 },
        cluster: null,
        calc: { active_jobs: [], recent_runs: [] },
        ingest: { generator_active: [], bulk_active: [], bulk_loader: null },
        drift: { threshold_pct: 0.01, total_checks: 0, drift_count: 0, recent: [] },
        inflight: { count: 0, items: [], stale: [] },
        recent_errors: [],
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

  it("renders all admin widgets including ingest capacity test", async () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    routeFetch();
    const { Admin } = await import("../../src/routes/Admin");
    render(<MemoryRouter><Admin /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: /^ingest capacity test$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^calc coverage$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^drift$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^snapshots$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^stream status$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^reconcile bucket$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByTestId("admin-per-shard-link")).toBeInTheDocument();
  });

  it("runs capacity test and shows recommended workers", async () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    routeFetch();
    const { Admin } = await import("../../src/routes/Admin");
    render(<MemoryRouter><Admin /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("ingest-capacity-run"));
    expect(await screen.findByTestId("ingest-capacity-recommended")).toHaveTextContent("2");
    expect(screen.getByTestId("ingest-capacity-replicas")).toHaveTextContent("5");
    expect(screen.getByTestId("ingest-capacity-row-2")).toBeInTheDocument();
  });
});

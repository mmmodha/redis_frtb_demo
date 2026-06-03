// Wave 5.56 — tests for the useFacets() hook.
//
// Verifies the fetch-on-mount behaviour, refetch on frtb:facets-stale and
// connections:active-changed events, and graceful fallback to a null snapshot
// when the api errors / responds with a non-2xx status.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import {
  useFacets,
  FACETS_STALE_EVENT,
  CONNECTIONS_CHANGED_EVENT,
  type FacetsSnapshot,
} from "../../src/hooks/useFacets";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function happySnapshot(): FacetsSnapshot {
  return {
    ok: true,
    ms: 4,
    target_label: "primary",
    total_rows: 7,
    risk_class: { GIRR: 5, Equity: 2 },
    sensitivity_type: { Delta: 6, Vega: 1 },
    bucket_by_risk_class: { GIRR: { "USD-IRS": 5 }, Equity: { B1: 2 } },
  };
}

describe("useFacets()", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches /facets on mount and exposes the snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(happySnapshot()));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFacets());
    await waitFor(() => expect(result.current.facets).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/\/facets$/);
    expect(result.current.facets?.ok).toBe(true);
    expect(result.current.facets?.risk_class).toEqual({ GIRR: 5, Equity: 2 });
  });

  it("refetches when frtb:facets-stale is dispatched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(happySnapshot()));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useFacets());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(FACETS_STALE_EVENT));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("refetches when connections:active-changed is dispatched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(happySnapshot()));
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useFacets());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED_EVENT));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("returns ok=false empty-index snapshot through unchanged", async () => {
    const empty: FacetsSnapshot = {
      ok: false,
      reason: "empty-index",
      ms: 1,
      target_label: "primary",
      total_rows: 0,
      risk_class: {},
      sensitivity_type: {},
      bucket_by_risk_class: {},
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(empty));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFacets());
    await waitFor(() => expect(result.current.facets).not.toBeNull());
    expect(result.current.facets?.ok).toBe(false);
  });

  it("falls back to null when the fetch rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFacets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.facets).toBeNull();
  });

  it("falls back to null when the api responds with a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFacets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.facets).toBeNull();
  });
});

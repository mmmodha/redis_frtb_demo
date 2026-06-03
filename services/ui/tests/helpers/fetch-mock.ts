// Wave 5.56 — small URL-routing fetch mock for panel unit tests.
//
// PivotPanel / CalcPanel / JsonExplorerPanel now call useFacets() on mount,
// which fires a GET /facets fetch before any user-initiated /pivot or
// /calc/sbm fetch. The legacy `fetchMock.mockResolvedValueOnce(...)` pattern
// is order-sensitive — the once-value would land on /facets instead of the
// endpoint the test intended. installFetchRouter() routes by URL substring
// so the facets fetch is handled with a default empty-index response and
// per-test routes target the endpoint(s) under test directly.

import { vi } from "vitest";

const EMPTY_FACETS = {
  ok: false as const,
  reason: "empty-index" as const,
  ms: 0,
  target_label: "test",
  total_rows: 0 as const,
  risk_class: {},
  sensitivity_type: {},
  bucket_by_risk_class: {},
};

export type FetchResponseLike =
  | Response
  | {
      ok?: boolean;
      status?: number;
      json?: () => Promise<unknown>;
      text?: () => Promise<string>;
    };

export interface RouteSpec {
  match: string;
  response: FetchResponseLike | ((url: string) => FetchResponseLike);
}

export interface FetchRouterOptions {
  // Override the default empty-index /facets response.
  facets?: FetchResponseLike;
  // URL substring → response. First match wins.
  routes?: RouteSpec[];
  // Fallback called when no route matches. Defaults to throwing.
  fallback?: (url: string) => FetchResponseLike;
}

// installFetchIntercept wires a global `fetch` that short-circuits the
// background calls (/facets, /suggest) that useFacets and SuggestCombobox
// fire on mount, and delegates every other URL to the returned inner mock.
// Tests can then keep their existing `inner.mockResolvedValueOnce(...)` and
// `inner.mock.calls.find(c => c[0].includes("/pivot"))` patterns unchanged —
// the once-queue only sees the URLs the test actually cares about.
export function installFetchIntercept(): ReturnType<typeof vi.fn> {
  const inner = vi.fn();
  const wrapper = vi.fn(async (input: unknown, init?: unknown) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as { url?: string })?.url ?? String(input);
    if (url.includes("/facets")) {
      return { ok: true, status: 200, json: async () => EMPTY_FACETS };
    }
    if (url.includes("/suggest")) {
      return { ok: true, status: 200, json: async () => ({ suggestions: [] }) };
    }
    return await (inner as (...a: unknown[]) => Promise<unknown>)(input, init);
  });
  vi.stubGlobal("fetch", wrapper);
  return inner;
}

export function installFetchRouter(opts: FetchRouterOptions = {}): ReturnType<typeof vi.fn> {
  const defaultFacets: FetchResponseLike = {
    ok: true,
    status: 200,
    json: async () => EMPTY_FACETS,
  };
  const facets = opts.facets ?? defaultFacets;
  const mock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as { url?: string })?.url ?? String(input);
    if (url.includes("/facets")) return facets;
    for (const r of opts.routes ?? []) {
      if (url.includes(r.match)) {
        return typeof r.response === "function" ? r.response(url) : r.response;
      }
    }
    // SuggestCombobox debounce can fire a /suggest after the component mounts;
    // return an empty list by default so unrelated tests don't trip over it.
    if (url.includes("/suggest")) {
      return { ok: true, status: 200, json: async () => ({ suggestions: [] }) };
    }
    if (opts.fallback) return opts.fallback(url);
    throw new Error(`fetch-mock: no route for ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

// Wave 6.39.D — ReconcileBucketAction surfaces the destructive POST
// /admin/reconcile-bucket call. Token + bucket coordinates required, plus
// a type-back confirmation modal before the POST goes out.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReconcileBucketAction } from "../../src/components/ReconcileBucketAction";
import { ADMIN_TOKEN_STORAGE_KEY } from "../../src/lib/admin";

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

function mockOk() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return new Response(JSON.stringify({
      ok: true, before_sum: 100, after_sum: 100, drift_pct: 0,
      risk_class: "GIRR", bucket: "1", sensitivity_type: "Delta",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

describe("<ReconcileBucketAction />", () => {
  it("disables submit when token / risk_class / bucket are blank", () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    render(<ReconcileBucketAction />);
    expect(screen.getByTestId("reconcile-submit")).toBeDisabled();
  });

  it("opens the confirm modal and requires the operator to type RECONCILE", async () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    const calls = mockOk();
    render(<ReconcileBucketAction />);
    fireEvent.change(screen.getByTestId("reconcile-token"), { target: { value: "secret" } });
    fireEvent.change(screen.getByTestId("reconcile-risk-class"), { target: { value: "GIRR" } });
    fireEvent.change(screen.getByTestId("reconcile-bucket"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("reconcile-submit"));
    const modal = await screen.findByTestId("reconcile-confirm-modal");
    const confirm = screen.getByTestId("reconcile-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId("reconcile-confirm-input"), { target: { value: "WRONG" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId("reconcile-confirm-input"), { target: { value: "RECONCILE" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toMatch(/\/admin\/reconcile-bucket$/);
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = new Headers(calls[0]!.init?.headers as HeadersInit | undefined);
    expect(headers.get("x-admin-token")).toBe("secret");
    expect(modal).not.toBeInTheDocument();
    const result = await screen.findByTestId("reconcile-result");
    expect(result).toHaveTextContent(/GIRR/);
  });

  it("persists the admin token to localStorage and restores it on next mount", async () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    const { unmount } = render(<ReconcileBucketAction />);
    fireEvent.change(screen.getByTestId("reconcile-token"), { target: { value: "abc-123" } });
    expect(window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBe("abc-123");
    unmount();
    render(<ReconcileBucketAction />);
    expect((screen.getByTestId("reconcile-token") as HTMLInputElement).value).toBe("abc-123");
  });

  it("surfaces a 401 from the server in the result area", async () => {
    vi.stubGlobal("localStorage", makeMemoryStorage());
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    render(<ReconcileBucketAction />);
    fireEvent.change(screen.getByTestId("reconcile-token"), { target: { value: "bogus" } });
    fireEvent.change(screen.getByTestId("reconcile-risk-class"), { target: { value: "GIRR" } });
    fireEvent.change(screen.getByTestId("reconcile-bucket"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("reconcile-submit"));
    fireEvent.change(screen.getByTestId("reconcile-confirm-input"), { target: { value: "RECONCILE" } });
    fireEvent.click(screen.getByTestId("reconcile-confirm"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/401|unauthorized/i);
  });
});

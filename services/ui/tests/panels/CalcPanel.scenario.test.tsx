import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CalcPanel } from "../../src/panels/CalcPanel";
import type { CalcSbmResponse } from "../../src/lib/calc";

// Wave 5.53 — Scenario dropdown (plain-English regulatory framing for the
// MAR21.6 cross-bucket γ regime) plus the new "Show Redis commands" toggle
// and `?demo=1` auto-enable behaviour.

const originalFetch = globalThis.fetch;
const originalSearch = typeof window !== "undefined" ? window.location.search : "";



// Mirror of the capture helper in the other CalcPanel test files — records
// every outbound /calc/sbm request body so individual assertions can dissect
// them (no fragile URL string-matching).
function mockCalcWithCapture(body: CalcSbmResponse) {
  const sent: Array<unknown> = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return sent;
}

// Mirrors the workaround in GeneratorRunContext.test.tsx — Node 22's
// experimental globalThis.localStorage can shadow jsdom's and stub out the
// standard Storage API, so we hand the panel an in-memory Storage shim.
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

function makeResponse(regime?: "low" | "medium" | "high"): CalcSbmResponse {
  const base: CalcSbmResponse = {
    charge: 9558.91,
    per_bucket: [{ bucket: "USD", K_b: 200, S_b: 180, count: 5000, ms: 12 }],
    total_ms: 14,
    shard_breakdown: [{ shard: "shard-1", buckets: ["USD"], ms: 12 }],
    fanout_ms: 2,
  };
  return regime ? { ...base, correlation_regime: regime } : base;
}

function setSearch(search: string) {
  // jsdom permits replaceState; this re-writes window.location.search without
  // navigating, so the CalcPanel's useState initializer reads the new value.
  window.history.replaceState(null, "", `/${search}`);
}

beforeEach(() => {
  const ls = makeMemoryStorage();
  // Wave 6.45.B — pin to the Advanced view so the legacy assertions below
  // (Scenario select, Show Redis commands toggle, advanced-filters) see the
  // pre-6.45.B CalcPanel surface; the production default is Simple.
  ls.setItem("frtb:calc:view:v1", "advanced");
  vi.stubGlobal("localStorage", ls);
  setSearch("");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSearch(originalSearch);
});

describe("Scenario dropdown", () => {
  it("renders a Scenario select with 'Standard charge' as the default option", () => {
    render(<CalcPanel />);
    const select = screen.getByLabelText(/scenario/i) as HTMLSelectElement;
    expect(select.value).toBe("standard");
    // No Low/Med/High letters in the happy-path UI.
    expect(screen.queryByText(/correlation regime/i)).toBeNull();
    expect(screen.queryByText(/^Low$/)).toBeNull();
    expect(screen.queryByText(/^Med$/)).toBeNull();
    expect(screen.queryByText(/^High$/)).toBeNull();
  });

  it("lists the three plain-English scenario options with tooltips", () => {
    render(<CalcPanel />);
    const select = screen.getByLabelText(/scenario/i) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => ({
      value: o.value,
      label: o.textContent ?? "",
      title: o.title,
    }));
    expect(options).toEqual([
      {
        value: "standard",
        label: "Standard charge",
        title: expect.stringMatching(/Basel medium correlation/i),
      },
      {
        value: "stress-low",
        label: "Stress: low correlation",
        title: expect.stringMatching(/decorrelated stress/i),
      },
      {
        value: "stress-high",
        label: "Stress: high correlation",
        title: expect.stringMatching(/co-movement stress/i),
      },
    ]);
  });

  it("Standard charge (default) → request body omits correlation_regime", async () => {
    const sent = mockCalcWithCapture(makeResponse("medium"));
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ risk_class: "GIRR", sensitivity_type: "Delta" });
    expect(sent[0]).not.toHaveProperty("correlation_regime");
  });

  it("Stress: low correlation → request body includes correlation_regime: 'low'", async () => {
    const sent = mockCalcWithCapture(makeResponse("low"));
    render(<CalcPanel />);
    fireEvent.change(screen.getByLabelText(/scenario/i), { target: { value: "stress-low" } });
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({ correlation_regime: "low" });
  });

  it("Stress: high correlation → request body includes correlation_regime: 'high'", async () => {
    const sent = mockCalcWithCapture(makeResponse("high"));
    render(<CalcPanel />);
    fireEvent.change(screen.getByLabelText(/scenario/i), { target: { value: "stress-high" } });
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({ correlation_regime: "high" });
  });

  it("RegimeBadge reflects the regime echoed by the api response (not just the picker)", async () => {
    // api response advertises 'high' regardless of what the user picked —
    // the badge must trust the wire response so we don't lie about what was
    // actually applied to the charge.
    mockCalcWithCapture(makeResponse("high"));
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    const badge = await screen.findByTestId("regime-badge");
    expect(badge).toHaveAttribute("data-regime", "high");
    expect(badge.textContent).toMatch(/high/i);
  });

  it("RegimeBadge is omitted when the api response carries no correlation_regime field (legacy back-compat)", async () => {
    mockCalcWithCapture(makeResponse());
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    expect(screen.queryByTestId("regime-badge")).toBeNull();
  });
});

describe("Show Redis commands toggle", () => {
  const responseWithCommands: CalcSbmResponse = {
    ...makeResponse(),
    commands: {
      discovery: {
        command: "FT.AGGREGATE",
        index: "idx:sens",
        query: "@risk_class:{GIRR}",
        groupby: ["@bucket"],
        reducers: ["COUNT 0 AS n"],
      },
      fcall: {
        command: "FCALL",
        function: "sbm_delta_bucket",
        library: "frtb",
        arg_template: "FCALL sbm_delta_bucket 1 sens:{GIRR:<bucket>}:_route GIRR <bucket>",
        dispatched_keys: ["sens:{GIRR:USD}:_route"],
      },
    },
  };

  it("Redis commands panel is hidden by default even when commands are present in the response", async () => {
    mockCalcWithCapture(responseWithCommands);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    expect(screen.queryByTestId("redis-commands")).toBeNull();
  });

  it("flipping the toggle on shows the panel; flipping off hides it again", async () => {
    mockCalcWithCapture(responseWithCommands);
    render(<CalcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("calc-charge")).toBeInTheDocument());
    const toggle = screen.getByTestId("calc-show-redis-commands-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByTestId("redis-commands")).toBeInTheDocument());
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId("redis-commands")).toBeNull());
  });

  it("flipping the toggle on forces the Advanced disclosure open", () => {
    render(<CalcPanel />);
    const details = screen.getByTestId("advanced-filters") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByTestId("calc-show-redis-commands-toggle"));
    expect(details.open).toBe(true);
  });

  it("persists the choice in localStorage and restores it on next mount", async () => {
    const { unmount } = render(<CalcPanel />);
    fireEvent.click(screen.getByTestId("calc-show-redis-commands-toggle"));
    expect(window.localStorage.getItem("calc.show-redis-commands")).toBe("true");
    unmount();
    render(<CalcPanel />);
    expect(screen.getByTestId("calc-show-redis-commands-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("?demo=1 URL param auto-enables the toggle on first load (and writes to localStorage)", async () => {
    setSearch("?demo=1");
    mockCalcWithCapture(responseWithCommands);
    render(<CalcPanel />);
    const toggle = screen.getByTestId("calc-show-redis-commands-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("calc.show-redis-commands")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /calculate sbm risk charge/i }));
    await waitFor(() => expect(screen.getByTestId("redis-commands")).toBeInTheDocument());
  });
});

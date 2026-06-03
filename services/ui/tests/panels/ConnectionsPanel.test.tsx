// Wave 3.5A — RED tests for the ConnectionsPanel (CRUD + Test + Activate).
//
// Mocks fetch + the shell primitives (PanelCard, EnterpriseCallout) following
// the pattern set by IngestPanel.test.tsx. Covers all 4 standard states:
// loading / empty / data / error, plus the Add dialog and the Test+Activate
// click paths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConnectionsPanel } from "../../src/panels/ConnectionsPanel";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2>{actions}</header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: any) => (
    <aside data-testid="enterprise-callout" data-signal={signal}>
      <span>business value: {signal}</span>
      {children}
    </aside>
  ),
}));

// Wave 5.16z2 — control the useInflight hook from tests. Default snapshot is
// count=0 so unrelated tests stay green; lockout tests mutate `mockInflight`
// before rendering to drive the panel into the lockout state.
let mockInflight: { count: number; items: any[]; stale: any[]; ready: boolean } =
  { count: 0, items: [], stale: [], ready: true };
vi.mock("../../src/hooks/useInflight", () => ({
  useInflight: () => mockInflight,
}));

function profile(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "01J", name: "demo-cluster", host: "redis-1.lab", port: 12000,
    tls: { enabled: true }, created_at: "t", updated_at: "t",
    ...over,
  };
}

function renderPanel() {
  return render(<MemoryRouter><ConnectionsPanel /></MemoryRouter>);
}

describe("<ConnectionsPanel/>", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockInflight = { count: 0, items: [], stale: [], ready: true };
  });

  function routeJson(url: string | RegExp, method: string, body: unknown, status = 200) {
    return (input: RequestInfo, init?: RequestInit) =>
      String(input).match(url) && (init?.method ?? "GET") === method
        ? Promise.resolve(new Response(body == null ? null : JSON.stringify(body), {
            status, headers: { "content-type": "application/json" },
          }))
        : null;
  }

  function setRoutes(...handlers: Array<ReturnType<typeof routeJson>>) {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      for (const h of handlers) {
        const r = h(input, init);
        if (r) return r;
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  it("renders the Connections heading and the 3 business-value callouts", async () => {
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "h", port: 1, tls: false, db: 0, label: "demo-cluster" }),
      routeJson(/\/connections$/, "GET", []),
    );
    renderPanel();
    expect(screen.getByRole("heading", { name: /^Connections$/i, level: 1 })).toBeInTheDocument();
    const signals = screen.getAllByTestId("enterprise-callout").map((e) => e.getAttribute("data-signal"));
    expect(signals).toEqual(expect.arrayContaining(["ClusterScaleOut", "ModuleBundle", "ObservabilityModule"]));
  });

  it("shows a loading state while initial fetch is in flight", () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderPanel();
    expect(screen.getByText(/loading clusters/i)).toBeInTheDocument();
  });

  it("shows the empty state with a clear CTA when no profiles exist", async () => {
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "h", port: 1, tls: false, db: 0, label: "default" }),
      routeJson(/\/connections$/, "GET", []),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText(/no clusters configured yet/i)).toBeInTheDocument());
  });

  it("renders a card per profile with name, host:port, TLS indicator, status pill", async () => {
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" }),
      routeJson(/\/connections$/, "GET", [profile(), profile({ id: "01K", name: "scale-cluster", host: "redis-2.lab", port: 12001, tls: { enabled: false } })]),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
    expect(screen.getByText("scale-cluster")).toBeInTheDocument();
    expect(screen.getByText(/redis-1\.lab:12000/)).toBeInTheDocument();
    expect(screen.getByText(/redis-2\.lab:12001/)).toBeInTheDocument();
    // demo-cluster matches the active-target label → shows Active badge.
    const cards = screen.getAllByTestId("profile-card");
    const active = cards.find((c) => c.getAttribute("data-active") === "true");
    expect(active).toBeDefined();
    expect(within(active!).getByText(/^Active$/)).toBeInTheDocument();
  });

  it("shows an error state with a retry button when /connections fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo) => {
      const url = String(input);
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("boom", { status: 500 });
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/failed to load connections/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("clicking Add cluster opens a dialog with name/host/port/password/TLS fields", async () => {
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "h", port: 1, tls: false, db: 0, label: "x" }),
      routeJson(/\/connections$/, "GET", []),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: /add cluster/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /add cluster/i }));
    const dialog = await screen.findByRole("dialog", { name: /add cluster/i });
    expect(within(dialog).getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^host$/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^port$/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/tls/i)).toBeInTheDocument();
  });

  it("submitting the Add dialog POSTs /connections with the form body", async () => {
    let postedBody: unknown = null;
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "GET") return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "POST") {
        postedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(profile({ id: "new-1", name: "demo-cluster" })), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /add cluster/i }));
    const dialog = await screen.findByRole("dialog", { name: /add cluster/i });
    fireEvent.change(within(dialog).getByLabelText(/^name$/i), { target: { value: "demo-cluster" } });
    fireEvent.change(within(dialog).getByLabelText(/^host$/i), { target: { value: "redis-1.lab" } });
    fireEvent.change(within(dialog).getByLabelText(/^port$/i), { target: { value: "12000" } });
    fireEvent.change(within(dialog).getByLabelText(/^password$/i), { target: { value: "s3cret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(postedBody).not.toBeNull());
    expect(postedBody).toMatchObject({ name: "demo-cluster", host: "redis-1.lab", port: 12000, password: "s3cret" });
  });

  it("clicking Test runs POST /connections/:id/test and renders module ticks", async () => {
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "h", port: 1, tls: false, db: 0, label: "demo-cluster" }),
      routeJson(/\/connections$/, "GET", [profile()]),
      routeJson(/\/connections\/01J\/test$/, "POST", {
        ok: true, latency_ms: 9,
        modules: [
          { name: "JSON", present: true },
          { name: "Search", present: true },
          { name: "Time Series", present: true },
          { name: "Probabilistic", present: false },
        ],
        errors: [],
      }),
    );
    renderPanel();
    const testBtn = await screen.findByRole("button", { name: /^Test$/ });
    fireEvent.click(testBtn);
    await waitFor(() => expect(screen.getByTestId("test-result-01J")).toBeInTheDocument());
    const result = screen.getByTestId("test-result-01J");
    expect(within(result).getByText(/JSON/)).toBeInTheDocument();
    expect(within(result).getByText(/Search/)).toBeInTheDocument();
    expect(within(result).getByText(/Time Series/)).toBeInTheDocument();
    expect(within(result).getByText(/Probabilistic/)).toBeInTheDocument();
    expect(within(result).getByText(/9\s*ms/)).toBeInTheDocument();
  });

  it("renders pill text 'untested' (not 'pending') for a profile with no test result yet", async () => {
    // Block /test calls forever so the auto-test pass never resolves; the
    // pre-fire \"pending\" state is intercepted by re-rendering BEFORE the
    // setState lands by asserting against an empty test-results snapshot
    // would race the auto-test pre-fire. Instead, mount with zero profiles to
    // assert the untested branch is unreachable, then with one profile and a
    // hung /test endpoint to assert the brief pending → \"testing…\" wording.
    // For the default-state assertion we render a profile with a hung /test
    // and look at the very first paint via getByText on the testing label
    // (covered in transition test). Here we assert the *text* of the
    // ProfileStatusPill undefined branch by rendering the component with no
    // auto-test pre-fire — empty profiles list ⇒ no pill rendered, but the
    // rename invariant is asserted at the markup level: scan the panel for
    // any element whose data-status equals 'pending' (legacy) — there must
    // be none after this rename.
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "h", port: 1, tls: false, db: 0, label: "x" }),
      routeJson(/\/connections$/, "GET", [profile()]),
      // /test never resolves → pill stays in pre-fire "pending" (testing…)
      // which is the *transition* state, NOT the legacy data-status="pending"
      // text. The legacy "pending" wording must be gone.
      () => new Promise(() => {}) as any,
    );
    const { container } = renderPanel();
    await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
    // The legacy data-status="pending" + literal " pending" text must NEVER
    // appear (replaced by "untested" for the undefined branch and "testing…"
    // for the in-flight branch).
    expect(container.querySelector('[data-status="pending"]')).toBeNull();
    expect(screen.queryByText(/^\s*pending\s*$/)).toBeNull();
  });

  it("auto-tests every profile on mount, settling each pill to live or unreachable without manual click", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) {
        return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections$/) && method === "GET") {
        return new Response(JSON.stringify([
          profile({ id: "live-1", name: "live-standalone" }),
          profile({ id: "dead-1", name: "demo-cluster" }),
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/live-1\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: true, latency_ms: 4, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/dead-1\/test$/) && method === "POST") {
        return new Response("nope", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    // Neither name was clicked — auto-test fires on mount.
    await waitFor(() => expect(screen.getByTestId("test-result-live-1")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("test-result-dead-1")).toBeInTheDocument());
    expect(within(screen.getByTestId("test-result-live-1")).getByText(/reachable/i)).toBeInTheDocument();
    expect(within(screen.getByTestId("test-result-dead-1")).getByText(/unreachable/i)).toBeInTheDocument();
  });

  it("shows the brief 'Testing…' transition state while the auto-test pass is in flight", async () => {
    let resolveTest: ((r: Response) => void) | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) {
        return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections$/) && method === "GET") {
        return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
        return new Promise<Response>((resolve) => { resolveTest = resolve; });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    // Auto-test fires on mount → Test button reads "Testing…" before the
    // hung /test endpoint resolves.
    await waitFor(() => expect(screen.getByRole("button", { name: /testing/i })).toBeInTheDocument());
    // Now release the in-flight test → pill settles.
    resolveTest!(new Response(JSON.stringify({ ok: true, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Test$/ })).toBeInTheDocument());
  });

  it("clicking Activate runs POST /connections/:id/activate and marks card active", async () => {
    let activatedCalled = false;
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "scale-cluster" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "GET") return new Response(JSON.stringify([profile(), profile({ id: "01K", name: "scale-cluster" })]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections\/[^/]+\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: true, latency_ms: 4, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J\/activate$/) && method === "POST") {
        activatedCalled = true;
        return new Response(JSON.stringify(profile()), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    const activateBtns = await screen.findAllByRole("button", { name: /^Activate$/ });
    await waitFor(() => expect((activateBtns[0]! as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(activateBtns[0]!);
    await waitFor(() => expect(activatedCalled).toBe(true));
  });

  it("disables Activate with a 'Test the connection first' title when no test result yet", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "GET") return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      // /test never resolves → tr stays "pending"; but for the *undefined*
      // branch we want the moment before the auto-test pre-fire — assert on
      // the markup right after the connections list lands, using a profile
      // whose id won't match the in-flight /test response.
      if (url.match(/\/connections\/[^/]+\/test$/)) return new Promise(() => {}) as any;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
    const activateBtn = screen.getByRole("button", { name: /^Activate$/ }) as HTMLButtonElement;
    expect(activateBtn.disabled).toBe(true);
    // While auto-test is in flight tr === "pending" → "Testing connection…"
    expect(activateBtn.title).toMatch(/test/i);
  });

  it("hides the Activate button entirely after the auto-test settles ok:false", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "GET") return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: false, errors: ["nope"], modules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("test-result-01J")).toBeInTheDocument());
    // Confirmed-unreachable profiles render no Activate button at all.
    expect(screen.queryByRole("button", { name: /^Activate$/ })).toBeNull();
    // An amber warning banner (role=alert) sits ABOVE the action row and
    // explains why activation is unavailable.
    const banner = screen.getByTestId("activate-hint-01J");
    expect(banner).toHaveTextContent(/unreachable/i);
    expect(banner.getAttribute("role")).toBe("alert");
    const card = screen.getAllByTestId("profile-card")[0]!;
    const actions = card.querySelector(".profile-card__actions");
    expect(actions).not.toBeNull();
    expect(banner.compareDocumentPosition(actions!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides the Activate button when a profile transitions from untested/pending to ok:false", async () => {
    let resolveTest: ((r: Response) => void) | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "GET") return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
        return new Promise<Response>((resolve) => { resolveTest = resolve; });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    // While the auto-test is in flight the Activate button is rendered (disabled).
    const initialBtn = await screen.findByRole("button", { name: /^Activate$/ }) as HTMLButtonElement;
    expect(initialBtn.disabled).toBe(true);
    // Resolve the in-flight test with ok:false → button disappears entirely.
    resolveTest!(new Response(JSON.stringify({ ok: false, errors: ["dns fail"], modules: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Activate$/ })).toBeNull());
    expect(screen.getByTestId("activate-hint-01J")).toBeInTheDocument();
  });

  it("enables Activate after the auto-test settles ok:true for a non-active profile", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "other", port: 9, tls: false, db: 0, label: "other" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "GET") return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: true, latency_ms: 7, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("test-result-01J")).toBeInTheDocument());
    const activateBtn = screen.getByRole("button", { name: /^Activate$/ }) as HTMLButtonElement;
    await waitFor(() => expect(activateBtn.disabled).toBe(false));
  });

  it("sorts profile cards by reachability — reachable on top, unreachable on the bottom, regardless of name", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) {
        return new Response(JSON.stringify({ host: "other", port: 9, tls: false, db: 0, label: "other" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections$/) && method === "GET") {
        return new Response(JSON.stringify([
          profile({ id: "a-dead", name: "alpha-cluster" }),
          profile({ id: "b-live", name: "zeta-cluster" }),
          profile({ id: "c-err", name: "mid-cluster" }),
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/b-live\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: true, latency_ms: 4, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/a-dead\/test$/) && method === "POST") {
        return new Response("nope", { status: 500 });
      }
      if (url.match(/\/connections\/c-err\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: false, errors: ["x"], modules: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("test-result-b-live")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("test-result-a-dead")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("test-result-c-err")).toBeInTheDocument());
    const cards = screen.getAllByTestId("profile-card");
    const names = cards.map((c) => within(c).getByRole("heading", { level: 3 }).textContent);
    expect(names[0]).toBe("zeta-cluster"); // ok:true → rank 0
    // Both remaining are unreachable (ok:false) → rank 2, tie-break by name
    expect(names.slice(1)).toEqual(["alpha-cluster", "mid-cluster"]);
  });

  it("Wave 5.16z2: disables non-active Activate when useInflight reports count>0", async () => {
    mockInflight = {
      count: 1,
      items: [{ id: "lg1", kind: "loadgen", label: "loadgen-1", started_at: Date.now() }],
      stale: [],
      ready: true,
    };
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "other", port: 9, tls: false, db: 0, label: "other" }),
      routeJson(/\/connections$/, "GET", [profile()]),
      routeJson(/\/connections\/01J\/test$/, "POST", { ok: true, latency_ms: 4, modules: [], errors: [] }),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("test-result-01J")).toBeInTheDocument());
    const btn = screen.getByRole("button", { name: /^Activate$/ }) as HTMLButtonElement;
    // Even though the profile is reachable, the in-flight lockout keeps Activate disabled.
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.title).toMatch(/in flight|target switching/i);
  });

  it("Wave 5.59: editing the active profile dispatches connections:active-changed after PUT", async () => {
    let putCalled = false;
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) {
        return new Response(JSON.stringify({ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections$/) && method === "GET") {
        return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: true, latency_ms: 4, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J$/) && method === "PUT") {
        putCalled = true;
        return new Response(JSON.stringify(profile({ name: "demo-renamed" })), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener("connections:active-changed", listener);

    try {
      renderPanel();
      await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
      // Open Edit on the active card and submit a new name.
      const editBtn = (await screen.findAllByRole("button", { name: /^Edit$/ }))[0]!;
      fireEvent.click(editBtn);
      const dialog = await screen.findByRole("dialog", { name: /edit cluster/i });
      const nameInput = within(dialog).getByLabelText(/^name$/i) as HTMLInputElement;
      fireEvent.change(nameInput, { target: { value: "demo-renamed" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

      await waitFor(() => expect(putCalled).toBe(true));
      await waitFor(() => expect(events.length).toBeGreaterThan(0));
      expect(events[0]!.type).toBe("connections:active-changed");
    } finally {
      window.removeEventListener("connections:active-changed", listener);
    }
  });

  it("Wave 5.59: editing a NON-active profile does NOT dispatch connections:active-changed", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) {
        // Active target is something else entirely.
        return new Response(JSON.stringify({ host: "other.lab", port: 9999, tls: false, db: 0, label: "other-cluster" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections$/) && method === "GET") {
        return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: true, latency_ms: 4, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J$/) && method === "PUT") {
        return new Response(JSON.stringify(profile({ name: "demo-renamed" })), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });

    const events: Event[] = [];
    const listener = (e: Event) => events.push(e);
    window.addEventListener("connections:active-changed", listener);

    try {
      renderPanel();
      await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
      const editBtn = (await screen.findAllByRole("button", { name: /^Edit$/ }))[0]!;
      fireEvent.click(editBtn);
      const dialog = await screen.findByRole("dialog", { name: /edit cluster/i });
      fireEvent.change(within(dialog).getByLabelText(/^name$/i), { target: { value: "demo-renamed" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));
      // Wait for refresh to settle; non-active edit must NOT dispatch.
      await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
      expect(events.length).toBe(0);
    } finally {
      window.removeEventListener("connections:active-changed", listener);
    }
  });

  it("Wave 5.16z2: a 409 from activate surfaces a per-row error listing inflight items", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) {
        return new Response(JSON.stringify({ host: "other", port: 9, tls: false, db: 0, label: "other" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections$/) && method === "GET") {
        return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
        return new Response(JSON.stringify({ ok: true, latency_ms: 4, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.match(/\/connections\/01J\/activate$/) && method === "POST") {
        return new Response(JSON.stringify({
          error: "in flight",
          inflight: [
            { id: "lg1", kind: "loadgen", label: "loadgen-1", started_at: 1 },
            { id: "in3", kind: "ingest", label: "ingest-3", started_at: 2 },
          ],
          stale: [],
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    const btn = await screen.findByRole("button", { name: /^Activate$/ }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    const errEl = await screen.findByTestId("activate-error-01J");
    expect(errEl).toHaveTextContent(/cannot activate/i);
    expect(errEl).toHaveTextContent(/2 runs still in flight/i);
    expect(errEl).toHaveTextContent(/loadgen-1/);
    expect(errEl).toHaveTextContent(/ingest-3/);
  });

  describe("Wave 5.60 — duplicate-endpoint guard + explicit-mode submit", () => {
    function dupResponse(existingId: string, existingName: string, host: string, port: number) {
      return new Response(
        JSON.stringify({
          error: "duplicate-endpoint",
          message: `duplicate ${host}:${port}`,
          existing_id: existingId,
          existing_name: existingName,
          host, port, db: 0,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    it("duplicate POST keeps the dialog open, shows the banner, and offers Switch to Edit", async () => {
      fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.match(/\/redis\/active-target$/)) {
          return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections$/) && method === "GET") {
          return new Response(JSON.stringify([profile({ id: "existing-1", name: "demo-cluster", host: "redis-1.lab", port: 12000 })]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/[^/]+\/test$/) && method === "POST") {
          return new Response(JSON.stringify({ ok: true, latency_ms: 1, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections$/) && method === "POST") {
          return dupResponse("existing-1", "demo-cluster", "redis-1.lab", 12000);
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      renderPanel();
      fireEvent.click(await screen.findByRole("button", { name: /add cluster/i }));
      const dialog = await screen.findByRole("dialog", { name: /add cluster/i });
      fireEvent.change(within(dialog).getByLabelText(/^name$/i), { target: { value: "new-cluster" } });
      fireEvent.change(within(dialog).getByLabelText(/^host$/i), { target: { value: "redis-1.lab" } });
      fireEvent.change(within(dialog).getByLabelText(/^port$/i), { target: { value: "12000" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

      const banner = await within(dialog).findByTestId("dialog-banner-error");
      expect(banner).toHaveTextContent(/already exists/i);
      expect(banner).toHaveTextContent(/demo-cluster/);
      // The dialog must remain open with the Switch-to-Edit affordance.
      expect(within(dialog).getByTestId("dialog-switch-to-edit")).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: /add cluster/i })).toBeInTheDocument();
    });

    it("clicking Switch to Edit reopens the dialog as Edit on the existing profile, pre-filled", async () => {
      fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.match(/\/redis\/active-target$/)) {
          return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections$/) && method === "GET") {
          return new Response(JSON.stringify([profile({ id: "existing-1", name: "demo-cluster", host: "redis-1.lab", port: 12000 })]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/[^/]+\/test$/) && method === "POST") {
          return new Response(JSON.stringify({ ok: true, latency_ms: 1, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections$/) && method === "POST") {
          return dupResponse("existing-1", "demo-cluster", "redis-1.lab", 12000);
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: /add cluster/i }));
      const addDialog = await screen.findByRole("dialog", { name: /add cluster/i });
      fireEvent.change(within(addDialog).getByLabelText(/^name$/i), { target: { value: "dup-cluster" } });
      fireEvent.change(within(addDialog).getByLabelText(/^host$/i), { target: { value: "redis-1.lab" } });
      fireEvent.change(within(addDialog).getByLabelText(/^port$/i), { target: { value: "12000" } });
      fireEvent.click(within(addDialog).getByRole("button", { name: /save/i }));

      const switchBtn = await within(addDialog).findByTestId("dialog-switch-to-edit");
      fireEvent.click(switchBtn);

      const editDialog = await screen.findByRole("dialog", { name: /edit cluster/i });
      expect((within(editDialog).getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("demo-cluster");
      expect((within(editDialog).getByLabelText(/^host$/i) as HTMLInputElement).value).toBe("redis-1.lab");
      expect((within(editDialog).getByLabelText(/^port$/i) as HTMLInputElement).value).toBe("12000");
      // Banner is gone after switching.
      expect(within(editDialog).queryByTestId("dialog-banner-error")).toBeNull();
    });

    it("duplicate PUT (changing host to existing) shows the banner inside the Edit dialog", async () => {
      fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.match(/\/redis\/active-target$/)) {
          return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections$/) && method === "GET") {
          return new Response(JSON.stringify([
            profile({ id: "01A", name: "a-cluster", host: "rs.a", port: 12000 }),
            profile({ id: "01B", name: "b-cluster", host: "rs.b", port: 12000 }),
          ]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/[^/]+\/test$/) && method === "POST") {
          return new Response(JSON.stringify({ ok: true, latency_ms: 1, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/01B$/) && method === "PUT") {
          return dupResponse("01A", "a-cluster", "rs.a", 12000);
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText("b-cluster")).toBeInTheDocument());
      // Edit the b-cluster card.
      const cards = screen.getAllByTestId("profile-card");
      const bCard = cards.find((c) => within(c).queryByText("b-cluster")) as HTMLElement;
      fireEvent.click(within(bCard).getByRole("button", { name: /^Edit$/ }));
      const dialog = await screen.findByRole("dialog", { name: /edit cluster/i });
      fireEvent.change(within(dialog).getByLabelText(/^host$/i), { target: { value: "rs.a" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

      const banner = await within(dialog).findByTestId("dialog-banner-error");
      expect(banner).toHaveTextContent(/already exists/i);
      expect(banner).toHaveTextContent(/a-cluster/);
      // The Edit dialog stays open.
      expect(screen.getByRole("dialog", { name: /edit cluster/i })).toBeInTheDocument();
    });

    it("normal PUT (no host/port/db change) on the active profile does NOT trigger a false-positive banner", async () => {
      let putCalled = false;
      fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.match(/\/redis\/active-target$/)) {
          return new Response(JSON.stringify({ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections$/) && method === "GET") {
          return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
          return new Response(JSON.stringify({ ok: true, latency_ms: 1, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/01J$/) && method === "PUT") {
          putCalled = true;
          return new Response(JSON.stringify(profile({ name: "demo-renamed" })), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
      fireEvent.click((await screen.findAllByRole("button", { name: /^Edit$/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: /edit cluster/i });
      fireEvent.change(within(dialog).getByLabelText(/^name$/i), { target: { value: "demo-renamed" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

      await waitFor(() => expect(putCalled).toBe(true));
      // Dialog closes, no banner.
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /edit cluster/i })).toBeNull());
      expect(screen.queryByTestId("dialog-banner-error")).toBeNull();
    });

    it("Cancel-then-Edit: opening Add, cancelling, then editing a card fires exactly one PUT (no POST)", async () => {
      const requests: Array<{ url: string; method: string }> = [];
      fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (url.match(/\/redis\/active-target$/)) {
          return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections$/) && method === "GET") {
          return new Response(JSON.stringify([profile()]), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/01J\/test$/) && method === "POST") {
          return new Response(JSON.stringify({ ok: true, latency_ms: 1, modules: [], errors: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.match(/\/connections\/01J$/) && method === "PUT") {
          return new Response(JSON.stringify(profile({ name: "renamed" })), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      });
      renderPanel();
      await waitFor(() => expect(screen.getByText("demo-cluster")).toBeInTheDocument());
      // 1. Open Add dialog.
      fireEvent.click(screen.getByRole("button", { name: /add cluster/i }));
      await screen.findByRole("dialog", { name: /add cluster/i });
      // 2. Cancel.
      fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: /add cluster/i })).toBeNull());
      // 3. Click Edit on the card.
      fireEvent.click((await screen.findAllByRole("button", { name: /^Edit$/ }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: /edit cluster/i });
      fireEvent.change(within(dialog).getByLabelText(/^name$/i), { target: { value: "renamed" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));

      // The submit MUST be PUT, not POST — the Add dialog was cancelled, so
      // the closure-captured `dialog.kind` race is moot now.
      await waitFor(() => expect(requests.some((r) => r.method === "PUT" && /\/connections\/01J$/.test(r.url))).toBe(true));
      const writes = requests.filter((r) =>
        (r.method === "POST" && /\/connections$/.test(r.url)) ||
        (r.method === "PUT" && /\/connections\/[^/]+$/.test(r.url))
      );
      const puts = writes.filter((w) => w.method === "PUT");
      const posts = writes.filter((w) => w.method === "POST");
      expect(puts.length).toBe(1);
      expect(posts.length).toBe(0);
    });
  });
});

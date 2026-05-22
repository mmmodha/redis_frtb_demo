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
      <span>buying signal: {signal}</span>
      {children}
    </aside>
  ),
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

  it("renders the Connections heading and the 3 buying-signal callouts", async () => {
    setRoutes(
      routeJson(/\/redis\/active-target$/, "GET", { host: "h", port: 1, tls: false, db: 0, label: "demo-cluster" }),
      routeJson(/\/connections$/, "GET", []),
    );
    renderPanel();
    expect(screen.getByRole("heading", { name: /^Connections$/i, level: 1 })).toBeInTheDocument();
    const signals = screen.getAllByTestId("enterprise-callout").map((e) => e.getAttribute("data-signal"));
    expect(signals).toEqual(expect.arrayContaining(["ClusterScaleOut", "Functions", "ObservabilityModule"]));
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
          { name: "ReJSON", present: true },
          { name: "search", present: true },
          { name: "redisgears", present: false },
        ],
        errors: [],
      }),
    );
    renderPanel();
    const testBtn = await screen.findByRole("button", { name: /^Test$/ });
    fireEvent.click(testBtn);
    await waitFor(() => expect(screen.getByTestId("test-result-01J")).toBeInTheDocument());
    const result = screen.getByTestId("test-result-01J");
    expect(within(result).getByText(/ReJSON/)).toBeInTheDocument();
    expect(within(result).getByText(/search/)).toBeInTheDocument();
    expect(within(result).getByText(/redisgears/)).toBeInTheDocument();
    expect(within(result).getByText(/9\s*ms/)).toBeInTheDocument();
  });

  it("clicking Activate runs POST /connections/:id/activate and marks card active", async () => {
    let activatedCalled = false;
    fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.match(/\/redis\/active-target$/)) return new Response(JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "scale-cluster" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections$/) && method === "GET") return new Response(JSON.stringify([profile(), profile({ id: "01K", name: "scale-cluster" })]), { status: 200, headers: { "content-type": "application/json" } });
      if (url.match(/\/connections\/01J\/activate$/) && method === "POST") {
        activatedCalled = true;
        return new Response(JSON.stringify(profile()), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    renderPanel();
    const activateBtns = await screen.findAllByRole("button", { name: /^Activate$/ });
    fireEvent.click(activateBtns[0]!);
    await waitFor(() => expect(activatedCalled).toBe(true));
  });
});

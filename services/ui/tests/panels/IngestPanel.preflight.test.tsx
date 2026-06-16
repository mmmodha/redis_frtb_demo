// Wave 5.47b — pre-flight banner + one-click rebuild in IngestPanel.
//
// Renders a yellow banner above the SyntheticGeneratorCard when
// GET /admin/preflight returns ok=false; clicking "Rebuild indexes" POSTs to
// /admin/rebuild-indexes and re-runs preflight; banner disappears on success.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import { GeneratorRunProvider } from "../../src/context/GeneratorRunContext";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2>{actions}</header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: any) => (<aside data-signal={signal}>{children}</aside>),
}));
vi.mock("../../src/components/MetricTile", () => ({
  MetricTile: ({ label, value }: any) => (<div data-label={label}>{value}</div>),
}));

function renderPanel() {
  const r = render(
    <MemoryRouter>
      <GeneratorRunProvider>
        <IngestPanel />
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
  // Wave 6.17 — preflight banner now lives under the outer Advanced
  // (custom run) disclosure on the IngestPanel; open it so banner queries
  // resolve.
  fireEvent.click(screen.getByTestId("ingest-advanced-toggle"));
  return r;
}

const preflightFail = {
  ok: false,
  checks: {
    idx_sens: { ok: false, missing: ["node-0"] },
    frtb_library: { ok: true, loaded: true },
    stream: { ok: true, exists: true },
  },
  can_rebuild: true,
};
const preflightPass = {
  ok: true,
  checks: {
    idx_sens: { ok: true, missing: [] },
    frtb_library: { ok: true, loaded: true },
    stream: { ok: true, exists: true },
  },
  can_rebuild: false,
};

interface MockState {
  preflightQueue: unknown[];
  rebuildBody?: unknown;
  rebuildOk?: boolean;
}

function mockFetch(state: MockState): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  fetchMock.mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/sources") && method === "GET") return { ok: true, json: async () => [] };
    if (url.includes("/observability/keys")) return { ok: true, json: async () => ({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 1 }) };
    if (url.includes("/observability/memory")) return { ok: true, json: async () => ({ used_memory: 0, used_memory_human: "0B", ms: 1 }) };
    if (url.endsWith("/admin/preflight") && method === "GET") {
      const next = state.preflightQueue.shift() ?? preflightPass;
      return { ok: true, json: async () => next };
    }
    if (url.endsWith("/admin/rebuild-indexes") && method === "POST") {
      return {
        ok: state.rebuildOk ?? true,
        status: 200,
        json: async () => state.rebuildBody ?? { ok: true, ms: 5, bootstrap: { ok: true } },
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IngestPanel — pre-flight banner (Wave 5.47b)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("hides the banner when preflight returns ok=true", async () => {
    fetchMock = mockFetch({ preflightQueue: [preflightPass] });
    renderPanel();
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find((c) => /\/admin\/preflight$/.test(String(c[0])));
      expect(posted).toBeDefined();
    });
    expect(screen.queryByTestId("preflight-banner")).not.toBeInTheDocument();
  });

  it("renders the banner with the missing pieces when preflight returns ok=false", async () => {
    fetchMock = mockFetch({ preflightQueue: [preflightFail] });
    renderPanel();
    const banner = await screen.findByTestId("preflight-banner");
    expect(banner.textContent).toMatch(/pre-flight failed/i);
    expect(banner.textContent).toMatch(/idx:sens/i);
    expect(banner.textContent).toMatch(/node-0/);
    expect(screen.getByTestId("preflight-rebuild-btn")).toBeEnabled();
  });

  it("clicking Rebuild POSTs /admin/rebuild-indexes, re-runs preflight, and hides the banner on success", async () => {
    fetchMock = mockFetch({ preflightQueue: [preflightFail, preflightPass] });
    renderPanel();
    await screen.findByTestId("preflight-banner");
    fireEvent.click(screen.getByTestId("preflight-rebuild-btn"));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => /\/admin\/rebuild-indexes$/.test(String(c[0])) && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBeDefined();
    });
    await waitFor(() => expect(screen.queryByTestId("preflight-banner")).not.toBeInTheDocument());
    // Two preflight calls: mount + post-rebuild.
    const preflights = fetchMock.mock.calls.filter((c) => /\/admin\/preflight$/.test(String(c[0])));
    expect(preflights.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces bootstrap.ok=false from rebuild and keeps the banner", async () => {
    fetchMock = mockFetch({
      preflightQueue: [preflightFail],
      rebuildBody: { ok: false, ms: 3, bootstrap: { ok: false, error: "FT.CREATE failed" } },
    });
    renderPanel();
    await screen.findByTestId("preflight-banner");
    fireEvent.click(screen.getByTestId("preflight-rebuild-btn"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/ft\.create failed/i);
    expect(screen.getByTestId("preflight-banner")).toBeInTheDocument();
  });

  it("disables Rebuild when can_rebuild=false (redis unhealthy)", async () => {
    fetchMock = mockFetch({
      preflightQueue: [{ ...preflightFail, can_rebuild: false }],
    });
    renderPanel();
    await screen.findByTestId("preflight-banner");
    expect(screen.getByTestId("preflight-rebuild-btn")).toBeDisabled();
  });
});

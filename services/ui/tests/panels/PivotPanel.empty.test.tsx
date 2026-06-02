import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PivotPanel } from "../../src/panels/PivotPanel";
import { PivotBurstProvider } from "../../src/context/PivotBurstContext";
import { PivotHistoryProvider } from "../../src/context/PivotHistoryContext";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card">
      <header>
        <h2>{title}</h2>
        {actions}
      </header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: any) => (
    <aside data-testid="enterprise-callout" data-signal={signal}>{children}</aside>
  ),
}));
vi.mock("../../src/components/MetricTile", () => ({
  MetricTile: ({ label, value, unit }: any) => (
    <div data-testid="metric-tile" data-label={label}>
      <span>{label}</span>
      <strong>{value}</strong>
      <span>{unit}</span>
    </div>
  ),
}));

function renderPanel() {
  return render(
    <PivotBurstProvider>
      <PivotHistoryProvider>
        <MemoryRouter>
          <PivotPanel />
        </MemoryRouter>
      </PivotHistoryProvider>
    </PivotBurstProvider>,
  );
}

describe("<PivotPanel /> friendly empty-target banner (Wave 5.16z3)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("412 bootstrap response renders the amber banner (target_label + bootstrap_phase), not the red error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 412,
      json: async () => ({
        error: "Function not found",
        target_label: "test2",
        bootstrap_phase: "library-loading",
      }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const banner = await waitFor(() => screen.getByTestId("empty-target-banner"));
    expect(banner.getAttribute("data-kind")).toBe("bootstrap");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.className).toMatch(/panel-callout--amber/);
    expect(banner.textContent).toMatch(/Bootstrapping/i);
    expect(banner.textContent).toMatch(/test2/);
    expect(banner.textContent).toMatch(/library-loading/);
    expect(banner.textContent).toMatch(/Pivot will be available/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("503 no-data-or-index renders the amber 'head to Sources' banner", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: "no-data-or-index", hint: "Upload via Sources first." }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const banner = await waitFor(() => screen.getByTestId("empty-target-banner"));
    expect(banner.getAttribute("data-kind")).toBe("no-data");
    expect(banner.className).toMatch(/panel-callout--amber/);
    expect(banner.textContent).toMatch(/No sensitivities indexed yet/i);
    expect(banner.textContent).toMatch(/Sources/);
    expect(banner.textContent).toMatch(/Upload via Sources first/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ordinary 500 still renders the existing red alert (not swallowed)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run query/i }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toMatch(/500|failed/i);
    expect(screen.queryByTestId("empty-target-banner")).toBeNull();
  });
});

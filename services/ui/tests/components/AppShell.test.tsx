import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "../../src/components/AppShell";
import {
  PivotBurstContext,
  type PivotBurstContextValue,
} from "../../src/context/PivotBurstContext";
import {
  GeneratorRunContext,
  type GeneratorRunContextValue,
  type GeneratorRunState,
} from "../../src/context/GeneratorRunContext";

function renderShell(initialPath = "/observability") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppShell>
        <div data-testid="slot">slot-content</div>
      </AppShell>
    </MemoryRouter>,
  );
}

function renderShellWithBurst(
  burstValue: PivotBurstContextValue,
  initialPath = "/calc",
) {
  return render(
    <PivotBurstContext.Provider value={burstValue}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppShell>
          <div data-testid="slot">slot-content</div>
        </AppShell>
      </MemoryRouter>
    </PivotBurstContext.Provider>,
  );
}

function renderShellWithGenerator(
  generatorValue: GeneratorRunContextValue,
  initialPath = "/calc",
) {
  return render(
    <GeneratorRunContext.Provider value={generatorValue}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppShell>
          <div data-testid="slot">slot-content</div>
        </AppShell>
      </MemoryRouter>
    </GeneratorRunContext.Provider>,
  );
}

function makeRunningGenerator(rowsDone = 50, rowsTotal = 200): GeneratorRunState {
  return {
    rowsTotal,
    rowsDone,
    elapsedMs: 100,
    rowsPerSec: 500,
    runId: "01HXGEN",
    status: "running",
  };
}

describe("<AppShell />", () => {
  it("renders a left rail with the 6 locked navigation sections", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: /primary/i });
    const labels = ["Connections", "Sources", "Ingest", "Search", "Calculation", "Observability"];
    for (const label of labels) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the content slot for the active panel", () => {
    renderShell();
    expect(screen.getByTestId("slot")).toHaveTextContent("slot-content");
  });

  it("brands the header with the FRTB SBM Redis Enterprise label", () => {
    renderShell();
    expect(screen.getByRole("banner")).toHaveTextContent(/FRTB SBM/i);
    expect(screen.getByRole("banner")).toHaveTextContent(/Redis Enterprise/i);
  });

  it("Wave 5.21g — renders the pivot burst nav pill on non-pivot routes when burst is active, and hides it when burst is null", () => {
    const active: PivotBurstContextValue = {
      burst: { done: 42, total: 100 },
      startBurst: () => {},
      cancelBurst: () => {},
    };
    const { unmount } = renderShellWithBurst(active, "/calc");
    const pill = screen.getByTestId("pivot-burst-nav-pill");
    expect(pill).toHaveTextContent("42 / 100");
    expect(pill).toHaveAttribute("role", "status");
    expect(pill).toHaveAttribute("aria-live", "polite");
    expect(pill).toHaveAttribute("aria-label", "Search burst running, 42 of 100");
    unmount();

    const idle: PivotBurstContextValue = {
      burst: null,
      startBurst: () => {},
      cancelBurst: () => {},
    };
    renderShellWithBurst(idle, "/calc");
    expect(screen.queryByTestId("pivot-burst-nav-pill")).toBeNull();
  });

  it("Wave 5.38a — renders the generator run nav pill on non-ingest routes when run is running, hides it on /ingest and when run is null", () => {
    const running: GeneratorRunContextValue = {
      run: makeRunningGenerator(50, 200),
      error: null,
      startRun: () => {},
      cancelRun: () => {},
      clearRun: () => {},
    };
    const r1 = renderShellWithGenerator(running, "/calc");
    const pill = screen.getByTestId("generator-run-nav-pill");
    expect(pill).toHaveTextContent("50 / 200");
    expect(pill).toHaveAttribute("role", "status");
    expect(pill).toHaveAttribute("aria-live", "polite");
    expect(pill).toHaveAttribute("aria-label", "Generator running, 50 of 200");
    r1.unmount();

    const r2 = renderShellWithGenerator(running, "/ingest");
    expect(screen.queryByTestId("generator-run-nav-pill")).toBeNull();
    r2.unmount();

    const idle: GeneratorRunContextValue = {
      run: null,
      error: null,
      startRun: () => {},
      cancelRun: () => {},
      clearRun: () => {},
    };
    renderShellWithGenerator(idle, "/calc");
    expect(screen.queryByTestId("generator-run-nav-pill")).toBeNull();
  });
});

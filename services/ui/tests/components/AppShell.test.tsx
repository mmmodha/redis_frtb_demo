import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "../../src/components/AppShell";

function renderShell(initialPath = "/observability") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppShell>
        <div data-testid="slot">slot-content</div>
      </AppShell>
    </MemoryRouter>,
  );
}

describe("<AppShell />", () => {
  it("renders a left rail with the 6 locked navigation sections", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: /primary/i });
    const labels = ["Connections", "Sources", "Ingest", "Pivot", "Calc", "Observability"];
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
});

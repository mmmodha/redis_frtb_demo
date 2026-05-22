import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PanelCard } from "../../src/components/PanelCard";

describe("<PanelCard />", () => {
  it("renders the title in a heading and the children in the body", () => {
    render(
      <PanelCard title="Observability">
        <p>body text</p>
      </PanelCard>,
    );
    expect(screen.getByRole("heading", { name: "Observability" })).toBeInTheDocument();
    expect(screen.getByText("body text")).toBeInTheDocument();
  });

  it("renders the actions slot when provided", () => {
    render(
      <PanelCard title="x" actions={<button type="button">Refresh</button>}>
        <span>body</span>
      </PanelCard>,
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});

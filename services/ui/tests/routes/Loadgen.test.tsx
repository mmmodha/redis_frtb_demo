// RED — Loadgen route renders the panel under a top-level page heading.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../src/lib/loadgen", () => ({
  startLoadgen: vi.fn(),
  stopLoadgen: vi.fn(),
  getLoadgenStatus: vi.fn(async () => ({ running: false })),
  subscribeMetrics: vi.fn(() => () => undefined),
}));

import { Loadgen } from "../../src/routes/Loadgen";

describe("<Loadgen /> route", () => {
  it("renders an h1 'Loadgen' heading", () => {
    render(
      <MemoryRouter>
        <Loadgen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /loadgen/i, level: 1 })).toBeInTheDocument();
  });

  it("embeds the LoadgenPanel content (Concurrent Load section)", () => {
    render(
      <MemoryRouter>
        <Loadgen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /concurrent load/i })).toBeInTheDocument();
  });
});

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../src/App";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("<App /> routes", () => {
  it("renders the Connections panel at /connections", () => {
    renderAt("/connections");
    expect(screen.getByRole("heading", { name: /connections/i, level: 1 })).toBeInTheDocument();
  });

  it("renders the Sources panel at /sources", () => {
    renderAt("/sources");
    expect(screen.getByRole("heading", { name: /sources/i, level: 1 })).toBeInTheDocument();
  });

  it("renders the Ingest panel at /ingest", () => {
    renderAt("/ingest");
    expect(screen.getByRole("heading", { name: /ingest/i, level: 1 })).toBeInTheDocument();
  });

  it("renders the Search panel at /pivot", () => {
    renderAt("/pivot");
    expect(screen.getByRole("heading", { name: /search/i, level: 1 })).toBeInTheDocument();
  });

  it("renders the Calc panel at /calc", () => {
    renderAt("/calc");
    expect(screen.getByRole("heading", { name: /calc/i, level: 1 })).toBeInTheDocument();
  });

  it("renders the Observability panel at /observability", () => {
    renderAt("/observability");
    expect(screen.getByRole("heading", { name: /observability/i, level: 1 })).toBeInTheDocument();
  });

  it("renders the Per-shard panel at /observability/shards", () => {
    renderAt("/observability/shards");
    expect(
      screen.getByRole("heading", { name: /per-shard observability/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("redirects the root path / to /observability", () => {
    renderAt("/");
    const nav = screen.getByRole("navigation", { name: /primary/i });
    expect(within(nav).getByRole("link", { name: "Observability" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /observability/i, level: 1 })).toBeInTheDocument();
  });
});

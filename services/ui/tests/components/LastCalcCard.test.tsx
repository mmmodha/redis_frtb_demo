// Wave 6.01 — covers the three rendering modes of LastCalcCard:
// empty state, per_class headline + tiles, total headline + tiles, plus the
// click-to-expand mini-table.

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LastCalcCard } from "../../src/components/LastCalcCard";
import type { RecentCalcRun } from "../../src/lib/api";

function perClass(over: Partial<RecentCalcRun> = {}): RecentCalcRun {
  return {
    id: "01J0", ts: new Date(Date.now() - 12_000).toISOString(),
    kind: "per_class", risk_class: "GIRR", leg: "delta", scenario: "medium",
    charge: 1.5, total_ms: 4.2, fanout_ms: 1.1, cells_evaluated: 3,
    cache: "miss", engine: "fast", ...over,
  } as RecentCalcRun;
}
function total(over: Partial<RecentCalcRun> = {}): RecentCalcRun {
  return {
    id: "01J1", ts: new Date(Date.now() - 2_000).toISOString(),
    kind: "total", charge: 9.9, total_ms: 11.0, cumulative_ms: 22.0,
    parallelism_factor: 2, redis_ops_count: 27, ops_skipped: 0,
    cells_empty: 0, cache_hits: 0, cache: "miss", engine: "orchestrator", ...over,
  } as RecentCalcRun;
}

describe("<LastCalcCard />", () => {
  it("renders the empty-state copy when items is empty", () => {
    render(<LastCalcCard items={[]} now={Date.now()} />);
    expect(screen.getByTestId("last-calc-empty")).toHaveTextContent(/No calculations yet/i);
  });

  it("renders per_class header + Wall time / Engine / Cache / Cells tiles", () => {
    render(<LastCalcCard items={[perClass()]} now={Date.now()} />);
    expect(screen.getByTestId("last-calc-header").textContent).toMatch(/GIRR Delta · Medium · 12s ago/);
    const tiles = screen.getByTestId("last-calc-tiles-per-class");
    expect(tiles).toHaveTextContent(/Wall time/);
    expect(tiles).toHaveTextContent("4.2");
    expect(tiles).toHaveTextContent(/Engine/);
    expect(tiles).toHaveTextContent("fast");
    expect(tiles).toHaveTextContent(/Cache/);
    expect(tiles).toHaveTextContent("miss");
    expect(tiles).toHaveTextContent(/Cells evaluated/);
    expect(tiles).toHaveTextContent("3");
  });

  it("renders total header + Redis ops / Parallelism tiles", () => {
    render(<LastCalcCard items={[total()]} now={Date.now()} />);
    expect(screen.getByTestId("last-calc-header").textContent).toMatch(/Total SBM · 2s ago/);
    const tiles = screen.getByTestId("last-calc-tiles-total");
    expect(tiles).toHaveTextContent(/Redis ops/);
    expect(tiles).toHaveTextContent("27");
    expect(tiles).toHaveTextContent(/Parallelism/);
    expect(tiles).toHaveTextContent("×2");
  });

  it("click toggles a 5-row history table; second click collapses it", () => {
    const items = [perClass(), total(), perClass({ id: "01J2", risk_class: "EQUITY" })];
    render(<LastCalcCard items={items} now={Date.now()} />);
    expect(screen.queryByTestId("last-calc-table")).toBeNull();
    fireEvent.click(screen.getByTestId("last-calc-toggle"));
    const table = screen.getByTestId("last-calc-table");
    expect(table.querySelectorAll("tbody tr").length).toBe(3);
    expect(table).toHaveTextContent("EQUITY");
    fireEvent.click(screen.getByTestId("last-calc-toggle"));
    expect(screen.queryByTestId("last-calc-table")).toBeNull();
  });

  it("caps the expanded table at 5 rows", () => {
    const items: RecentCalcRun[] = [];
    for (let i = 0; i < 8; i++) items.push(perClass({ id: `id-${i}` }));
    render(<LastCalcCard items={items} now={Date.now()} />);
    fireEvent.click(screen.getByTestId("last-calc-toggle"));
    expect(screen.getByTestId("last-calc-table").querySelectorAll("tbody tr").length).toBe(5);
  });
});

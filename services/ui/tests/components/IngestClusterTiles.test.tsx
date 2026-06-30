import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { IngestClusterTiles } from "../../src/components/ingest/IngestClusterTiles";

describe("IngestClusterTiles", () => {
  it("renders target, memory bar, and sensitivities", () => {
    render(
      <IngestClusterTiles
        targetLabel="redis-primary"
        memory={{
          usedBytes: 4e9,
          usedHuman: "4.0G",
          capBytes: 8e9,
          capHuman: "8.0G",
          pct: 50,
          level: "orange",
        }}
        sens={{ count: 1_000_000 }}
      />,
    );
    expect(screen.getByTestId("ingest-tile-target")).toHaveTextContent("redis-primary");
    expect(screen.getByTestId("ingest-tile-sens")).toHaveTextContent("1,000,000");
    expect(screen.getByTestId("ingest-memory-bar")).toHaveAttribute("data-level", "orange");
    expect(screen.getByTestId("ingest-memory-caption")).toHaveTextContent(/4\.0G \/ 8\.0G/);
  });

  it("shows keys added and row progress when keys lag behind rows written", () => {
    render(
      <IngestClusterTiles
        targetLabel="redis-primary"
        memory={{
          usedBytes: 1e9,
          usedHuman: "1.0G",
          capBytes: 8e9,
          capHuman: "8.0G",
          pct: 12,
          level: "green",
        }}
        sens={{ count: 350_000 }}
        runPhase="running"
        keysAtRunStart={100_000}
        runWritten={500_000}
      />,
    );
    const hint = screen.getByTestId("ingest-tile-sens-added");
    expect(hint).toHaveTextContent(/\+250,000 keys in DB/);
    expect(hint).not.toHaveTextContent(/from last run/);
    expect(hint).toHaveTextContent(/500,000 rows written/);
  });

  it("shows persisted keys added from last run when idle", () => {
    render(
      <IngestClusterTiles
        targetLabel="redis-primary"
        memory={{
          usedBytes: 1e9,
          usedHuman: "1.0G",
          capBytes: null,
          capHuman: null,
          pct: null,
          level: "unknown",
        }}
        sens={{ count: 900_000 }}
        runPhase="hidden"
        lastRunKeysAdded={100_000}
      />,
    );
    const hint = screen.getByTestId("ingest-tile-sens-added");
    expect(hint).toHaveTextContent(/\+100,000 keys in DB from last run/);
  });
});

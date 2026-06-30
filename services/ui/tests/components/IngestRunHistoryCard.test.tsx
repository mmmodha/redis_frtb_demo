import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestRunHistoryCard } from "../../src/components/ingest/IngestRunHistoryCard";
import type { IngestRunHistoryEntry } from "../../src/lib/ingestRunHistoryDisplay";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section data-testid="panel-card" data-title={title}>{title}{children}</section>
  ),
}));

const sample: IngestRunHistoryEntry = {
  run_id: "01HIST",
  status: "done",
  rows_total: 10_000,
  rows_sent: 10_000,
  rows_written: 9800,
  rows_skipped: 0,
  avg_producer_rps: 2000,
  avg_write_rps: 1960,
  duration_ms: 5000,
  started_at_iso: "2026-06-23T10:00:00.000Z",
  ended_at_iso: "2026-06-23T10:00:05.000Z",
  bulk_loader_base: "http://bulk-loader:8086",
  workers: 2,
  batch_size: 500,
  concurrency: 32,
};

describe("IngestRunHistoryCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows empty state when no runs", () => {
    render(
      <IngestRunHistoryCard runs={[]} expandedId={null} onExpandedChange={() => {}} />,
    );
    expect(screen.getByTestId("ingest-history-empty")).toBeInTheDocument();
  });

  it("lists summary row and drills down into endpoint and avg write rate", () => {
    const onExpandedChange = vi.fn();
    const { rerender } = render(
      <IngestRunHistoryCard runs={[sample]} expandedId={null} onExpandedChange={onExpandedChange} />,
    );
    expect(screen.getByTestId("ingest-history-group-2026-06-23")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("1 run")).toBeInTheDocument();
    expect(screen.getByText(/9,800 \/ 10,000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/1,960 rows\/s avg/)).toBeInTheDocument();
    expect(screen.getByText(/bulk-loader:8086/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("ingest-history-toggle-01HIST"));
    expect(onExpandedChange).toHaveBeenCalledWith("01HIST");

    rerender(
      <IngestRunHistoryCard runs={[sample]} expandedId="01HIST" onExpandedChange={onExpandedChange} />,
    );
    expect(screen.getByTestId("ingest-history-endpoint")).toHaveTextContent("http://bulk-loader:8086");
    expect(screen.getByTestId("ingest-history-avg-write")).toHaveTextContent("1,960");
  });

  it("groups runs into separate date dropdowns", () => {
    const older: IngestRunHistoryEntry = {
      ...sample,
      run_id: "01OLD",
      started_at_iso: "2026-06-22T10:00:00.000Z",
      ended_at_iso: "2026-06-22T10:00:05.000Z",
    };
    render(
      <IngestRunHistoryCard runs={[sample, older]} expandedId={null} onExpandedChange={() => {}} />,
    );
    expect(screen.getByTestId("ingest-history-group-2026-06-23")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-history-group-2026-06-22")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getAllByText("1 run")).toHaveLength(2);
    expect(screen.getByTestId("ingest-history-row-01HIST")).toBeInTheDocument();
    expect(screen.getByTestId("ingest-history-row-01OLD")).toBeInTheDocument();
  });
});

// Wave 7.0.9 — Active jobs card lists producers + bulk-loader drain state.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ActiveJobsCard } from "../../src/components/ActiveJobsCard";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2>{actions}</header>
      <div>{children}</div>
    </section>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handlers: {
  generators?: unknown;
  bulkRuns?: unknown;
  loadStatus?: unknown;
}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url.endsWith("/generator/runs")) {
      return { ok: true, json: async () => handlers.generators ?? { active: [] } };
    }
    if (url.endsWith("/ingest/bulk/runs") && !url.includes("/ingest/bulk/runs/")) {
      return { ok: true, json: async () => handlers.bulkRuns ?? { active: [] } };
    }
    if (url.endsWith("/ingest/bulk/load-status")) {
      return { ok: true, json: async () => handlers.loadStatus ?? { pool_size: 16, connected: 16, dispatcher: { in_flight: 0, high_water: 0 }, workers: [] } };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
}

describe("<ActiveJobsCard />", () => {
  it("shows idle when no producers and bulk-loader queue empty", async () => {
    stubFetch({});
    render(<ActiveJobsCard />);
    expect(await screen.findByTestId("active-jobs-idle")).toBeInTheDocument();
    expect(screen.getByTestId("active-jobs-healthy")).toBeInTheDocument();
    expect(screen.getByTestId("active-jobs-card")).toHaveAttribute("data-status", "idle");
  });

  it("lists active bulk-ingest runs using rows_written for progress", async () => {
    stubFetch({
      bulkRuns: {
        active: [{
          run_id: "01BULK",
          status: "running",
          rows_sent: 22_000_000,
          rows_written: 10_675_314,
          rows_total: 100_000_000,
          workers: 8,
        }],
      },
    });
    render(<ActiveJobsCard />);
    await waitFor(() => {
      expect(screen.getByTestId("active-job-bulk-01BULK")).toBeInTheDocument();
    });
    expect(screen.getByTestId("active-job-bulk-01BULK")).toHaveTextContent("10,675,314 / 100,000,000");
    expect(screen.getByTestId("active-jobs-card")).toHaveAttribute("data-status", "active");
  });

  it("shows draining banner when pending rows remain after stop", async () => {
    stubFetch({
      loadStatus: {
        pool_size: 16,
        connected: 16,
        dispatcher: { in_flight: 1200, high_water: 5000 },
        workers: [{ id: 0, queued: 320_000, flushed: 10000, errors: 0 }],
      },
    });
    render(<ActiveJobsCard />);
    expect(await screen.findByTestId("active-jobs-draining")).toBeInTheDocument();
    expect(screen.getByTestId("active-jobs-pending")).toHaveTextContent("1,200");
    expect(screen.getByTestId("active-jobs-card")).toHaveAttribute("data-status", "draining");
  });

  it("does not show draining when only lifetime queued counter is high", async () => {
    stubFetch({
      loadStatus: {
        pool_size: 16,
        connected: 16,
        dispatcher: { in_flight: 0, high_water: 5000 },
        workers: [{ id: 0, queued: 320_583, flushed: 500_000, errors: 0 }],
      },
    });
    render(<ActiveJobsCard />);
    await screen.findByTestId("active-jobs-idle");
    expect(screen.queryByTestId("active-jobs-draining")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-jobs-healthy")).toBeInTheDocument();
  });

  it("calls onRequestStopAll from header button", async () => {
    stubFetch({});
    const onStop = vi.fn();
    render(<ActiveJobsCard onRequestStopAll={onStop} />);
    await screen.findByTestId("active-jobs-idle");
    fireEvent.click(screen.getByTestId("active-jobs-stop-all"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

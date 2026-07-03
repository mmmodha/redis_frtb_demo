import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ObservabilityOpsBanner } from "../../src/components/observability/ObservabilityOpsBanner";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("ObservabilityOpsBanner", () => {
  it("shows calc banner when a job is running", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/admin/calc-jobs")) {
        return new Response(JSON.stringify({
          active: [{
            id: "j1",
            kind: "total",
            status: "running",
            started_at: new Date().toISOString(),
            cells_total: 27,
            cells_done: 9,
            current_cell: "GIRR/Delta",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/admin/recent-errors")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <ObservabilityOpsBanner />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("obs-ops-banner")).toHaveAttribute("data-kind", "calc");
    });
    expect(screen.getByText(/calc in progress/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /admin diagnostics/i })).toHaveAttribute("href", "/admin#diagnostics");
  });

  it("shows error banner when recent errors exist and no calc is running", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/admin/calc-jobs")) {
        return new Response(JSON.stringify({ active: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/admin/recent-errors")) {
        return new Response(JSON.stringify({
          items: [{
            id: "e1",
            ts: new Date().toISOString(),
            request_id: "req-err-1",
            method: "POST",
            route: "/calc/sbm/total",
            status_code: 500,
            error: "boom",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    render(
      <MemoryRouter>
        <ObservabilityOpsBanner />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("obs-ops-banner")).toHaveAttribute("data-kind", "error");
    });
    expect(screen.getByText(/api errors/i)).toBeInTheDocument();
  });
});

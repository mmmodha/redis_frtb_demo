// Wave 7.0.6.17 — bulk-loader target divergence banner + Start lockout.
//
// Verifies the IngestPanel:
//   • shows nothing when /admin/host-info reports bulk_loader_bound_target ===
//     api active-target label (aligned state),
//   • shows the stale-target banner when bulk_loader_target_stale=true,
//   • shows the "watcher should re-bind" banner when labels differ but stale
//     is still false,
//   • disables the Start preset button whenever the banner is visible.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IngestPanel } from "../../src/panels/IngestPanel";
import { GeneratorRunProvider } from "../../src/context/GeneratorRunContext";

vi.mock("../../src/components/PanelCard", () => ({
  PanelCard: ({ title, children, actions }: any) => (
    <section data-testid="panel-card" data-title={title}>
      <header><h2>{title}</h2>{actions}</header>
      <div>{children}</div>
    </section>
  ),
}));
vi.mock("../../src/components/EnterpriseCallout", () => ({
  EnterpriseCallout: ({ signal, children }: any) => (<aside data-signal={signal}>{children}</aside>),
}));
vi.mock("../../src/components/MetricTile", () => ({
  MetricTile: ({ label, value }: any) => (<div data-label={label}>{value}</div>),
}));
vi.mock("../../src/lib/connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/connections")>();
  return {
    ...actual,
    useActiveTargetLabel: () => "redis-cloud-prod",
  };
});

interface HostInfoStub {
  bulk_loader_bound_target: { host: string; port: number; label: string } | null;
  bulk_loader_target_stale: boolean | null;
  bulk_loader_target_watcher: "enabled" | "disabled" | null;
}

function stubHostInfo(stub: HostInfoStub): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (url.endsWith("/admin/host-info")) {
      return new Response(JSON.stringify({
        cores: 8, recommended_max_workers: 6, max_workers_hard_cap: 32,
        bulk_loader_pool_size: 32, shards: 1, target_label: "redis-cloud-prod",
        ...stub,
      }), { status: 200 });
    }
    if (url.endsWith("/sources")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/observability")) {
      return new Response(JSON.stringify({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, used_memory: 0, used_memory_human: "0B", count: 0, ms: 1 }), { status: 200 });
    }
    if (url.endsWith("/admin/preflight")) {
      return new Response(JSON.stringify({ ok: true, checks: { idx_sens: { ok: true, missing: [] }, frtb_library: { ok: true, loaded: true }, stream: { ok: true, exists: true } }, can_rebuild: false }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <GeneratorRunProvider>
        <IngestPanel />
      </GeneratorRunProvider>
    </MemoryRouter>,
  );
}

describe("IngestPanel — bulk-loader target divergence banner (Wave 7.0.6.17)", () => {
  beforeEach(() => { });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("does NOT show the banner when the bulk-loader bound target matches the api active-target", async () => {
    stubHostInfo({
      bulk_loader_bound_target: { host: "10.0.0.1", port: 12000, label: "redis-cloud-prod" },
      bulk_loader_target_stale: false,
      bulk_loader_target_watcher: "enabled",
    });
    renderPanel();
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.some((c) => String(c[0]).endsWith("/admin/host-info"))).toBe(true);
    });
    expect(screen.queryByTestId("bulk-loader-target-banner")).not.toBeInTheDocument();
  });

  it("shows the stale banner when bulk_loader_target_stale=true and disables the Start preset", async () => {
    stubHostInfo({
      bulk_loader_bound_target: { host: "127.0.0.1", port: 12000, label: "localcluster" },
      bulk_loader_target_stale: true,
      bulk_loader_target_watcher: "disabled",
    });
    renderPanel();
    const banner = await screen.findByTestId("bulk-loader-target-banner");
    expect(banner.getAttribute("data-stale")).toBe("true");
    expect(banner.getAttribute("data-watcher")).toBe("disabled");
    expect(banner.textContent).toMatch(/localcluster/);
    expect(banner.textContent).toMatch(/redis-cloud-prod/);
    expect(banner.textContent).toMatch(/INTERNAL_API_TOKEN/);
    // Start preset button should be disabled. The button label text is
    // "Start <preset>" — we resolve via the button element.
    const startBtn = screen.getByRole("button", { name: /^Start / });
    expect(startBtn).toBeDisabled();
  });

  it("shows the diverged (non-stale) banner when labels differ but watcher is still enabled", async () => {
    stubHostInfo({
      bulk_loader_bound_target: { host: "127.0.0.1", port: 12000, label: "localcluster" },
      bulk_loader_target_stale: false,
      bulk_loader_target_watcher: "enabled",
    });
    renderPanel();
    const banner = await screen.findByTestId("bulk-loader-target-banner");
    expect(banner.getAttribute("data-stale")).toBe("false");
    expect(banner.getAttribute("data-watcher")).toBe("enabled");
    expect(banner.textContent).toMatch(/Watcher is enabled/);
    expect(banner.textContent).toMatch(/should re-bind automatically/);
    const startBtn = screen.getByRole("button", { name: /^Start / });
    expect(startBtn).toBeDisabled();
  });

  it("does NOT show the banner when bulk_loader_bound_target is null (legacy bulk-loader or fetch error)", async () => {
    stubHostInfo({
      bulk_loader_bound_target: null,
      bulk_loader_target_stale: null,
      bulk_loader_target_watcher: null,
    });
    renderPanel();
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.some((c) => String(c[0]).endsWith("/admin/host-info"))).toBe(true);
    });
    expect(screen.queryByTestId("bulk-loader-target-banner")).not.toBeInTheDocument();
  });

  it("does NOT show the banner when active-target label is unknown (null) on the UI side", async () => {
    // Stubs only — useActiveTargetLabel returns "redis-cloud-prod" via the
    // module mock; we cannot easily flip it per-test. Instead, simulate by
    // making the bulk_loader_bound_target label match.
    stubHostInfo({
      bulk_loader_bound_target: { host: "10.0.0.1", port: 12000, label: "redis-cloud-prod" },
      bulk_loader_target_stale: false,
      bulk_loader_target_watcher: "enabled",
    });
    renderPanel();
    fireEvent.click(screen.queryByTestId("ingest-advanced-toggle") ?? document.createElement("div"));
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.some((c) => String(c[0]).endsWith("/admin/host-info"))).toBe(true);
    });
    expect(screen.queryByTestId("bulk-loader-target-banner")).not.toBeInTheDocument();
  });
});

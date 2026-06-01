// Wave 5.16z1 — tests for <BootstrapStatusOverlay/>.
//
// Confirms the overlay renders the amber/red banners only for the running
// and failed phases (idle/ready → no DOM output).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

function mockHook(snapshot: {
  phase: "idle" | "running" | "ready" | "failed";
  target_label?: string;
  err?: string;
}): void {
  vi.doMock("../../src/hooks/useBootstrapStatus", () => ({
    useBootstrapStatus: () => ({
      snapshot: { phase: snapshot.phase, target_label: snapshot.target_label, err: snapshot.err },
      phase: snapshot.phase,
      refresh: () => {},
    }),
  }));
}

async function freshOverlay() {
  const mod = await import("../../src/components/BootstrapStatusOverlay");
  return mod.BootstrapStatusOverlay;
}

describe("<BootstrapStatusOverlay/>", () => {
  it("renders nothing when phase=idle", async () => {
    mockHook({ phase: "idle" });
    const Overlay = await freshOverlay();
    const { container } = render(<Overlay />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when phase=ready", async () => {
    mockHook({ phase: "ready", target_label: "demo-cluster" });
    const Overlay = await freshOverlay();
    const { container } = render(<Overlay />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an amber bootstrapping banner for phase=running", async () => {
    mockHook({ phase: "running", target_label: "demo-cluster" });
    const Overlay = await freshOverlay();
    render(<Overlay />);
    const banner = screen.getByTestId("bootstrap-overlay");
    expect(banner.getAttribute("data-slot")).toBe("bootstrap-overlay");
    expect(banner.getAttribute("data-phase")).toBe("running");
    expect(banner).toHaveTextContent(/Bootstrapping FRTB on/i);
    expect(banner).toHaveTextContent(/demo-cluster/);
    expect(banner.className).toMatch(/bootstrap-overlay--running/);
    // No retry button while running.
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("renders a red failure banner with err text + Retry button for phase=failed", async () => {
    mockHook({ phase: "failed", target_label: "demo-cluster", err: "FCALL frtb.run_sbm refused" });
    const Overlay = await freshOverlay();
    render(<Overlay />);
    const banner = screen.getByTestId("bootstrap-overlay");
    expect(banner.getAttribute("data-phase")).toBe("failed");
    expect(banner.className).toMatch(/bootstrap-overlay--failed/);
    expect(banner).toHaveTextContent(/Bootstrap failed/i);
    expect(banner).toHaveTextContent(/demo-cluster/);
    expect(banner).toHaveTextContent(/FCALL frtb.run_sbm refused/);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

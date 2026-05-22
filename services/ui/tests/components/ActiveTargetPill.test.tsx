// Wave 3.5A — RED tests for the shell-header ActiveTargetPill.
//
// The pill is a small badge rendered inside <AppShell/>'s header showing
// the active Redis Enterprise cluster's name + host:port + a connection-
// state dot (live | disconnected). It must be accessible (status role +
// label), and must never display a password.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActiveTargetPill } from "../../src/components/ActiveTargetPill";

describe("<ActiveTargetPill/>", () => {
  it("renders the active cluster label + host:port and a live status dot", () => {
    render(
      <ActiveTargetPill
        target={{ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" }}
        state="live"
      />,
    );
    const pill = screen.getByRole("status", { name: /active cluster/i });
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/demo-cluster/);
    expect(pill).toHaveTextContent(/redis-1\.lab:12000/);
    expect(pill.querySelector('[data-state="live"]')).not.toBeNull();
  });

  it("falls back to a disconnected pill when no target is set", () => {
    render(<ActiveTargetPill target={null} state="disconnected" />);
    const pill = screen.getByRole("status", { name: /active cluster/i });
    expect(pill).toHaveTextContent(/no active cluster/i);
    expect(pill.querySelector('[data-state="disconnected"]')).not.toBeNull();
  });

  it("shows a TLS indicator when the active target uses TLS", () => {
    render(
      <ActiveTargetPill
        target={{ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" }}
        state="live"
      />,
    );
    const pill = screen.getByRole("status", { name: /active cluster/i });
    expect(pill).toHaveTextContent(/TLS/);
  });
});

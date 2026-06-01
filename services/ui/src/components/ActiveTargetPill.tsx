// Persistent badge rendered in <AppShell/>'s header showing the active
// Redis Enterprise cluster's label + host:port + a connection-state dot.
//
// The pill is informational only (`role="status"`); it never holds secrets
// or accepts user input. The shell wires it to GET /redis/active-target
// and re-fetches on a window event when the Connections panel activates a
// different cluster.

import type { ActiveTarget } from "../lib/connections";
import type { BootstrapPhase } from "../lib/bootstrap-status";

export type ActiveTargetState = "live" | "testing" | "disconnected";

export interface ActiveTargetPillProps {
  target: ActiveTarget | null;
  state: ActiveTargetState;
  // Wave 5.16z1 — when the active target is still bootstrapping (or its
  // bootstrap failed) the pill renders a small phase dot. Hidden for the
  // idle/ready phases so steady state stays uncluttered.
  bootstrapPhase?: BootstrapPhase;
}

function stateDotLabel(state: ActiveTargetState): string {
  switch (state) {
    case "live": return "live";
    case "testing": return "testing";
    case "disconnected": return "disconnected";
  }
}

export function ActiveTargetPill({ target, state, bootstrapPhase }: ActiveTargetPillProps) {
  const disconnected = target == null || state === "disconnected";
  const dotState = disconnected ? "disconnected" : state;
  const showBootstrapDot =
    bootstrapPhase === "running" || bootstrapPhase === "failed";
  return (
    <span
      className="active-target-pill"
      role="status"
      aria-label="Active cluster"
      data-state={dotState}
    >
      <span className="active-target-pill__dot" data-state={dotState} aria-hidden="true" />
      {target ? (
        <>
          <span className="active-target-pill__label">{target.label || target.host}</span>
          <span className="active-target-pill__addr">
            {target.host}:{target.port}
          </span>
          {target.tls ? <span className="active-target-pill__tls" aria-label="TLS enabled">TLS</span> : null}
        </>
      ) : (
        <span className="active-target-pill__label active-target-pill__label--muted">
          No active cluster
        </span>
      )}
      {showBootstrapDot ? (
        <span
          className="active-target-pill__bootstrap-dot"
          data-phase={bootstrapPhase}
          data-testid="active-target-pill-bootstrap-dot"
          aria-label={`bootstrap status: ${bootstrapPhase}`}
          role="img"
        />
      ) : null}
      <span className="visually-hidden">{stateDotLabel(dotState)}</span>
    </span>
  );
}

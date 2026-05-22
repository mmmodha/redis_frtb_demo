// Persistent badge rendered in <AppShell/>'s header showing the active
// Redis Enterprise cluster's label + host:port + a connection-state dot.
//
// The pill is informational only (`role="status"`); it never holds secrets
// or accepts user input. The shell wires it to GET /redis/active-target
// and re-fetches on a window event when the Connections panel activates a
// different cluster.

import type { ActiveTarget } from "../lib/connections";

export type ActiveTargetState = "live" | "testing" | "disconnected";

export interface ActiveTargetPillProps {
  target: ActiveTarget | null;
  state: ActiveTargetState;
}

function stateDotLabel(state: ActiveTargetState): string {
  switch (state) {
    case "live": return "live";
    case "testing": return "testing";
    case "disconnected": return "disconnected";
  }
}

export function ActiveTargetPill({ target, state }: ActiveTargetPillProps) {
  const disconnected = target == null || state === "disconnected";
  const dotState = disconnected ? "disconnected" : state;
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
      <span className="visually-hidden">{stateDotLabel(dotState)}</span>
    </span>
  );
}

import { useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ActiveTargetPill, type ActiveTargetState } from "./ActiveTargetPill";
import { BootstrapStatusOverlay } from "./BootstrapStatusOverlay";
import { LockoutBanner } from "./LockoutBanner";
import { useBootstrapStatus } from "../hooks/useBootstrapStatus";
import { getActiveTarget, type ActiveTarget } from "../lib/connections";
import { PivotBurstContext } from "../context/PivotBurstContext";

const SECTIONS = [
  { to: "/connections", label: "Connections" },
  { to: "/sources", label: "Sources" },
  { to: "/ingest", label: "Ingest" },
  { to: "/pivot", label: "Search" },
  { to: "/calc", label: "Calculation" },
  { to: "/observability", label: "Observability" },
  { to: "/explorer", label: "JSON Explorer" },
] as const;

export interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [target, setTarget] = useState<ActiveTarget | null>(null);
  const [state, setState] = useState<ActiveTargetState>("disconnected");
  const { phase: bootstrapPhase } = useBootstrapStatus();
  const burstCtx = useContext(PivotBurstContext);
  const location = useLocation();
  const burst = burstCtx?.burst ?? null;
  const showBurstPill = burst !== null && location.pathname !== "/pivot";

  const refreshTarget = useCallback(async () => {
    try {
      const t = await getActiveTarget();
      setTarget(t);
      setState("live");
    } catch {
      setTarget(null);
      setState("disconnected");
    }
  }, []);

  useEffect(() => {
    void refreshTarget();
    const onChanged = () => { void refreshTarget(); };
    window.addEventListener("connections:active-changed", onChanged);
    return () => window.removeEventListener("connections:active-changed", onChanged);
  }, [refreshTarget]);

  return (
    <div className="app-shell">
      <header className="app-shell__header" role="banner">
        <span className="app-shell__brand-mark" aria-hidden="true" />
        <span className="app-shell__brand">FRTB SBM</span>
        <span className="app-shell__brand-sub">· on Redis Enterprise</span>
        <div className="app-shell__header-spacer" />
        <ActiveTargetPill target={target} state={state} bootstrapPhase={bootstrapPhase} />
      </header>
      <nav className="app-shell__nav" aria-label="Primary">
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.to}>
              <NavLink
                to={s.to}
                className={({ isActive }) => (isActive ? "is-active" : undefined)}
              >
                {s.label}
              </NavLink>
              {s.to === "/pivot" && showBurstPill && burst !== null && (
                <span
                  className="app-shell__nav-pill"
                  data-testid="pivot-burst-nav-pill"
                  role="status"
                  aria-live="polite"
                  aria-label={`Search burst running, ${burst.done} of ${burst.total}`}
                >
                  {burst.done} / {burst.total}
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="app-shell__nav-brand">
          <img src="/redis-logo.svg" alt="Redis" />
        </div>
      </nav>
      <main className="app-shell__main">
        <BootstrapStatusOverlay />
        <LockoutBanner />
        {children}
      </main>
    </div>
  );
}

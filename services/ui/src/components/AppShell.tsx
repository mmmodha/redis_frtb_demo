import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { ActiveTargetPill, type ActiveTargetState } from "./ActiveTargetPill";
import { LockoutBanner } from "./LockoutBanner";
import { getActiveTarget, type ActiveTarget } from "../lib/connections";

const SECTIONS = [
  { to: "/connections", label: "Connections" },
  { to: "/sources", label: "Sources" },
  { to: "/ingest", label: "Ingest" },
  { to: "/pivot", label: "Pivot" },
  { to: "/calc", label: "Calc" },
  { to: "/observability", label: "Observability" },
] as const;

export interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [target, setTarget] = useState<ActiveTarget | null>(null);
  const [state, setState] = useState<ActiveTargetState>("disconnected");

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
        <ActiveTargetPill target={target} state={state} />
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
            </li>
          ))}
        </ul>
        <div className="app-shell__nav-brand">
          <img src="/redis-logo.svg" alt="Redis" />
        </div>
      </nav>
      <main className="app-shell__main">
        <LockoutBanner />
        {children}
      </main>
    </div>
  );
}

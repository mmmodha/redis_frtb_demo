import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

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
  return (
    <div className="app-shell">
      <header className="app-shell__header" role="banner">
        <span className="app-shell__brand-mark" aria-hidden="true" />
        <span className="app-shell__brand">FRTB SBM</span>
        <span className="app-shell__brand-sub">· on Redis Enterprise</span>
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
      </nav>
      <main className="app-shell__main">{children}</main>
    </div>
  );
}

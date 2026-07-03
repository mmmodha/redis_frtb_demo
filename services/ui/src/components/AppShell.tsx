import { useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ActiveTargetPill, type ActiveTargetState } from "./ActiveTargetPill";
import { BootstrapStatusOverlay } from "./BootstrapStatusOverlay";
import { LockoutBanner } from "./LockoutBanner";
import { useBootstrapStatus } from "../hooks/useBootstrapStatus";
import { getActiveTarget, type ActiveTarget } from "../lib/connections";
import { CalcRunContext } from "../context/CalcRunContext";
import { GeneratorRunContext } from "../context/GeneratorRunContext";
import { PivotBurstContext } from "../context/PivotBurstContext";
import { useIngestRun } from "../hooks/useIngestRun";

const SECTIONS = [
  { to: "/connections", label: "Connections" },
  { to: "/sources", label: "Sources" },
  { to: "/ingest", label: "Ingest" },
  { to: "/pivot", label: "Search" },
  { to: "/calc", label: "Calculation" },
  { to: "/benchmarking", label: "Benchmarking" },
  { to: "/observability", label: "Observability" },
  { to: "/explorer", label: "JSON Explorer" },
  { to: "/admin", label: "Admin" },
] as const;

export interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [target, setTarget] = useState<ActiveTarget | null>(null);
  const [state, setState] = useState<ActiveTargetState>("disconnected");
  const [navOpen, setNavOpen] = useState(false);
  const { phase: bootstrapPhase } = useBootstrapStatus();
  const burstCtx = useContext(PivotBurstContext);
  const generatorCtx = useContext(GeneratorRunContext);
  const calcCtx = useContext(CalcRunContext);
  const { view: ingestView } = useIngestRun();
  const location = useLocation();
  const burst = burstCtx?.burst ?? null;
  const showBurstPill = burst !== null && location.pathname !== "/pivot";
  const generatorRun = generatorCtx?.run ?? null;
  const showGeneratorPill =
    generatorRun !== null &&
    generatorRun.status === "running" &&
    location.pathname !== "/ingest";
  const calcBusy = calcCtx !== null && (calcCtx.perClassLoading || calcCtx.totalLoading);
  const showCalcPill = calcBusy && location.pathname !== "/calc";
  const showIngestPill =
    ingestView.phase === "running" &&
    location.pathname !== "/ingest";

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

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className={`app-shell${navOpen ? " app-shell--nav-open" : ""}`}>
      <header className="app-shell__header" role="banner">
        <button
          type="button"
          className="app-shell__nav-toggle"
          data-testid="app-shell-nav-toggle"
          aria-label={navOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={navOpen}
          aria-controls="app-shell-primary-nav"
          onClick={() => setNavOpen((v) => !v)}
        >
          <span className="app-shell__nav-toggle-icon" aria-hidden="true" />
        </button>
        <span className="app-shell__brand-mark" aria-hidden="true" />
        <span className="app-shell__brand">FRTB SBM</span>
        <span className="app-shell__brand-sub">· on Redis Enterprise</span>
        <div className="app-shell__header-spacer" />
        <ActiveTargetPill target={target} state={state} bootstrapPhase={bootstrapPhase} />
      </header>
      <button
        type="button"
        className="app-shell__nav-backdrop"
        aria-label="Close navigation menu"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
      <nav
        id="app-shell-primary-nav"
        className="app-shell__nav"
        aria-label="Primary"
      >
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.to}>
              <NavLink
                to={s.to}
                className={({ isActive }) => (isActive ? "is-active" : undefined)}
                onClick={() => setNavOpen(false)}
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
              {s.to === "/ingest" && showIngestPill && (
                <span
                  className="app-shell__nav-pill"
                  data-testid="ingest-run-nav-pill"
                  role="status"
                  aria-live="polite"
                  aria-label={`Ingest running, ${ingestView.written} of ${ingestView.total}`}
                >
                  {ingestView.written.toLocaleString("en-US")} / {ingestView.total.toLocaleString("en-US")}
                </span>
              )}
              {s.to === "/ingest" && showGeneratorPill && generatorRun !== null && (
                <span
                  className="app-shell__nav-pill"
                  data-testid="generator-run-nav-pill"
                  role="status"
                  aria-live="polite"
                  aria-label={`Generator running, ${generatorRun.rowsDone} of ${generatorRun.rowsTotal}`}
                >
                  {generatorRun.rowsDone} / {generatorRun.rowsTotal}
                </span>
              )}
              {s.to === "/calc" && showCalcPill && (
                <span
                  className="app-shell__nav-pill"
                  data-testid="calc-run-nav-pill"
                  role="status"
                  aria-live="polite"
                  aria-label="Calculation in progress"
                >
                  Calculating…
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

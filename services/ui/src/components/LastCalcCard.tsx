// Wave 6.01 — "Last Calculation" card on the Observability page. Surfaces
// the most recent /calc/sbm or /calc/sbm/total run from the api's in-memory
// ring buffer so the operator gets concrete telemetry (wall time, engine,
// cache, ops) without bouncing to the SBM Calculator. Click anywhere on the
// card body to expand a 5-row mini-table of prior runs.

import { useState } from "react";
import { PanelCard } from "./PanelCard";
import { MetricTile } from "./MetricTile";
import { humanizeSeconds } from "../routes/Observability";
import type {
  RecentCalcRun,
  RecentCalcRunPerClass,
  RecentCalcRunTotal,
} from "../lib/api";

export interface LastCalcCardProps {
  items: RecentCalcRun[];
  // Parent owns the 1s "now" ticker (mirrors the Updated-Ns-ago badge) so we
  // don't spawn a second timer per card. Passed in so the headline timestamp
  // counts up smoothly between cadence-driven fetches.
  now: number;
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function ago(now: number, ts: string): string {
  const t = new Date(ts).getTime();
  const s = Math.max(0, Math.floor((now - t) / 1000));
  return `${humanizeSeconds(s)} ago`;
}

function headerText(run: RecentCalcRun, now: number): string {
  const when = ago(now, run.ts);
  if (run.kind === "per_class") {
    const base = `${run.risk_class} ${titleCase(run.leg)}`;
    const scenario = run.scenario ? ` · ${titleCase(run.scenario)}` : "";
    return `${base}${scenario} · ${when}`;
  }
  return `Total SBM · ${when}`;
}

function PerClassTiles({ run }: { run: RecentCalcRunPerClass }) {
  return (
    <div className="metric-grid" data-testid="last-calc-tiles-per-class">
      <MetricTile label="Wall time" value={run.total_ms.toFixed(1)} unit="ms" status="live" />
      <MetricTile label="Engine" value={run.engine || "—"} status="live" />
      <MetricTile label="Cache" value={run.cache} status={run.cache === "hit" ? "derived" : "live"} />
      <MetricTile label="Cells evaluated" value={String(run.cells_evaluated)} unit="cells" status="live" />
    </div>
  );
}

function TotalTiles({ run }: { run: RecentCalcRunTotal }) {
  return (
    <div className="metric-grid" data-testid="last-calc-tiles-total">
      <MetricTile label="Wall time" value={run.total_ms.toFixed(1)} unit="ms" status="live" />
      <MetricTile label="Engine" value={run.engine || "orchestrator"} status="live" />
      <MetricTile label="Redis ops" value={String(run.redis_ops_count)} unit="ops" status="live" />
      <MetricTile label="Parallelism" value={`×${run.parallelism_factor}`} status="live" />
    </div>
  );
}

function rowLabel(run: RecentCalcRun): string {
  if (run.kind === "per_class") {
    return run.scenario
      ? `${run.risk_class} ${titleCase(run.leg)} · ${titleCase(run.scenario)}`
      : `${run.risk_class} ${titleCase(run.leg)}`;
  }
  return "Total SBM";
}

export function LastCalcCard({ items, now }: LastCalcCardProps) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return (
      <PanelCard title="Last Calculation">
        <div className="last-calc__empty" data-testid="last-calc-empty" role="status">
          No calculations yet — head to the SBM Calculator to run one.
        </div>
      </PanelCard>
    );
  }
  const headline = items[0]!;
  return (
    <PanelCard title="Last Calculation">
      <button
        type="button"
        className="last-calc__toggle"
        data-testid="last-calc-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="last-calc__header" data-testid="last-calc-header">
          {headerText(headline, now)}
        </div>
        {headline.kind === "per_class"
          ? <PerClassTiles run={headline} />
          : <TotalTiles run={headline} />}
      </button>
      {expanded ? (
        <table className="last-calc__table" data-testid="last-calc-table">
          <thead>
            <tr>
              <th>When</th><th>Kind</th><th>Charge</th><th>Wall time</th><th>Cache</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 5).map((it) => (
              <tr key={it.id}>
                <td>{ago(now, it.ts)}</td>
                <td>{rowLabel(it)}</td>
                <td>{Number.isFinite(it.charge) ? it.charge.toFixed(2) : "—"}</td>
                <td>{it.total_ms.toFixed(1)} ms</td>
                <td>{it.cache}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </PanelCard>
  );
}

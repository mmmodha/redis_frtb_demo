// Wave 6.01 — "Last Calculation" card on the Observability page. Surfaces
// the most recent /calc/sbm or /calc/sbm/total run from the api's in-memory
// ring buffer so the operator gets concrete telemetry (wall time, engine,
// cache, ops) without bouncing to the SBM Calculator. Click anywhere on the
// card body to expand a 5-row mini-table of prior runs.

import { useState } from "react";
import { Link } from "react-router-dom";
import { PanelCard } from "./PanelCard";
import { humanizeSeconds } from "../routes/Observability";
import type {
  RecentCalcRun,
  RecentCalcRunPerClass,
  RecentCalcRunTotal,
} from "../lib/api";

export interface LastCalcCardProps {
  items: RecentCalcRun[];
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

function headerText(run: RecentCalcRunPerClass | RecentCalcRunTotal, now: number): string {
  const when = ago(now, run.ts);
  if (run.kind === "per_class") {
    const base = `${run.risk_class} ${titleCase(run.leg)}`;
    const scenario = run.scenario ? ` · ${titleCase(run.scenario)}` : "";
    return `${base}${scenario} · ${when}`;
  }
  return `Total SBM · ${when}`;
}

function CalcStat(props: { label: string; value: string; unit?: string }): JSX.Element {
  const { label, value, unit } = props;
  return (
    <div className="obs-stat">
      <span className="obs-stat__label">{label}</span>
      <span className="obs-stat__value">
        {value}
        {unit ? <span className="obs-stat__unit">{unit}</span> : null}
      </span>
    </div>
  );
}

function PerClassTiles({ run }: { run: RecentCalcRunPerClass }) {
  return (
    <div className="obs-stat-row last-calc__stats" data-testid="last-calc-tiles-per-class">
      <CalcStat label="Wall time" value={run.total_ms.toFixed(1)} unit="ms" />
      <CalcStat label="Fan-out" value={run.fanout_ms.toFixed(1)} unit="ms" />
      <CalcStat label="Engine" value={run.engine || "—"} />
      <CalcStat label="Cache" value={run.cache} />
      <CalcStat label="Cells" value={String(run.cells_evaluated)} />
    </div>
  );
}

function TotalTiles({ run }: { run: RecentCalcRunTotal }) {
  return (
    <div className="obs-stat-row last-calc__stats" data-testid="last-calc-tiles-total">
      <CalcStat label="Wall time" value={run.total_ms.toFixed(1)} unit="ms" />
      <CalcStat label="Engine" value={run.engine || "orchestrator"} />
      <CalcStat label="Redis ops" value={String(run.redis_ops_count)} />
      <CalcStat label="Parallelism" value={`×${run.parallelism_factor}`} />
    </div>
  );
}

function rowLabel(run: RecentCalcRun): string {
  if (run.kind === "failed") {
    return run.calc_kind === "total"
      ? "failed Total SBM"
      : `failed ${run.risk_class ?? ""} ${run.leg ?? ""}`.trim();
  }
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
  const successItems = items.filter((it) => it.kind !== "failed");
  const headline = successItems[0] ?? items[0]!;
  const headlineIsFailed = headline.kind === "failed";
  return (
    <PanelCard
      title="Last Calculation"
      actions={
        <Link to="/calc" className="btn btn--secondary" data-testid="last-calc-rerun-link">
          Open Calculator
        </Link>
      }
    >
      <button
        type="button"
        className="last-calc__toggle"
        data-testid="last-calc-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="last-calc__header" data-testid="last-calc-header">
          <div className="last-calc__title" title={headlineIsFailed ? headline.error : headerText(headline as RecentCalcRunPerClass | RecentCalcRunTotal, now)}>
            {headlineIsFailed
              ? `Failed ${headline.calc_kind === "total" ? "Total SBM" : `${headline.risk_class ?? ""} ${headline.leg ?? ""}`} · ${ago(now, headline.ts)}`
              : headerText(headline as RecentCalcRunPerClass | RecentCalcRunTotal, now)}
          </div>
          <div className="last-calc__run-id" data-testid="last-calc-run-id">
            <code title={headline.id}>{headline.id}</code>
          </div>
        </div>
        {headlineIsFailed ? (
          <p className="admin-error" role="alert">{headline.error}{headline.request_id ? ` (${headline.request_id})` : ""}</p>
        ) : headline.kind === "per_class"
          ? <PerClassTiles run={headline} />
          : <TotalTiles run={headline} />}
      </button>
      {expanded ? (
        <div className="last-calc__table-wrap">
          <table className="last-calc__table" data-testid="last-calc-table">
            <thead>
              <tr>
                <th>When</th><th>Kind</th><th>Charge</th><th>Wall time</th><th>Fan-out</th><th>Cache</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 10).map((it) => (
                <tr key={it.id}>
                  <td>{ago(now, it.ts)}</td>
                  <td>{it.kind === "failed" ? `failed ${it.calc_kind}` : rowLabel(it)}</td>
                  <td>{it.kind === "failed" ? "—" : Number.isFinite(it.charge) ? it.charge.toFixed(2) : "—"}</td>
                  <td>{it.kind === "failed" ? "—" : `${it.total_ms.toFixed(1)} ms`}</td>
                  <td>{it.kind === "per_class" ? `${it.fanout_ms.toFixed(1)} ms` : "—"}</td>
                  <td>{it.kind === "failed" ? it.error : it.cache}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </PanelCard>
  );
}

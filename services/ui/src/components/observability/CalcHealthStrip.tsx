import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PanelCard } from "../PanelCard";
import { getDriftStatus, type DriftStatusResponse } from "../../lib/admin";

const POLL_MS = 10_000;

export function CalcHealthStrip(): JSX.Element {
  const [data, setData] = useState<DriftStatusResponse | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getDriftStatus()
        .then((d) => { if (!cancelled) setData(d); })
        .catch(() => { /* keep last */ });
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const driftCount = data?.results.filter((r) => r.status === "drift").length ?? 0;
  const recent = data?.results.slice(-5).reverse() ?? [];

  return (
    <PanelCard
      title="Calc drift"
      actions={<Link to="/admin" className="btn btn--secondary">Reconcile</Link>}
    >
      <div className="obs-calc-health" data-testid="calc-health-strip">
        <button
          type="button"
          className="obs-calc-health__toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className={driftCount > 0 ? "pill pill--err" : "pill pill--ok"} data-testid="calc-drift-count">
            {driftCount > 0 ? `${driftCount} drift` : "All clear"}
          </span>
          <span className="obs-calc-health__hint">
            {data ? `${data.results.length} bucket checks recorded` : "Loading drift status…"}
          </span>
        </button>
        {expanded && recent.length > 0 ? (
          <table className="admin-table obs-calc-health__table" data-testid="calc-drift-mini-table">
            <thead>
              <tr><th>When</th><th>Class</th><th>Bucket</th><th>Drift</th><th>Status</th></tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.ts}-${i}`}>
                  <td>{r.ts.replace("T", " ").slice(0, 19)}</td>
                  <td>{r.risk_class}</td>
                  <td>{r.bucket}</td>
                  <td>{(r.drift_pct * 100).toFixed(2)}%</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : expanded ? (
          <p className="obs-calc-health__empty">No drift checks yet — run a calc or open Admin to reconcile.</p>
        ) : null}
      </div>
    </PanelCard>
  );
}

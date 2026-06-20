// Wave 6.41.D — Top-N desks panel ranked by |contribution to K_b|. Fetches
// POST /calc/sbm/by-desk on (riskClass, sensitivityType, …) change and
// renders a bar chart over the constant-ρ per-desk K_b approximation. The
// per-desk K_b is NOT Basel-exact (precision contract lives in
// services/api/src/sbm/by-desk.ts) — suitable for ranking, not reporting.

import { useEffect, useState, type KeyboardEvent } from "react";
import { PanelCard } from "./PanelCard";
import {
  postCalcSbmByDesk,
  type CalcSbmByDeskRow,
  type CorrelationRegime,
  type SensitivityType,
} from "../lib/calc";
import { formatCharge } from "../lib/format";
import "./CalcByDesk.css";

export interface CalcByDeskProps {
  riskClass: string;
  sensitivityType: SensitivityType;
  correlationRegime?: CorrelationRegime;
  topN?: number;
  include?: { book?: string[]; desk?: string[] };
  exclude?: { book?: string[]; trade_id?: string[]; risk_factor?: string[] };
  // Optional click handler — when omitted the rows render non-interactive.
  onDeskClick?: (desk: string) => void;
}

export function CalcByDesk(props: CalcByDeskProps) {
  const {
    riskClass,
    sensitivityType,
    correlationRegime,
    topN = 10,
    include,
    exclude,
    onDeskClick,
  } = props;

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<CalcSbmByDeskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!riskClass) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    postCalcSbmByDesk({
      risk_class: riskClass,
      sensitivity_type: sensitivityType,
      ...(correlationRegime ? { correlation_regime: correlationRegime } : {}),
      ...(topN !== 10 ? { top_n: topN } : {}),
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
    })
      .then((r) => {
        if (cancelled) return;
        setRows(Array.isArray(r?.desks) ? r.desks : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setRows(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [riskClass, sensitivityType, correlationRegime, topN, include, exclude]);

  return (
    <PanelCard title={`Top ${topN} desks by K_b contribution`}>
      <p className="calc-by-desk__lead">
        Per-desk K_b uses a constant-ρ single-aggregate approximation — suitable
        for ranking, not for the Basel-exact desk-level charge.
      </p>
      {loading ? <CalcByDeskSkeleton topN={topN} /> : null}
      {error ? (
        <div role="alert" className="calc-by-desk__error" data-testid="calc-by-desk-error">
          {error}
        </div>
      ) : null}
      {!loading && !error && rows !== null ? (
        rows.length === 0 ? (
          <p className="calc-by-desk__empty" data-testid="calc-by-desk-empty">
            No desk data yet
          </p>
        ) : (
          <CalcByDeskChart rows={rows} onDeskClick={onDeskClick} />
        )
      ) : null}
    </PanelCard>
  );
}

function CalcByDeskSkeleton({ topN }: { topN: number }) {
  const rows = Math.min(Math.max(topN, 1), 10);
  return (
    <div
      className="calc-by-desk__skeleton"
      aria-busy="true"
      aria-label="Loading top desks"
      data-testid="calc-by-desk-skeleton"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="calc-by-desk__skeleton-row" aria-hidden />
      ))}
    </div>
  );
}

function CalcByDeskChart({
  rows,
  onDeskClick,
}: {
  rows: CalcSbmByDeskRow[];
  onDeskClick?: (desk: string) => void;
}) {
  const maxK = Math.max(...rows.map((r) => r.K_b), 1);
  const interactive = typeof onDeskClick === "function";
  return (
    <div className="calc-by-desk__chart" role="list" data-testid="calc-by-desk-chart">
      {rows.map((r) => {
        const fill = Math.max(r.K_b / maxK, 0.02);
        const handle = () => {
          if (onDeskClick) onDeskClick(r.desk);
        };
        const interactiveProps = interactive
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-label": `Add desk ${r.desk} to filter`,
              onClick: handle,
              onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handle();
                }
              },
            }
          : { role: "listitem" as const };
        return (
          <div
            key={r.desk}
            className="calc-by-desk__row"
            data-testid="calc-by-desk-row"
            data-desk={r.desk}
            data-interactive={interactive ? "true" : "false"}
            {...interactiveProps}
          >
            <span className="calc-by-desk__name">{r.desk}</span>
            <div className="calc-by-desk__bar" aria-hidden="true">
              <div
                className="calc-by-desk__bar-fill"
                style={{ transform: `scaleX(${fill})` }}
              />
            </div>
            <span className="calc-by-desk__value">{formatCharge(r.K_b)}</span>
            <span className="calc-by-desk__meta">
              {r.contribution_pct.toFixed(1)}% · {r.count} sens
            </span>
          </div>
        );
      })}
    </div>
  );
}

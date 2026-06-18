// Wave 6.39.D — CalcCoverageCard surfaces GET /admin/calc-coverage as a
// sortable + searchable table. The summary header gives operators an
// at-a-glance feel for "how much rollup data is materialised" and the
// per-row pill makes missing buckets pop visually.

import { useEffect, useMemo, useState } from "react";
import { PanelCard } from "./PanelCard";
import { getCalcCoverage, type CalcCoverageResponse, type CoverageRow } from "../lib/admin";

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: CalcCoverageResponse }
  | { kind: "error"; message: string };

type SortKey = "risk_class" | "bucket" | "sens_type" | "present" | "count";
type SortDir = "asc" | "desc";

function compareRows(a: CoverageRow, b: CoverageRow, key: SortKey, dir: SortDir): number {
  const sign = dir === "asc" ? 1 : -1;
  switch (key) {
    case "risk_class": return sign * a.risk_class.localeCompare(b.risk_class);
    case "bucket": return sign * a.bucket.localeCompare(b.bucket, undefined, { numeric: true });
    case "sens_type": return sign * a.sens_type.localeCompare(b.sens_type);
    case "present": return sign * (Number(a.rollup_present) - Number(b.rollup_present));
    case "count": return sign * (a.sens_doc_count - b.sens_doc_count);
  }
}

export function CalcCoverageCard() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [query, setQuery] = useState("");
  // Default present-sort ascending so the first click (-> desc) lands the
  // missing rows (rollup_present=false, numerically 0) at the top.
  const [sortKey, setSortKey] = useState<SortKey>("present");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    let cancelled = false;
    getCalcCoverage()
      .then((data) => { if (!cancelled) setState({ kind: "ready", data }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => { cancelled = true; };
  }, []);

  const filteredSorted = useMemo(() => {
    if (state.kind !== "ready") return [];
    const q = query.trim().toLowerCase();
    const rows = q
      ? state.data.coverage.filter((r) =>
          r.risk_class.toLowerCase().includes(q) ||
          r.bucket.toLowerCase().includes(q) ||
          r.sens_type.toLowerCase().includes(q),
        )
      : state.data.coverage.slice();
    rows.sort((a, b) => compareRows(a, b, sortKey, sortDir));
    return rows;
  }, [state, query, sortKey, sortDir]);

  function toggleSort(next: SortKey) {
    if (next === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(next);
      setSortDir("asc");
    }
  }

  if (state.kind === "loading") {
    return (
      <PanelCard title="Calc Coverage">
        <div className="admin-skeleton" data-testid="calc-coverage-skeleton" role="status" aria-label="Loading calc coverage" />
      </PanelCard>
    );
  }
  if (state.kind === "error") {
    return (
      <PanelCard title="Calc Coverage">
        <div className="admin-error" role="alert">Failed to load calc coverage — {state.message}</div>
      </PanelCard>
    );
  }
  if (state.data.coverage.length === 0) {
    return (
      <PanelCard title="Calc Coverage">
        <div className="admin-empty" data-testid="calc-coverage-empty" role="status">
          No calc coverage yet — run a calculation to materialise rollups.
        </div>
      </PanelCard>
    );
  }

  const { summary } = state.data;
  return (
    <PanelCard title="Calc Coverage">
      <div className="admin-summary" data-testid="calc-coverage-summary">
        <span><strong>{summary.total}</strong> buckets</span>
        <span className="pill pill--ok"><strong>{summary.present}</strong>&nbsp;present</span>
        <span className={summary.missing > 0 ? "pill pill--err" : "pill"}>
          <strong>{summary.missing}</strong>&nbsp;missing
        </span>
      </div>
      <div className="admin-toolbar">
        <input
          type="search"
          className="admin-search"
          placeholder="Filter risk class / bucket / type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="calc-coverage-search"
          aria-label="Filter calc coverage"
        />
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table" data-testid="calc-coverage-table">
          <thead>
            <tr>
              <th><button type="button" className="admin-th" onClick={() => toggleSort("risk_class")}>Risk class</button></th>
              <th><button type="button" className="admin-th" onClick={() => toggleSort("bucket")}>Bucket</button></th>
              <th><button type="button" className="admin-th" onClick={() => toggleSort("sens_type")}>Sens type</button></th>
              <th>
                <button
                  type="button"
                  className="admin-th"
                  data-testid="calc-coverage-sort-present"
                  onClick={() => toggleSort("present")}
                >
                  Rollup
                </button>
              </th>
              <th><button type="button" className="admin-th" onClick={() => toggleSort("count")}>Sens docs</button></th>
            </tr>
          </thead>
          <tbody>
            {filteredSorted.map((r) => (
              <tr key={`${r.risk_class}|${r.bucket}|${r.sens_type}`}>
                <td>{r.risk_class}</td>
                <td>{r.bucket}</td>
                <td>{r.sens_type}</td>
                <td>
                  <span className={r.rollup_present ? "pill pill--ok" : "pill pill--err"}>
                    {r.rollup_present ? "present" : "missing"}
                  </span>
                </td>
                <td>{r.sens_doc_count.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelCard>
  );
}

import { Fragment, useMemo, useState } from "react";
import { PanelCard } from "../components/PanelCard";
import { apiBase } from "../lib/api";
import {
  EmptyTargetError,
  checkEmptyTargetError,
  readErrorBody,
} from "../lib/empty-target";
import type { PivotResp, PivotRow } from "../lib/pivot";
import { useFacets } from "../hooks/useFacets";
import { bucketOptions, riskClassOptions, sensitivityTypeOptions } from "../lib/facet-options";

const PAGE_SIZES = [10, 25, 100] as const;

export function JsonExplorerPanel(): JSX.Element {
  const [riskClass, setRiskClass] = useState<string>("");
  const [bucket, setBucket] = useState<string>("");
  const [sensType, setSensType] = useState<string>("");
  const [book, setBook] = useState<string>("");
  const [tradeId, setTradeId] = useState<string>("");
  const [limit, setLimit] = useState<number>(25);
  const [offset, setOffset] = useState<number>(0);
  const [keyContains, setKeyContains] = useState<string>("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyError, setEmptyError] = useState<EmptyTargetError | null>(null);
  const [result, setResult] = useState<PivotResp | null>(null);

  // Wave 5.56 — facet-driven dropdowns; fall back to static lists when the
  // /facets call errors or the index is empty.
  const { facets } = useFacets();
  const riskClasses = useMemo(() => riskClassOptions(facets), [facets]);
  const buckets = useMemo(() => bucketOptions(facets, riskClass), [facets, riskClass]);
  const sensTypes = useMemo(() => sensitivityTypeOptions(facets), [facets]);

  function onRiskClassChange(next: string): void {
    setRiskClass(next);
    setBucket("");
  }

  async function runAt(nextOffset: number): Promise<void> {
    setError(null);
    setEmptyError(null);
    setLoading(true);
    const params = new URLSearchParams();
    if (riskClass) params.set("risk_class", riskClass);
    if (bucket) params.set("bucket", bucket);
    if (sensType) params.set("sensitivity_type", sensType);
    if (book) params.set("book", book);
    if (tradeId) params.set("trade_id", tradeId);
    params.set("limit", String(limit));
    params.set("offset", String(nextOffset));
    const url = `${apiBase().replace(/\/$/, "")}/pivot?${params.toString()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const friendly = checkEmptyTargetError(res.status, await readErrorBody(res));
        if (friendly) throw friendly;
        throw new Error(`Explorer failed (HTTP ${res.status})`);
      }
      const body = (await res.json()) as PivotResp;
      setResult(body);
      setOffset(nextOffset);
      setExpanded({});
    } catch (e) {
      if (e instanceof EmptyTargetError) {
        setEmptyError(e);
      } else {
        const msg = e instanceof Error ? e.message : "Failed to load documents";
        setError(msg);
      }
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    void runAt(0);
  }

  function toggle(key: string): void {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const filteredRows = useMemo<PivotRow[]>(() => {
    if (!result) return [];
    const q = keyContains.trim().toLowerCase();
    if (q === "") return result.rows;
    return result.rows.filter((r) => r.key.toLowerCase().includes(q));
  }, [result, keyContains]);

  const hasPrev = result !== null && offset > 0;
  const hasNext = result !== null && offset + result.rows.length < result.total;

  return (
    <div className="json-explorer-panel">
      <h1>JSON Explorer</h1>

      <PanelCard
        title="Filters"
        actions={
          <button type="button" onClick={() => void runAt(0)} disabled={loading}>
            {loading ? "Loading…" : "Run query"}
          </button>
        }
      >
        <form onSubmit={onSubmit} className="json-explorer-filters">
          <label htmlFor="je-risk-class">Risk class</label>
          <select
            id="je-risk-class"
            aria-label="Risk class"
            value={riskClass}
            onChange={(e) => onRiskClassChange(e.target.value)}
          >
            <option value="">All risk classes</option>
            {riskClasses.map((r) => (
              <option key={r.value} value={r.value}>{r.value}</option>
            ))}
          </select>
          <label htmlFor="je-bucket">Bucket</label>
          <select
            id="je-bucket"
            aria-label="Bucket"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            disabled={buckets.length === 0}
          >
            <option value="">{buckets.length === 0 ? "Pick a class first" : "All buckets"}</option>
            {buckets.map((b) => (
              <option key={b.value} value={b.value}>{b.value}</option>
            ))}
          </select>
          <label htmlFor="je-sensitivity-type">Sensitivity type</label>
          <select
            id="je-sensitivity-type"
            aria-label="Sensitivity type"
            value={sensType}
            onChange={(e) => setSensType(e.target.value)}
          >
            <option value="">All sensitivity types</option>
            {sensTypes.map((s) => (
              <option key={s.value} value={s.value}>{s.value}</option>
            ))}
          </select>
          <label htmlFor="je-book">Book</label>
          <input
            id="je-book"
            aria-label="Book"
            type="text"
            value={book}
            onChange={(e) => setBook(e.target.value)}
            placeholder="e.g. RATES-LDN"
          />
          <label htmlFor="je-trade-id">Trade ID</label>
          <input
            id="je-trade-id"
            aria-label="Trade ID"
            type="text"
            value={tradeId}
            onChange={(e) => setTradeId(e.target.value)}
            placeholder="e.g. T-12345"
          />
          <label htmlFor="je-page-size">Page size</label>
          <select
            id="je-page-size"
            aria-label="Page size"
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10) || 25)}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </form>
      </PanelCard>

      {emptyError !== null && (
        <div
          role="status"
          className="panel-callout panel-callout--amber"
          data-testid="empty-target-banner"
          data-kind={emptyError.status === 412 ? "bootstrap" : "no-data"}
        >
          {emptyError.status === 412 ? (
            <>
              Bootstrapping <strong>{emptyError.target_label ?? "this target"}</strong>
              {emptyError.bootstrap_phase ? <> — {emptyError.bootstrap_phase}</> : null}.
              Explorer will be available once it's ready.
            </>
          ) : (
            <>
              No sensitivities indexed yet — head to Sources to ingest
              {emptyError.hint ? <> ({emptyError.hint})</> : null}.
            </>
          )}
        </div>
      )}

      {error !== null && (
        <div role="alert" className="json-explorer-error">{error}</div>
      )}

      {result !== null && result.rows.length === 0 && error === null && (
        <PanelCard title="Documents">
          <p>No documents match these filters.</p>
        </PanelCard>
      )}

      {result !== null && result.rows.length > 0 && (
        <PanelCard
          title="Documents"
          actions={
            <span data-testid="explorer-summary">
              Showing {filteredRows.length} of {result.total}
            </span>
          }
        >
          <div className="json-explorer-keyfilter">
            <label htmlFor="je-key-contains">Key contains</label>
            <input
              id="je-key-contains"
              aria-label="Key contains"
              type="text"
              value={keyContains}
              onChange={(e) => setKeyContains(e.target.value)}
              placeholder="substring filter"
            />
          </div>
          <table aria-label="Explorer results" className="json-explorer-table">
            <thead>
              <tr>
                <th aria-label="Expand" />
                <th>Key</th>
                <th>Risk class</th>
                <th>Bucket</th>
                <th>Sensitivity</th>
                <th>Book</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const open = !!expanded[r.key];
                return (
                  <Fragment key={r.key}>
                    <tr data-testid="explorer-row">
                      <td>
                        <button
                          type="button"
                          className="json-explorer-toggle"
                          aria-label={open ? `Collapse ${r.key}` : `Expand ${r.key}`}
                          aria-expanded={open}
                          onClick={() => toggle(r.key)}
                        >
                          {open ? "▼" : "▶"}
                        </button>
                      </td>
                      <td><code>{r.key}</code></td>
                      <td>{String(r.doc.risk_class ?? "")}</td>
                      <td>{String(r.doc.bucket ?? "")}</td>
                      <td>{String(r.doc.sensitivity_type ?? "")}</td>
                      <td>{String(r.doc.book ?? "")}</td>
                    </tr>
                    {open && (
                      <tr className="json-explorer-docrow">
                        <td />
                        <td colSpan={5}>
                          <pre className="json-explorer-doc" data-testid="explorer-doc">
                            {JSON.stringify(r.doc, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="json-explorer-pagination">
            <button
              type="button"
              onClick={() => void runAt(Math.max(0, offset - limit))}
              disabled={!hasPrev || loading}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => void runAt(offset + limit)}
              disabled={!hasNext || loading}
            >
              Next
            </button>
          </div>
        </PanelCard>
      )}
    </div>
  );
}

export default JsonExplorerPanel;

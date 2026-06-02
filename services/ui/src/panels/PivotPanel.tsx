import { useMemo, useState } from "react";
import { PanelCard } from "../components/PanelCard";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { LatencyStrip } from "../components/LatencyStrip";
import { SuggestCombobox } from "../components/SuggestCombobox";
import { apiBase } from "../lib/api";
import {
  EmptyTargetError,
  checkEmptyTargetError,
  readErrorBody,
} from "../lib/empty-target";
import type { PivotResp } from "../lib/pivot";
import { BUCKETS_BY_RISK_CLASS, RISK_CLASSES, SENSITIVITY_TYPES } from "../lib/buckets";
import { usePivotBurst } from "../context/PivotBurstContext";
import { usePivotHistory } from "../context/PivotHistoryContext";

const DEFAULT_LIMIT = 100;

export function PivotPanel(): JSX.Element {
  const [riskClass, setRiskClass] = useState<string>("");
  const [bucket, setBucket] = useState<string>("");
  const [sensType, setSensType] = useState<string>("");
  const [book, setBook] = useState<string>("");
  const [tradeId, setTradeId] = useState<string>("");
  const [riskFactor, setRiskFactor] = useState<string>("");
  const [fuzzy, setFuzzy] = useState<boolean>(true);
  const limit = DEFAULT_LIMIT;
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyError, setEmptyError] = useState<EmptyTargetError | null>(null);
  // Wave 5.22 — result/serverMs/clientMs/offset live in the global
  // PivotHistoryContext so the strip chart survives route changes.
  const { result, serverMs, clientMs, offset, push, setOffset, reset } = usePivotHistory();
  // Wave 5.21g — burst lives in the global PivotBurstContext so the loop
  // survives route changes (and AppShell can render a nav pill).
  const { burst, startBurst } = usePivotBurst();

  const buckets = useMemo<string[]>(() => BUCKETS_BY_RISK_CLASS[riskClass] ?? [], [riskClass]);

  function onRiskClassChange(next: string): void {
    setRiskClass(next);
    setBucket("");
  }

  async function runAt(nextOffset: number): Promise<boolean> {
    setError(null);
    setEmptyError(null);
    setLoading(true);
    const params = new URLSearchParams();
    if (riskClass) params.set("risk_class", riskClass);
    if (bucket) params.set("bucket", bucket);
    if (sensType) params.set("sensitivity_type", sensType);
    if (book) params.set("book", book);
    if (tradeId) params.set("trade_id", tradeId);
    if (riskFactor) params.set("risk_factor", riskFactor);
    params.set("limit", String(limit));
    params.set("offset", String(nextOffset));
    const url = `${apiBase().replace(/\/$/, "")}/pivot?${params.toString()}`;
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      const t1 = performance.now();
      if (!res.ok) {
        // Wave 5.16z3: 412/503 with the api's friendly empty-data shape are
        // not real failures — surface them as an amber banner instead.
        const friendly = checkEmptyTargetError(res.status, await readErrorBody(res));
        if (friendly) throw friendly;
        throw new Error(`Search failed (HTTP ${res.status})`);
      }
      const body = (await res.json()) as PivotResp;
      setOffset(nextOffset);
      push(body.ms, Math.round((t1 - t0) * 1000) / 1000, body);
      return true;
    } catch (e) {
      if (e instanceof EmptyTargetError) {
        setEmptyError(e);
      } else {
        const msg = e instanceof Error ? e.message : "Failed to load search";
        setError(msg);
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    void runAt(0);
  }

  function runBurst(n: number): void {
    setError(null);
    setEmptyError(null);
    // Snapshot filter values at click time so mid-burst edits don't leak in.
    const filters = {
      risk_class: riskClass,
      bucket,
      sensitivity_type: sensType,
      book,
      trade_id: tradeId,
      risk_factor: riskFactor,
      limit,
      offset: 0,
    };
    startBurst({
      total: n,
      filters,
      onIteration: (body, ms) => {
        setOffset(0);
        push(body.ms, ms, body);
      },
      onError: (err) => {
        if (err instanceof EmptyTargetError) {
          setEmptyError(err);
        } else {
          setError(err.message || "Failed to load search");
        }
      },
    });
  }

  const hasPrev = result !== null && offset > 0;
  const hasNext = result !== null && offset + result.rows.length < result.total;

  return (
    <div className="pivot-panel">
      <h1>Search</h1>
      <EnterpriseCallout signal="RedisQueryEngine">
        Sub-100ms FT.SEARCH across millions of native-JSON sensitivity docs — no flattening, no JOIN tax.
      </EnterpriseCallout>

      <PanelCard
        title="Filters"
        actions={
          <>
            <button
              type="button"
              className={`pivot-fuzzy-toggle ${fuzzy ? "is-on" : "is-off"}`}
              data-testid="pivot-fuzzy-toggle"
              aria-pressed={fuzzy}
              onClick={() => setFuzzy((v) => !v)}
            >
              <span data-testid="pivot-fuzzy-hint">Fuzzy: {fuzzy ? "on" : "off"}</span>
            </button>
            <button type="button" onClick={() => void runAt(0)} disabled={loading || burst !== null}>
              {loading || burst !== null ? "Running…" : "Run query"}
            </button>
            <button type="button" onClick={() => runBurst(100)} disabled={loading || burst !== null}>
              {burst !== null ? `Running ${burst.done} / ${burst.total}…` : "Run 100x"}
            </button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="pivot-filters">
          <label htmlFor="pivot-risk-class">Risk class</label>
          <select
            id="pivot-risk-class"
            aria-label="Risk class"
            value={riskClass}
            onChange={(e) => onRiskClassChange(e.target.value)}
          >
            <option value="">All risk classes</option>
            {RISK_CLASSES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <label htmlFor="pivot-bucket">Bucket</label>
          <select
            id="pivot-bucket"
            aria-label="Bucket"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            disabled={buckets.length === 0}
          >
            <option value="">{buckets.length === 0 ? "Pick a class first" : "All buckets"}</option>
            {buckets.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <label htmlFor="pivot-sensitivity-type">Sensitivity type</label>
          <select
            id="pivot-sensitivity-type"
            aria-label="Sensitivity type"
            value={sensType}
            onChange={(e) => setSensType(e.target.value)}
          >
            {SENSITIVITY_TYPES.map((s) => (
              <option key={s || "_all"} value={s}>{s || "All sensitivity types"}</option>
            ))}
          </select>
          <label htmlFor="pivot-book">Book</label>
          <SuggestCombobox
            field="book"
            id="pivot-book"
            value={book}
            onChange={setBook}
            placeholder="e.g. RATES-LDN"
            fuzzy={fuzzy}
          />
          <label htmlFor="pivot-trade-id">Trade ID</label>
          <SuggestCombobox
            field="trade_id"
            id="pivot-trade-id"
            value={tradeId}
            onChange={setTradeId}
            placeholder="e.g. T0042"
            fuzzy={fuzzy}
          />
          <label htmlFor="pivot-risk-factor">Risk factor</label>
          <SuggestCombobox
            field="risk_factor"
            id="pivot-risk-factor"
            value={riskFactor}
            onChange={setRiskFactor}
            placeholder="e.g. RF_GIRR_05"
            fuzzy={fuzzy}
          />
        </form>
      </PanelCard>

      {burst !== null && (
        <div className="pivot-burst" data-testid="pivot-burst-progress">
          <div
            className="pivot-burst__bar"
            role="progressbar"
            aria-label="Burst progress"
            aria-valuemin={0}
            aria-valuemax={burst.total}
            aria-valuenow={burst.done}
          >
            <div
              className="pivot-burst__fill"
              style={{ width: `${burst.total > 0 ? (burst.done / burst.total) * 100 : 0}%` }}
            />
          </div>
          <span className="pivot-burst__label" aria-live="polite">
            Running {burst.done} / {burst.total}…
          </span>
        </div>
      )}

      {result !== null && result.ms < 100 && (
        <div data-testid="sub-100ms-callout" className="pivot-sub100" role="status">
          <strong>Sub-100ms</strong> on Redis Enterprise — last search returned in <strong>{result.ms}</strong> ms.
        </div>
      )}

      <PanelCard
        title="Latency strip (last 100 runs)"
        actions={
          <button
            type="button"
            onClick={reset}
            aria-label="Reset latency history"
            className="latency-strip__reset"
          >
            Reset
          </button>
        }
      >
        <LatencyStrip server={serverMs} client={clientMs} />
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
              Search will be available once it's ready.
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
        <div role="alert" className="pivot-error">{error}</div>
      )}

      {result !== null && result.rows.length === 0 && error === null && (
        <PanelCard title="Results">
          <p>No sensitivities match these filters.</p>
        </PanelCard>
      )}

      {result !== null && result.rows.length > 0 && (
        <PanelCard
          title="Results"
          actions={
            <span data-testid="results-summary">
              Showing {result.rows.length} of {result.total}
            </span>
          }
        >
          <table aria-label="Search results" className="pivot-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Risk class</th>
                <th>Bucket</th>
                <th>Sensitivity</th>
                <th>Book</th>
                <th>Trade</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.key}>
                  <td><code>{r.key}</code></td>
                  <td>{String(r.doc.risk_class ?? "")}</td>
                  <td>{String(r.doc.bucket ?? "")}</td>
                  <td>{String(r.doc.sensitivity_type ?? "")}</td>
                  <td>{String(r.doc.book ?? "")}</td>
                  <td>{String(r.doc.trade_id ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pivot-pagination">
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

export default PivotPanel;

import { useMemo, useState } from "react";
import { PanelCard } from "../components/PanelCard";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { MetricTile } from "../components/MetricTile";
import { apiBase } from "../lib/api";

const RISK_CLASSES = [
  "GIRR",
  "Equity",
  "FX",
  "Commodity",
  "CSR-nonsec",
  "CSR-sec-nonctp",
  "CSR-sec-ctp",
] as const;

const BUCKETS_BY_RISK_CLASS: Record<string, string[]> = {
  GIRR: ["USD-IRS", "EUR-IRS", "GBP-IRS", "JPY-IRS", "CHF-IRS", "CAD-IRS", "AUD-IRS", "CNY-IRS", "HKD-IRS"],
  Equity: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13"],
  FX: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "USDHKD"],
  Commodity: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11"],
  "CSR-nonsec": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "B12", "B13", "B14", "B15", "B16"],
  "CSR-sec-nonctp": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"],
  "CSR-sec-ctp": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"],
};

const SENSITIVITY_TYPES = ["", "Delta", "Vega", "Curvature"] as const;
const DEFAULT_LIMIT = 100;
const HIST_WINDOW = 100;

type PivotRow = { key: string; doc: Record<string, unknown> };
type PivotResp = { total: number; limit: number; offset: number; ms: number; rows: PivotRow[] };

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round((sorted[idx] ?? 0) * 1000) / 1000;
}

export function PivotPanel(): JSX.Element {
  const [riskClass, setRiskClass] = useState<string>("");
  const [bucket, setBucket] = useState<string>("");
  const [sensType, setSensType] = useState<string>("");
  const [book, setBook] = useState<string>("");
  const [offset, setOffset] = useState<number>(0);
  const limit = DEFAULT_LIMIT;
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PivotResp | null>(null);
  const [serverMs, setServerMs] = useState<number[]>([]);
  const [clientMs, setClientMs] = useState<number[]>([]);

  const buckets = useMemo<string[]>(() => BUCKETS_BY_RISK_CLASS[riskClass] ?? [], [riskClass]);

  function onRiskClassChange(next: string): void {
    setRiskClass(next);
    setBucket("");
  }

  async function runAt(nextOffset: number): Promise<void> {
    setError(null);
    setLoading(true);
    const params = new URLSearchParams();
    if (riskClass) params.set("risk_class", riskClass);
    if (bucket) params.set("bucket", bucket);
    if (sensType) params.set("sensitivity_type", sensType);
    if (book) params.set("book", book);
    params.set("limit", String(limit));
    params.set("offset", String(nextOffset));
    const url = `${apiBase().replace(/\/$/, "")}/pivot?${params.toString()}`;
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      const t1 = performance.now();
      if (!res.ok) {
        throw new Error(`Pivot failed (HTTP ${res.status})`);
      }
      const body = (await res.json()) as PivotResp;
      setResult(body);
      setOffset(nextOffset);
      setServerMs((prev) => [...prev.slice(-(HIST_WINDOW - 1)), body.ms]);
      setClientMs((prev) => [...prev.slice(-(HIST_WINDOW - 1)), Math.round((t1 - t0) * 1000) / 1000]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load pivot";
      setError(msg);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    void runAt(0);
  }

  async function runBurst(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await runAt(0);
    }
  }

  const hasPrev = result !== null && offset > 0;
  const hasNext = result !== null && offset + result.rows.length < result.total;

  return (
    <div className="pivot-panel">
      <h1>Pivot</h1>
      <EnterpriseCallout signal="RedisQueryEngine">
        Sub-100ms FT.SEARCH across millions of native-JSON sensitivity docs — no flattening, no JOIN tax.
      </EnterpriseCallout>

      <PanelCard
        title="Filters"
        actions={
          <>
            <button type="button" onClick={() => void runAt(0)} disabled={loading}>
              {loading ? "Running…" : "Run query"}
            </button>
            <button type="button" onClick={() => void runBurst(100)} disabled={loading}>
              Run 100x
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
          <input
            id="pivot-book"
            aria-label="Book"
            type="text"
            value={book}
            onChange={(e) => setBook(e.target.value)}
            placeholder="e.g. RATES-LDN"
          />
        </form>
      </PanelCard>

      {result !== null && result.ms < 100 && (
        <div data-testid="sub-100ms-callout" className="pivot-sub100" role="status">
          <strong>Sub-100ms</strong> on Redis Enterprise — last pivot returned in <strong>{result.ms}</strong> ms.
        </div>
      )}

      <PanelCard title="Latency histogram (last 100 runs)">
        <div data-testid="latency-histogram" className="pivot-latency">
          <p className="pivot-latency__last">
            {result ? <>Last query: <strong>{result.ms}</strong> ms (server-reported)</> : <em>No runs yet.</em>}
          </p>
          <div className="pivot-latency__grid">
            <MetricTile label="server p50" value={percentile(serverMs, 50)} unit="ms" />
            <MetricTile label="server p95" value={percentile(serverMs, 95)} unit="ms" />
            <MetricTile label="server p99" value={percentile(serverMs, 99)} unit="ms" />
            <MetricTile label="client p50" value={percentile(clientMs, 50)} unit="ms" />
            <MetricTile label="client p95" value={percentile(clientMs, 95)} unit="ms" />
            <MetricTile label="client p99" value={percentile(clientMs, 99)} unit="ms" />
          </div>
        </div>
      </PanelCard>

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
          <table aria-label="Pivot results" className="pivot-table">
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

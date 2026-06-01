import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { MetricTile } from "../components/MetricTile";
import { PanelCard } from "../components/PanelCard";
import {
  getObservabilityKeys,
  getObservabilityMemory,
  type ObservabilityKeysResponse,
  type ObservabilityMemoryResponse,
} from "../lib/api";
import {
  listSources,
  startGeneratorStream,
  startIngest,
  type GeneratorConfig,
  type GeneratorStreamHandle,
  type ProgressFrame,
  type Source,
  type TerminalFrame,
} from "../lib/ingest";

// Wave 5.20a — defensive fallback when dbsize=0 (no rows yet) so the sanity
// check still produces a meaningful estimate. ~1.5 KB/row is the smoke-run-12
// observed average for sens:{class:bucket}:{ulid} JSON docs.
const FALLBACK_BYTES_PER_ROW = 1500;

// Wave 5.17b — synthetic generator form domain. Risk classes and sensitivity
// types mirror services/api/src/routes/generator.ts DEFAULT_CLASSES /
// DEFAULT_SENSITIVITY_TYPES; "Curvature" is opt-in (Equity, FX only).
const GENERATOR_CLASSES = ["GIRR", "Equity", "FX"] as const;
const GENERATOR_SENS_TYPES = ["Delta", "Vega", "Curvature"] as const;
const DEFAULT_GEN_ROWS = 200;
const DEFAULT_GEN_FACTOR_POOL = 16;

const POLL_MS = 1000;
const MAX_SAMPLES = 60;

interface ChartSample { t: number; v: number }

function chartPath(samples: ChartSample[], width: number, height: number): { line: string; area: string } {
  if (samples.length < 2) return { line: "", area: "" };
  const xs = samples.map((s) => s.t);
  const ys = samples.map((s) => s.v);
  const xMin = xs[0]!;
  const xMax = xs[xs.length - 1]!;
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 1);
  const dx = xMax - xMin || 1;
  const dy = yMax - yMin || 1;
  const px = (t: number) => ((t - xMin) / dx) * width;
  const py = (v: number) => height - ((v - yMin) / dy) * (height - 4) - 2;
  const points = samples.map((s) => `${px(s.t).toFixed(2)},${py(s.v).toFixed(2)}`);
  const line = `M ${points.join(" L ")}`;
  const area = `${line} L ${px(xMax).toFixed(2)},${height} L ${px(xMin).toFixed(2)},${height} Z`;
  return { line, area };
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

function seriesStats(samples: ChartSample[]): { current: number; min: number; max: number } {
  if (samples.length === 0) return { current: 0, min: 0, max: 0 };
  const vs = samples.map((s) => s.v);
  return {
    current: vs[vs.length - 1]!,
    min: Math.min(...vs),
    max: Math.max(...vs),
  };
}

export function IngestPanel() {
  const [keys, setKeys] = useState<ObservabilityKeysResponse | null>(null);
  const [memory, setMemory] = useState<ObservabilityMemoryResponse | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const throughput = useRef<ChartSample[]>([]);
  const memorySeries = useRef<ChartSample[]>([]);
  const lastKeys = useRef<{ t: number; dbsize: number } | null>(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listSources().then((s) => { if (!cancelled) setSources(s); }).catch(() => { /* tolerate missing source-service */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const [k, m] = await Promise.all([getObservabilityKeys("sens:"), getObservabilityMemory()]);
        if (cancelled) return;
        const now = Date.now();
        if (lastKeys.current) {
          const dt = (now - lastKeys.current.t) / 1000;
          const dn = k.dbsize - lastKeys.current.dbsize;
          const rate = dt > 0 ? Math.max(0, dn / dt) : 0;
          throughput.current = [...throughput.current, { t: now, v: rate }].slice(-MAX_SAMPLES);
        }
        lastKeys.current = { t: now, dbsize: k.dbsize };
        memorySeries.current = [...memorySeries.current, { t: now, v: m.used_memory ?? 0 }].slice(-MAX_SAMPLES);
        setKeys(k);
        setMemory(m);
        setError(null);
        setLoaded(true);
        forceRender((n) => n + 1);
      } catch (e) {
        if (cancelled) return;
        setError(`Failed to load ingest telemetry: ${(e as Error).message}`);
        setLoaded(true);
      }
    }
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const activeSource = useMemo(() => sources.find((s) => s.is_active) ?? sources[0], [sources]);
  const rowsPerSec = throughput.current.length > 0 ? throughput.current[throughput.current.length - 1]!.v : 0;
  const dbsize = keys?.dbsize ?? 0;
  const usedMem = memory?.used_memory ?? 0;
  const isEmpty = loaded && !error && dbsize === 0 && (keys?.sample.length ?? 0) === 0;

  async function onStartIngest() {
    if (!activeSource) return;
    setBusy(true); setLastAction(null);
    try {
      const r = await startIngest(activeSource.id);
      setLastAction(`Ingest run started${r.run_id ? ` (${r.run_id})` : ""}`);
    } catch (e) {
      setLastAction(`Start ingest failed: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  const tput = chartPath(throughput.current, 360, 80);
  const memPath = chartPath(memorySeries.current, 360, 80);
  const sampleKeys = keys?.sample ?? [];
  // Wave 5.20a — surface current/min/max next to each sparkline so the
  // demo audience can read numeric values without hovering the SVG.
  const tputStats = seriesStats(throughput.current);
  const memStats = seriesStats(memorySeries.current);

  return (
    <div className="panel ingest-panel">
      <header className="panel__header">
        <h1>Ingest</h1>
        <p className="panel__subhead">Live throughput, memory growth and key locality for streaming sensitivities into Redis Enterprise.</p>
      </header>

      <div className="ingest-panel__callouts">
        <EnterpriseCallout signal="Streams">
          Sensitivities land via a durable Redis Stream — back-pressure, replay, and consumer groups for free.
        </EnterpriseCallout>
        <EnterpriseCallout signal="JSON">
          Rows are written as native JSON documents — no row explosion, no flattening, indexable by RQE.
        </EnterpriseCallout>
      </div>

      <PanelCard
        title="Ingest controls"
        actions={
          activeSource ? (
            <button type="button" onClick={onStartIngest} disabled={busy} className="btn btn--primary">
              Start ingest
            </button>
          ) : null
        }
      >
        <div className="ingest-controls">
          <div className="ingest-controls__status">
            {activeSource ? (
              <span>Active source: <code>{activeSource.id}</code> ({activeSource.kind})</span>
            ) : (
              <span>No sources registered — use the synthetic generator below.</span>
            )}
          </div>
          {lastAction ? <div className="ingest-controls__action">{lastAction}</div> : null}
        </div>
      </PanelCard>

      <SyntheticGeneratorCard />


      <div className="metric-row">
        <MetricTile label="Total rows" value={fmtInt(dbsize)} unit="keys" status={loaded && !error ? "live" : "pending"} />
        <MetricTile label="Rows/sec" value={fmtInt(rowsPerSec)} unit="rows/s" status={loaded && !error ? (throughput.current.length > 1 ? "live" : "sampled") : "pending"} />
        <MetricTile label="Memory" value={fmtBytes(usedMem)} status={loaded && !error ? "live" : "pending"} />
      </div>

      {error ? (
        <PanelCard title="Telemetry error">
          <p role="alert">{error}</p>
        </PanelCard>
      ) : null}

      {isEmpty ? (
        <PanelCard title="Awaiting data">
          <p>No rows ingested yet. Start an ingest run to see live throughput and memory growth.</p>
        </PanelCard>
      ) : null}

      <div className="chart-grid">
        <PanelCard title="Throughput (rows/sec)">
          <svg data-testid="chart-throughput" viewBox="0 0 360 80" width="100%" height="80" role="img" aria-label="rows per second chart">
            {tput.area ? <path d={tput.area} fill="rgba(255, 68, 56, 0.18)" /> : null}
            {tput.line ? <path d={tput.line} fill="none" stroke="#FF4438" strokeWidth="2" /> : null}
          </svg>
          <div className="chart-card__labels" data-testid="chart-throughput-labels">
            <span>now <strong>{fmtInt(tputStats.current)}</strong></span>
            <span>min <strong>{fmtInt(tputStats.min)}</strong></span>
            <span>max <strong>{fmtInt(tputStats.max)}</strong></span>
          </div>
        </PanelCard>
        <PanelCard title="Memory growth">
          <svg data-testid="chart-memory" viewBox="0 0 360 80" width="100%" height="80" role="img" aria-label="memory usage chart">
            {memPath.area ? <path d={memPath.area} fill="rgba(138, 180, 199, 0.18)" /> : null}
            {memPath.line ? <path d={memPath.line} fill="none" stroke="#8AB4C7" strokeWidth="2" /> : null}
          </svg>
          <div className="chart-card__labels" data-testid="chart-memory-labels">
            <span>now <strong>{fmtBytes(memStats.current)}</strong></span>
            <span>min <strong>{fmtBytes(memStats.min)}</strong></span>
            <span>max <strong>{fmtBytes(memStats.max)}</strong></span>
          </div>
        </PanelCard>
      </div>

      <section data-testid="panel-card-sample-keys" className="sample-keys">
        <PanelCard title="Sample keys (hash-tag locality)">
          <p className="sample-keys__hint">
            Hash tag <code>{"{risk_class:bucket}"}</code> keeps every sensitivity for the same (risk_class, bucket)
            on the same shard — so per-bucket <code>FCALL</code> is slot-local.
          </p>
          {sampleKeys.length === 0 ? (
            <p className="sample-keys__empty">No keys to sample yet.</p>
          ) : (
            <ul className="sample-keys__list">
              {sampleKeys.slice(0, 8).map((k) => (
                <li key={k}><code>{k}</code></li>
              ))}
            </ul>
          )}
        </PanelCard>
      </section>
    </div>
  );
}

// Wave 5.20a — pre-submit sanity check.
//
//   bytes_per_row = used_memory / dbsize   (fallback FALLBACK_BYTES_PER_ROW)
//   estimate      = rows × bytes_per_row
//   headroom      = maxmemory ? maxmemory − used : total_system × 0.7 − used
//
// pct = estimate / headroom:
//   <70%   → submit immediately (returns null)
//   70-100 → yellow warning modal (variant="warn")
//   >100%  → red block-with-override modal (variant="block")
//
// If both `maxmemory_bytes` and `total_system_memory_bytes` are 0/unknown
// we can't compute headroom — return null and let the request through so
// the api's own MAX_ROWS guard remains the authoritative limit.
export interface SanityEstimate {
  variant: "warn" | "block";
  estimateBytes: number;
  usedBytes: number;
  headroomBytes: number;
  pct: number;
  suggestedRows: number;
  bytesPerRow: number;
}

export function computeSanity(
  rows: number,
  mem: Pick<ObservabilityMemoryResponse, "used_memory" | "maxmemory_bytes" | "total_system_memory_bytes" | "dbsize">,
): SanityEstimate | null {
  const used = Number(mem.used_memory ?? 0);
  const max = Number(mem.maxmemory_bytes ?? 0);
  const totSys = Number(mem.total_system_memory_bytes ?? 0);
  const dbsize = Number(mem.dbsize ?? 0);
  const bpr = dbsize > 0 && used > 0 ? used / dbsize : FALLBACK_BYTES_PER_ROW;
  const estimate = rows * bpr;
  const headroom = max > 0 ? max - used : totSys * 0.7 - used;
  if (!Number.isFinite(headroom) || headroom <= 0) {
    if (max <= 0 && totSys <= 0) return null;
    return {
      variant: "block",
      estimateBytes: estimate,
      usedBytes: used,
      headroomBytes: Math.max(0, headroom),
      pct: Infinity,
      suggestedRows: Math.max(1, Math.floor((Math.max(0, headroom) * 0.7) / bpr) || 1),
      bytesPerRow: bpr,
    };
  }
  const pct = (estimate / headroom) * 100;
  if (pct < 70) return null;
  const variant: "warn" | "block" = pct > 100 ? "block" : "warn";
  const suggestedRows = Math.max(1, Math.floor((headroom * 0.7) / bpr));
  return { variant, estimateBytes: estimate, usedBytes: used, headroomBytes: headroom, pct, suggestedRows, bytesPerRow: bpr };
}

interface PendingSubmit {
  cfg: GeneratorConfig | null; // null ⇒ post empty body (api defaults)
  rows: number;                // for "Use N rows" override
  est: SanityEstimate;
}

function fmtMB(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

// Wave 5.17b — configurable synthetic generator. Always rendered as its own
// PanelCard so the demo can top up sensitivities:in with explicit row count,
// class mix, sensitivity types, seed, and HSBC-style pool sizes.
//
// Wave 5.20a — adds a primary "Generate 200 rows" button (empty-body post,
// api applies its DEFAULT_ROWS / DEFAULT_CLASSES / DEFAULT_SENSITIVITY_TYPES)
// and a pre-submit sanity-check modal that prevents OOMs.
// Wave 5.20c — generator run progress + terminal state. Drives the
// progress bar (running / cancelling) and the post-run success/cancelled
// summary line.
interface RunState {
  rowsTotal: number;
  rowsDone: number;
  elapsedMs: number;
  rowsPerSec: number;
  runId: string | null;
  status: "running" | "cancelling" | "done" | "cancelled" | "error";
  terminalMs?: number;
}

function SyntheticGeneratorCard() {
  const [rows, setRows] = useState<number>(DEFAULT_GEN_ROWS);
  const [classes, setClasses] = useState<Set<string>>(() => new Set(GENERATOR_CLASSES));
  const [sensTypes, setSensTypes] = useState<Set<string>>(() => new Set(["Delta", "Vega"]));
  const [seed, setSeed] = useState<string>("0");
  const [tradePool, setTradePool] = useState<string>(""); // empty = auto (api derives)
  const [factorPool, setFactorPool] = useState<number>(DEFAULT_GEN_FACTOR_POOL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const streamRef = useRef<GeneratorStreamHandle | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState<PendingSubmit | null>(null);

  function toggleMember(prev: Set<string>, value: string): Set<string> {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  }

  function buildAdvancedConfig(): GeneratorConfig | string {
    if (!Number.isFinite(rows) || rows < 100 || rows > 2000) return "Rows must be between 100 and 2000.";
    if (classes.size === 0) return "Select at least one risk class.";
    if (sensTypes.size === 0) return "Select at least one sensitivity type.";
    const seedTrim = seed.trim();
    const seedValue: string | number = /^-?\d+$/.test(seedTrim) ? Number(seedTrim) : seedTrim;
    const cfg: GeneratorConfig = {
      rows,
      classes: Array.from(classes),
      sensitivity_types: Array.from(sensTypes),
      seed: seedValue,
      factor_pool_size: factorPool,
    };
    const tradeTrim = tradePool.trim();
    if (tradeTrim !== "") cfg.trade_pool_size = Number(tradeTrim);
    return cfg;
  }

  // Wave 5.20c — streaming generator run. Drives the live progress bar and
  // the post-run summary line via SSE frames. setBusy is flipped off only
  // when the terminal frame (or an error) arrives.
  function postGenerator(cfg: GeneratorConfig | null): void {
    setBusy(true);
    setError(null);
    const initialRows = cfg?.rows ?? DEFAULT_GEN_ROWS;
    setRun({
      rowsTotal: initialRows,
      rowsDone: 0,
      elapsedMs: 0,
      rowsPerSec: 0,
      runId: null,
      status: "running",
    });
    const handle = startGeneratorStream(cfg ?? undefined, {
      onProgress: (f: ProgressFrame) => {
        setRun((prev) => {
          if (!prev || prev.status === "done" || prev.status === "cancelled" || prev.status === "error") return prev;
          return {
            rowsTotal: f.rows_total,
            rowsDone: f.rows_done,
            elapsedMs: f.elapsed_ms,
            rowsPerSec: f.rows_per_sec,
            runId: f.run_id,
            status: prev.status, // preserve "cancelling" if user already clicked cancel
          };
        });
      },
      onTerminal: (f: TerminalFrame) => {
        setRun({
          rowsTotal: f.rows_queued,
          rowsDone: f.rows_queued,
          elapsedMs: f.ms,
          rowsPerSec: 0,
          runId: f.run_id,
          status: f.cancelled ? "cancelled" : "done",
          terminalMs: f.ms,
        });
        if (f.error) setError(f.error);
        streamRef.current = null;
        setBusy(false);
      },
      onError: (e: Error) => {
        setError(e.message);
        setRun((prev) => (prev ? { ...prev, status: "error" } : prev));
        streamRef.current = null;
        setBusy(false);
      },
    });
    streamRef.current = handle;
  }

  async function runWithSanityCheck(cfg: GeneratorConfig | null, rowsForCheck: number) {
    setError(null);
    setRun(null);
    let mem: ObservabilityMemoryResponse | null = null;
    try { mem = await getObservabilityMemory(); } catch { mem = null; }
    const est = mem ? computeSanity(rowsForCheck, mem) : null;
    if (!est) { postGenerator(cfg); return; }
    setPending({ cfg, rows: rowsForCheck, est });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setRun(null);
    const built = buildAdvancedConfig();
    if (typeof built === "string") { setError(built); return; }
    await runWithSanityCheck(built, built.rows ?? DEFAULT_GEN_ROWS);
  }

  async function onGenerateDefaults() {
    await runWithSanityCheck(null, DEFAULT_GEN_ROWS);
  }

  function onRandomSeed() {
    setSeed(String(Math.floor(Math.random() * 1_000_000_000)));
  }

  function onCancelRun(): void {
    setRun((prev) => (prev && prev.status === "running" ? { ...prev, status: "cancelling" } : prev));
    void streamRef.current?.cancel();
  }

  function onModalCancel() { setPending(null); }
  function onModalProceed() {
    const p = pending; setPending(null);
    if (p) postGenerator(p.cfg);
  }
  function onModalUseSuggested() {
    const p = pending; setPending(null);
    if (!p) return;
    const cfg: GeneratorConfig = p.cfg
      ? { ...p.cfg, rows: p.est.suggestedRows }
      : { rows: p.est.suggestedRows };
    postGenerator(cfg);
  }

  return (
    <PanelCard title="Synthetic generator">
      <form className="generator-form" onSubmit={onSubmit} aria-label="Synthetic generator">
        <div className="generator-form__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={onGenerateDefaults}
            data-testid="generator-defaults-btn"
          >
            {busy ? "Generating…" : "Generate 200 rows"}
          </button>
          <span className="generator-form__hint">uses api defaults (200 rows · all classes · Delta+Vega)</span>
        </div>

        <button
          type="button"
          className="generator-form__advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls="generator-form-advanced"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          {advancedOpen ? "▾" : "▸"} Advanced options
        </button>
        <div id="generator-form-advanced" className="generator-form__advanced-body">
          <div className="generator-form__row">
            <label htmlFor="gen-rows">Rows</label>
            <input
              id="gen-rows"
              type="number"
              min={100}
              max={2000}
              value={rows}
              disabled={busy}
              onChange={(e) => setRows(Number(e.target.value) || 0)}
            />
          </div>

          <fieldset className="generator-form__group" disabled={busy}>
            <legend>Risk classes</legend>
            {GENERATOR_CLASSES.map((c) => (
              <label key={c} className="generator-form__check">
                <input
                  type="checkbox"
                  name="gen-class"
                  value={c}
                  checked={classes.has(c)}
                  onChange={() => setClasses((prev) => toggleMember(prev, c))}
                />
                {c}
              </label>
            ))}
          </fieldset>

          <fieldset className="generator-form__group" disabled={busy}>
            <legend>Sensitivity types</legend>
            {GENERATOR_SENS_TYPES.map((t) => (
              <label key={t} className="generator-form__check">
                <input
                  type="checkbox"
                  name="gen-sens"
                  value={t}
                  checked={sensTypes.has(t)}
                  onChange={() => setSensTypes((prev) => toggleMember(prev, t))}
                />
                {t}
              </label>
            ))}
          </fieldset>

          <div className="generator-form__row">
            <label htmlFor="gen-seed">Seed</label>
            <input
              id="gen-seed"
              type="text"
              value={seed}
              disabled={busy}
              onChange={(e) => setSeed(e.target.value)}
            />
            <button type="button" className="btn btn--secondary" onClick={onRandomSeed} disabled={busy}>
              Random
            </button>
          </div>

          <div className="generator-form__row">
            <label htmlFor="gen-trade-pool">Trade pool size</label>
            <input
              id="gen-trade-pool"
              type="number"
              min={1}
              max={10000}
              placeholder="auto"
              value={tradePool}
              disabled={busy}
              onChange={(e) => setTradePool(e.target.value)}
            />
            <span className="generator-form__hint">empty = auto (ceil(rows/10))</span>
          </div>

          <div className="generator-form__row">
            <label htmlFor="gen-factor-pool">Risk factor pool size</label>
            <input
              id="gen-factor-pool"
              type="number"
              min={1}
              max={256}
              value={factorPool}
              disabled={busy}
              onChange={(e) => setFactorPool(Number(e.target.value) || 0)}
            />
          </div>

          <div className="generator-form__actions">
            <button type="submit" className="btn btn--secondary" disabled={busy}>
              {busy ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>

        {run && (run.status === "running" || run.status === "cancelling") ? (
          <GeneratorProgress run={run} onCancel={onCancelRun} />
        ) : null}
        {error ? (
          <div className="generator-form__error" role="alert">{error}</div>
        ) : null}
        {run && run.status === "done" && !error ? (
          <div className="generator-form__status" data-testid="generator-status">
            Done — {run.rowsDone} rows queued in {run.terminalMs ?? run.elapsedMs}ms
            {run.runId ? <> · run_id <code>{run.runId}</code></> : null}
          </div>
        ) : null}
        {run && run.status === "cancelled" ? (
          <div className="generator-form__status generator-form__status--cancelled" data-testid="generator-status">
            Cancelled — {run.rowsDone} rows queued in {run.terminalMs ?? run.elapsedMs}ms
            {run.runId ? <> · run_id <code>{run.runId}</code></> : null}
          </div>
        ) : null}
      </form>

      {pending ? (
        <SanityCheckModal
          est={pending.est}
          requestedRows={pending.rows}
          onCancel={onModalCancel}
          onProceed={onModalProceed}
          onUseSuggested={onModalUseSuggested}
        />
      ) : null}
    </PanelCard>
  );
}

// Wave 5.20c — live progress bar for a streaming generator run. Renders the
// percentage, rows-done / rows-total, throughput, elapsed time, plus the
// cancel button. The bar caps at 100% and switches to a "Cancelling…" label
// once the user clicks cancel.
function GeneratorProgress(props: { run: RunState; onCancel: () => void }) {
  const { run, onCancel } = props;
  const pct = run.rowsTotal > 0
    ? Math.max(0, Math.min(100, (run.rowsDone / run.rowsTotal) * 100))
    : 0;
  const elapsedSec = (run.elapsedMs / 1000).toFixed(1);
  const rps = Math.round(run.rowsPerSec);
  const cancelling = run.status === "cancelling";
  return (
    <div className="generator-form__progress" data-testid="generator-progress" role="status" aria-live="polite">
      <div
        className="generator-form__progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className="generator-form__progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="generator-form__progress-meta">
        <span data-testid="generator-progress-text">
          {run.rowsDone.toLocaleString()} / {run.rowsTotal.toLocaleString()} rows ({Math.round(pct)}%)
        </span>
        <span className="generator-form__progress-stats">
          {rps.toLocaleString()} rows/s · {elapsedSec}s
        </span>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onCancel}
          disabled={cancelling}
          data-testid="generator-cancel-btn"
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// Wave 5.20a — pre-submit sanity-check dialog. Reuses .dialog primitives;
// `variant` selects the yellow-warning or red-block left-border colour.
function SanityCheckModal(props: {
  est: SanityEstimate;
  requestedRows: number;
  onCancel: () => void;
  onProceed: () => void;
  onUseSuggested: () => void;
}) {
  const { est, requestedRows, onCancel, onProceed, onUseSuggested } = props;
  const pctText = Number.isFinite(est.pct) ? `${est.pct.toFixed(0)}%` : "∞";
  const isBlock = est.variant === "block";
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Sanity check">
      <div className={`dialog sanity-modal--${est.variant}`} data-testid={`sanity-modal-${est.variant}`}>
        <h2>{isBlock ? "Cluster headroom exceeded" : "Large generator batch"}</h2>
        <div className="sanity-modal__body">
          {isBlock ? (
            <>
              Estimated <strong>{fmtMB(est.estimateBytes)}</strong> exceeds available{" "}
              <strong>{fmtMB(est.headroomBytes)}</strong> headroom for {requestedRows} rows.
              <div className="sanity-modal__detail">
                Suggested max rows: <strong>{est.suggestedRows}</strong> (≈70% headroom).
              </div>
            </>
          ) : (
            <>
              Estimated ~<strong>{fmtMB(est.estimateBytes)}</strong> on top of{" "}
              <strong>{fmtMB(est.usedBytes)}</strong> used ({pctText} of available headroom). Continue?
            </>
          )}
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          {isBlock ? (
            <>
              <button type="button" className="btn btn--secondary" onClick={onUseSuggested}>
                Use {est.suggestedRows} rows
              </button>
              <button type="button" className="btn btn--danger" onClick={onProceed}>Override</button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onProceed}>Proceed</button>
          )}
        </div>
      </div>
    </div>
  );
}

export default IngestPanel;

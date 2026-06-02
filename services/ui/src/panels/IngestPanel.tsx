import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { MetricTile } from "../components/MetricTile";
import { PanelCard } from "../components/PanelCard";
import {
  useGeneratorRun,
  type GeneratorRunState,
} from "../context/GeneratorRunContext";
import {
  getObservabilityKeys,
  getObservabilityMemory,
  type ObservabilityKeysResponse,
  type ObservabilityMemoryResponse,
} from "../lib/api";
import {
  cancelAllGeneratorRuns,
  flushDb,
  listSources,
  preflight,
  rebuildIndexes,
  startIngest,
  type GeneratorConfig,
  type PreflightResponse,
  type Source,
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

// Wave 5.49 — named generator presets replace the raw trade_pool / factor_pool
// inputs in the advanced fieldset. "small" is the default and reproduces the
// historical trade_pool=200 / factor_pool=16 sizing; "custom" reveals the raw
// inputs for power users. The select sets internal tradePool / factorPool
// state on change, so buildAdvancedConfig keeps shipping numeric
// trade_pool_size / factor_pool_size — no API contract change.
type GeneratorPreset = "small" | "single-desk" | "trading-book" | "full-bank" | "custom";
const PRESETS: Record<Exclude<GeneratorPreset, "custom">, { label: string; tradePool: number; factorPool: number }> = {
  "small":         { label: "Small desk (200 trades · 16 risk factors)",            tradePool: 200,    factorPool: 16  },
  "single-desk":   { label: "Single desk realistic (2,000 trades · 32 risk factors)", tradePool: 2000,   factorPool: 32  },
  "trading-book":  { label: "Trading book realistic (20,000 trades · 64 risk factors)", tradePool: 20000,  factorPool: 64  },
  "full-bank":     { label: "Full bank (100,000 trades · 100 risk factors)",         tradePool: 100000, factorPool: 100 },
};
const DEFAULT_PRESET: GeneratorPreset = "small";
const DEFAULT_GEN_TRADE_POOL = PRESETS[DEFAULT_PRESET].tradePool;

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

// Wave 5.47c — human label for the generator's stop_reason. The "rows" case
// is the historical default and is intentionally suppressed at the call
// site (only non-rows stops add the "stopped: …" suffix to the status line).
function stopReasonLabel(reason: string): string {
  switch (reason) {
    case "memory": return "memory limit reached";
    case "elapsed": return "time limit reached";
    case "cancelled": return "cancelled";
    case "error": return "error";
    case "rows": return "row count reached";
    default: return reason;
  }
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

// Wave 5.47b — pre-flight check coordinator. Hoisted out of IngestPanel so
// the SyntheticGeneratorCard can request a fresh probe through a submit gate
// without duplicating cache + fetch state. Banner shows only when the api
// explicitly returned ok=false; missing/empty responses are treated as
// "unknown" (banner hidden, submit allowed) so existing tests that don't mock
// /admin/preflight keep passing.
const PREFLIGHT_STALENESS_MS = 30_000;

interface PreflightState {
  result: PreflightResponse | null;
  lastRunAt: number;
  rebuilding: boolean;
  rebuildError: string | null;
}

interface PreflightHandle {
  state: PreflightState;
  runPreflight: () => Promise<PreflightResponse | null>;
  rebuild: () => Promise<void>;
  ensureFresh: () => Promise<PreflightResponse | null>;
}

function usePreflight(): PreflightHandle {
  const [state, setState] = useState<PreflightState>({
    result: null, lastRunAt: 0, rebuilding: false, rebuildError: null,
  });
  // Wave 5.47b — guard against an in-flight probe being clobbered by a stale
  // mount-effect resolution after unmount; the ref also dedupes overlapping
  // ensureFresh callers (e.g. mount-effect racing the submit gate).
  const inflight = useRef<Promise<PreflightResponse | null> | null>(null);

  const runPreflight = async (): Promise<PreflightResponse | null> => {
    if (inflight.current) return inflight.current;
    const p = (async (): Promise<PreflightResponse | null> => {
      try {
        const r = await preflight();
        setState((s) => ({ ...s, result: r, lastRunAt: Date.now() }));
        return r;
      } catch {
        setState((s) => ({ ...s, lastRunAt: Date.now() }));
        return null;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  };

  const ensureFresh = async (): Promise<PreflightResponse | null> => {
    const age = Date.now() - state.lastRunAt;
    if (state.lastRunAt === 0 || age > PREFLIGHT_STALENESS_MS) {
      return runPreflight();
    }
    return state.result;
  };

  const rebuild = async (): Promise<void> => {
    setState((s) => ({ ...s, rebuilding: true, rebuildError: null }));
    try {
      const r = await rebuildIndexes();
      if (!r.ok) {
        setState((s) => ({ ...s, rebuilding: false, rebuildError: r.bootstrap.error ?? "rebuild failed" }));
        return;
      }
      setState((s) => ({ ...s, rebuilding: false, rebuildError: null }));
      await runPreflight();
    } catch (e) {
      setState((s) => ({ ...s, rebuilding: false, rebuildError: (e as Error).message }));
    }
  };

  return { state, runPreflight, rebuild, ensureFresh };
}

function PreflightBanner(props: { state: PreflightState; onRebuild: () => void }) {
  const { state, onRebuild } = props;
  const r = state.result;
  if (!r || r.ok !== false) return null;
  const missing: string[] = [];
  if (!r.checks.idx_sens.ok) {
    const tail = r.checks.idx_sens.missing.length > 0 ? ` (${r.checks.idx_sens.missing.join(", ")})` : "";
    missing.push(`idx:sens${tail}`);
  }
  if (!r.checks.frtb_library.ok) missing.push("frtb library");
  if (!r.checks.stream.ok) missing.push("sensitivities:in stream");
  return (
    <div className="preflight-banner" role="status" data-testid="preflight-banner">
      <div className="preflight-banner__body">
        <strong>Pre-flight failed.</strong> Missing: {missing.join(", ")}.
      </div>
      <div className="preflight-banner__actions">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onRebuild}
          disabled={state.rebuilding || !r.can_rebuild}
          data-testid="preflight-rebuild-btn"
        >
          {state.rebuilding ? "Rebuilding…" : "Rebuild indexes"}
        </button>
        {state.rebuildError ? (
          <span className="preflight-banner__error" role="alert">{state.rebuildError}</span>
        ) : null}
      </div>
    </div>
  );
}

export function IngestPanel() {
  const [keys, setKeys] = useState<ObservabilityKeysResponse | null>(null);
  const [memory, setMemory] = useState<ObservabilityMemoryResponse | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  // Wave 5.38c — Flush DB button state. `flushPending` drives the
  // confirmation modal; `flushBanner` is the transient success message; the
  // error path reuses the existing telemetry error display.
  const [flushPending, setFlushPending] = useState(false);
  const [flushBusy, setFlushBusy] = useState(false);
  const [flushBanner, setFlushBanner] = useState<string | null>(null);
  // Wave 5.44 — Stop all runs button state. Mirrors the flush-db shape:
  // `stopAllPending` drives the confirm modal, `stopAllBusy` disables the
  // button mid-call, and `stopAllBanner` is the transient summary message.
  const [stopAllPending, setStopAllPending] = useState(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const [stopAllBanner, setStopAllBanner] = useState<string | null>(null);
  // Wave 5.44 — best-effort sync with the locally-tracked generator run. If
  // the run the IngestPanel is currently showing happens to be in the
  // cancelled list, we clear it immediately so the progress UI doesn't sit
  // on "running" for the next polling tick.
  const { run: trackedRun, clearRun: clearTrackedRun } = useGeneratorRun();
  // Wave 5.47b — pre-flight banner + submit gate shared with SyntheticGeneratorCard.
  const preflightHandle = usePreflight();

  const throughput = useRef<ChartSample[]>([]);
  const memorySeries = useRef<ChartSample[]>([]);
  const lastKeys = useRef<{ t: number; dbsize: number } | null>(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listSources().then((s) => { if (!cancelled) setSources(s); }).catch(() => { /* tolerate missing source-service */ });
    return () => { cancelled = true; };
  }, []);

  // Wave 5.47b — run pre-flight on mount so the banner can render before the
  // user opens the synthetic generator form. Tolerate failures silently — a
  // 404 or down api should not block the rest of the panel.
  useEffect(() => {
    void preflightHandle.runPreflight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Wave 5.38c — Flush DB confirm handler. Calls POST /admin/flush, then
  // refetches /observability/keys + /observability/memory immediately so the
  // dbsize and memory tiles drop without waiting for the 1s poll tick. The
  // success banner auto-clears after 4s.
  async function onFlushConfirm() {
    setFlushPending(false);
    setFlushBusy(true);
    setError(null);
    try {
      const r = await flushDb();
      // Wave 5.46 — the api re-runs bootstrapFrtb after FLUSHDB. When it
      // succeeds the banner advertises the rebuilt index so the presenter
      // knows the next Calculate will not 412; when it fails we surface
      // the bootstrap error via the existing error display.
      if (r.bootstrap && !r.bootstrap.ok) {
        setError(`Flush failed: bootstrap ${r.bootstrap.error ?? "failed"}`);
      } else {
        const banner = r.bootstrap?.ok
          ? `Flushed in ${r.ms}ms · indexes rebuilt`
          : `Flushed in ${r.ms}ms`;
        setFlushBanner(banner);
        window.setTimeout(() => setFlushBanner(null), 4000);
      }
      try {
        const [k, m] = await Promise.all([getObservabilityKeys("sens:"), getObservabilityMemory()]);
        setKeys(k);
        setMemory(m);
        lastKeys.current = { t: Date.now(), dbsize: k.dbsize };
      } catch { /* tolerate transient refresh failure; next poll tick will catch up */ }
      // Wave 5.47b — flush re-bootstraps server-side, so re-run preflight to
      // refresh the banner state (typically clears it). Tolerate failures.
      void preflightHandle.runPreflight();
    } catch (e) {
      setError(`Flush failed: ${(e as Error).message}`);
    } finally {
      setFlushBusy(false);
    }
  }

  // Wave 5.44 — Stop all runs confirm handler. POSTs /admin/cancel-all-runs,
  // shows a transient banner with the cancelled count ("No active runs" when
  // N=0), and best-effort clears the locally-tracked generator run if its
  // run_id appears in the cancelled list. The error path reuses the existing
  // telemetry error display; the banner auto-clears after 4s.
  async function onStopAllConfirm() {
    setStopAllPending(false);
    setStopAllBusy(true);
    setError(null);
    try {
      const r = await cancelAllGeneratorRuns();
      const msg = r.cancelled === 0
        ? "No active runs"
        : `Stopped ${r.cancelled} run${r.cancelled === 1 ? "" : "s"}`;
      setStopAllBanner(msg);
      if (trackedRun?.runId && r.run_ids.includes(trackedRun.runId)) {
        clearTrackedRun();
      }
      window.setTimeout(() => setStopAllBanner(null), 4000);
    } catch (e) {
      setError(`Stop all runs failed: ${(e as Error).message}`);
    } finally {
      setStopAllBusy(false);
    }
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

      <PreflightBanner state={preflightHandle.state} onRebuild={() => { void preflightHandle.rebuild(); }} />

      <SyntheticGeneratorCard preflightGate={preflightHandle.ensureFresh} />

      <PanelCard title="Admin actions">
        <div className="ingest-admin">
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => setFlushPending(true)}
            disabled={flushBusy}
            data-testid="flush-db-btn"
          >
            {flushBusy ? "Flushing…" : "Flush DB"}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => setStopAllPending(true)}
            disabled={stopAllBusy}
            data-testid="stop-all-runs-btn"
          >
            {stopAllBusy ? "Stopping…" : "Stop all runs"}
          </button>
          {flushBanner ? (
            <span className="ingest-admin__banner" data-testid="flush-db-banner" role="status">
              {flushBanner}
            </span>
          ) : null}
          {stopAllBanner ? (
            <span className="ingest-admin__banner" data-testid="stop-all-runs-banner" role="status">
              {stopAllBanner}
            </span>
          ) : null}
        </div>
      </PanelCard>

      {flushPending ? (
        <FlushDbConfirmModal
          onCancel={() => setFlushPending(false)}
          onConfirm={onFlushConfirm}
        />
      ) : null}

      {stopAllPending ? (
        <StopAllRunsConfirmModal
          onCancel={() => setStopAllPending(false)}
          onConfirm={onStopAllConfirm}
        />
      ) : null}

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
// class mix, sensitivity types, seed, and tenant-style pool sizes.
//
// Wave 5.20a — adds a primary "Generate 200 rows" button (empty-body post,
// api applies its DEFAULT_ROWS / DEFAULT_CLASSES / DEFAULT_SENSITIVITY_TYPES)
// and a pre-submit sanity-check modal that prevents OOMs.
// Wave 5.20c — generator run progress + terminal state. Drives the
// progress bar (running / cancelling) and the post-run success/cancelled
// summary line. Wave 5.38a — state lives in GeneratorRunContext so it
// survives route changes; the panel only owns form-validation errors.
function SyntheticGeneratorCard(props: { preflightGate?: () => Promise<PreflightResponse | null> }) {
  const { preflightGate } = props;
  const [rows, setRows] = useState<number>(DEFAULT_GEN_ROWS);
  const [classes, setClasses] = useState<Set<string>>(() => new Set(GENERATOR_CLASSES));
  const [sensTypes, setSensTypes] = useState<Set<string>>(() => new Set(["Delta", "Vega"]));
  const [seed, setSeed] = useState<string>("0");
  // Wave 5.49 — default to the "small" preset's resolved trade/factor sizes
  // so submit ships trade_pool_size=200, factor_pool_size=16 without needing
  // the user to expand the (now-hidden) custom inputs.
  const [preset, setPreset] = useState<GeneratorPreset>(DEFAULT_PRESET);
  const [tradePool, setTradePool] = useState<string>(String(DEFAULT_GEN_TRADE_POOL));
  const [factorPool, setFactorPool] = useState<number>(DEFAULT_GEN_FACTOR_POOL);
  const [formError, setFormError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState<PendingSubmit | null>(null);
  // Wave 5.47d — explicit per-class row targets. Keyed by class label (not
  // canonical UPPER form); server resolves. All-zero / empty ⇒ omitted from
  // the request so the server falls back to round-robin via classes + rows.
  const [classSplit, setClassSplit] = useState<Record<string, string>>({});
  // Wave 5.47c — optional stop conditions (rows / memory % / elapsed s).
  // Empty strings ⇒ omitted from the request so the historical
  // "stop at row count" behaviour is preserved.
  const [stopRows, setStopRows] = useState<string>("");
  const [stopMemPct, setStopMemPct] = useState<string>("");
  const [stopElapsedSec, setStopElapsedSec] = useState<string>("");
  const { run, error: streamError, startRun, cancelRun, clearRun } = useGeneratorRun();
  const busy = run?.status === "running" || run?.status === "cancelling";
  const displayError = formError ?? streamError;

  function toggleMember(prev: Set<string>, value: string): Set<string> {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  }

  function buildAdvancedConfig(): GeneratorConfig | string {
    if (!Number.isFinite(rows) || rows < 100 || rows > 100_000_000) return "Rows must be between 100 and 100,000,000.";
    if (classes.size === 0) return "Select at least one risk class.";
    if (sensTypes.size === 0) return "Select at least one sensitivity type.";
    const seedTrim = seed.trim();
    const seedValue: string | number = /^-?\d+$/.test(seedTrim) ? Number(seedTrim) : seedTrim;
    // Wave 5.47d — collect non-zero per-class targets for selected classes.
    // Empty / all-zero ⇒ omit so the server uses round-robin.
    const splitOut: Record<string, number> = {};
    for (const c of classes) {
      const raw = classSplit[c];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return `Per-class target for ${c} must be a non-negative integer.`;
      }
      if (n > 0) splitOut[c] = n;
    }
    const hasSplit = Object.keys(splitOut).length > 0;
    const cfg: GeneratorConfig = {
      classes: Array.from(classes),
      sensitivity_types: Array.from(sensTypes),
      seed: seedValue,
      factor_pool_size: factorPool,
    };
    if (hasSplit) cfg.class_split = splitOut;
    else cfg.rows = rows;
    const tradeTrim = tradePool.trim();
    if (tradeTrim !== "") cfg.trade_pool_size = Number(tradeTrim);
    // Wave 5.47c — assemble optional stop_when. Each field is validated to
    // mirror the api guards (positive integers; memory_pct in 1..95;
    // elapsed_seconds in 1..86400). Empty fields are dropped.
    const stopWhen: { rows?: number; memory_pct?: number; elapsed_seconds?: number } = {};
    const stopRowsTrim = stopRows.trim();
    if (stopRowsTrim !== "") {
      const n = Number(stopRowsTrim);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return "Stop after rows must be a positive integer.";
      }
      stopWhen.rows = n;
    }
    const stopMemTrim = stopMemPct.trim();
    if (stopMemTrim !== "") {
      const n = Number(stopMemTrim);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 95) {
        return "Stop at memory % must be an integer in 1..95.";
      }
      stopWhen.memory_pct = n;
    }
    const stopElapsedTrim = stopElapsedSec.trim();
    if (stopElapsedTrim !== "") {
      const n = Number(stopElapsedTrim);
      if (!Number.isFinite(n) || n <= 0 || n > 86400) {
        return "Stop after seconds must be a positive number ≤ 86400.";
      }
      stopWhen.elapsed_seconds = n;
    }
    if (Object.keys(stopWhen).length > 0) cfg.stop_when = stopWhen;
    return cfg;
  }

  async function runWithSanityCheck(cfg: GeneratorConfig | null, rowsForCheck: number) {
    setFormError(null);
    clearRun();
    // Wave 5.47b — gate the run on pre-flight. ensureFresh re-probes when the
    // last result is older than 30s (or has never run); a strict ok=false
    // response blocks submit so the panel banner is the next thing the user
    // sees. Null / missing fields are treated as "unknown" — allow through.
    if (preflightGate) {
      const pf = await preflightGate();
      if (pf && pf.ok === false) {
        setFormError("Pre-flight failed. Use the Rebuild indexes button above.");
        return;
      }
    }
    let mem: ObservabilityMemoryResponse | null = null;
    try { mem = await getObservabilityMemory(); } catch { mem = null; }
    const est = mem ? computeSanity(rowsForCheck, mem) : null;
    if (!est) { startRun(cfg); return; }
    setPending({ cfg, rows: rowsForCheck, est });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    clearRun();
    const built = buildAdvancedConfig();
    if (typeof built === "string") { setFormError(built); return; }
    // Wave 5.47d — when class_split is set, the effective row count is the
    // sum; otherwise it's the explicit `rows` field. Pass that to the sanity
    // check so headroom math reflects what the server will actually queue.
    const effectiveRows = built.class_split
      ? Object.values(built.class_split).reduce((a, b) => a + b, 0)
      : built.rows ?? DEFAULT_GEN_ROWS;
    await runWithSanityCheck(built, effectiveRows);
  }

  async function onGenerateDefaults() {
    await runWithSanityCheck(null, DEFAULT_GEN_ROWS);
  }

  function onRandomSeed() {
    setSeed(String(Math.floor(Math.random() * 1_000_000_000)));
  }

  // Wave 5.49 — preset change drops the resolved trade / factor sizes into
  // the existing state slots so buildAdvancedConfig keeps shipping numeric
  // trade_pool_size / factor_pool_size. Selecting "custom" reveals the raw
  // inputs pre-populated with the last preset's values.
  function onPresetChange(next: GeneratorPreset): void {
    setPreset(next);
    if (next !== "custom") {
      setTradePool(String(PRESETS[next].tradePool));
      setFactorPool(PRESETS[next].factorPool);
    }
  }

  // Wave 5.47d — populate per-class targets with an even split of `rows`
  // across the currently-selected classes. Any remainder lands on the first
  // class so the totals sum to `rows` exactly.
  function onEvenSplit(): void {
    const selected = Array.from(classes);
    if (selected.length === 0) return;
    const base = Math.floor(rows / selected.length);
    const remainder = rows - base * selected.length;
    const next: Record<string, string> = {};
    selected.forEach((c, i) => { next[c] = String(base + (i === 0 ? remainder : 0)); });
    setClassSplit(next);
  }

  function onCancelRun(): void {
    cancelRun();
  }

  function onModalCancel() { setPending(null); }
  function onModalProceed() {
    const p = pending; setPending(null);
    if (p) startRun(p.cfg);
  }
  function onModalUseSuggested() {
    const p = pending; setPending(null);
    if (!p) return;
    const cfg: GeneratorConfig = p.cfg
      ? { ...p.cfg, rows: p.est.suggestedRows }
      : { rows: p.est.suggestedRows };
    startRun(cfg);
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
          {/* Wave 5.49 — named presets sit at the top of the advanced
              fieldset; they update tradePool / factorPool state and hide the
              raw inputs unless "Custom…" is picked. */}
          <div className="generator-form__row">
            <label htmlFor="gen-preset">Realistic profile</label>
            <select
              id="gen-preset"
              data-testid="generator-preset"
              value={preset}
              disabled={busy}
              onChange={(e) => onPresetChange(e.target.value as GeneratorPreset)}
            >
              {(Object.keys(PRESETS) as Array<Exclude<GeneratorPreset, "custom">>).map((k) => (
                <option key={k} value={k}>{PRESETS[k].label}</option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </div>

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
            <span className="generator-form__hint">Same seed + preset + classes ⇒ reproducible run</span>
          </div>

          <div className="generator-form__row">
            <label htmlFor="gen-rows">Rows</label>
            <input
              id="gen-rows"
              type="number"
              min={100}
              max={100_000_000}
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

          {/* Wave 5.47d — per-class row targets. Empty / all-zero ⇒ server
              falls back to round-robin via classes + rows. */}
          <fieldset className="generator-form__group" disabled={busy} data-testid="generator-class-split">
            <legend>Per-class targets</legend>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onEvenSplit}
              disabled={busy || classes.size === 0}
              data-testid="generator-even-split-btn"
            >
              Even split
            </button>
            <table className="generator-form__split-table">
              <tbody>
                {Array.from(classes).map((c) => (
                  <tr key={c}>
                    <td><label htmlFor={`gen-split-${c}`}>{c}</label></td>
                    <td>
                      <input
                        id={`gen-split-${c}`}
                        type="number"
                        min={0}
                        step={1}
                        placeholder="0"
                        value={classSplit[c] ?? ""}
                        disabled={busy}
                        onChange={(e) => setClassSplit((prev) => ({ ...prev, [c]: e.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="generator-form__hint">leave blank / all zero to use Rows + round-robin</span>
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

          {/* Wave 5.49 — raw trade / factor pool inputs only surface when
              the user picks "Custom…". Non-custom presets seed the same
              underlying state slots, so the submit body is identical. */}
          {preset === "custom" ? (
            <>
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
            </>
          ) : null}

          {/* Wave 5.47c — optional stop conditions. Whichever trips first
              halts the run; leaving all three empty preserves the historical
              "stop at row count" behaviour. */}
          <fieldset
            className="generator-form__fieldset"
            data-testid="generator-stop-when"
          >
            <legend>Stop conditions <span className="generator-form__hint">(optional — first to trip wins)</span></legend>
            <div className="generator-form__row">
              <label htmlFor="gen-stop-rows">Stop after rows</label>
              <input
                id="gen-stop-rows"
                type="number"
                min={1}
                placeholder="(use rows above)"
                value={stopRows}
                disabled={busy}
                onChange={(e) => setStopRows(e.target.value)}
              />
            </div>
            <div className="generator-form__row">
              <label htmlFor="gen-stop-mem-pct">Stop at memory %</label>
              <input
                id="gen-stop-mem-pct"
                type="number"
                min={1}
                max={95}
                placeholder="off"
                value={stopMemPct}
                disabled={busy}
                onChange={(e) => setStopMemPct(e.target.value)}
              />
              <span className="generator-form__hint">used_memory / maxmemory · polled every ~25 batches</span>
            </div>
            <div className="generator-form__row">
              <label htmlFor="gen-stop-elapsed">Stop after seconds</label>
              <input
                id="gen-stop-elapsed"
                type="number"
                min={1}
                max={86400}
                placeholder="off"
                value={stopElapsedSec}
                disabled={busy}
                onChange={(e) => setStopElapsedSec(e.target.value)}
              />
            </div>
          </fieldset>

          <div className="generator-form__actions">
            <button type="submit" className="btn btn--secondary" disabled={busy}>
              {busy ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>

        {run && (run.status === "running" || run.status === "cancelling") ? (
          <GeneratorProgress run={run} onCancel={onCancelRun} />
        ) : null}
        {displayError ? (
          <div className="generator-form__error" role="alert">{displayError}</div>
        ) : null}
        {run && run.status === "done" && !displayError ? (
          <div className="generator-form__status" data-testid="generator-status">
            Done — {run.rowsDone} rows queued in {run.terminalMs ?? run.elapsedMs}ms
            {run.runId ? <> · run_id <code>{run.runId}</code></> : null}
            {run.stopReason && run.stopReason !== "rows" ? (
              <> · stopped: <span data-testid="generator-stop-reason">{stopReasonLabel(run.stopReason)}</span></>
            ) : null}
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
function GeneratorProgress(props: { run: GeneratorRunState; onCancel: () => void }) {
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

// Wave 5.38c — destructive-action confirmation. Mirrors the SanityCheckModal
// shape (dialog-backdrop + .dialog) so styling stays consistent; Confirm uses
// btn--danger to telegraph the data-loss intent.
function FlushDbConfirmModal(props: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { onCancel, onConfirm } = props;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Flush DB confirmation">
      <div className="dialog sanity-modal--block" data-testid="flush-db-modal">
        <h2>Flush the active Redis database?</h2>
        <div className="sanity-modal__body">
          This will delete all sensitivities and the input stream. The index will be empty until the next ingest.
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel} data-testid="flush-db-cancel">
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} data-testid="flush-db-confirm">
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// Wave 5.44 — destructive-action confirmation for "Stop all runs". Same
// dialog shape as FlushDbConfirmModal so the layout stays consistent.
function StopAllRunsConfirmModal(props: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { onCancel, onConfirm } = props;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Stop all runs confirmation">
      <div className="dialog sanity-modal--block" data-testid="stop-all-runs-modal">
        <h2>Stop all active generator runs?</h2>
        <div className="sanity-modal__body">
          This cancels every run currently producing rows. Already-finished runs are unaffected.
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel} data-testid="stop-all-runs-cancel">
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} data-testid="stop-all-runs-confirm">
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

export default IngestPanel;

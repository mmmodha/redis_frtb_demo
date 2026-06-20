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
  stopAllRuns,
  flushDb,
  getGeneratorRunStatus,
  getIndexCount,
  getIngestShards,
  listSources,
  preflight,
  preflightAndRebuildIfNeeded,
  rebuildIndexes,
  resetIngestShards,
  setIngestShards,
  startIngest,
  type GeneratorConfig,
  type PreflightResponse,
  type Source,
} from "../lib/ingest";
import {
  clearAnchor,
  computePct,
  computeRatePerSec,
  pushSample,
  readAnchor,
  writeAnchor,
  type IndexCountSample,
  type IndexingAnchor,
} from "../lib/indexingState";
import { useActiveTargetLabel } from "../lib/connections";

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

// Wave 5.52 — Generator UX overhaul. The simple-mode form shows only two
// inputs (Total rows + Class mix). Auto-derivation maps these to the full
// request body; advanced mode reveals the historical fine-grained controls.
const QUICK_PICK_ROWS = [
  { label: "200", value: 200 },
  { label: "2k", value: 2_000 },
  { label: "20k", value: 20_000 },
  { label: "200k", value: 200_000 },
  { label: "2M", value: 2_000_000 },
  { label: "10M", value: 10_000_000 },
  { label: "50M", value: 50_000_000 },
  { label: "100M", value: 100_000_000 },
] as const;
// Wave 6.10 — api-side default XADD MAXLEN cap (mirrors
// DEFAULT_STREAM_MAXLEN in services/api/src/routes/generator.ts). When the
// user picks a simple-mode row count above this and has NOT manually set a
// cap in Advanced, the submitted request auto-flips stream_maxlen to match
// the row count so no rows are silently truncated.
const DEFAULT_STREAM_MAXLEN = 2_000_000;
// Wave 5.87a — balanced-thirds default. Mirrors the canonical 200k baseline
// (README "Canonical 200k baseline (Wave 5.84)") used to pin
// calc-live-200k.test.ts charge anchors — the legacy 60/30/10 default
// produced a skewed corpus that drifted those pins on UI-driven 200k runs.
const DEFAULT_MIX_PCT: Record<(typeof GENERATOR_CLASSES)[number], number> = { GIRR: 34, Equity: 33, FX: 33 };
const CANONICAL_DEMO_SEED = 0xCAFEBABE;
const CANONICAL_DEMO_MIX: Record<(typeof GENERATOR_CLASSES)[number], number> = { GIRR: 100, Equity: 0, FX: 0 };
const CANONICAL_DEMO_ROWS = 200;
const CANONICAL_DEMO_SENS_TYPES = ["Delta", "Vega"] as const;

function deriveTradePool(n: number): number {
  return Math.max(50, Math.min(10_000, Math.floor(n / 20)));
}
function deriveFactorPool(n: number): number {
  return Math.max(8, Math.min(256, Math.floor(n / 200)));
}
function deriveClassSplit(
  n: number,
  mix: Record<(typeof GENERATOR_CLASSES)[number], number>,
): Record<string, number> {
  const ordered = GENERATOR_CLASSES.filter((c) => (mix[c] ?? 0) > 0);
  const out: Record<string, number> = {};
  if (ordered.length === 0) return out;
  let allocated = 0;
  for (let i = 0; i < ordered.length - 1; i++) {
    const c = ordered[i]!;
    const cnt = Math.floor((n * (mix[c] ?? 0)) / 100);
    out[c] = cnt;
    allocated += cnt;
  }
  out[ordered[ordered.length - 1]!] = n - allocated;
  return out;
}
function formatSeedHex(seed: number): string {
  return `0x${(seed >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}
function randomSeed(): number {
  return (Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
}

// Wave 6.10 — parse the Advanced "Stream cap" input. Empty ⇒ null (no
// manual override, callers may auto-flip). 0 ⇒ explicit opt-out (no cap).
// Returns Error on a malformed entry so the caller can surface a form error.
function parseManualMaxlen(raw: string): number | null | Error {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return new Error("Stream cap must be a non-negative integer (0 to disable).");
  }
  return n;
}

// Wave 6.17 — five fixed run presets that wire all dials (rows, stream
// fan-out, stream_maxlen, defer_trim) for the primary IngestPanel surface.
// Each preset is paired with an auto-align step that POSTs /ingest/shards
// before /generator/start/stream so the consumer fan-out matches the
// producer dial without manual fiddling. Numbers mirror the task spec; the
// description is the small grey line under each radio button.
export type RunPresetKey = "quick" | "demo" | "medium" | "large" | "xl" | "overnight" | "xxl";
export interface RunPreset {
  key: RunPresetKey;
  label: string;
  rows: number;
  shards: number;
  // 0 ⇒ no MAXLEN cap (XADD without ~ MAXLEN); positive ⇒ ship as the
  // resolved stream_maxlen on the generator request.
  maxlen: number;
  deferTrim: boolean;
  description: string;
}
export const RUN_PRESETS: Record<RunPresetKey, RunPreset> = {
  quick:     { key: "quick",     label: "10K rows",  rows: 10_000,      shards: 1,  maxlen: 100_000,   deferTrim: false, description: "" },
  demo:      { key: "demo",      label: "100K rows", rows: 100_000,     shards: 1,  maxlen: 200_000,   deferTrim: false, description: "" },
  medium:    { key: "medium",    label: "1M rows",   rows: 1_000_000,   shards: 4,  maxlen: 2_000_000, deferTrim: false, description: "" },
  large:     { key: "large",     label: "10M rows",  rows: 10_000_000,  shards: 8,  maxlen: 0,         deferTrim: true,  description: "" },
  xl:        { key: "xl",        label: "50M rows",  rows: 50_000_000,  shards: 12, maxlen: 0,         deferTrim: true,  description: "" },
  overnight: { key: "overnight", label: "100M rows", rows: 100_000_000, shards: 16, maxlen: 0,         deferTrim: true,  description: "" },
  xxl:       { key: "xxl",       label: "200M rows", rows: 200_000_000, shards: 20, maxlen: 0,         deferTrim: true,  description: "" },
};
const RUN_PRESET_ORDER: RunPresetKey[] = ["quick", "demo", "medium", "large", "xl", "overnight", "xxl"];

export function buildRunPresetConfig(p: RunPreset): GeneratorConfig {
  // Wave 6.17 — emit defer_trim verbatim (true or false) so the request body
  // matches the spec literally. The api treats omitted ⇔ false, but the
  // explicit boolean makes the preset's intent self-documenting for ops.
  const cfg: GeneratorConfig = {
    rows: p.rows,
    stream_shards: p.shards,
    stream_maxlen: p.maxlen,
    defer_trim: p.deferTrim,
  };
  return cfg;
}

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
  // Wave 5.44 / 6.53.A — Stop generators button state. Mirrors the flush-db
  // shape: `stopAllPending` drives the confirm modal, `stopAllBusy` disables
  // the button mid-call, and `stopAllBanner` is the transient summary message.
  const [stopAllPending, setStopAllPending] = useState(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const [stopAllBanner, setStopAllBanner] = useState<string | null>(null);
  // Wave 5.44 — best-effort sync with the locally-tracked generator run. If
  // the run the IngestPanel is currently showing happens to be in the
  // cancelled list, we clear it immediately so the progress UI doesn't sit
  // on "running" for the next polling tick.
  const { run: trackedRun, clearRun: clearTrackedRun, startRun, cancelRun } = useGeneratorRun();
  // Wave 5.47b — pre-flight banner + submit gate shared with SyntheticGeneratorCard.
  const preflightHandle = usePreflight();
  // Wave 6.17 — primary preset card state. `presetKey` is the currently
  // staged preset; `presetStep` is the human-readable label for the current
  // automation step (preflight → rebuild → shards → start); `presetError`
  // surfaces any failure that halted the flow. `presetInflight` is true
  // while the orchestrator is between buttons (preflight call started, run
  // not yet handed off to GeneratorRunContext).
  const [presetKey, setPresetKey] = useState<RunPresetKey>("quick");
  const [presetStep, setPresetStep] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetInflight, setPresetInflight] = useState<boolean>(false);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  // Wave 6.12b — ingest fan-out card state. `ingestShards` mirrors the most
  // recent GET /ingest/shards; `producerDial` is the resolved
  // dials.stream_shards from the active run (when one exists). Both are
  // refreshed by the existing 1s telemetry poll — no new timer.
  const [ingestShards, setIngestShardsState] = useState<number | null>(null);
  const [producerDial, setProducerDial] = useState<number | "per-bucket" | null>(null);
  const [shardRebuilding, setShardRebuilding] = useState<boolean>(false);
  const [shardError, setShardError] = useState<string | null>(null);
  // Wave 6.32.C — server-reported rebuild start time (ISO8601) when the
  // ingest snapshot reports `rebuilding: true`. Null otherwise. Surfaces a
  // spinner with elapsed seconds so the operator can tell a stuck rebuild
  // from a normal one.
  const [rebuildStartedAt, setRebuildStartedAt] = useState<string | null>(null);
  // Wave 6.32.C — Force reset confirmation modal + in-flight flag for the
  // POST /ingest/shards/reset call. Mirrors the flush-db button shape.
  const [resetPending, setResetPending] = useState<boolean>(false);
  const [resetBusy, setResetBusy] = useState<boolean>(false);
  // Pending value submitted via POST — used to render the transient
  // "rebuilding… → N" affordance until the next GET confirms the new value.
  const pendingShardRef = useRef<number | null>(null);
  // Capture the tracked run id without restarting the polling effect when it
  // changes; the poll tick reads the ref each tick to decide whether to
  // fetch /generator/runs/:id/status.
  const trackedRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    trackedRunIdRef.current = trackedRun?.runId ?? null;
    if (!trackedRun?.runId) setProducerDial(null);
  }, [trackedRun?.runId]);

  const throughput = useRef<ChartSample[]>([]);
  const memorySeries = useRef<ChartSample[]>([]);
  // Wave 6.51.A — throughput is now derived from FT.SEARCH index-count
  // deltas (sens/sec) rather than DBSIZE deltas, so the "Rows/sec" tile
  // reflects sensitivities indexed per second instead of all-keys churn
  // (rollup:*, processed:*, RediSearch internals, duplicate-hash keys).
  const lastIndexCount = useRef<{ t: number; count: number } | null>(null);
  const [indexCount, setIndexCount] = useState<number>(0);
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
        // Wave 6.51.A — index-count alongside keys/memory. Throughput +
        // the "Sensitivities" tile read from the FT.SEARCH count of the
        // active sens index (sens written/sec), not DBSIZE. SCAN sample is
        // still consumed by the "Sample keys (hash-tag locality)" card.
        const [k, m, ic] = await Promise.all([
          getObservabilityKeys("sens:"),
          getObservabilityMemory(),
          getIndexCount(),
        ]);
        if (cancelled) return;
        const now = Date.now();
        const icCount = typeof ic.count === "number" ? ic.count : 0;
        if (lastIndexCount.current) {
          const dt = (now - lastIndexCount.current.t) / 1000;
          const dn = icCount - lastIndexCount.current.count;
          const rate = dt > 0 ? Math.max(0, dn / dt) : 0;
          throughput.current = [...throughput.current, { t: now, v: rate }].slice(-MAX_SAMPLES);
        }
        lastIndexCount.current = { t: now, count: icCount };
        memorySeries.current = [...memorySeries.current, { t: now, v: m.used_memory ?? 0 }].slice(-MAX_SAMPLES);
        setKeys(k);
        setMemory(m);
        setIndexCount(icCount);
        setError(null);
        setLoaded(true);
        forceRender((n) => n + 1);
      } catch (e) {
        if (cancelled) return;
        setError(`Failed to load ingest telemetry: ${(e as Error).message}`);
        setLoaded(true);
      }
      // Wave 6.12b — fan-out poll. Independent try/catch so a transient
      // /ingest/shards failure does not clobber the telemetry error and
      // vice-versa. Once the GET confirms the value the user posted, we
      // clear the transient `rebuilding…` flag.
      try {
        const snap = await getIngestShards();
        if (cancelled) return;
        setIngestShardsState(snap.totalShards);
        // Wave 6.32.C — server is authoritative for the rebuilding flag once
        // it advertises it (snap.rebuilding === true|false). Older ingest
        // builds omit the field; fall back to the local optimistic flag in
        // that case so the existing "Rebuilding…" affordance still works.
        if (typeof snap.rebuilding === "boolean") {
          setShardRebuilding(snap.rebuilding);
          setRebuildStartedAt(snap.rebuilding ? (snap.rebuild_started_at ?? null) : null);
          if (!snap.rebuilding) pendingShardRef.current = null;
        } else if (pendingShardRef.current !== null && snap.totalShards === pendingShardRef.current) {
          pendingShardRef.current = null;
          setShardRebuilding(false);
        }
      } catch { /* tolerate transient /ingest/shards failure */ }
      // Wave 6.12b — pick up the producer's resolved dials.stream_shards
      // from the active run, when one is being tracked. Streaming runs
      // populate dials; non-streaming runs leave it undefined (we render
      // "—" + neutral chip in that case).
      const rid = trackedRunIdRef.current;
      if (rid) {
        try {
          const status = await getGeneratorRunStatus(rid);
          if (cancelled) return;
          if (status?.dials?.stream_shards !== undefined) {
            setProducerDial(status.dials.stream_shards);
          }
        } catch { /* tolerate transient /generator/runs failure */ }
      }
    }
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const activeSource = useMemo(() => sources.find((s) => s.is_active) ?? sources[0], [sources]);
  const rowsPerSec = throughput.current.length > 0 ? throughput.current[throughput.current.length - 1]!.v : 0;
  const usedMem = memory?.used_memory ?? 0;
  // Wave 6.51.A — empty-state heuristic keyed on the same FT.SEARCH count
  // the user sees in the "Sensitivities" tile so the "Awaiting data" card
  // appears/disappears in lock-step with that number.
  const isEmpty = loaded && !error && indexCount === 0;

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
        const [k, m, ic] = await Promise.all([
          getObservabilityKeys("sens:"),
          getObservabilityMemory(),
          getIndexCount(),
        ]);
        setKeys(k);
        setMemory(m);
        const icCount = typeof ic.count === "number" ? ic.count : 0;
        setIndexCount(icCount);
        lastIndexCount.current = { t: Date.now(), count: icCount };
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

  // Wave 5.44 / 6.53.A — Stop generators confirm handler. POSTs
  // /admin/stop-runs, shows a transient banner with the cancelled count
  // ("No active runs" when N=0), and best-effort clears the locally-tracked
  // generator run if its run_id appears in the cancelled list. The error
  // path reuses the existing telemetry error display; the banner auto-clears
  // after 4s. Wave 6.53.A removed the destructive flush summary — the api
  // route no longer touches the stream backlog or indexed rows, so the
  // banner only reports the cancel count. Use "Flush DB" for the destructive
  // path.
  async function onStopAllConfirm() {
    setStopAllPending(false);
    setStopAllBusy(true);
    setError(null);
    try {
      const r = await stopAllRuns();
      const banner = r.cancelled === 0
        ? "No active runs."
        : `Stopped ${r.cancelled} generator${r.cancelled === 1 ? "" : "s"}.`;
      setStopAllBanner(banner);
      if (trackedRun?.runId && r.run_ids.includes(trackedRun.runId)) {
        clearTrackedRun();
      }
      window.setTimeout(() => setStopAllBanner(null), 4000);
    } catch (e) {
      setError(`Stop generators failed: ${(e as Error).message}`);
    } finally {
      setStopAllBusy(false);
    }
  }

  // Wave 6.17 — orchestrator for the primary preset-Start button. Runs
  // pre-flight, auto-repairs indexes if needed, aligns the ingest consumer
  // fan-out to the preset's stream_shards, then hands off to startRun. Each
  // step updates `presetStep` so the operator sees what's happening; any
  // step throwing bubbles up via `presetError` and halts the flow. The
  // Start button stays disabled (via presetStartDisabled below) for the
  // whole sequence and through the tracked-run lifetime.
  async function onStartPreset(): Promise<void> {
    const p = RUN_PRESETS[presetKey];
    setPresetInflight(true);
    setPresetError(null);
    setPresetStep("Checking indexes…");
    try {
      const { preflight: pf, rebuilt } = await preflightAndRebuildIfNeeded();
      // Refresh the banner state so the existing rebuild affordance reflects
      // the post-flow truth; tolerate failures (banner stays stale at worst).
      void preflightHandle.runPreflight();
      if (pf.ok === false) {
        setPresetError("Pre-flight failed after rebuild — open Advanced to inspect.");
        setPresetStep(null);
        return;
      }
      if (rebuilt) setPresetStep("Indexes repaired.");
      setPresetStep(`Aligning consumer to ${p.shards} shard${p.shards === 1 ? "" : "s"}…`);
      const snap = await setIngestShards(p.shards);
      setIngestShardsState(snap.totalShards);
      setPresetStep(`Starting ${p.label} run…`);
      startRun(buildRunPresetConfig(p));
      // Hand-off is complete: startRun has spawned the SSE stream and
      // GeneratorRunContext now owns the run lifecycle. Drop the step
      // label so the run-status line below takes over.
      setPresetStep(null);
    } catch (e) {
      setPresetError((e as Error).message);
      setPresetStep(null);
    } finally {
      setPresetInflight(false);
    }
  }

  // Wave 6.17 — Start stays disabled while any step is in flight: the
  // orchestrator's own pre-startRun window, plus the entire tracked-run
  // lifetime ("running" + "cancelling"). Once the run hits a terminal
  // status the button re-enables for the next preset selection.
  const presetRunInflight = trackedRun?.status === "running" || trackedRun?.status === "cancelling";
  const presetStartDisabled = presetInflight || presetRunInflight;

  // Wave 6.12b — Apply handler for the ingest fan-out card. POST returns
  // the new snapshot synchronously, so the displayed value updates straight
  // away; we still flip `shardRebuilding` until the next GET tick confirms
  // it so the operator sees the transient state if the POST takes longer
  // than the immediate response (e.g. a slow drain). 400 (invalid) / 409
  // (rebuild busy) surface verbatim via `shardError`.
  async function onApplyShards(next: number): Promise<void> {
    setShardError(null);
    setShardRebuilding(true);
    pendingShardRef.current = next;
    try {
      const snap = await setIngestShards(next);
      setIngestShardsState(snap.totalShards);
      if (snap.totalShards === next) {
        pendingShardRef.current = null;
        setShardRebuilding(false);
      }
    } catch (e) {
      pendingShardRef.current = null;
      setShardRebuilding(false);
      setShardError((e as Error).message);
    }
  }

  // Wave 6.32.C — Force reset handler. Operator recovery for a stuck rebuild
  // mutex: POST /ingest/shards/reset force-clears `rebuilding` on the ingest
  // service and detaches the abandoned MultiConsumer. We optimistically clear
  // the local flag too so the Apply button re-enables immediately; the next
  // GET tick confirms the server state. Errors surface via `shardError`.
  async function onResetShardsConfirm(): Promise<void> {
    setResetPending(false);
    setResetBusy(true);
    setShardError(null);
    try {
      await resetIngestShards();
      pendingShardRef.current = null;
      setShardRebuilding(false);
      setRebuildStartedAt(null);
    } catch (e) {
      setShardError((e as Error).message);
    } finally {
      setResetBusy(false);
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

      {/* Wave 6.17 — primary preset surface. Five fixed presets wire all
          dials (rows / fan-out / maxlen / defer_trim) and auto-align the
          consumer + indexes before each run. The historical free-form
          controls (preflight banner, fan-out card, synthetic generator
          form) are moved into the collapsed "Advanced (custom run)"
          disclosure below. */}
      <RunPresetCard
        presetKey={presetKey}
        onSelect={setPresetKey}
        onStart={() => { void onStartPreset(); }}
        startDisabled={presetStartDisabled}
        inflight={presetInflight}
        runStatus={trackedRun?.status ?? null}
        step={presetStep}
        error={presetError}
        trackedRun={trackedRun}
        onCancelRun={cancelRun}
      />

      <button
        type="button"
        className="ingest-advanced-toggle"
        aria-expanded={advancedOpen}
        aria-controls="ingest-advanced-body"
        onClick={() => setAdvancedOpen((v) => !v)}
        data-testid="ingest-advanced-toggle"
      >
        {advancedOpen ? "▾ Hide advanced (custom run)" : "▸ Advanced (custom run)"}
      </button>
      {advancedOpen ? (
        <div id="ingest-advanced-body" className="ingest-advanced-body" data-testid="ingest-advanced-body">
          <PreflightBanner state={preflightHandle.state} onRebuild={() => { void preflightHandle.rebuild(); }} />

          <IngestFanoutCard
            ingestShards={ingestShards}
            producerDial={producerDial}
            rebuilding={shardRebuilding}
            rebuildStartedAt={rebuildStartedAt}
            error={shardError}
            onApply={onApplyShards}
            onRequestReset={() => setResetPending(true)}
            resetBusy={resetBusy}
          />

          <SyntheticGeneratorCard
            // Wave 6.17 — Advanced submit uses the same orchestrator as the
            // preset Start button: preflight → rebuild-if-needed →
            // /ingest/shards (when stream_shards is numeric) → startRun. Step
            // labels surface inline; throws halt before startRun and the
            // message is shown as a form error. The operator therefore cannot
            // launch an Advanced run that bypasses /ingest/shards alignment.
            onPreRun={async (cfg, onStep) => {
              onStep("Checking indexes…");
              const { preflight: pf, rebuilt } = await preflightAndRebuildIfNeeded();
              void preflightHandle.runPreflight();
              if (pf.ok === false) {
                throw new Error(
                  "Pre-flight failed after rebuild — use the Rebuild indexes button above to inspect.",
                );
              }
              if (rebuilt) onStep("Indexes repaired.");
              if (typeof cfg.stream_shards === "number") {
                onStep(
                  `Aligning consumer to ${cfg.stream_shards} shard${cfg.stream_shards === 1 ? "" : "s"}…`,
                );
                const snap = await setIngestShards(cfg.stream_shards);
                setIngestShardsState(snap.totalShards);
              }
              onStep("Starting run…");
            }}
          />
        </div>
      ) : null}

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
            {stopAllBusy ? "Stopping…" : "Stop generators"}
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

      {resetPending ? (
        <ResetShardsConfirmModal
          onCancel={() => setResetPending(false)}
          onConfirm={onResetShardsConfirm}
        />
      ) : null}

      <div className="metric-row">
        <MetricTile label="Sensitivities" value={fmtInt(indexCount)} unit="sens" status={loaded && !error ? "live" : "pending"} />
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

// Wave 6.17 — Primary preset surface. Renders the five fixed presets as a
// radio group and a single Start button. The Start button hands off to the
// IngestPanel orchestrator (onStartPreset), which runs preflight, repairs
// indexes if needed, aligns /ingest/shards, then kicks off the run via
// startRun. Status line below mirrors `step` (orchestrator-side) and the
// terminal run summary (from GeneratorRunContext via `runStatus`).
function RunPresetCard(props: {
  presetKey: RunPresetKey;
  onSelect: (k: RunPresetKey) => void;
  onStart: () => void;
  startDisabled: boolean;
  inflight: boolean;
  runStatus: "running" | "cancelling" | "done" | "cancelled" | "error" | null;
  step: string | null;
  error: string | null;
  // Wave 6.17b — full tracked-run state + cancel handler so the preset
  // surface can render the live <GeneratorProgress> bar inline (rows-done,
  // throughput, % complete, ETA, Cancel) while a run is in flight. Mirrors
  // the bar that already renders inside the Advanced disclosure.
  trackedRun: GeneratorRunState | null;
  onCancelRun: () => void;
}) {
  const { presetKey, onSelect, onStart, startDisabled, inflight, runStatus, step, error, trackedRun, onCancelRun } = props;
  const showProgress = trackedRun !== null
    && (trackedRun.status === "running" || trackedRun.status === "cancelling");
  const selected = RUN_PRESETS[presetKey];
  // Button label tracks the high-level state: idle / pre-run automation /
  // run in flight / cancelling / done. Idle text names the staged preset so
  // the user knows what Start will fire.
  const buttonLabel = inflight
    ? "Starting…"
    : runStatus === "running"
      ? "Generating…"
      : runStatus === "cancelling"
        ? "Cancelling…"
        : `Start ${selected.label}`;
  return (
    <PanelCard title="Run preset">
      <div
        className="ingest-presets"
        role="radiogroup"
        aria-label="Run preset"
        data-testid="ingest-preset-radiogroup"
      >
        {RUN_PRESET_ORDER.map((k) => {
          const p = RUN_PRESETS[k];
          const checked = presetKey === k;
          return (
            <label
              key={k}
              className={`ingest-presets__btn${checked ? " ingest-presets__btn--selected" : ""}`}
              data-testid={`ingest-preset-${k}`}
            >
              <input
                type="radio"
                name="ingest-preset"
                value={k}
                checked={checked}
                disabled={startDisabled}
                onChange={() => onSelect(k)}
              />
              <span className="ingest-presets__label">{p.label}</span>
              {p.description ? (
                <span className="ingest-presets__desc">{p.description}</span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="ingest-presets__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={startDisabled}
          onClick={onStart}
          data-testid="ingest-preset-start-btn"
        >
          {buttonLabel}
        </button>
        {step ? (
          <span
            className="ingest-presets__step"
            data-testid="ingest-preset-step"
            role="status"
            aria-live="polite"
          >
            {step}
          </span>
        ) : null}
        {error ? (
          <span
            className="ingest-presets__error"
            data-testid="ingest-preset-error"
            role="alert"
          >
            {error}
          </span>
        ) : null}
      </div>
      {showProgress ? (
        <GeneratorProgress run={trackedRun!} onCancel={onCancelRun} />
      ) : null}
      <IndexingProgress />
    </PanelCard>
  );
}

// Wave 6.12b — Ingest fan-out card. Renders the current ingest shard count
// (poll-refreshed from GET /ingest/shards), the producer's resolved
// dials.stream_shards from the active streaming run (or "—" when no run is
// tracked / non-streaming run), and a match-indicator chip. The dropdown
// limits to integer shard counts (1/4/8/16/32) — "per-bucket" is producer-
// only and not a valid consumer setting. 400/409 errors from POST surface
// inline so the operator sees rebuild conflicts instead of a silent retry.
const INGEST_FANOUT_OPTIONS = [1, 4, 8, 16, 32] as const;

type MatchKind = "match" | "mismatch" | "neutral";

function computeFanoutMatch(
  ingest: number | null,
  producer: number | "per-bucket" | null,
): MatchKind {
  if (ingest === null || producer === null) return "neutral";
  if (producer === "per-bucket") return "mismatch";
  return ingest === producer ? "match" : "mismatch";
}

function IngestFanoutCard(props: {
  ingestShards: number | null;
  producerDial: number | "per-bucket" | null;
  rebuilding: boolean;
  // Wave 6.32.C — ISO8601 timestamp from the server snapshot when a rebuild
  // is in flight; null when the server reports `rebuilding: false` (or omits
  // the field). Used to render an elapsed-time spinner so a stuck rebuild
  // becomes visible.
  rebuildStartedAt: string | null;
  error: string | null;
  onApply: (next: number) => Promise<void>;
  // Wave 6.32.C — opens the Force reset confirmation modal owned by the
  // panel. `resetBusy` mirrors the in-flight POST so the button can show a
  // spinner label while the request is outstanding.
  onRequestReset: () => void;
  resetBusy: boolean;
}) {
  const {
    ingestShards, producerDial, rebuilding, rebuildStartedAt,
    error, onApply, onRequestReset, resetBusy,
  } = props;
  // Default the dropdown to the current ingest value when known; fall back
  // to the first option so the form is always submittable.
  const initial = ingestShards != null && (INGEST_FANOUT_OPTIONS as readonly number[]).includes(ingestShards)
    ? ingestShards
    : INGEST_FANOUT_OPTIONS[0];
  const [pending, setPending] = useState<number>(initial);
  // Track the last "live" ingest value the user has seen so a server-side
  // poll update silently re-syncs the dropdown until the user touches it.
  const lastIngestRef = useRef<number | null>(ingestShards);
  useEffect(() => {
    if (ingestShards != null && ingestShards !== lastIngestRef.current) {
      lastIngestRef.current = ingestShards;
      if ((INGEST_FANOUT_OPTIONS as readonly number[]).includes(ingestShards)) {
        setPending(ingestShards);
      }
    }
  }, [ingestShards]);

  const match = computeFanoutMatch(ingestShards, producerDial);
  const ingestLabel = ingestShards == null ? "—" : String(ingestShards);
  const producerLabel = producerDial == null ? "—" : String(producerDial);
  const chipText = match === "match" ? "✓ match" : match === "mismatch" ? "⚠ mismatch" : "no active run";
  const chipTestId = `ingest-fanout-chip-${match}`;
  const disabled = rebuilding;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await onApply(pending);
  }

  return (
    <PanelCard title="Ingest fan-out">
      <form className="ingest-fanout" onSubmit={onSubmit} aria-label="Ingest fan-out" data-testid="ingest-fanout-card">
        <div className="ingest-fanout__row">
          <span data-testid="ingest-fanout-ingest">
            Ingest fan-out: <strong>{ingestLabel}</strong>
          </span>
          <span data-testid="ingest-fanout-producer">
            Producer fan-out: <strong>{producerLabel}</strong>
          </span>
          <span
            className={`ingest-fanout__chip ingest-fanout__chip--${match}`}
            data-testid={chipTestId}
            role="status"
          >
            {chipText}
          </span>
        </div>
        {match === "mismatch" ? (
          <div className="ingest-fanout__hint" data-testid="ingest-fanout-explainer">
            Ingest reads {ingestLabel} shard{ingestShards === 1 ? "" : "s"}; producer is writing to {producerLabel}
            {producerDial === "per-bucket" ? "" : producerDial === 1 ? " shard" : " shards"} — rebuild ingest to match for full coverage.
          </div>
        ) : null}
        <div className="ingest-fanout__row">
          <label htmlFor="ingest-fanout-select">Set ingest shards</label>
          <select
            id="ingest-fanout-select"
            data-testid="ingest-fanout-select"
            value={pending}
            disabled={disabled}
            onChange={(e) => setPending(Number(e.target.value))}
          >
            {INGEST_FANOUT_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={disabled}
            data-testid="ingest-fanout-apply"
          >
            {rebuilding ? "Rebuilding…" : "Apply"}
          </button>
        </div>
        {rebuilding ? (
          <div className="ingest-fanout__hint" data-testid="ingest-fanout-rebuilding" role="status">
            <span className="ingest-fanout__spinner" aria-hidden="true">⏳</span>
            {" "}Rebuilding ingest consumer
            {rebuildStartedAt ? (
              <>
                {" — started "}
                <time
                  dateTime={rebuildStartedAt}
                  data-testid="ingest-fanout-rebuild-started-at"
                  title={rebuildStartedAt}
                >
                  {formatRebuildStartedAt(rebuildStartedAt)}
                </time>
              </>
            ) : (
              " — waiting for the next poll to confirm."
            )}
          </div>
        ) : null}
        {/* Wave 6.32.C — Force reset escape hatch for a stuck rebuild mutex.
            Always rendered so the operator can recover even if the snapshot
            never flips back to `rebuilding: false`; visually de-emphasised
            unless a rebuild is in flight. */}
        <div className="ingest-fanout__row ingest-fanout__row--reset">
          <button
            type="button"
            className="btn btn--danger"
            onClick={onRequestReset}
            disabled={resetBusy}
            data-testid="ingest-fanout-reset"
            title="Force-clear a stuck rebuild mutex on the ingest service. Destructive: in-flight messages from the abandoned consumer may be lost."
          >
            {resetBusy ? "Resetting…" : "Force reset"}
          </button>
        </div>
        {error ? (
          <div className="ingest-fanout__error" data-testid="ingest-fanout-error" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </PanelCard>
  );
}

// Wave 6.32.C — render the rebuild start timestamp as a short relative
// elapsed-seconds string ("5s ago") so the operator can spot a stuck rebuild
// at a glance. Falls back to the raw ISO when parsing fails so the tooltip
// still carries useful info.
function formatRebuildStartedAt(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const delta = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ${delta % 60}s ago`;
  return `${Math.floor(delta / 3600)}h ${Math.floor((delta % 3600) / 60)}m ago`;
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
function SyntheticGeneratorCard(props: {
  preflightGate?: () => Promise<PreflightResponse | null>;
  // Wave 6.17 — when provided, runs the full preset-style orchestrator
  // (preflight → rebuild-if-needed → /ingest/shards) before startRun and
  // supersedes preflightGate. Throws on any step failure; the message is
  // surfaced verbatim in formError. The onStep callback drives the inline
  // transient label so operators see what's happening per step.
  onPreRun?: (
    cfg: GeneratorConfig,
    onStep: (step: string | null) => void,
  ) => Promise<void>;
}) {
  const { preflightGate, onPreRun } = props;
  // Wave 6.17 — transient per-step label for the orchestrator; cleared once
  // the run hands off to startRun (or on error).
  const [preRunStep, setPreRunStep] = useState<string | null>(null);
  // Wave 5.52 — the two simple-mode controls: Total rows and Class mix.
  const [rows, setRows] = useState<number>(DEFAULT_GEN_ROWS);
  const [mixPct, setMixPct] = useState<Record<(typeof GENERATOR_CLASSES)[number], number>>(
    () => ({ ...DEFAULT_MIX_PCT }),
  );
  // Wave 5.52 — pendingSeed is non-null when the user has explicitly chosen
  // a seed for the next run (Reset to canonical → 0xCAFEBABE). Otherwise
  // simple-mode submits draw a fresh random seed per run so the displayed
  // "Last seed" pill is meaningful and the run is replayable.
  const [pendingSeed, setPendingSeed] = useState<number | null>(null);
  // Wave 5.52 — surfaced as "Last seed: 0x…" below the action buttons after
  // the first run has been kicked off this session. Click-to-copy.
  const [lastSeed, setLastSeed] = useState<number | null>(null);
  const [seedCopied, setSeedCopied] = useState<boolean>(false);

  // Wave 5.49 / pre-5.52 — advanced-mode state. Only consulted when
  // advancedOpen=true; otherwise auto-derivation builds the body.
  const [classes, setClasses] = useState<Set<string>>(() => new Set(GENERATOR_CLASSES));
  // Wave 6.10 — Curvature on by default so a fresh-page run populates all
  // three sensitivity legs. CANONICAL_DEMO_SENS_TYPES (Delta+Vega only) is
  // still applied by onResetToCanonical so calc-live-200k anchors hold.
  const [sensTypes, setSensTypes] = useState<Set<string>>(() => new Set(["Delta", "Vega", "Curvature"]));
  // Wave 6.10 — optional stream MAXLEN cap (string state to distinguish
  // "user has not touched it" (empty) from an explicit value). Empty ⇒ the
  // submit path auto-flips to match `rows` when rows > DEFAULT_STREAM_MAXLEN.
  const [streamMaxlen, setStreamMaxlen] = useState<string>("");
  // Wave 6.11b — explicit stream-shard fan-out dial. "auto" ⇒ omit from
  // body so the server uses the profile-derived value (1 on standalone-
  // presenting targets). Numeric strings ship as numbers; "per-bucket"
  // ships as a literal string. The api validates the value at the route.
  const [streamShards, setStreamShards] = useState<string>("auto");
  const [seed, setSeed] = useState<string>("0");
  const [preset, setPreset] = useState<GeneratorPreset>(DEFAULT_PRESET);
  const [tradePool, setTradePool] = useState<string>(String(DEFAULT_GEN_TRADE_POOL));
  const [factorPool, setFactorPool] = useState<number>(DEFAULT_GEN_FACTOR_POOL);
  const [classSplit, setClassSplit] = useState<Record<string, string>>({});
  const [stopRows, setStopRows] = useState<string>("");
  const [stopMemPct, setStopMemPct] = useState<string>("");
  const [stopElapsedSec, setStopElapsedSec] = useState<string>("");

  const [formError, setFormError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pending, setPending] = useState<PendingSubmit | null>(null);

  const { run, error: streamError, startRun, cancelRun, clearRun } = useGeneratorRun();
  const busy = run?.status === "running" || run?.status === "cancelling";
  const displayError = formError ?? streamError;

  // Wave 5.52 — class-mix validation. Generate is disabled until the three
  // class percentages sum to exactly 100; the pill surfaces the live total.
  const mixSum = useMemo(
    () => GENERATOR_CLASSES.reduce((s, c) => s + (Number.isFinite(mixPct[c]) ? mixPct[c] : 0), 0),
    [mixPct],
  );
  const mixValid = mixSum === 100;

  // Wave 5.52 — non-destructive reveal: opening Advanced pre-populates the
  // legacy fields with whatever the simple-mode auto-derivation would have
  // sent. Re-runs on every open so the values track the current rows + mix.
  useEffect(() => {
    if (!advancedOpen) return;
    const derivedTrade = deriveTradePool(rows);
    const derivedFactor = deriveFactorPool(rows);
    const derivedSplit = deriveClassSplit(rows, mixPct);
    // Wave 6.10 — opening Advanced mirrors the simple-mode default
    // (Delta+Vega+Curvature). CANONICAL_DEMO_SENS_TYPES stays Delta+Vega and
    // is only applied by onResetToCanonical.
    setSensTypes(new Set(["Delta", "Vega", "Curvature"]));
    setClasses(new Set(GENERATOR_CLASSES));
    setSeed(String(pendingSeed ?? lastSeed ?? randomSeed()));
    setPreset("custom");
    setTradePool(String(derivedTrade));
    setFactorPool(derivedFactor);
    setClassSplit(
      Object.fromEntries(
        GENERATOR_CLASSES.map((c) => [c, derivedSplit[c] !== undefined ? String(derivedSplit[c]) : ""]),
      ),
    );
    setStopRows(String(rows));
    setStopMemPct("75");
    setStopElapsedSec("600");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advancedOpen]);

  // Wave 5.50 — live sum of the per-class targets table (advanced only).
  const classSplitSum = useMemo(() => {
    let sum = 0;
    for (const c of classes) {
      const raw = classSplit[c];
      if (raw === undefined || raw.trim() === "") continue;
      const n = Number(raw);
      if (Number.isFinite(n) && Number.isInteger(n) && n > 0) sum += n;
    }
    return sum;
  }, [classes, classSplit]);
  const classSplitActive = classSplitSum > 0;

  // Wave 6.10 — surfaced just above the Submit button: either an "auto-flip"
  // hint (no manual cap, rows exceed the api default) or an orange warning
  // (manual cap < effective rows ⇒ silent truncation risk). Mirrors the
  // build-time logic in buildSimpleConfig / buildAdvancedConfig.
  const maxlenHint = useMemo<
    { kind: "auto"; cap: number } | { kind: "warn"; cap: number; rows: number } | null
  >(() => {
    const effectiveRows = advancedOpen && classSplitActive
      ? classSplitSum
      : (Number.isFinite(rows) ? rows : 0);
    if (effectiveRows <= 0) return null;
    const trimmed = streamMaxlen.trim();
    if (trimmed === "") {
      if (effectiveRows > DEFAULT_STREAM_MAXLEN) return { kind: "auto", cap: effectiveRows };
      return null;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    if (n < effectiveRows) return { kind: "warn", cap: n, rows: effectiveRows };
    return null;
  }, [advancedOpen, classSplitActive, classSplitSum, rows, streamMaxlen]);

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
    // Wave 6.10 — propagate the manual / auto-flipped MAXLEN cap. Manual
    // entry always wins; otherwise auto-flip to the effective row count when
    // it exceeds the api-side default so no rows are silently truncated.
    const effectiveRows = hasSplit
      ? Object.values(splitOut).reduce((a, b) => a + b, 0)
      : rows;
    const parsedMaxlen = parseManualMaxlen(streamMaxlen);
    if (parsedMaxlen instanceof Error) return parsedMaxlen.message;
    if (parsedMaxlen !== null) cfg.stream_maxlen = parsedMaxlen;
    else if (effectiveRows > DEFAULT_STREAM_MAXLEN) cfg.stream_maxlen = effectiveRows;
    // Wave 6.11b — explicit stream-shard fan-out. "auto" leaves the field
    // off so the server uses the profile-derived value; numeric strings
    // ship as numbers; "per-bucket" ships as a literal string.
    if (streamShards !== "auto") {
      cfg.stream_shards = streamShards === "per-bucket" ? "per-bucket" : Number(streamShards);
    }
    return cfg;
  }

  // Wave 5.52 — simple-mode config builder. Maps Total rows + Class mix to
  // the full request body via the documented auto-derivation table, includes
  // a fresh per-run seed (or the canonical 0xCAFEBABE when staged), and
  // returns an error string if validation fails.
  function buildSimpleConfig(): { cfg: GeneratorConfig; seedUsed: number } | string {
    if (!Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1) {
      return "Total rows must be a positive integer.";
    }
    if (!mixValid) return `Class mix must sum to 100 (currently ${mixSum})`;
    const split = deriveClassSplit(rows, mixPct);
    if (Object.keys(split).length === 0) return "At least one class must have a non-zero percentage.";
    if (sensTypes.size === 0) return "Select at least one sensitivity type.";
    const seedUsed = pendingSeed ?? randomSeed();
    const cfg: GeneratorConfig = {
      class_split: split,
      // Wave 6.10 — simple mode now emits the user's sensTypes (fresh-page
      // default Delta+Vega+Curvature). Reset to canonical demo restores the
      // Delta+Vega pair via onResetToCanonical so the 200-row canary stays
      // bit-identical.
      sensitivity_types: Array.from(sensTypes),
      seed: seedUsed,
      trade_pool_size: deriveTradePool(rows),
      factor_pool_size: deriveFactorPool(rows),
      stop_when: { rows, memory_pct: 75, elapsed_seconds: 600 },
    };
    // Wave 6.10 — MAXLEN cap. Manual entry wins; otherwise auto-flip when
    // rows exceed the api-side default cap (DEFAULT_STREAM_MAXLEN).
    const parsedMaxlen = parseManualMaxlen(streamMaxlen);
    if (parsedMaxlen instanceof Error) return parsedMaxlen.message;
    if (parsedMaxlen !== null) cfg.stream_maxlen = parsedMaxlen;
    else if (rows > DEFAULT_STREAM_MAXLEN) cfg.stream_maxlen = rows;
    return { cfg, seedUsed };
  }

  async function runWithSanityCheck(
    cfg: GeneratorConfig | null,
    rowsForCheck: number,
    seedUsed: number | null,
  ) {
    setFormError(null);
    setPreRunStep(null);
    clearRun();
    // Wave 6.17 — when the panel wires the full orchestrator (preflight →
    // rebuild-if-needed → /ingest/shards), defer to it and surface per-step
    // labels via setPreRunStep. Throws propagate to formError so the operator
    // sees the exact reason inline; the run halts before startRun. This
    // supersedes preflightGate so the Advanced submit path cannot bypass
    // /ingest/shards alignment.
    if (onPreRun && cfg) {
      try {
        await onPreRun(cfg, setPreRunStep);
      } catch (e) {
        setFormError((e as Error).message);
        setPreRunStep(null);
        return;
      }
    } else if (preflightGate) {
      // Wave 5.47b — legacy gate (no rebuild) for callers that haven't
      // adopted onPreRun; ok=false blocks submit and points to the banner.
      const pf = await preflightGate();
      if (pf && pf.ok === false) {
        setFormError("Pre-flight failed. Use the Rebuild indexes button above.");
        setPreRunStep(null);
        return;
      }
    }
    let mem: ObservabilityMemoryResponse | null = null;
    try { mem = await getObservabilityMemory(); } catch { mem = null; }
    const est = mem ? computeSanity(rowsForCheck, mem) : null;
    if (!est) {
      startRun(cfg);
      setPreRunStep(null);
      if (seedUsed !== null) {
        setLastSeed(seedUsed);
        setPendingSeed(null);
      }
      return;
    }
    setPreRunStep(null);
    setPending({ cfg, rows: rowsForCheck, est });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    clearRun();
    if (advancedOpen) {
      // Wave 5.52 — advanced-mode submit: ship user-entered values verbatim.
      const built = buildAdvancedConfig();
      if (typeof built === "string") { setFormError(built); return; }
      const effectiveRows = built.class_split
        ? Object.values(built.class_split).reduce((a, b) => a + b, 0)
        : built.rows ?? DEFAULT_GEN_ROWS;
      // Capture the seed actually sent so the "Last seed" pill updates.
      const seedNum = typeof built.seed === "number"
        ? built.seed
        : typeof built.seed === "string" && /^-?\d+$/.test(built.seed)
          ? Number(built.seed)
          : null;
      await runWithSanityCheck(built, effectiveRows, seedNum);
      return;
    }
    // Simple mode: auto-derive trade/factor pool, class_split, stop_when.
    const built = buildSimpleConfig();
    if (typeof built === "string") { setFormError(built); return; }
    await runWithSanityCheck(built.cfg, rows, built.seedUsed);
  }

  function onRandomSeed() {
    setSeed(String(Math.floor(Math.random() * 1_000_000_000)));
  }

  // Wave 5.52 — quick-pick row buttons. Pure UX: set the Total rows input
  // and clear any staged canonical seed (a non-canonical row count is a
  // signal the user is moving away from the canonical demo).
  function onQuickPickRows(n: number): void {
    setRows(n);
    setPendingSeed(null);
  }

  // Wave 5.52 — class-mix percent input. Integer 0..100 per channel; the
  // mix-sum pill enforces the equality-to-100 invariant before submit.
  function onMixChange(c: (typeof GENERATOR_CLASSES)[number], raw: string): void {
    const n = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(0, Math.min(100, Math.floor(n)));
    setMixPct((prev) => ({ ...prev, [c]: clamped }));
    setPendingSeed(null);
  }

  // Wave 5.52 — Reset to canonical demo. Stages the fixed-seed run that
  // reproduces the 0.6846 GIRR.Delta result. User still has to click
  // Generate to fire it (matches the spec mockup's two-button layout).
  function onResetToCanonical(): void {
    setRows(CANONICAL_DEMO_ROWS);
    setMixPct({ ...CANONICAL_DEMO_MIX });
    setPendingSeed(CANONICAL_DEMO_SEED);
    // Wave 6.10 — restore the Delta+Vega sens-type pair so the 200-row
    // canonical canary stays bit-identical to the calc-live-200k anchors
    // (CANONICAL_DEMO_SENS_TYPES). Also drop any manual MAXLEN override so
    // the 200-row run requires no cap argument at all.
    setSensTypes(new Set(CANONICAL_DEMO_SENS_TYPES));
    setStreamMaxlen("");
    setFormError(null);
  }

  async function onCopyLastSeed(): Promise<void> {
    if (lastSeed === null) return;
    const text = formatSeedHex(lastSeed);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch { /* clipboard unavailable — still show the tooltip for feedback */ }
    setSeedCopied(true);
    window.setTimeout(() => setSeedCopied(false), 1500);
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
        {/* Wave 5.52 — simple-mode controls: Total rows + Class mix. The
            advanced disclosure below reveals the full historical form. */}
        <div className="generator-form__row" data-testid="generator-total-rows">
          <label htmlFor="gen-total-rows">Total rows</label>
          <input
            id="gen-total-rows"
            type="number"
            min={1}
            max={100_000_000}
            value={rows}
            disabled={busy}
            onChange={(e) => onQuickPickRows(Number(e.target.value) || 0)}
          />
          <span className="generator-form__quick-picks" data-testid="generator-quick-picks">
            {QUICK_PICK_ROWS.map((q) => (
              <button
                key={q.value}
                type="button"
                className="btn btn--secondary"
                disabled={busy}
                onClick={() => onQuickPickRows(q.value)}
                data-testid={`generator-quick-pick-${q.label}`}
              >
                {q.label}
              </button>
            ))}
          </span>
        </div>

        <fieldset
          className="generator-form__group"
          disabled={busy}
          data-testid="generator-class-mix"
        >
          <legend>Class mix (sum = 100%)</legend>
          {GENERATOR_CLASSES.map((c) => (
            <div key={c} className="generator-form__row">
              <label htmlFor={`gen-mix-${c}`}>{c}</label>
              <input
                id={`gen-mix-${c}`}
                type="number"
                min={0}
                max={100}
                step={1}
                value={mixPct[c] ?? 0}
                disabled={busy}
                onChange={(e) => onMixChange(c, e.target.value)}
              />
              <span className="generator-form__hint">%</span>
            </div>
          ))}
          {!mixValid ? (
            <span
              className="generator-form__pill generator-form__pill--warn"
              data-testid="generator-mix-pill"
              role="status"
            >
              Class mix must sum to 100 (currently {mixSum})
            </span>
          ) : null}
        </fieldset>

        {maxlenHint?.kind === "auto" ? (
          <div
            className="generator-form__hint generator-form__hint--info"
            data-testid="ingest-maxlen-auto"
            role="status"
          >
            Stream cap auto-set to {maxlenHint.cap.toLocaleString()} entries — no truncation. Override in Advanced.
          </div>
        ) : maxlenHint?.kind === "warn" ? (
          <div
            className="generator-form__hint generator-form__hint--warn"
            data-testid="ingest-maxlen-warn"
            role="status"
          >
            ⚠ Stream cap is {maxlenHint.cap.toLocaleString()} entries; this run produces {maxlenHint.rows.toLocaleString()} rows. Only the most recent {maxlenHint.cap.toLocaleString()} will be retained.
          </div>
        ) : null}

        <div className="generator-form__actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !mixValid}
            data-testid="generator-generate-btn"
          >
            {busy ? "Generating…" : "Generate"}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={onResetToCanonical}
            data-testid="generator-reset-canonical-btn"
          >
            Reset to canonical demo
          </button>
        </div>

        {lastSeed !== null ? (
          <div className="generator-form__last-seed" data-testid="generator-last-seed">
            <span>Last seed: </span>
            <button
              type="button"
              className="generator-form__seed-copy"
              onClick={() => { void onCopyLastSeed(); }}
              data-testid="generator-last-seed-copy"
              aria-label={`Copy last seed ${formatSeedHex(lastSeed)}`}
            >
              <code>{formatSeedHex(lastSeed)}</code>
            </button>
            {seedCopied ? (
              <span className="generator-form__hint" data-testid="generator-last-seed-copied">Copied</span>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          className="generator-form__advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls="generator-form-advanced"
          onClick={() => setAdvancedOpen((v) => !v)}
          data-testid="generator-advanced-toggle"
        >
          {advancedOpen ? "▾ Hide advanced…" : "▸ Show advanced…"}
        </button>
        {advancedOpen ? (
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
              disabled={busy || classSplitActive}
              onChange={(e) => setRows(Number(e.target.value) || 0)}
            />
            {classSplitActive ? (
              <span className="generator-form__hint" data-testid="gen-rows-hint">
                Controlled by per-class targets below — sum = {classSplitSum}
              </span>
            ) : null}
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
              falls back to round-robin via classes + rows.
              Wave 5.50 — legend renamed to "Per-class row targets"; live sum
              line surfaces below the table to disambiguate vs the Rows
              field above (which is disabled while class_split is active). */}
          <fieldset className="generator-form__group" disabled={busy} data-testid="generator-class-split">
            <legend>Per-class row targets</legend>
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
            <span className="generator-form__hint" data-testid="class-split-sum">
              {classSplitActive
                ? `Sum: ${classSplitSum} rows`
                : "Sum: 0 rows (using Rows + round-robin)"}
            </span>
            {!classSplitActive ? (
              <span className="generator-form__hint">leave blank / all zero to use Rows + round-robin</span>
            ) : null}
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

          {/* Wave 6.11b — explicit stream-shard fan-out dial. Default "auto"
              omits stream_shards from the body so the server uses the
              profile-derived value (1 on standalone-presenting targets);
              4/8/16/32 ship as numbers, "per-bucket" ships as a literal
              string. Useful on Redis Enterprise DMC where the target
              advertises redis_mode=standalone but is actually clustered. */}
          <div className="generator-form__row" data-testid="ingest-stream-shards">
            <label htmlFor="gen-stream-shards">Stream fan-out (hash-tag slots)</label>
            <select
              id="gen-stream-shards"
              value={streamShards}
              disabled={busy}
              onChange={(e) => setStreamShards(e.target.value)}
            >
              <option value="auto">1 (auto / profile-derived)</option>
              <option value="4">4</option>
              <option value="8">8</option>
              <option value="16">16</option>
              <option value="32">32</option>
              <option value="per-bucket">per-bucket</option>
            </select>
            <span className="generator-form__hint">
              Profile auto picks 1 on standalone-presenting targets. If your
              target is Redis Enterprise behind a DMC proxy (cluster hidden),
              set 16 or 32 for balanced fan-out.
            </span>
          </div>

          {/* Wave 5.52 — Advanced disclosure always surfaces the raw trade /
              factor pool inputs (preset just stages new values into them); in
              the new UX the simple-mode card is the abstraction layer. */}
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

          {/* Wave 6.10 — manual stream MAXLEN override. Empty ⇒ simple-mode
              auto-flips to rows when rows > DEFAULT_STREAM_MAXLEN. 0 opts out
              of the cap entirely (XADD bit-identical to pre-5.92C). */}
          <div className="generator-form__row">
            <label htmlFor="gen-stream-maxlen">Stream cap (MAXLEN)</label>
            <input
              id="gen-stream-maxlen"
              type="number"
              min={0}
              placeholder="auto"
              value={streamMaxlen}
              disabled={busy}
              onChange={(e) => setStreamMaxlen(e.target.value)}
              data-testid="generator-stream-maxlen"
            />
            <span className="generator-form__hint">empty = auto-flip to rows above 2M · 0 = no cap</span>
          </div>

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
        </div>
        ) : null}

        {preRunStep ? (
          <div
            className="generator-form__status"
            role="status"
            data-testid="generator-prerun-step"
          >
            {preRunStep}
          </div>
        ) : null}
        {run && (run.status === "running" || run.status === "cancelling") ? (
          <GeneratorProgress run={run} onCancel={onCancelRun} />
        ) : null}
        <IndexingProgress />
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

// Wave 6.41.E — Indexing progress bar.
// Wave 6.41.E.fix3 — bar data source switched from `xlen` to the
// strictly-monotonic `consumed` counter (services/ingest publishes
// `ingest:consumed:<stream>` at 1Hz; api surfaced it via
// /admin/stream-status). Unbounded streams (stream_maxlen=0) never see
// xlen shrink, so the prior peak-xlen design pinned the bar at 0% for
// large/overnight presets.
// Wave 6.41.E.fix4 — IndexingProgress no longer reads `xlen` for any
// state decision. The implicit-anchor seed (xlen>0 ⇒ create anchor) is
// removed because on maxlen=0 streams it re-fired immediately after the
// 3s "Indexing complete" toast cleared the anchor, pinning the bar at
// 0%. The xlen===0 auto-clear hatch is replaced by a plateau signal
// that works on unbounded streams.
// Wave 6.44.D — bar data source switched from the ingest `consumed`
// counter to the live FT.SEARCH * doc count against the active sens
// index (surfaced through /admin/index-count). The consumed counter
// leads the index by the ingest write lag, so the bar previously
// overshot what a calc query could actually see. pct =
// (indexCountNow - indexCountAtAnchor) / rowsTotal across both
// in-generation and post-terminal phases — the split branch stays gone.
// Wave 6.52.A — bar data source switched back to the strictly-monotonic
// `consumed` counter (/admin/stream-status).
// Wave 6.52.C — bar data source reverted to /admin/index-count. The
// `consumed` counter is per-worker-process and in-memory (resets on
// restart) and the generator fans 1 logical row → ~2 stream entries, so
// it is an unreliable denominator. `index-count` is the ground truth
// for "sens queryable in Redis"; the 6.52.B atTarget gating already
// prevents the bar from vanishing early if the generator finishes before
// the index catches up. pct = (indexCountNow - indexCountAtAnchor) /
// rowsTotal across both in-generation and post-terminal phases — the
// split branch stays gone. 2.5s poll cadence is preserved.
const INDEXING_POLL_MS = 2_500;
const INDEXING_COMPLETE_MS = 3_000;
const INDEXING_WINDOW = 10;

function formatIntCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${Math.round(n)}`;
}

function formatEtaSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function IndexingProgress() {
  const { run } = useGeneratorRun();
  // Wave 6.44.B — active-target label drives per-target anchor isolation.
  // While the label is `null` (first paint before /redis/active-target
  // resolves) we skip all anchor reads/writes — the storage layer needs a
  // label to form the v3 key.
  const targetLabel = useActiveTargetLabel();
  const [currentIndexCount, setCurrentIndexCount] = useState<number | null>(null);
  const [samples, setSamples] = useState<IndexCountSample[]>([]);
  const [anchor, setAnchor] = useState<IndexingAnchor | null>(null);
  const [completeShownAt, setCompleteShownAt] = useState<number | null>(null);
  const prevRunStatusRef = useRef<string | null>(null);
  // Wave 6.44.F — tracks whether the previous render saw a non-null `run`.
  // Used by the defensive auto-clear effect below to detect ANY transition
  // from a present run to `null` (registry eviction, grace-expiry, manual
  // clear, Stop-all-runs) so we can unconditionally drop the indexing
  // anchor and avoid the "stuck bar at 0%" leak.
  const prevRunPresenceRef = useRef<boolean>(false);
  // Wave 6.41.E.fix (A) — timeout id held in a ref (not state) so re-renders
  // during the 3s "Indexing complete" toast do not cancel it via the effect
  // cleanup path that was the root cause of the stuck-toast bug.
  const completeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Shared reset used by the auto-clear escape hatches and the 3s completion
  // timeout callback. Wave 6.44.B — clears storage only for the active label;
  // anchors on other targets are left intact.
  const resetIndexingState = (): void => {
    if (completeTimeoutRef.current !== null) {
      clearTimeout(completeTimeoutRef.current);
      completeTimeoutRef.current = null;
    }
    if (targetLabel) clearAnchor(targetLabel);
    setAnchor(null);
    setCompleteShownAt(null);
    setSamples([]);
  };

  // Mount + target-switch: load the anchor for the live target. Re-runs
  // when `targetLabel` changes so flipping active cluster swaps the
  // displayed anchor in-place (the storage layer is partitioned by label
  // so each target keeps its own anchor across switches).
  useEffect(() => {
    if (!targetLabel) {
      setAnchor(null);
      return;
    }
    const a = readAnchor(targetLabel);
    setAnchor(a);
  }, [targetLabel]);

  // Unmount: cancel any pending completion timeout to avoid setState on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (completeTimeoutRef.current !== null) {
        clearTimeout(completeTimeoutRef.current);
        completeTimeoutRef.current = null;
      }
    };
  }, []);

  // Wave 6.52.C — poll /admin/index-count for the live FT.SEARCH * count
  // against the active sens-index. Errors are swallowed — the next tick
  // retries.
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      getIndexCount()
        .then((s) => {
          if (cancelled) return;
          const indexCount = typeof s.count === "number" ? s.count : 0;
          setCurrentIndexCount(indexCount);
          setSamples((prev) => pushSample(prev, { indexCount, ts: Date.now() }, INDEXING_WINDOW));
        })
        .catch(() => { /* swallow transient errors */ });
    };
    tick();
    const id = setInterval(tick, INDEXING_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Wave 6.44.D — restart detection. If the live counter ever drops below
  // the anchor's baseline, the counter was reset (FLUSHDB,
  // /admin/bootstrap, or a fresh index); re-seed `indexCountAtAnchor` at
  // the new value so the bar continues smoothly without going negative.
  useEffect(() => {
    if (anchor === null || currentIndexCount === null) return;
    if (!targetLabel || anchor.targetLabel !== targetLabel) return;
    if (currentIndexCount >= anchor.indexCountAtAnchor) return;
    const now = Date.now();
    const next: IndexingAnchor = {
      ...anchor,
      indexCountAtAnchor: currentIndexCount,
      lastSeenAt: now,
    };
    writeAnchor(targetLabel, next);
    setAnchor(next);
  }, [anchor, currentIndexCount, targetLabel]);

  // Implicit-anchor seed removed by 6.41.E.fix4: on unbounded streams
  // (stream_maxlen=0) xlen never returns to 0, so a "xlen>0 ⇒ seed anchor"
  // effect re-fired immediately after the 3s "Indexing complete" toast
  // cleared the previous anchor and pinned the bar at 0%. The localStorage
  // anchor and the run-status transitions below are the only seed paths.
  // A future reconnect-mid-drain heuristic should gate on
  // run.status === "running" from /generator/runs, not on xlen/index-count
  // deltas.

  // Run-status transitions:
  //  • running just started ⇒ wipe any stale anchor + samples then seed a
  //    fresh anchor at the current index-count baseline so the in-generation
  //    bar grows from 0% toward run.rowsTotal.
  //  • running/cancelling ⇒ done/cancelled ⇒ leave the existing run anchor
  //    in place; it already has the correct baseline. If no anchor exists
  //    (page opened mid-run with localStorage cleared) seed one now using
  //    `run.rowsTotal` as the denominator.
  useEffect(() => {
    const prev = prevRunStatusRef.current;
    const status = run?.status ?? null;
    prevRunStatusRef.current = status;
    if (prev === status) return;
    const isStartingRun = status === "running"
      && prev !== "running"
      && prev !== "cancelling";
    if (isStartingRun) {
      resetIndexingState();
      // Seed the anchor immediately when we have an index-count sample to
      // anchor against; otherwise the in-generation effect below picks it
      // up on the next poll.
      if (targetLabel && currentIndexCount !== null && (run?.rowsTotal ?? 0) > 0) {
        const now = Date.now();
        const a: IndexingAnchor = {
          runId: run?.runId ?? null,
          rowsTotal: run!.rowsTotal,
          indexCountAtAnchor: currentIndexCount,
          anchorTs: now,
          lastSeenAt: now,
          targetLabel,
        };
        writeAnchor(targetLabel, a);
        setAnchor(a);
      }
      return;
    }
    // Wave 6.44.E — explicit-cancel / error transition while an anchor is
    // still in place. If the indexed delta has NOT reached rowsTotal yet,
    // hard-clear the bar immediately; the prior "3s complete toast" path
    // only runs when pct hits 100% so a stopped/errored run would otherwise
    // leave the bar stranded until tab close. The running→done case is
    // intentionally excluded: the indexer may briefly lag the generator
    // and the existing post-terminal anchor display is the right UX for
    // that case.
    //
    // Wave 6.52.B — the prior `runDropped` branch (status non-null → null,
    // i.e. registry-eviction / grace-expiry / Stop-all-runs auto-dismiss)
    // was folded into this immediate-clear path and killed the bar mid-
    // drain when context dropped the run before the indexer caught up.
    // FT.SEARCH can lag the generator by many seconds, so a silent run-
    // eviction is no longer a reliable terminal signal. The runDropped path
    // is removed here; cleanup falls through to the 6.44.F backstop below
    // (clears once index catches up) or to the plateau-hatch effect (~25s
    // no-progress window). Explicit cancelled/error transitions are
    // unchanged.
    const becomesTerminal = (status === "done" || status === "cancelled" || status === "error")
      && (prev === "running" || prev === "cancelling");
    const becomesCancelOrError = (status === "cancelled" || status === "error")
      && (prev === "running" || prev === "cancelling");
    if (becomesCancelOrError) {
      if (anchor !== null) {
        const indexed = currentIndexCount !== null
          ? currentIndexCount - anchor.indexCountAtAnchor
          : 0;
        const atTarget = anchor.rowsTotal > 0 && indexed >= anchor.rowsTotal;
        if (!atTarget) {
          resetIndexingState();
        }
        return;
      }
    }
    if (!becomesTerminal) return;
    if (anchor !== null) return;
    if (currentIndexCount === null) return;
    if (!targetLabel) return;
    const rowsTotal = run?.rowsTotal ?? 0;
    if (rowsTotal <= 0) return;
    const now = Date.now();
    const a: IndexingAnchor = {
      runId: run?.runId ?? null,
      rowsTotal,
      indexCountAtAnchor: currentIndexCount,
      anchorTs: now,
      lastSeenAt: now,
      targetLabel,
    };
    writeAnchor(targetLabel, a);
    setAnchor(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status, run?.runId, run?.rowsTotal, anchor, currentIndexCount, targetLabel]);

  // While a run is active and the anchor is still missing (e.g. first poll
  // hadn't landed when the run started), seed it as soon as the index-count
  // sample arrives so the bar appears on the very next render.
  useEffect(() => {
    if (anchor !== null) return;
    const status = run?.status ?? null;
    if (status !== "running" && status !== "cancelling") return;
    if (currentIndexCount === null) return;
    if (!targetLabel) return;
    const rowsTotal = run?.rowsTotal ?? 0;
    if (rowsTotal <= 0) return;
    const now = Date.now();
    const a: IndexingAnchor = {
      runId: run?.runId ?? null,
      rowsTotal,
      indexCountAtAnchor: currentIndexCount,
      anchorTs: now,
      lastSeenAt: now,
      targetLabel,
    };
    writeAnchor(targetLabel, a);
    setAnchor(a);
  }, [anchor, run?.status, run?.runId, run?.rowsTotal, currentIndexCount, targetLabel]);

  // Wave 6.44.F — defensive auto-clear, gated by Wave 6.52.B. When `run`
  // transitions from non-null to null (any cause: registry-eviction,
  // grace-expiry, manual clear, Stop-all-runs flipping the registry entry
  // terminal then auto-dismiss dropping it from context) and an anchor still
  // exists, clear the indexing state ONLY when the index has actually
  // reached the target (atTarget). FT.SEARCH can lag the generator by many
  // seconds, and the run object is often evicted from context before the
  // index has caught up — clearing here unconditionally killed the bar
  // mid-flight at e.g. 60%. When the index has NOT caught up, fall through
  // to the existing plateau-hatch effect (~25s window) and the completion-
  // toast effect, both of which fire once `indexCount` reaches
  // `indexCountAtAnchor + rowsTotal`. The cancel/error path above already
  // handles the not-atTarget case via its own `becomesCancelOrError` branch.
  useEffect(() => {
    const wasPresent = prevRunPresenceRef.current;
    const isPresent = run !== null;
    prevRunPresenceRef.current = isPresent;
    if (wasPresent && !isPresent && anchor !== null) {
      const indexed = currentIndexCount !== null
        ? currentIndexCount - anchor.indexCountAtAnchor
        : 0;
      const atTarget = anchor.rowsTotal > 0 && indexed >= anchor.rowsTotal;
      if (atTarget) {
        resetIndexingState();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, anchor, currentIndexCount]);

  // Wave 6.41.E.fix (A) — pct reached 100% with an active anchor ⇒ show
  // the completion banner for INDEXING_COMPLETE_MS then clear. The timeout
  // id lives in a ref so the re-render caused by setCompleteShownAt does
  // not cancel the pending timeout via React's effect cleanup.
  useEffect(() => {
    if (anchor === null) return;
    if (currentIndexCount === null) return;
    const indexed = currentIndexCount - anchor.indexCountAtAnchor;
    const atTarget = anchor.rowsTotal > 0 && indexed >= anchor.rowsTotal;
    if (!atTarget) {
      // Slipped back below target (rare — restart-detection handles the
      // common case). Cancel any pending toast / clear the complete banner.
      if (completeTimeoutRef.current !== null) {
        clearTimeout(completeTimeoutRef.current);
        completeTimeoutRef.current = null;
      }
      setCompleteShownAt(null);
      return;
    }
    if (completeTimeoutRef.current !== null) return; // already scheduled
    setCompleteShownAt(Date.now());
    const clearLabel = anchor.targetLabel;
    completeTimeoutRef.current = setTimeout(() => {
      completeTimeoutRef.current = null;
      clearAnchor(clearLabel);
      setAnchor(null);
      setCompleteShownAt(null);
      setSamples([]);
    }, INDEXING_COMPLETE_MS);
  }, [anchor, currentIndexCount]);

  // Wave 6.41.E.fix4 — plateau auto-clear. The prior xlen===0 hatches never
  // fired on maxlen=0 streams (xlen is cumulative-ever). Replaced with:
  // when every sample in the window already reflects
  // indexCount >= indexCountAtAnchor + rowsTotal AND no run is active, the
  // bar has nothing left to display and the 3s completion toast has had
  // ample time to run; drop the anchor as a fallback dismiss path. The
  // sample window (10 × 2.5s = 25s) is long enough that the 3s toast wins
  // in the happy path.
  useEffect(() => {
    if (anchor === null) return;
    if (samples.length < 2) return;
    const runActive = run?.status === "running" || run?.status === "cancelling";
    if (runActive) return;
    const target = anchor.indexCountAtAnchor + anchor.rowsTotal;
    const allAtTarget = samples.every((s) => s.indexCount >= target);
    if (!allAtTarget) return;
    resetIndexingState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, anchor, run?.status]);

  // Render decision. Single phase: bar is visible iff an anchor exists and
  // we have observed at least one index-count poll. The in-generation /
  // post-terminal split is gone — both compute pct off the same formula.
  // Wave 6.44.B — also evict when the in-memory anchor was created against
  // a different active target than the one currently selected. The mount
  // effect re-reads on label change so this guard only fires for the one
  // render between a label flip and the re-read settling.
  if (anchor === null || currentIndexCount === null) return null;
  if (!targetLabel || anchor.targetLabel !== targetLabel) return null;

  const showingComplete = completeShownAt !== null;
  const rawIndexed = currentIndexCount - anchor.indexCountAtAnchor;
  const indexed = Math.max(0, rawIndexed);
  const pct = showingComplete
    ? 100
    : computePct(anchor.indexCountAtAnchor, currentIndexCount, anchor.rowsTotal);
  const denomLabel = anchor.rowsTotal;
  const ratePerSec = computeRatePerSec(samples);
  const projectedRemaining = Math.max(0, denomLabel - indexed);
  const etaSeconds = !showingComplete
    && denomLabel > 0
    && ratePerSec !== null
    && ratePerSec > 0
    ? projectedRemaining / ratePerSec
    : null;

  const metaContent: JSX.Element = showingComplete ? (
    <span data-testid="indexing-complete">Indexing complete</span>
  ) : (
    <>
      <span data-testid="indexing-progress-text">
        {indexed.toLocaleString()} / {denomLabel.toLocaleString()} indexed ({Math.round(pct)}%)
      </span>
      <span className="generator-form__progress-stats" data-testid="indexing-progress-stats">
        {ratePerSec === null || denomLabel <= 0 ? (
          "ETA unknown"
        ) : (
          <>
            {formatIntCompact(ratePerSec)} rows/s · ETA {etaSeconds !== null ? formatEtaSeconds(etaSeconds) : "—"}
          </>
        )}
      </span>
    </>
  );

  return (
    <div
      className="generator-form__progress indexing-progress"
      data-testid="indexing-progress"
      role="status"
      aria-live="polite"
    >
      <div className="indexing-progress__label">Indexing (sens → redis)</div>
      <div
        className="generator-form__progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className="generator-form__progress-fill indexing-progress__fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="generator-form__progress-meta">
        {metaContent}
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

// Wave 5.44 / 6.53.A — confirmation for "Stop generators". Same dialog
// shape as FlushDbConfirmModal so the layout stays consistent. Copy
// reflects the non-destructive semantics introduced in 6.53.A: cancelling
// active producer runs leaves the stream backlog and indexed rows in place.
// Use the dedicated "Flush DB" button when a wipe is intended.
function StopAllRunsConfirmModal(props: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { onCancel, onConfirm } = props;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Stop generators confirmation">
      <div className="dialog sanity-modal--block" data-testid="stop-all-runs-modal">
        <h2>Stop active generators?</h2>
        <div className="sanity-modal__body">
          Stops the active generators. Data and stream backlog are kept. Use &apos;Flush DB&apos; to wipe.
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

// Wave 6.32.C — Force reset confirmation. Same dialog shape as
// FlushDbConfirmModal / StopAllRunsConfirmModal so the layout stays
// consistent. Copy reflects the destructive semantics documented on the
// ingest runtime: the abandoned MultiConsumer is detached, not stopped, and
// any in-flight messages it owns may be lost.
function ResetShardsConfirmModal(props: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { onCancel, onConfirm } = props;
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-label="Force reset ingest shards confirmation">
      <div className="dialog sanity-modal--block" data-testid="ingest-fanout-reset-modal">
        <h2>Force-reset the ingest rebuild mutex?</h2>
        <div className="sanity-modal__body">
          This abandons the in-flight rebuild on the ingest service without waiting for it to drain. Any messages
          owned by the abandoned consumer may be lost. Use this only when a rebuild appears stuck (e.g. after a
          mid-ingest flush). The next "Apply" will spawn a fresh consumer.
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel} data-testid="ingest-fanout-reset-cancel">
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} data-testid="ingest-fanout-reset-confirm">
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

export default IngestPanel;

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
  startGenerator,
  startIngest,
  type GeneratorConfig,
  type GeneratorStartResponse,
  type Source,
} from "../lib/ingest";

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
        </PanelCard>
        <PanelCard title="Memory growth">
          <svg data-testid="chart-memory" viewBox="0 0 360 80" width="100%" height="80" role="img" aria-label="memory usage chart">
            {memPath.area ? <path d={memPath.area} fill="rgba(138, 180, 199, 0.18)" /> : null}
            {memPath.line ? <path d={memPath.line} fill="none" stroke="#8AB4C7" strokeWidth="2" /> : null}
          </svg>
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

// Wave 5.17b — configurable synthetic generator. Always rendered as its own
// PanelCard so the demo can top up sensitivities:in with explicit row count,
// class mix, sensitivity types, seed, and HSBC-style pool sizes.
function SyntheticGeneratorCard() {
  const [rows, setRows] = useState<number>(DEFAULT_GEN_ROWS);
  const [classes, setClasses] = useState<Set<string>>(() => new Set(GENERATOR_CLASSES));
  const [sensTypes, setSensTypes] = useState<Set<string>>(() => new Set(["Delta", "Vega"]));
  const [seed, setSeed] = useState<string>("0");
  const [tradePool, setTradePool] = useState<string>(""); // empty = auto (api derives)
  const [factorPool, setFactorPool] = useState<number>(DEFAULT_GEN_FACTOR_POOL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratorStartResponse | null>(null);

  function toggleMember(prev: Set<string>, value: string): Set<string> {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!Number.isFinite(rows) || rows < 100 || rows > 2000) {
      setError("Rows must be between 100 and 2000.");
      return;
    }
    if (classes.size === 0) {
      setError("Select at least one risk class.");
      return;
    }
    if (sensTypes.size === 0) {
      setError("Select at least one sensitivity type.");
      return;
    }
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
    if (tradeTrim !== "") {
      cfg.trade_pool_size = Number(tradeTrim);
    }
    setBusy(true);
    try {
      const r = await startGenerator(cfg);
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onRandomSeed() {
    setSeed(String(Math.floor(Math.random() * 1_000_000_000)));
  }

  return (
    <PanelCard title="Synthetic generator">
      <form className="generator-form" onSubmit={onSubmit} aria-label="Synthetic generator">
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
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? (
              <>
                <span className="generator-form__spinner" aria-hidden="true">⟳</span>
                Generating…
              </>
            ) : (
              "Generate"
            )}
          </button>
        </div>

        {error ? (
          <div className="generator-form__error" role="alert">{error}</div>
        ) : null}
        {result && !error ? (
          <div className="generator-form__status" data-testid="generator-status">
            Generated {result.rows_queued} rows in {result.ms}ms
            {result.run_id ? <> · run_id <code>{result.run_id}</code></> : null}
          </div>
        ) : null}
      </form>
    </PanelCard>
  );
}

export default IngestPanel;

import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { EnterpriseCallout, PanelCard, Sparkline, TimingStrip } from "../components";
import type { ShardTiming } from "../components/TimingStrip";
import {
  postCalcSbm,
  type BucketResult,
  type CalcCommands,
  type CalcSbmResponse,
  type SensitivityType,
} from "../lib/calc";
import { EmptyTargetError } from "../lib/empty-target";
import { formatCharge } from "../lib/format";
import { fetchPivot, type PivotDoc, type PivotRow } from "../lib/pivot";

type RiskClass = "GIRR" | "Equity" | "FX";
type SortKey = "bucket" | "K_b" | "S_b" | "count" | "ms";
type Tone = "green" | "amber" | "red";
type BucketClass = "girr" | "equity" | "fx";

const RISK_CLASS_OPTIONS: Array<{ value: RiskClass; label: string; live: boolean }> = [
  { value: "GIRR", label: "GIRR", live: true },
  { value: "Equity", label: "Equity", live: true },
  { value: "FX", label: "FX", live: true },
];

const SENSITIVITY_OPTIONS: SensitivityType[] = ["Delta", "Vega", "Curvature"];

// Wave 5.18: standard tenor ordering for GIRR Delta/Vega risk_value arrays —
// used as sparkline x-axis labels so hovers read "3M → 0.842".
const GIRR_TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"];

// Wave 5.18: Basel-clause caption shown beneath the hero charge tile. Switches
// per sensitivity type; risk_class is substituted live from the result context.
function baselCaption(rc: string, st: SensitivityType): string {
  if (st === "Curvature") {
    return `${rc} · Curvature · MAR21 §21.5(5) Cross-bucket reduce (γ² · ψ-gated)`;
  }
  return `${rc} · ${st} · MAR21 §21.4(5) Cross-bucket reduce`;
}

// Wave 5.18: derive the visual class for a bucket label so chart + table pills
// can carry a class-aware accent (GIRR currency / Equity sector / FX pair).
function bucketClassFor(riskClass: RiskClass): BucketClass {
  if (riskClass === "Equity") return "equity";
  if (riskClass === "FX") return "fx";
  return "girr";
}

function toneFor(totalMs: number): Tone {
  if (totalMs < 2000) return "green";
  if (totalMs < 5000) return "amber";
  return "red";
}

// Re-export so unit tests can import the formatter alongside the panel.
export { formatCharge };

function compareBuckets(a: BucketResult, b: BucketResult, key: SortKey): number {
  if (key === "bucket") return a.bucket.localeCompare(b.bucket);
  return (b[key] as number) - (a[key] as number);
}

function shardsFromResponse(r: CalcSbmResponse): ShardTiming[] {
  return r.shard_breakdown.map((s, i) => ({
    id: `${s.shard}-${i}`,
    label: s.shard,
    ms: s.ms,
  }));
}

// Wave 5.16n: on standalone Redis (single shard, sub-ms FCALL) the per-shard
// panel is all-zero noise — suppress unless there's something to look at.
function hasMeaningfulShardTiming(r: CalcSbmResponse): boolean {
  if (r.shard_breakdown.length <= 1) return false;
  return r.shard_breakdown.some((s) => (s.ms ?? 0) > 0);
}

function bucketToneFor(share: number): Tone {
  if (share > 0.4) return "red";
  if (share >= 0.2) return "amber";
  return "green";
}

// Wave 5.18: small class-aware pill for bucket labels — GIRR currencies in
// blue-ish, Equity sector numbers in amber, FX pairs in teal. Accent comes
// from data-class so a single CSS rule per class controls colour.
function BucketPill({
  bucket,
  bucketClass,
  riskClass,
}: {
  bucket: string;
  bucketClass: BucketClass;
  riskClass: RiskClass;
}) {
  return (
    <span
      className="bucket-pill"
      data-class={bucketClass}
      data-testid="bucket-pill"
      aria-label={`${riskClass} bucket ${bucket}`}
    >
      {bucket}
    </span>
  );
}

// Wave 5.16n: at-a-glance capital-concentration chart. K_b descending,
// per-bucket horizontal bars mirroring TimingStrip's scaleX pattern.
// Wave 5.18: each row is a click-toggle for an accordion drill-down.
function BucketChargeChart({
  buckets,
  riskClass,
  expanded,
  onToggle,
  renderDrilldown,
}: {
  buckets: BucketResult[];
  riskClass: RiskClass;
  expanded: Set<string>;
  onToggle: (bucket: string) => void;
  renderDrilldown: (bucket: string) => JSX.Element | null;
}) {
  if (buckets.length === 0) {
    return <div className="bucket-chart__empty">no buckets yet</div>;
  }
  const sorted = [...buckets].sort((a, b) => b.K_b - a.K_b);
  const maxK = Math.max(...sorted.map((b) => b.K_b), 1);
  const totalK = sorted.reduce((acc, b) => acc + b.K_b, 0);
  const bClass = bucketClassFor(riskClass);
  return (
    <div className="bucket-chart" role="list" data-testid="bucket-chart">
      {sorted.map((b) => {
        const share = totalK > 0 ? b.K_b / totalK : 0;
        const tone = bucketToneFor(share);
        const sBSign = b.S_b >= 0 ? "+" : "";
        const isOpen = expanded.has(b.bucket);
        const drillId = `bucket-drilldown-chart-${b.bucket}`;
        return (
          <div role="listitem" key={b.bucket}>
            <div
              className="bucket-chart__row"
              data-testid="bucket-chart-row"
              data-bucket={b.bucket}
              data-expanded={isOpen ? "true" : "false"}
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              aria-controls={drillId}
              aria-label={`Drill into bucket ${b.bucket}`}
              onClick={() => onToggle(b.bucket)}
              onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle(b.bucket);
                }
              }}
            >
              <BucketPill bucket={b.bucket} bucketClass={bClass} riskClass={riskClass} />
              <div className="bucket-chart__bar" aria-hidden="true">
                <div
                  className="bucket-chart__bar-fill"
                  data-tone={tone}
                  style={{ transform: `scaleX(${Math.max(b.K_b / maxK, 0.02)})` }}
                />
              </div>
              <span className="bucket-chart__value">{formatCharge(b.K_b)}</span>
              <span className="bucket-chart__meta">
                {b.count} sens · S_b {sBSign}
                {formatCharge(b.S_b)}
              </span>
            </div>
            {isOpen ? (
              <div id={drillId} className="bucket-drilldown bucket-drilldown--chart">
                {renderDrilldown(b.bucket)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function CalcPanel() {
  const [riskClass, setRiskClass] = useState<RiskClass>("GIRR");
  const [sensitivityType, setSensitivityType] = useState<SensitivityType>("Delta");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CalcSbmResponse | null>(null);
  // Wave 5.18: capture the (risk_class, sensitivity_type) at compute time so
  // the Basel caption and drill-down /pivot queries stay aligned with the
  // displayed result even if the user edits the form afterwards.
  const [resultContext, setResultContext] = useState<{ riskClass: RiskClass; sensitivityType: SensitivityType } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyError, setEmptyError] = useState<EmptyTargetError | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  // Wave 5.18: separate expansion sets for chart vs table so clicking a row
  // in one view doesn't echo an accordion in the other — drill-down sits
  // directly below the clicked row, nothing else.
  const [chartExpanded, setChartExpanded] = useState<Set<string>>(new Set());
  const [tableExpanded, setTableExpanded] = useState<Set<string>>(new Set());

  const isWave4 = riskClass !== "GIRR";

  async function onCalculate() {
    setLoading(true);
    setError(null);
    setEmptyError(null);
    setResult(null);
    setResultContext(null);
    setSortKey(null);
    setChartExpanded(new Set());
    setTableExpanded(new Set());
    try {
      const r = await postCalcSbm({ risk_class: riskClass, sensitivity_type: sensitivityType });
      setResult(r);
      setResultContext({ riskClass, sensitivityType });
    } catch (e) {
      if (e instanceof EmptyTargetError) {
        setEmptyError(e);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  function makeToggle(setter: (fn: (prev: Set<string>) => Set<string>) => void) {
    return (bucket: string) => {
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(bucket)) next.delete(bucket);
        else next.add(bucket);
        return next;
      });
    };
  }
  const toggleChart = makeToggle(setChartExpanded);
  const toggleTable = makeToggle(setTableExpanded);

  const sortedBuckets = result
    ? sortKey
      ? [...result.per_bucket].sort((a, b) => compareBuckets(a, b, sortKey))
      : result.per_bucket
    : [];

  return (
    <div className="calc-panel">
      <h1>Calc</h1>
      <p className="calc-panel__lead">
        SBM risk charge — Delta or Vega, computed inside Redis via map-reduce across hash-tagged buckets.
      </p>

      <div className="calc-panel__callouts">
        <EnterpriseCallout signal="Functions">
          <strong>In-database compute</strong> — SBM math runs inside Redis via Redis Functions; no row-by-row network round-trip.
        </EnterpriseCallout>
        <EnterpriseCallout signal="ClusterScaleOut">
          <strong>Map-Reduce</strong> — one FCALL per bucket fans out across shards; coordinator aggregates K_b → risk-class charge.
        </EnterpriseCallout>
        <EnterpriseCallout signal="RQE">
          <strong>Hash-tag locality</strong> — <code>sens:{"{risk_class:bucket}"}:...</code> hash tag keeps every bucket's FCALL slot-local.
        </EnterpriseCallout>
      </div>

      <PanelCard
        title="Calculate"
        actions={
          <button
            type="button"
            className="calc-panel__cta"
            onClick={onCalculate}
            disabled={loading}
            data-testid="calc-cta"
          >
            {loading ? "Calculating…" : "Calculate SBM risk charge"}
          </button>
        }
      >
        <div className="calc-panel__form">
          <label className="calc-panel__field">
            <span>Risk class</span>
            <select
              value={riskClass}
              onChange={(e) => setRiskClass(e.target.value as RiskClass)}
            >
              {RISK_CLASS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {isWave4 ? <span className="calc-panel__badge calc-panel__badge--wave4">Wave 4</span> : null}
          </label>
          <label className="calc-panel__field">
            <span>Sensitivity type</span>
            <select
              value={sensitivityType}
              onChange={(e) => setSensitivityType(e.target.value as SensitivityType)}
            >
              {SENSITIVITY_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
      </PanelCard>

      {emptyError ? <CalcEmptyBanner err={emptyError} /> : null}

      {error ? (
        <div role="alert" className="calc-panel__error">
          {error}
        </div>
      ) : null}

      {!result && !error && !emptyError && !loading ? (
        <PanelCard title="Result">
          <p className="calc-panel__empty">Press Calculate to fan out a slot-local FCALL per bucket.</p>
        </PanelCard>
      ) : null}

      {result && resultContext ? (
        <CalcResult
          result={result}
          context={resultContext}
          sortKey={sortKey}
          setSortKey={setSortKey}
          sortedBuckets={sortedBuckets}
          chartExpanded={chartExpanded}
          tableExpanded={tableExpanded}
          onToggleChart={toggleChart}
          onToggleTable={toggleTable}
        />
      ) : null}
    </div>
  );
}

// Wave 5.16z3: friendly amber banner shown in place of the red error when
// the api signals "your target just has no data yet" (412 bootstrap pending
// or 503 no-data-or-index) rather than a real fault.
function CalcEmptyBanner({ err }: { err: EmptyTargetError }) {
  const kind = err.status === 412 ? "bootstrap" : "no-data";
  return (
    <div
      role="status"
      className="panel-callout panel-callout--amber"
      data-testid="empty-target-banner"
      data-kind={kind}
    >
      {err.status === 412 ? (
        <>
          Bootstrapping <strong>{err.target_label ?? "this target"}</strong>
          {err.bootstrap_phase ? <> — {err.bootstrap_phase}</> : null}. Calc will
          be available once it's ready.
        </>
      ) : (
        <>
          <strong>
            {err.risk_class ?? "This target"}
            {err.measure ? ` / ${err.measure}` : ""}
          </strong>{" "}
          has indexes but no FRTB data yet
          {err.hint ? <> — {err.hint}</> : null}. Go to the Sources tab to
          ingest.
        </>
      )}
    </div>
  );
}

// Wave 5.18: prefers-reduced-motion query, cached at module load. JSDOM in
// the unit test environment doesn't implement matchMedia; treat that as
// "reduced motion" so the animation is a no-op under test.
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

// Wave 5.19: small inline pill that labels which §21.5(5) branch produced
// the curvature charge — primary positive-interior path or the §21.5(5)(b)
// S_b-clipped fallback. Rendered only when the api response includes the
// `curvature_branch` field (i.e. curvature legs); omitted for Delta/Vega.
function CurvatureBranchPill({
  branch,
}: {
  branch: "positive_interior" | "fallback_clipped_s";
}) {
  const isFallback = branch === "fallback_clipped_s";
  const label = isFallback
    ? "§21.5(5)(b) · S_b clipped fallback"
    : "§21.5(5) · positive interior";
  const tooltip = isFallback
    ? "interior was negative; recomputed with S_b clipped into [-K_b, +K_b] per §21.5(5)(b)"
    : "Σ K_b² + Σ γ² · S_b · S_c ≥ 0; standard §21.5(5) charge";
  return (
    <span
      className="curvature-branch-pill"
      data-branch={branch}
      data-testid="curvature-branch-pill"
      title={tooltip}
    >
      {label}
    </span>
  );
}

// Wave 5.18: charge tile with a ~600ms ease-out count-up on fresh result.
function AnimatedCharge({ value }: { value: number }) {
  const [displayed, setDisplayed] = useState<number>(() => (prefersReducedMotion() ? value : 0));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplayed(value);
      return;
    }
    const start = performance.now();
    const duration = 600;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic: 1 - (1 - t)^3
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayed(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplayed(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <div className="calc-panel__charge" data-testid="calc-charge">
      {formatCharge(displayed)}
    </div>
  );
}

function CalcResult({
  result,
  context,
  sortKey,
  setSortKey,
  sortedBuckets,
  chartExpanded,
  tableExpanded,
  onToggleChart,
  onToggleTable,
}: {
  result: CalcSbmResponse;
  context: { riskClass: RiskClass; sensitivityType: SensitivityType };
  sortKey: SortKey | null;
  setSortKey: (k: SortKey) => void;
  sortedBuckets: BucketResult[];
  chartExpanded: Set<string>;
  tableExpanded: Set<string>;
  onToggleChart: (bucket: string) => void;
  onToggleTable: (bucket: string) => void;
}) {
  const tone = toneFor(result.total_ms);
  const bClass = bucketClassFor(context.riskClass);
  const caption = baselCaption(context.riskClass, context.sensitivityType);

  const renderDrilldown = (bucket: string, source: "chart" | "table") => (
    <BucketDrilldown
      key={`${bucket}-${context.riskClass}-${context.sensitivityType}-${source}`}
      bucket={bucket}
      riskClass={context.riskClass}
      sensitivityType={context.sensitivityType}
      bucketResult={result.per_bucket.find((p) => p.bucket === bucket)}
      onClose={() => (source === "chart" ? onToggleChart(bucket) : onToggleTable(bucket))}
    />
  );

  return (
    <>
      <PanelCard
        title="Risk-class charge"
        actions={
          <span
            className={`calc-panel__wallclock calc-panel__wallclock--${tone}`}
            data-testid="wallclock-badge"
            data-tone={tone}
          >
            Total wall-clock: {result.total_ms} ms · fanout {result.fanout_ms} ms
          </span>
        }
      >
        <div className="calc-panel__charge-row">
          <AnimatedCharge value={result.charge} />
          {result.curvature_branch ? (
            <CurvatureBranchPill branch={result.curvature_branch} />
          ) : null}
        </div>
        <p className="calc-panel__basel-caption" data-testid="basel-caption">
          {caption}
        </p>
      </PanelCard>

      {hasMeaningfulShardTiming(result) ? (
        <PanelCard title="Per-shard timing">
          <TimingStrip shards={shardsFromResponse(result)} />
        </PanelCard>
      ) : null}

      {result.commands ? <CommandsPanel commands={result.commands} /> : null}

      <PanelCard title="Per-bucket K_b (capital concentration)">
        <BucketChargeChart
          buckets={result.per_bucket}
          riskClass={context.riskClass}
          expanded={chartExpanded}
          onToggle={onToggleChart}
          renderDrilldown={(b) => renderDrilldown(b, "chart")}
        />
      </PanelCard>

      <PanelCard title="Per-bucket breakdown">
        <table aria-label="per-bucket K_b breakdown" className="calc-panel__table">
          <thead>
            <tr>
              <th>
                <button type="button" onClick={() => setSortKey("bucket")} aria-label="Sort by bucket">
                  Bucket{sortKey === "bucket" ? " ▾" : ""}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => setSortKey("K_b")} aria-label="Sort by K_b">
                  K_b{sortKey === "K_b" ? " ▾" : ""}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => setSortKey("S_b")} aria-label="Sort by S_b">
                  S_b{sortKey === "S_b" ? " ▾" : ""}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => setSortKey("count")} aria-label="Sort by count">
                  count{sortKey === "count" ? " ▾" : ""}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => setSortKey("ms")} aria-label="Sort by ms">
                  ms{sortKey === "ms" ? " ▾" : ""}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedBuckets.map((b) => {
              const isOpen = tableExpanded.has(b.bucket);
              const drillId = `bucket-drilldown-table-${b.bucket}`;
              return (
                <Fragment key={b.bucket}>
                  <tr
                    data-testid="bucket-row"
                    data-bucket={b.bucket}
                    data-expanded={isOpen ? "true" : "false"}
                    aria-expanded={isOpen}
                    aria-controls={drillId}
                    onClick={() => onToggleTable(b.bucket)}
                    onKeyDown={(e: KeyboardEvent<HTMLTableRowElement>) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onToggleTable(b.bucket);
                      }
                    }}
                    tabIndex={0}
                  >
                    <td>
                      <BucketPill bucket={b.bucket} bucketClass={bClass} riskClass={context.riskClass} />
                    </td>
                    <td>{formatCharge(b.K_b)}</td>
                    <td>{formatCharge(b.S_b)}</td>
                    <td>{b.count}</td>
                    <td>{b.ms}</td>
                  </tr>
                  {isOpen ? (
                    <tr className="bucket-drilldown-row">
                      <td colSpan={5} id={drillId}>
                        <div className="bucket-drilldown bucket-drilldown--table">
                          {renderDrilldown(b.bucket, "table")}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </PanelCard>
    </>
  );
}

// Wave 5.18: per-bucket drill-down. Fetches /pivot for (risk_class, bucket,
// sensitivity_type) and renders a small "Top trades" table inside the
// accordion. Empty/error states stay scoped to the drill-down — a failed
// fetch doesn't kill the surrounding CalcPanel.
const DRILLDOWN_LIMIT = 20;
const DRILLDOWN_CEILING = 200;

type DrilldownState =
  | { status: "loading" }
  | { status: "loaded"; rows: PivotRow[]; total: number; offset: number }
  | { status: "empty-target"; err: EmptyTargetError }
  | { status: "error"; message: string };

function toFiniteArray(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
}

function readScalar(rv: unknown, key: string): number | null {
  if (rv && typeof rv === "object" && key in (rv as Record<string, unknown>)) {
    const v = (rv as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function DrilldownValueCell({
  doc,
  riskClass,
  sensitivityType,
}: {
  doc: PivotDoc;
  riskClass: RiskClass;
  sensitivityType: SensitivityType;
}) {
  const rv = doc.risk_value;
  if (riskClass === "GIRR") {
    if (sensitivityType === "Curvature") {
      const up = toFiniteArray(
        rv && typeof rv === "object" && "cvr_up" in (rv as Record<string, unknown>)
          ? (rv as Record<string, unknown>).cvr_up
          : [],
      );
      const down = toFiniteArray(
        rv && typeof rv === "object" && "cvr_down" in (rv as Record<string, unknown>)
          ? (rv as Record<string, unknown>).cvr_down
          : [],
      );
      return (
        <Sparkline
          points={up}
          pointsB={down}
          series={2}
          labels={GIRR_TENORS}
          ariaLabel={`Curvature cvr_up vs cvr_down for ${doc.trade_id ?? "trade"}`}
        />
      );
    }
    const pts = toFiniteArray(rv);
    return (
      <Sparkline
        points={pts}
        labels={GIRR_TENORS}
        ariaLabel={`${sensitivityType} 10-tenor curve for ${doc.trade_id ?? "trade"}`}
      />
    );
  }
  // Equity / FX
  if (sensitivityType === "Curvature") {
    const up = readScalar(rv, "up");
    const down = readScalar(rv, "down");
    return (
      <span className="drilldown-curv-pill" data-testid="drilldown-curv-pill">
        <span className="drilldown-curv-pill__up">↑{up !== null ? formatCharge(up) : "—"}</span>
        <span className="drilldown-curv-pill__down">↓{down !== null ? formatCharge(down) : "—"}</span>
      </span>
    );
  }
  // Equity/FX Delta or Vega — spot scalar
  const spot = readScalar(rv, "spot");
  const value = spot !== null ? spot : typeof rv === "number" && Number.isFinite(rv) ? rv : null;
  return (
    <span className="drilldown-scalar" data-testid="drilldown-scalar">
      {value !== null ? formatCharge(value) : "—"}
    </span>
  );
}

function BucketDrilldown({
  bucket,
  riskClass,
  sensitivityType,
  bucketResult,
  onClose,
}: {
  bucket: string;
  riskClass: RiskClass;
  sensitivityType: SensitivityType;
  bucketResult: BucketResult | undefined;
  onClose: () => void;
}) {
  const [state, setState] = useState<DrilldownState>({ status: "loading" });
  const firstFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchPivot({ risk_class: riskClass, bucket, sensitivity_type: sensitivityType, limit: DRILLDOWN_LIMIT, offset: 0 })
      .then((resp) => {
        if (cancelled) return;
        setState({ status: "loaded", rows: resp.rows, total: resp.total, offset: 0 });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof EmptyTargetError) setState({ status: "empty-target", err: e });
        else setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, riskClass, sensitivityType]);

  useEffect(() => {
    // Focus the close button on open so keyboard users land inside the panel.
    firstFocusRef.current?.focus();
  }, []);

  async function loadMore() {
    if (state.status !== "loaded") return;
    const nextOffset = state.offset + DRILLDOWN_LIMIT;
    if (nextOffset >= state.total || nextOffset >= DRILLDOWN_CEILING) return;
    try {
      const resp = await fetchPivot({
        risk_class: riskClass,
        bucket,
        sensitivity_type: sensitivityType,
        limit: DRILLDOWN_LIMIT,
        offset: nextOffset,
      });
      setState({
        status: "loaded",
        rows: [...state.rows, ...resp.rows],
        total: resp.total,
        offset: nextOffset,
      });
    } catch (e: unknown) {
      if (e instanceof EmptyTargetError) setState({ status: "empty-target", err: e });
      else setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  const k = bucketResult?.K_b ?? 0;
  const s = bucketResult?.S_b ?? 0;

  return (
    <div
      className="bucket-drilldown__inner"
      data-testid="bucket-drilldown"
      data-bucket={bucket}
      role="region"
      aria-label={`Drill-down for bucket ${bucket}`}
      onKeyDown={onKeyDown}
    >
      <div className="bucket-drilldown__header">
        <h4 className="bucket-drilldown__title">Top trades in bucket {bucket}</h4>
        <button
          ref={firstFocusRef}
          type="button"
          className="bucket-drilldown__close"
          onClick={onClose}
          aria-label={`Close drill-down for bucket ${bucket}`}
          data-testid="bucket-drilldown-close"
        >
          ✕
        </button>
      </div>
      <div aria-live="polite" data-testid="bucket-drilldown-live">
        {state.status === "loaded"
          ? `Drill-down for bucket ${bucket} expanded — ${state.rows.length} trades loaded`
          : ""}
      </div>
      {state.status === "loading" ? (
        <div className="bucket-drilldown__loading" data-testid="bucket-drilldown-loading">
          Loading trades…
        </div>
      ) : null}
      {state.status === "empty-target" ? (
        <div className="panel-callout panel-callout--amber" role="status" data-testid="bucket-drilldown-empty">
          <strong>{state.err.target_label ?? "Target"}</strong> has no FRTB data yet
          {state.err.hint ? <> — {state.err.hint}</> : null}.
        </div>
      ) : null}
      {state.status === "error" ? (
        <div role="alert" className="bucket-drilldown__error" data-testid="bucket-drilldown-error">
          {state.message}
        </div>
      ) : null}
      {state.status === "loaded" && state.rows.length === 0 ? (
        <p className="bucket-drilldown__empty" data-testid="bucket-drilldown-no-rows">
          No trades returned — bucket data may be stale.
        </p>
      ) : null}
      {state.status === "loaded" && state.rows.length > 0 ? (
        <>
          <table className="bucket-drilldown__table" aria-label={`trades in bucket ${bucket}`}>
            <thead>
              <tr>
                <th>trade_id</th>
                <th>risk_factor</th>
                <th>risk_value</th>
                <th>weight</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => (
                <tr key={row.key} data-testid="drilldown-row" data-trade-id={row.doc.trade_id ?? ""}>
                  <td>
                    <span className="drilldown-pill drilldown-pill--trade">
                      {row.doc.trade_id ?? row.key}
                    </span>
                  </td>
                  <td>
                    <span className="drilldown-pill drilldown-pill--rf">
                      {row.doc.risk_factor ?? "—"}
                    </span>
                  </td>
                  <td>
                    <DrilldownValueCell
                      doc={row.doc}
                      riskClass={riskClass}
                      sensitivityType={sensitivityType}
                    />
                  </td>
                  <td>
                    {sensitivityType === "Curvature"
                      ? "—"
                      : typeof row.doc.weight === "number"
                      ? formatCharge(row.doc.weight)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="bucket-drilldown__footer">
            <span data-testid="bucket-drilldown-footer">
              Showing top {state.rows.length} of {state.total} trades · K_b = {formatCharge(k)} · S_b ={" "}
              {formatCharge(s)}
            </span>
            <button
              type="button"
              className="bucket-drilldown__load-more"
              onClick={loadMore}
              disabled={
                state.offset + DRILLDOWN_LIMIT >= state.total ||
                state.offset + DRILLDOWN_LIMIT >= DRILLDOWN_CEILING
              }
              data-testid="bucket-drilldown-load-more"
            >
              Load 20 more
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// Wave 5.16m: read-only observability panel that renders the exact Redis
// commands the api dispatched. Surfaces the Redis Enterprise primitives
// (RediSearch FT.AGGREGATE for discovery, Redis Functions FCALL for the
// slot-local fan-out) in plain view for the HSBC demo. Display-only — no
// re-execution, no logging beyond the api response.
function CommandsPanel({ commands }: { commands: CalcCommands }) {
  const codeStyle: CSSProperties = {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    margin: 0,
  };
  const captionStyle: CSSProperties = {
    marginTop: "0.25rem",
    fontSize: "0.8125rem",
    color: "var(--redis-text-secondary, #666)",
  };

  const d = commands.discovery;
  const discoveryOneLiner = `${d.command} ${d.index} "${d.query}" GROUPBY ${d.groupby.length} ${d.groupby.join(" ")} REDUCE ${d.reducers.join(" ")} LIMIT 0 10000 DIALECT 2`;
  const f = commands.fcall;

  return (
    <PanelCard title="Redis commands executed">
      <div aria-live="polite" data-testid="redis-commands">
        <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.9375rem" }}>Discovery (FT.AGGREGATE)</h3>
        <pre style={codeStyle}>
          <code data-testid="discovery-command">{discoveryOneLiner}</code>
        </pre>
        <p style={captionStyle}>
          Counts how many sensitivities exist per bucket so we know which shards to fan out to.
        </p>

        <h3 style={{ margin: "1rem 0 0.5rem", fontSize: "0.9375rem" }}>
          Per-bucket fanout (FCALL)
        </h3>
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.8125rem" }}>
          Function: <strong data-testid="fcall-function">{f.function}</strong> · Library:{" "}
          <strong data-testid="fcall-library">{f.library}</strong>
        </p>
        <pre style={codeStyle}>
          <code data-testid="fcall-command">{f.arg_template}</code>
        </pre>
        <p style={captionStyle}>
          Runs the SBM K_b reduction inside Redis, slot-local per bucket via the hash-tagged
          routing key.
        </p>
        <details style={{ marginTop: "0.5rem" }} data-testid="fcall-dispatched-keys">
          <summary>Dispatched keys ({f.dispatched_keys.length})</summary>
          <pre style={codeStyle}>
            <code>{f.dispatched_keys.join("\n")}</code>
          </pre>
        </details>
      </div>
    </PanelCard>
  );
}

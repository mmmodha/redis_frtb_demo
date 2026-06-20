import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { BlockMath, InlineMath } from "react-katex";
import { CommandPreview, EnterpriseCallout, PanelCard, Sparkline, TimingStrip } from "../components";
import { CalcByDesk } from "../components/CalcByDesk";
import { SuggestCombobox } from "../components/SuggestCombobox";
import type { ShardTiming } from "../components/TimingStrip";
import {
  postBucketCrossDetail,
  postCalcSbm,
  postCalcSbmTotal,
  type BucketResult,
  type CalcCacheState,
  type CalcCommands,
  type CalcEngine,
  type CalcSbmResponse,
  type CorrelationRegime,
  type CrossComponent,
  type CvrComponent,
  type SensitivityType,
  type TotalSbmBreakdownRow,
  type TotalSbmLeg,
  type TotalSbmResponse,
  type WsComponent,
} from "../lib/calc";
import { EmptyTargetError } from "../lib/empty-target";
import { formatCharge } from "../lib/format";
import { fetchPivot, type PivotDoc, type PivotRow } from "../lib/pivot";
import { useFacets } from "../hooks/useFacets";

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

// Basel MAR21.6 three-regime cross-bucket γ scaler. The api echoes back which
// regime was applied; the result-card RegimeBadge reads label + hint from
// here so values can't drift between API and UI.
const REGIME_OPTIONS: Array<{ value: CorrelationRegime; label: string; factor: number; hint: string }> = [
  { value: "low", label: "Low", factor: 0.75, hint: "γ × 0.75" },
  { value: "medium", label: "Med", factor: 1.0, hint: "γ × 1.0" },
  { value: "high", label: "High", factor: 1.25, hint: "γ × 1.25 (cap 1)" },
];

// Scenario picker — replaces the visible "Low/Med/High" segmented control with
// plain-English regulatory framing. The default "standard" scenario omits the
// `correlation_regime` field entirely so the default-path /calc/sbm body stays
// byte-identical to the pre-scenario happy path.
type ScenarioKey = "standard" | "stress-low" | "stress-high";
const SCENARIO_OPTIONS: Array<{
  value: ScenarioKey;
  label: string;
  regime: CorrelationRegime | null;
  tooltip: string;
}> = [
  {
    value: "standard",
    label: "Standard charge",
    regime: null,
    tooltip: "Basel medium correlation — the day-to-day regulatory charge.",
  },
  {
    value: "stress-low",
    label: "Stress: low correlation",
    regime: "low",
    tooltip: "Decorrelated stress — buckets diverge, typical of crisis dispersion.",
  },
  {
    value: "stress-high",
    label: "Stress: high correlation",
    regime: "high",
    tooltip: "Co-movement stress — buckets move together, typical of flight-to-quality.",
  },
];

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

// Wave 5.96F — humanise ms values that span four orders of magnitude
// (cache hits land in the single-digit ms range, cold computes can hit
// 20+ seconds). The headline chip needs both: "Computed in 21.05 s
// (cached, served in 12 ms)".
function formatComputeMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms} ms`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}
function formatServedMs(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms} ms`;
  if (ms < 1) return `<1 ms`;
  return `${Math.round(ms)} ms`;
}
// Wave 5.96N — parallelism factor on cold runs lands in the 1–N range
// (e.g. ×18.00); on cache hits it can blow up to the hundreds of
// thousands (e.g. ×146,770) once we source the cold cumulative. Format
// big values as comma-grouped integers and small values with two
// decimals so both regimes read naturally.
function formatParallelismFactor(factor: number): string {
  if (!Number.isFinite(factor)) return `${factor}`;
  if (Math.abs(factor) >= 1000) return Math.round(factor).toLocaleString("en-US");
  return factor.toFixed(2);
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

// localStorage key for the "Show Redis commands" toggle. Persisted across
// sessions so the demo-viewer setting survives reloads.
//
// Wave 6.44.B audit — intentionally global (not target-scoped). This is a
// UI display preference of the operator, not a per-cluster fact; the same
// human wants to see (or hide) the Redis commands panel regardless of
// which target is active.
const SHOW_REDIS_COMMANDS_KEY = "calc.show-redis-commands";

// Reads the initial state of `showRedisCommands` from the environment. If the
// URL carries `?demo=1`, the toggle is force-enabled (and the preference is
// written back to localStorage) so demo wrappers can flip verbose mode on
// without manual clicking. Otherwise we honour the prior localStorage value.
function readInitialShowRedisCommands(): boolean {
  if (typeof window === "undefined") return false;
  let isDemo = false;
  try {
    isDemo = new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    isDemo = false;
  }
  if (isDemo) {
    try {
      window.localStorage.setItem(SHOW_REDIS_COMMANDS_KEY, "true");
    } catch {
      // best-effort — localStorage may be unavailable
    }
    return true;
  }
  try {
    return window.localStorage.getItem(SHOW_REDIS_COMMANDS_KEY) === "true";
  } catch {
    return false;
  }
}

export function CalcPanel() {
  const [riskClass, setRiskClass] = useState<RiskClass>("GIRR");
  const [sensitivityType, setSensitivityType] = useState<SensitivityType>("Delta");
  // Wave 5.56 — facet counts narrow the risk_class / sensitivity_type
  // dropdowns to what's actually in the active index, with row counts
  // shown next to each label.
  const { facets } = useFacets();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CalcSbmResponse | null>(null);
  // Wave 5.18: capture the (risk_class, sensitivity_type) at compute time so
  // the Basel caption and drill-down /pivot queries stay aligned with the
  // displayed result even if the user edits the form afterwards.
  const [resultContext, setResultContext] = useState<{ riskClass: RiskClass; sensitivityType: SensitivityType } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyError, setEmptyError] = useState<EmptyTargetError | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  // Separate expansion sets for chart vs table so clicking a row in one view
  // doesn't echo an accordion in the other — drill-down sits directly below
  // the clicked row, nothing else.
  const [chartExpanded, setChartExpanded] = useState<Set<string>>(new Set());
  const [tableExpanded, setTableExpanded] = useState<Set<string>>(new Set());
  // Optional discovery-layer subset. `null` = no subset (default, sends every
  // bucket); `Set<string>` = user has interacted with the pills. Carried
  // across runs so a refine→Calculate cycle preserves the selection.
  const [bucketSubset, setBucketSubset] = useState<Set<string> | null>(null);
  // Scenario picker — "standard" is the default and a no-op on the wire (we
  // omit the `correlation_regime` field), preserving the byte-identical
  // default-path body shape and keeping the Redis commands panel clean.
  const [scenario, setScenario] = useState<ScenarioKey>("standard");
  // Kernel-side row-exclusion predicate sets. Stored as Set<string> so
  // add/remove via chips stays O(1). Empty sets are not serialised onto the
  // wire — mirrors the "don't send the default" convention so the
  // default-path body shape stays byte-identical.
  const [excludeBooks, setExcludeBooks] = useState<Set<string>>(new Set());
  const [excludeTrades, setExcludeTrades] = useState<Set<string>>(new Set());
  const [excludeFactors, setExcludeFactors] = useState<Set<string>>(new Set());
  // Mirrors PivotPanel's fuzzy toggle. `false` ⇒ the exclude comboboxes stop
  // fetching /suggest and the dropdown stays closed; they remain plain text
  // inputs so the user can still commit free-text chips.
  const [fuzzy, setFuzzy] = useState<boolean>(true);
  // Visibility toggle for the "Redis commands executed" panel. Hidden by
  // default for end users; persisted via localStorage so the choice survives
  // reloads, and force-enabled by the `?demo=1` URL param on first load.
  const [showRedisCommands, setShowRedisCommands] = useState<boolean>(
    readInitialShowRedisCommands,
  );
  // Tracks whether the user has explicitly opened the Advanced disclosure
  // this session. Combined with the auto-open conditions below to derive the
  // `open` prop on <details> — once any auto-open condition is true, the
  // details stay open regardless.
  const [advancedManuallyOpened, setAdvancedManuallyOpened] = useState<boolean>(false);

  // Wave 5.96B — Total SBM orchestrator state. Independent of the per-cell
  // form so a Total run doesn't disturb the active risk_class / sensitivity
  // / scenario picks. bucket_subset + exclude are shared because the same
  // filters apply uniformly across every cell of the 27-cell matrix.
  const [totalLoading, setTotalLoading] = useState(false);
  const [totalResult, setTotalResult] = useState<TotalSbmResponse | null>(null);
  const [totalError, setTotalError] = useState<string | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SHOW_REDIS_COMMANDS_KEY,
        showRedisCommands ? "true" : "false",
      );
    } catch {
      // best-effort — localStorage may be unavailable
    }
  }, [showRedisCommands]);

  const excludeTotal = excludeBooks.size + excludeTrades.size + excludeFactors.size;
  // Auto-open Advanced whenever a non-default setting is in play, so the
  // controls that produced the deviation stay discoverable.
  const advancedAutoOpen =
    excludeTotal > 0 || bucketSubset !== null || !fuzzy || showRedisCommands;
  const advancedOpen = advancedManuallyOpened || advancedAutoOpen;

  // Wave 5.56 — narrow the static risk_class / sensitivity_type lists to
  // values that have rows in the live index, and surface the count next to
  // each label. When facets are null (api error) or empty-index, fall back
  // to the full static lists so the form remains usable.
  const liveFacets = facets !== null && facets.ok === true && facets.total_rows > 0 ? facets : null;
  const calcRiskClassOptions = useMemo(() => {
    if (!liveFacets) return RISK_CLASS_OPTIONS.map((o) => ({ ...o, count: null as number | null }));
    return RISK_CLASS_OPTIONS
      .filter((o) => (liveFacets.risk_class[o.value] ?? 0) > 0)
      .map((o) => ({ ...o, count: liveFacets.risk_class[o.value]! }));
  }, [liveFacets]);
  const calcSensitivityOptions = useMemo(() => {
    if (!liveFacets) return SENSITIVITY_OPTIONS.map((s) => ({ value: s, count: null as number | null }));
    return SENSITIVITY_OPTIONS
      .filter((s) => (liveFacets.sensitivity_type[s] ?? 0) > 0)
      .map((s) => ({ value: s, count: liveFacets.sensitivity_type[s]! }));
  }, [liveFacets]);

  async function onCalculate() {
    setLoading(true);
    setError(null);
    setEmptyError(null);
    setSortKey(null);
    setChartExpanded(new Set());
    setTableExpanded(new Set());
    try {
      // Only send `bucket_subset` when the user has actively narrowed below
      // the available bucket set — sending a full-list subset wastes bytes
      // and clutters the "Redis commands executed" panel.
      const sendSubset =
        result !== null &&
        bucketSubset !== null &&
        bucketSubset.size < result.per_bucket.length;
      const subsetArr = sendSubset ? Array.from(bucketSubset!) : undefined;
      // Only send `correlation_regime` when the Scenario maps to a non-null
      // regime (i.e. anything other than "Standard charge") — preserves the
      // byte-identical default-path body shape.
      const scenarioOpt = SCENARIO_OPTIONS.find((s) => s.value === scenario);
      const scenarioRegime = scenarioOpt?.regime ?? null;
      // Build the optional `exclude` only when at least one list is non-empty
      // — same "don't send the default" convention.
      const excludeBody: Record<string, string[]> = {};
      if (excludeBooks.size > 0) excludeBody.book = Array.from(excludeBooks);
      if (excludeTrades.size > 0) excludeBody.trade_id = Array.from(excludeTrades);
      if (excludeFactors.size > 0) excludeBody.risk_factor = Array.from(excludeFactors);
      const sendExclude = Object.keys(excludeBody).length > 0;
      const r = await postCalcSbm({
        risk_class: riskClass,
        sensitivity_type: sensitivityType,
        ...(subsetArr ? { bucket_subset: subsetArr } : {}),
        ...(scenarioRegime ? { correlation_regime: scenarioRegime } : {}),
        ...(sendExclude ? { exclude: excludeBody } : {}),
      });
      setResult(r);
      setResultContext({ riskClass, sensitivityType });
    } catch (e) {
      setResult(null);
      setResultContext(null);
      if (e instanceof EmptyTargetError) {
        setEmptyError(e);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  // Wave 5.96B — Total SBM orchestrator handler. Fires a single
  // /calc/sbm/total request that fans out the 27-cell matrix server-side;
  // bucket_subset + exclude carry the same "don't send the default" rule
  // as onCalculate so the body stays byte-minimal on the default path.
  async function onCalculateTotal() {
    setTotalLoading(true);
    setTotalError(null);
    try {
      const excludeBody: Record<string, string[]> = {};
      if (excludeBooks.size > 0) excludeBody.book = Array.from(excludeBooks);
      if (excludeTrades.size > 0) excludeBody.trade_id = Array.from(excludeTrades);
      if (excludeFactors.size > 0) excludeBody.risk_factor = Array.from(excludeFactors);
      const sendExclude = Object.keys(excludeBody).length > 0;
      const sendSubset =
        result !== null &&
        bucketSubset !== null &&
        bucketSubset.size < result.per_bucket.length;
      const subsetArr = sendSubset ? Array.from(bucketSubset!) : undefined;
      const r = await postCalcSbmTotal({
        ...(subsetArr ? { bucket_subset: subsetArr } : {}),
        ...(sendExclude ? { exclude: excludeBody } : {}),
      });
      setTotalResult(r);
    } catch (e) {
      setTotalResult(null);
      setTotalError(e instanceof Error ? e.message : String(e));
    } finally {
      setTotalLoading(false);
    }
  }

  function toggleSubsetBucket(bucket: string) {
    setBucketSubset((prev) => {
      // First interaction starts from "all selected" — the visible default.
      const base = prev ?? new Set(result?.per_bucket.map((p) => p.bucket) ?? []);
      const next = new Set(base);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }

  function resetSubset() {
    setBucketSubset(null);
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
      <h1>Calculation</h1>
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

      <PanelCard title="Calculate">
        <div className="calc-panel__form">
          <label className="calc-panel__field">
            <span>Risk class</span>
            <select
              value={riskClass}
              onChange={(e) => setRiskClass(e.target.value as RiskClass)}
            >
              {calcRiskClassOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="calc-panel__field">
            <span>Sensitivity</span>
            <select
              value={sensitivityType}
              onChange={(e) => setSensitivityType(e.target.value as SensitivityType)}
            >
              {calcSensitivityOptions.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.value}
                </option>
              ))}
            </select>
          </label>
          <ScenarioSelect scenario={scenario} onChange={setScenario} />
        </div>
        <div className="calc-panel__cta-row">
          <button
            type="button"
            className="calc-panel__cta"
            onClick={onCalculate}
            disabled={loading || (bucketSubset !== null && bucketSubset.size === 0)}
            data-testid="calc-cta"
          >
            {loading ? "Calculating…" : "Calculate SBM risk charge"}
          </button>
        </div>
        <AdvancedFilters
          open={advancedOpen}
          onToggle={(next) => {
            // Only persist user clicks when no auto-open condition is forcing
            // the disclosure open — otherwise the user can never close it.
            if (!advancedAutoOpen) setAdvancedManuallyOpened(next);
          }}
          excludeTotal={excludeTotal}
          buckets={result?.per_bucket ?? []}
          riskClass={resultContext?.riskClass ?? riskClass}
          subset={bucketSubset}
          onToggleSubsetBucket={toggleSubsetBucket}
          onResetSubset={resetSubset}
          books={excludeBooks}
          trades={excludeTrades}
          factors={excludeFactors}
          onBooksChange={setExcludeBooks}
          onTradesChange={setExcludeTrades}
          onFactorsChange={setExcludeFactors}
          fuzzy={fuzzy}
          onFuzzyChange={setFuzzy}
          showRedisCommands={showRedisCommands}
          onShowRedisCommandsChange={setShowRedisCommands}
        />
      </PanelCard>

      {emptyError ? <CalcEmptyBanner err={emptyError} /> : null}

      {error ? (
        <div role="alert" className="calc-panel__error">
          {error}
        </div>
      ) : null}

      {!result && !error && !emptyError && !loading ? (
        <PanelCard title="Result">
          <p className="calc-panel__empty">Press Calculate to compute the risk charge.</p>
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
          showRedisCommands={showRedisCommands}
        />
      ) : null}

      {/* Wave 6.41.D — Top-10 desks ranked by |contribution to K_b|. Mounted
          as a separate card below the per-bucket breakdown so the by-desk
          ranking sits alongside the by-bucket view; hidden until the user
          has run a calc (resultContext pins the risk_class / sensitivity). */}
      {result && resultContext ? (
        <CalcByDesk
          riskClass={resultContext.riskClass}
          sensitivityType={resultContext.sensitivityType}
        />
      ) : null}

      <TotalSbmCard
        loading={totalLoading}
        result={totalResult}
        error={totalError}
        onCalculate={onCalculateTotal}
      />
    </div>
  );
}

// Wave 5.96B — Total SBM card. Fans out the §21.4(8) max-over-scenarios
// risk charge across the 27-cell (class × leg × scenario) matrix server-side
// and surfaces parallelism evidence so the demo can show "Redis-fast" with
// concrete numbers (wall-clock vs cumulative ms, parallelism factor).
function TotalSbmCard({
  loading,
  result,
  error,
  onCalculate,
}: {
  loading: boolean;
  result: TotalSbmResponse | null;
  error: string | null;
  onCalculate: () => void;
}) {
  // Wave 5.96D — elapsed-time counter that ticks every 250ms while the
  // orchestrator is in-flight. Sets expectation that this is a multi-second
  // operation (cold ~35s, warm ~6s) and resets cleanly between runs because
  // the effect re-runs whenever `loading` flips.
  // Wave 6.02 — also capture the final elapsed ms in the cleanup so the
  // result headline can surface a static "computed in Ns" pill alongside
  // the binding-scenario pill. Reset to null on each new run.
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finalElapsedMs, setFinalElapsedMs] = useState<number | null>(null);
  useEffect(() => {
    if (!loading) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    setFinalElapsedMs(null);
    const id = setInterval(() => setElapsedMs(Date.now() - start), 250);
    return () => {
      clearInterval(id);
      setFinalElapsedMs(Date.now() - start);
    };
  }, [loading]);
  const elapsedSeconds = elapsedMs / 1000;
  return (
    <PanelCard title="Total SBM (all classes × legs × scenarios)">
      <p className="calc-panel__lead">
        Computes the full §21.4(8) risk charge — Σ over classes of (Δ + V + Crv), max over
        Low/Med/High regimes.
      </p>
      <div className="calc-panel__cta-row">
        <button
          type="button"
          className="calc-panel__cta"
          onClick={onCalculate}
          disabled={loading}
          data-testid="calc-total-cta"
        >
          {loading
            ? "Computing risk charges across 3 scenarios…"
            : "Calculate Total SBM"}
        </button>
        {loading ? (
          <span
            className="calc-panel__total-elapsed calc-panel__total-elapsed--running"
            data-testid="calc-total-elapsed"
            aria-live="polite"
          >
            elapsed {elapsedSeconds.toFixed(elapsedSeconds < 10 ? 1 : 0)}s
          </span>
        ) : null}
      </div>
      {loading ? <TotalSbmSkeletonGrid /> : null}
      {error ? (
        <div role="alert" className="calc-panel__error">
          {error}
        </div>
      ) : null}
      {result ? (
        <TotalSbmResultView result={result} finalElapsedMs={finalElapsedMs} />
      ) : null}
    </PanelCard>
  );
}

// Wave 5.96D — placeholder 3×3 (class × leg) grid shown during in-flight so
// the user sees the structure of what's coming. Pure client-side; resolves to
// the real `TotalSbmResultView` matrix when the orchestrator response lands.
const TOTAL_SBM_SKELETON_CLASSES: ReadonlyArray<string> = ["GIRR", "Equity", "FX"];
function TotalSbmSkeletonGrid() {
  return (
    <div
      className="calc-panel__total-skeleton"
      data-testid="calc-total-skeleton"
      aria-busy="true"
      aria-label="Loading risk charges"
    >
      {TOTAL_SBM_SKELETON_CLASSES.map((rc) => (
        <div
          className="calc-panel__total-skeleton-class"
          key={rc}
          data-class={rc}
        >
          <div className="calc-panel__total-skeleton-class-name">{rc}</div>
          <div className="calc-panel__total-skeleton-legs">
            {TOTAL_SBM_LEG_ORDER.map((leg) => (
              <div
                key={leg}
                className="calc-panel__total-skeleton-cell"
                data-testid="calc-total-skeleton-cell"
                data-leg={leg}
              >
                <span className="calc-panel__total-skeleton-leg">
                  {TOTAL_SBM_LEG_LABEL[leg]}
                </span>
                <span
                  className="calc-panel__total-skeleton-shimmer"
                  aria-hidden
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Wave 5.96C — display labels for the §21.4(8) inner sum.  Δ / V / Crv
// are the Basel shorthand for delta / vega / curvature; using the symbols
// directly keeps the per-class subtotal rows compact and lines them up
// with the KaTeX-rendered formula above.
const TOTAL_SBM_SCENARIOS: CorrelationRegime[] = ["low", "medium", "high"];
const TOTAL_SBM_SCENARIO_LABEL: Record<CorrelationRegime, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};
const TOTAL_SBM_LEG_LABEL: Record<TotalSbmLeg, string> = {
  delta: "Δ",
  vega: "V",
  curvature: "Crv",
};
const TOTAL_SBM_LEG_ORDER: TotalSbmLeg[] = ["delta", "vega", "curvature"];

// Wave 5.96G-ui — hover tooltips for the per-cell ingestion badges. "empty"
// means the index has buckets but zero rows for this risk_class +
// sensitivity_type; "skipped" means the whole class has no buckets at all
// (the 503 no-data-or-index branch on /calc/sbm).
const CELL_BADGE_TOOLTIP: Record<"empty" | "skipped" | "populated", string> = {
  empty:
    "No rows of this risk_class + sensitivity_type were ingested. Charge is structurally 0.",
  skipped:
    "This class has no buckets in the index — typically the sensitivity_type was never ingested (Curvature is the common case). /calc/sbm returned 503 no-data-or-index for this cell.",
  populated: "",
};

// Preserve first-seen class order from the server breakdown so the column
// stack reads consistently across the three scenario columns.
function groupBreakdownByClass(
  breakdown: TotalSbmBreakdownRow[],
): Array<{ riskClass: string; rows: TotalSbmBreakdownRow[] }> {
  const order: string[] = [];
  const byClass = new Map<string, TotalSbmBreakdownRow[]>();
  for (const row of breakdown) {
    if (!byClass.has(row.risk_class)) {
      order.push(row.risk_class);
      byClass.set(row.risk_class, []);
    }
    byClass.get(row.risk_class)!.push(row);
  }
  return order.map((riskClass) => ({ riskClass, rows: byClass.get(riskClass)! }));
}

// Per-class (Δ + V + Crv) subtotal for one scenario column.  `allSkipped`
// distinguishes "no data" from a computed-zero subtotal so the column can
// render "(no data)" instead of "$0.00" — matches the user's request to
// keep empty vs. zero visually distinct.
function classSubtotalForScenario(
  rows: TotalSbmBreakdownRow[],
  scenario: CorrelationRegime,
): { value: number; allSkipped: boolean } {
  let value = 0;
  let computed = 0;
  for (const row of rows) {
    if (!row.skipped) {
      value += row.scenarios[scenario].charge;
      computed += 1;
    }
  }
  return { value, allSkipped: computed === 0 };
}

function TotalSbmResultView({
  result,
  finalElapsedMs,
}: {
  result: TotalSbmResponse;
  finalElapsedMs: number | null;
}) {
  const perf = result.performance;
  const totalCells = perf.redis_ops_count + perf.ops_skipped;
  const classGroups = useMemo(() => groupBreakdownByClass(result.breakdown), [result.breakdown]);
  const winningScenario = result.winning_scenario;

  // KaTeX expressions for the §21.4(8) total-charge derivation.  Symbolic
  // form stays scenario-agnostic; the substituted form below pins it to
  // the binding scenario so the headline number is the visible result.
  const symbolicMath =
    "\\text{Total SBM} = \\max_{s \\in \\{\\text{low}, \\text{med}, \\text{high}\\}} " +
    "\\sum_{c} \\left( \\Delta_{c} + V_{c} + \\mathrm{Crv}_{c} \\right)_{s}";

  // Build the substituted (Δ + V + Crv) terms per class for a given scenario.
  // Skipped cells contribute nothing — matches the server-side semantics.
  function buildSubstitutedTerms(scenario: CorrelationRegime): {
    terms: string[];
    total: number;
  } {
    const terms: string[] = [];
    let total = 0;
    for (const { riskClass, rows } of classGroups) {
      const sub = classSubtotalForScenario(rows, scenario);
      if (sub.allSkipped) continue;
      const byLeg: Record<TotalSbmLeg, number> = { delta: 0, vega: 0, curvature: 0 };
      for (const r of rows) {
        if (!r.skipped) byLeg[r.leg] = r.scenarios[scenario].charge;
      }
      const safe = riskClass.replace(/[^A-Za-z0-9]/g, "");
      terms.push(
        `(${byLeg.delta.toFixed(2)} + ${byLeg.vega.toFixed(2)} + ${byLeg.curvature.toFixed(2)})_{\\text{${safe}}}`,
      );
      total += sub.value;
    }
    return { terms, total };
  }

  const winningSubst = buildSubstitutedTerms(winningScenario);
  const winningSubstMath =
    `\\text{Total SBM}\\big|_{s=\\text{${winningScenario}}} = ` +
    (winningSubst.terms.length > 0 ? winningSubst.terms.join(" + ") : "0") +
    ` = ${winningSubst.total.toFixed(2)}`;

  // Wave 5.96F — when any cell came from the response cache, separate the
  // freshly-measured cumulative (truthful per-cell elapsed) from the
  // original cold cumulative preserved through cache hits. The tooltip
  // makes the distinction explicit so users don't read a sub-100 ms warm
  // run as evidence that the kernel ran in zero time.
  const perfCache = perf.cache;
  const originalCumulativeMs = typeof perf.original_cumulative_ms === "number"
    ? perf.original_cumulative_ms
    : perf.cumulative_ms;
  // Wave 5.96L — the "Σ if serial" chip displays the cold serial equivalent
  // (sum of per-cell compute time). On cache hits `cumulative_ms` collapses
  // to the warm cache-only path (~tens of ms) and destroys the parallelism
  // story, so we show `original_cumulative_ms` instead — the preserved cold
  // reference is what makes the contrast with wall-clock visceral.
  const serialEquivalentMs = perfCache === "hit" || perfCache === "partial"
    ? originalCumulativeMs
    : perf.cumulative_ms;
  // Wave 5.96N — the parallel-speedup chip mirrors the Σ-if-serial chip's
  // data source. When `original_parallelism_factor` is present (API ≥
  // 5.96N) use it; otherwise fall back to the legacy warm-cumulative
  // `parallelism_factor`. On cache hits this surfaces the true
  // cold-vs-warm speedup (e.g. ×146,770) instead of the warm cache-lookup
  // parallelism that left the perf strip telling two contradictory stories.
  const displayParallelismFactor = typeof perf.original_parallelism_factor === "number"
    ? perf.original_parallelism_factor
    : perf.parallelism_factor;
  const serialChipTooltip =
    `Sum of per-cell compute time across ${perf.redis_ops_count} cells. ` +
    `If we ran the cells one after another instead of in parallel, this is how long the user would wait. ` +
    `The wall-clock chip shows the actual wait time.`;
  const parallelChipTooltip = perfCache === "hit" || perfCache === "partial"
    ? `Speedup vs cold serial compute: ${originalCumulativeMs.toFixed(1)} ms (Σ if serial) / ${perf.total_ms.toFixed(1)} ms (wall-clock) = ${formatParallelismFactor(displayParallelismFactor)}×.`
    : `Speedup vs serial: ${perf.cumulative_ms.toFixed(1)} ms (Σ if serial) / ${perf.total_ms.toFixed(1)} ms (wall-clock) = ${formatParallelismFactor(displayParallelismFactor)}×.`;
  const perfTooltip = perfCache === "hit" || perfCache === "partial"
    ? `Served from cache ${perfCache === "hit" ? "(all cells)" : `(${perf.cache_hits ?? 0}/${perf.redis_ops_count} cells)`}. ` +
      `Wall-clock this request: ${perf.total_ms.toFixed(1)} ms. ` +
      `Fresh per-cell cumulative: ${perf.cumulative_ms.toFixed(1)} ms. ` +
      `Σ if serial (original cold compute, preserved): ${originalCumulativeMs.toFixed(1)} ms across ${perf.redis_ops_count} cells. ` +
      `Parallelism factor = Σ if serial / wall-clock = ${formatParallelismFactor(displayParallelismFactor)}× (speedup vs cold serial compute).`
    : `Σ if serial (sum of per-cell compute across ${perf.redis_ops_count} cells): ${perf.cumulative_ms.toFixed(1)} ms. ` +
      `Wall-clock elapsed: ${perf.total_ms.toFixed(1)} ms. ` +
      `Parallelism factor = Σ if serial / wall-clock = ${formatParallelismFactor(displayParallelismFactor)}×.`;

  return (
    <div className="calc-panel__total-result" data-testid="calc-total-result">
      {/* 1. Headline — prominent total + binding scenario pill */}
      <div className="calc-panel__total-headline">
        <div className="calc-panel__total-headline-main">
          <span className="calc-panel__total-headline-label">Total SBM charge</span>
          <strong
            className="calc-panel__total-headline-value"
            data-testid="calc-total-charge"
          >
            {formatCharge(result.total_sbm)}
          </strong>
        </div>
        <span
          className="calc-panel__total-winner-pill"
          data-scenario={winningScenario}
          data-testid="calc-total-winner-pill"
        >
          binding scenario: {winningScenario.toUpperCase()}
        </span>
        {finalElapsedMs !== null ? (() => {
          const finalSeconds = finalElapsedMs / 1000;
          return (
            <span
              className="calc-panel__total-elapsed calc-panel__total-elapsed--final"
              data-testid="calc-total-elapsed-final"
            >
              computed in {finalSeconds.toFixed(finalSeconds < 10 ? 1 : 0)}s
            </span>
          );
        })() : null}
      </div>

      {/* 2. §21.4(8) formula — symbolic + substituted for the binding scenario */}
      <section
        className="calc-panel__total-formula"
        data-testid="calc-total-formula"
        aria-label="Section 21.4(8) total SBM derivation"
      >
        <h3 className="calc-panel__total-section-title">How the Total SBM was calculated</h3>
        <div className="calc-panel__total-formula-symbolic">
          <BlockMath math={symbolicMath} />
        </div>
        <p className="calc-panel__total-formula-caption">
          Substituting the binding scenario (<InlineMath math={`s = \\text{${winningScenario}}`} />):
        </p>
        <div
          className="calc-panel__total-formula-substituted"
          data-testid="calc-total-formula-substituted"
        >
          <BlockMath math={winningSubstMath} />
        </div>
        <details
          className="calc-panel__total-formula-all"
          data-testid="calc-total-formula-all"
        >
          <summary>Show derivation for all scenarios</summary>
          <ul className="calc-panel__total-formula-all-list">
            {TOTAL_SBM_SCENARIOS.map((s) => {
              const subst = buildSubstitutedTerms(s);
              const expr =
                `\\text{Total SBM}\\big|_{s=\\text{${s}}} = ` +
                (subst.terms.length > 0 ? subst.terms.join(" + ") : "0") +
                ` = ${subst.total.toFixed(2)}`;
              return (
                <li
                  key={s}
                  className={
                    s === winningScenario
                      ? "calc-panel__total-formula-all-item calc-panel__total-formula-all-item--winner"
                      : "calc-panel__total-formula-all-item"
                  }
                >
                  <BlockMath math={expr} />
                </li>
              );
            })}
          </ul>
        </details>
      </section>

      {/* Wave 5.96G-ui — single-line banner above the breakdown grid when
          any cell came back with data_status === "empty". Tells the user
          their charge of 0 is structural (no rows ingested) rather than a
          real computed zero, and points at the generator flag that fills
          the gap. Skipped (503) cells are NOT counted here. */}
      {perf.cells_empty && perf.cells_empty > 0 ? (
        <div
          className="calc-panel__total-empty-banner"
          data-testid="calc-total-empty-banner"
          role="status"
        >
          <strong>{perf.cells_empty}</strong> cell{perf.cells_empty === 1 ? "" : "s"} have
          no ingested data — generate the missing rows with{" "}
          <code>--sensitivity-types Delta,Vega,Curvature</code> to populate them.
        </div>
      ) : null}

      {/* 3. Per-scenario subtotals — three columns, binding scenario tinted + starred */}
      <section
        className="calc-panel__total-scenarios"
        data-testid="calc-total-matrix"
        aria-label="Per-scenario subtotals by class"
      >
        {TOTAL_SBM_SCENARIOS.map((scenario) => {
          const isWinner = scenario === winningScenario;
          return (
            <div
              key={scenario}
              className={
                isWinner
                  ? "calc-panel__total-scenario calc-panel__total-scenario--winner"
                  : "calc-panel__total-scenario"
              }
              data-scenario={scenario}
              data-winner={isWinner ? "true" : "false"}
              data-testid={`calc-total-scenario-${scenario}`}
            >
              <header className="calc-panel__total-scenario-header">
                <span className="calc-panel__total-scenario-name">
                  {TOTAL_SBM_SCENARIO_LABEL[scenario]}
                </span>
                <span className="calc-panel__total-scenario-total">
                  {formatCharge(result.scenario_totals[scenario])}
                  {isWinner ? (
                    <span
                      className="calc-panel__total-scenario-star"
                      aria-label="binding scenario"
                      title="Binding scenario (max across low / medium / high — the regime that drives the capital charge)"
                    >
                      {"\u2605"}
                    </span>
                  ) : null}
                </span>
              </header>
              <ul className="calc-panel__total-scenario-classes">
                {classGroups.map(({ riskClass, rows }) => {
                  const sub = classSubtotalForScenario(rows, scenario);
                  return (
                    <li
                      key={riskClass}
                      className={
                        sub.allSkipped
                          ? "calc-panel__total-class calc-panel__total-class--empty"
                          : "calc-panel__total-class"
                      }
                      data-class={riskClass}
                    >
                      <div className="calc-panel__total-class-header">
                        <span className="calc-panel__total-class-name">{riskClass}</span>
                        {sub.allSkipped ? (
                          <span
                            className="calc-panel__total-class-empty"
                            data-status="skipped"
                            title={CELL_BADGE_TOOLTIP.skipped}
                          >
                            class not ingested
                          </span>
                        ) : null}
                      </div>
                      {sub.allSkipped ? null : (
                        <>
                          <dl className="calc-panel__total-class-legs">
                            {TOTAL_SBM_LEG_ORDER.map((leg) => {
                              const row = rows.find((r) => r.leg === leg);
                              // Wave 5.96G-ui — resolve effective per-cell
                              // ingestion status. Prefer cell-level
                              // data_status; fall back to row.skipped /
                              // missing-row for pre-5.96G-api responses.
                              const cellStatus: "populated" | "empty" | "skipped" =
                                !row
                                  ? "skipped"
                                  : (row.scenarios[scenario]?.data_status ??
                                     (row.skipped ? "skipped" : "populated"));
                              const isEmpty = cellStatus === "empty";
                              const isSkipped = cellStatus === "skipped";
                              const isNonPopulated = isEmpty || isSkipped;
                              return (
                                <Fragment key={leg}>
                                  <dt className="calc-panel__total-class-leg-label">
                                    {TOTAL_SBM_LEG_LABEL[leg]}
                                  </dt>
                                  <dd
                                    className={
                                      isNonPopulated
                                        ? "calc-panel__total-class-leg-value calc-panel__total-class-leg-value--empty"
                                        : "calc-panel__total-class-leg-value"
                                    }
                                  >
                                    {isNonPopulated ? (
                                      <span
                                        className="calc-panel__total-class-leg-badge"
                                        data-status={cellStatus}
                                        data-testid={`calc-total-cell-badge-${riskClass}-${leg}-${scenario}`}
                                        title={CELL_BADGE_TOOLTIP[cellStatus]}
                                      >
                                        {isEmpty
                                          ? "no data ingested"
                                          : "class not ingested"}
                                      </span>
                                    ) : (
                                      formatCharge(row!.scenarios[scenario].charge)
                                    )}
                                  </dd>
                                </Fragment>
                              );
                            })}
                          </dl>
                          <div className="calc-panel__total-class-subtotal">
                            <span className="calc-panel__total-class-subtotal-rule" aria-hidden />
                            <span className="calc-panel__total-class-subtotal-value">
                              {formatCharge(sub.value)}
                            </span>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </section>

      {/* 4. Performance / parallelism evidence — compact chip strip */}
      <div
        className="calc-panel__total-performance"
        data-testid="calc-total-performance"
        title={perfTooltip}
      >
        <span
          className="calc-panel__total-perf-chip"
          data-chip="ops"
          data-testid="calc-total-perf-ops-chip"
          title="3 risk classes (GIRR, Equity, FX) × 3 legs (Δ delta, V vega, Curvature) × 3 correlation scenarios (low, medium, high)."
        >
          <span aria-hidden>{"\u26A1"}</span> {perf.redis_ops_count}/{totalCells} cells
        </span>
        <span className="calc-panel__total-perf-chip" data-chip="wall">
          wall-clock <strong>{perf.total_ms.toFixed(1)} ms</strong>
        </span>
        <span
          className="calc-panel__total-perf-chip"
          data-chip="cumulative"
          title={serialChipTooltip}
        >
          {"\u03A3"} if serial · <strong>{formatComputeMs(serialEquivalentMs)}</strong>
        </span>
        <span
          className="calc-panel__total-perf-chip"
          data-chip="parallel"
          title={parallelChipTooltip}
        >
          ×<strong data-testid="calc-total-parallelism">
            {formatParallelismFactor(displayParallelismFactor)}
          </strong>{" "}
          parallel speedup
        </span>
        {perfCache === "hit" || perfCache === "partial" ? (
          <span
            className="calc-panel__total-perf-chip"
            data-chip="cache"
            data-cache={perfCache}
            data-testid="calc-total-perf-cache-chip"
            title={`Original cold compute: ${formatComputeMs(originalCumulativeMs)} across ${perf.redis_ops_count} cells.`}
          >
            {perfCache === "hit"
              ? `served from cache in ${formatServedMs(perf.total_ms)} · original ${formatComputeMs(originalCumulativeMs)}`
              : `${perf.cache_hits ?? 0}/${perf.redis_ops_count} from cache · original ${formatComputeMs(originalCumulativeMs)}`}
          </span>
        ) : null}
        {perf.ops_skipped > 0 ? (
          <span className="calc-panel__total-perf-chip" data-chip="skipped">
            {perf.ops_skipped} skipped
          </span>
        ) : null}
      </div>

      {/* 5. Footer — unsupported classes + resolved command summary */}
      {result.unsupported_classes.length > 0 ? (
        <p className="calc-panel__total-footnote">
          Unsupported classes (omitted):{" "}
          <code>{result.unsupported_classes.join(", ")}</code>
        </p>
      ) : null}
      <p className="calc-panel__total-footnote">
        <code>{result.resolved_command_summary}</code>
      </p>
    </div>
  );
}

// Plain-English Scenario picker — the visible regulatory framing for the
// MAR21.6 cross-bucket γ regime. "Standard charge" is a no-op on the wire
// (we omit `correlation_regime` entirely); the two stress scenarios map to
// the "low" and "high" wire values. Each <option> carries a `title` so the
// hover tooltip surfaces the plain-English explanation without forcing the
// user into the advanced disclosure.
function ScenarioSelect({
  scenario,
  onChange,
}: {
  scenario: ScenarioKey;
  onChange: (next: ScenarioKey) => void;
}) {
  const active = SCENARIO_OPTIONS.find((o) => o.value === scenario) ?? SCENARIO_OPTIONS[0]!;
  return (
    <label className="calc-panel__field" data-testid="scenario-select">
      <span>Scenario</span>
      <select
        value={scenario}
        onChange={(e) => onChange(e.target.value as ScenarioKey)}
        title={active.tooltip}
        data-testid="scenario-select-input"
      >
        {SCENARIO_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={o.tooltip}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// "Show advanced…" disclosure. Collapsed by default so the Calc panel stays
// uncluttered for first-time users and demo viewers. Hosts everything that
// isn't part of the day-to-day happy path: the bucket-subset refine row
// (only after a result lands), the three kernel-side row-exclusion chip
// combos, the fuzzy-suggestions toggle (which only affects those combos),
// and the "Show Redis commands" toggle that surfaces the verbose
// observability panel for demos. The `open` prop is controlled by the
// parent so it can auto-open when any non-default setting is active.
function AdvancedFilters({
  open,
  onToggle,
  excludeTotal,
  buckets,
  riskClass,
  subset,
  onToggleSubsetBucket,
  onResetSubset,
  books,
  trades,
  factors,
  onBooksChange,
  onTradesChange,
  onFactorsChange,
  fuzzy,
  onFuzzyChange,
  showRedisCommands,
  onShowRedisCommandsChange,
}: {
  open: boolean;
  onToggle: (next: boolean) => void;
  excludeTotal: number;
  buckets: BucketResult[];
  riskClass: RiskClass;
  subset: Set<string> | null;
  onToggleSubsetBucket: (bucket: string) => void;
  onResetSubset: () => void;
  books: Set<string>;
  trades: Set<string>;
  factors: Set<string>;
  onBooksChange: (next: Set<string>) => void;
  onTradesChange: (next: Set<string>) => void;
  onFactorsChange: (next: Set<string>) => void;
  fuzzy: boolean;
  onFuzzyChange: (next: boolean) => void;
  showRedisCommands: boolean;
  onShowRedisCommandsChange: (next: boolean) => void;
}) {
  return (
    <details
      className="calc-panel__advanced"
      data-testid="advanced-filters"
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="calc-panel__advanced-summary" data-testid="advanced-filters-summary">
        Show advanced…
      </summary>
      <div className="calc-panel__advanced-body">
        {buckets.length > 0 ? (
          <section className="calc-panel__advanced-section">
            <h3 className="calc-panel__advanced-heading">Refine to specific buckets</h3>
            <RefineBucketsRow
              buckets={buckets}
              riskClass={riskClass}
              subset={subset}
              onToggle={onToggleSubsetBucket}
              onReset={onResetSubset}
            />
          </section>
        ) : null}
        <section className="calc-panel__advanced-section">
          <h3
            className="calc-panel__advanced-heading"
            data-testid="exclude-rows-heading"
          >
            Exclude rows{excludeTotal > 0 ? ` · ${excludeTotal} excluded` : ""}
          </h3>
          <ExcludeChipsCombobox
            field="book"
            label="Books to exclude"
            placeholder="e.g. RATES-LDN"
            values={books}
            onChange={onBooksChange}
            fuzzy={fuzzy}
          />
          <ExcludeChipsCombobox
            field="trade_id"
            label="Trades to exclude"
            placeholder="e.g. T0042"
            values={trades}
            onChange={onTradesChange}
            fuzzy={fuzzy}
          />
          <ExcludeChipsCombobox
            field="risk_factor"
            label="Risk factors to exclude"
            placeholder="e.g. RF_GIRR_05"
            values={factors}
            onChange={onFactorsChange}
            fuzzy={fuzzy}
          />
        </section>
        <section className="calc-panel__advanced-section calc-panel__advanced-toggles">
          <button
            type="button"
            className={`pivot-fuzzy-toggle calc-fuzzy-toggle ${fuzzy ? "is-on" : "is-off"}`}
            data-testid="calc-fuzzy-toggle"
            aria-pressed={fuzzy}
            onClick={() => onFuzzyChange(!fuzzy)}
          >
            <span data-testid="calc-fuzzy-hint">
              Fuzzy suggestions: {fuzzy ? "on" : "off"}
            </span>
          </button>
          <button
            type="button"
            className={`pivot-fuzzy-toggle calc-redis-commands-toggle ${
              showRedisCommands ? "is-on" : "is-off"
            }`}
            data-testid="calc-show-redis-commands-toggle"
            aria-pressed={showRedisCommands}
            onClick={() => onShowRedisCommandsChange(!showRedisCommands)}
          >
            <span data-testid="calc-show-redis-commands-hint">
              Show Redis commands: {showRedisCommands ? "on" : "off"}
            </span>
          </button>
        </section>
      </div>
    </details>
  );
}

// Wave 5.31c: single-field exclude widget — combobox above a chip row. The
// combobox echoes whatever the user types into local `draft` state; on commit
// (Enter or selecting a suggestion) the value is added to `values` and the
// input is cleared so the user can keep adding more. Comma in the draft is
// treated as a commit too — paste of "A,B,C" splits into 3 chips.
function ExcludeChipsCombobox({
  field,
  label,
  placeholder,
  values,
  onChange,
  fuzzy,
}: {
  field: "book" | "trade_id" | "risk_factor";
  label: string;
  placeholder?: string;
  values: Set<string>;
  onChange: (next: Set<string>) => void;
  fuzzy: boolean;
}) {
  const [draft, setDraft] = useState<string>("");

  function commit(raw: string) {
    // Comma split mirrors the kernel CSV wire format — a paste of "A,B,C"
    // commits all three at once. Strips empties; preserves insertion order.
    const tokens = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (tokens.length === 0) return;
    const next = new Set(values);
    for (const t of tokens) next.add(t);
    onChange(next);
    setDraft("");
  }

  function remove(value: string) {
    const next = new Set(values);
    next.delete(value);
    onChange(next);
  }

  function onDraftChange(v: string) {
    // Auto-commit when the draft ends with "," so paste of CSVs lands as chips.
    if (v.endsWith(",")) {
      commit(v.slice(0, -1));
      return;
    }
    setDraft(v);
  }

  // Enter on the underlying combobox input either selects the active
  // suggestion (SuggestCombobox preventDefaults) or — when no suggestion is
  // active — bubbles unhandled. We catch that bubbled Enter at the wrapper
  // level and commit whatever is currently in `draft` so the user can add
  // free-text exclusions (e.g. a known book id that's not in /suggest).
  function onWrapperKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && !e.defaultPrevented && draft.length > 0) {
      e.preventDefault();
      commit(draft);
    }
  }

  return (
    <div className="exclude-chips" data-testid={`exclude-${field}`} onKeyDown={onWrapperKeyDown}>
      <label className="exclude-chips__label" htmlFor={`exclude-${field}-input`}>
        {label}
      </label>
      <SuggestCombobox
        field={field}
        id={`exclude-${field}-input`}
        value={draft}
        onChange={onDraftChange}
        placeholder={placeholder}
        fuzzy={fuzzy}
      />
      {values.size > 0 ? (
        <ul
          className="exclude-chips__list"
          role="list"
          aria-label={`Selected ${label.toLowerCase()}`}
          data-testid={`exclude-${field}-chips`}
        >
          {Array.from(values).map((v) => (
            <li key={v} className="exclude-chips__chip" data-testid="exclude-chip" data-value={v}>
              <span>{v}</span>
              <button
                type="button"
                className="exclude-chips__remove"
                aria-label={`Remove ${v}`}
                onClick={() => remove(v)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Wave 5.31a: "Refine buckets" multi-select pill row. Renders one pill per
// bucket from the most recent /calc/sbm response, sorted by K_b descending to
// match the per-bucket chart. `subset === null` means the user hasn't touched
// the pills yet → every pill renders pre-selected (the visible default). Once
// they click anything we switch to the explicit `Set` and toggle from there.
function RefineBucketsRow({
  buckets,
  riskClass,
  subset,
  onToggle,
  onReset,
}: {
  buckets: BucketResult[];
  riskClass: RiskClass;
  subset: Set<string> | null;
  onToggle: (bucket: string) => void;
  onReset: () => void;
}) {
  if (buckets.length === 0) return null;
  const sorted = [...buckets].sort((a, b) => b.K_b - a.K_b);
  const bClass = bucketClassFor(riskClass);
  const isSelected = (b: string) => (subset === null ? true : subset.has(b));
  const selectedCount = subset === null ? buckets.length : subset.size;
  const dirty = subset !== null;
  return (
    <div className="refine-buckets" data-testid="refine-buckets">
      <div className="refine-buckets__header">
        <span className="refine-buckets__label">Refine buckets</span>
        <span className="refine-buckets__count" data-testid="refine-buckets-count">
          {selectedCount}/{buckets.length} selected
        </span>
        {dirty ? (
          <button
            type="button"
            className="refine-buckets__reset"
            onClick={onReset}
            data-testid="refine-buckets-reset"
          >
            Reset to all
          </button>
        ) : null}
      </div>
      <div className="refine-buckets__pills" role="group" aria-label="Bucket subset">
        {sorted.map((b) => {
          const selected = isSelected(b.bucket);
          return (
            <button
              key={b.bucket}
              type="button"
              className="bucket-pill refine-buckets__pill"
              data-class={bClass}
              data-selected={selected ? "true" : "false"}
              data-testid="refine-bucket-pill"
              data-bucket={b.bucket}
              aria-pressed={selected}
              onClick={() => onToggle(b.bucket)}
            >
              {b.bucket}
            </button>
          );
        })}
      </div>
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

// Wave 5.31b: small inline badge that labels the Basel §21.6 regime that was
// actually applied to the charge. Reads from `result.correlation_regime` so
// the badge reflects what the api computed (not what the user clicked), which
// matters when the user clicks Calculate without changing the default and the
// api echoes "medium".
function RegimeBadge({ regime }: { regime: CorrelationRegime }) {
  const opt = REGIME_OPTIONS.find((o) => o.value === regime);
  const label = opt?.label ?? regime;
  const hint = opt?.hint ?? "";
  return (
    <span
      className="charge-tile__regime-badge"
      data-regime={regime}
      data-testid="regime-badge"
      title={`Basel MAR21.6 correlation regime — ${hint}`}
    >
      {label} ({hint})
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
  showRedisCommands,
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
  showRedisCommands: boolean;
}) {
  // Wave 5.96F — on cache hits the chip headlines the cold-compute cost
  // (the work the cache saved) and then surfaces the actual served-in time.
  // On misses the chip is unchanged. Tone reflects served time so cache hits
  // stay green even when the original cold compute was slow.
  const isCacheHit = result.cache === "hit";
  const tone = toneFor(result.total_ms);
  const headlineMs = isCacheHit && typeof result.original_compute_ms === "number"
    ? result.original_compute_ms
    : result.total_ms;
  const chipText = isCacheHit && typeof result.original_compute_ms === "number"
    ? `Computed in ${formatComputeMs(headlineMs)} (cached, served in ${formatServedMs(result.total_ms)})`
    : `Computed in ${result.total_ms} ms (${result.fanout_ms} ms of Redis fan-out)`;
  const chipTooltip = isCacheHit && typeof result.original_compute_ms === "number"
    ? `Original cold compute: ${formatComputeMs(headlineMs)}. This request was served from the response cache in ${formatServedMs(result.total_ms)}.`
    : `Wall-clock elapsed: ${result.total_ms} ms (Redis fan-out: ${result.fanout_ms} ms).`;
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
            data-cache={isCacheHit ? "hit" : undefined}
            title={chipTooltip}
          >
            {chipText}
          </span>
        }
      >
        <div className="calc-panel__charge-row">
          <AnimatedCharge value={result.charge} />
          {result.curvature_branch ? (
            <CurvatureBranchPill branch={result.curvature_branch} />
          ) : null}
          {result.correlation_regime ? (
            <RegimeBadge regime={result.correlation_regime} />
          ) : null}
        </div>
        <p className="calc-panel__basel-caption" data-testid="basel-caption">
          {caption}
        </p>
      </PanelCard>

      {hasMeaningfulShardTiming(result) ? (
        <PanelCard title="Per-bucket timing">
          <TimingStrip shards={shardsFromResponse(result)} />
        </PanelCard>
      ) : null}

      {showRedisCommands && result.commands ? (
        <CommandsPanel
          commands={result.commands}
          engine={result.engine}
          cache={result.cache}
          totalMs={result.total_ms}
        />
      ) : null}

      {/* Inlined panel-card so the heading can carry a `title` attribute
          tooltip — the shared PanelCard component renders the title as plain
          text and has no tooltip slot. */}
      <section className="panel-card">
        <div className="panel-card__header">
          <h2 title="Per-bucket K_b — capital charge concentration">
            Charge by bucket
          </h2>
        </div>
        <div className="panel-card__body">
          <BucketChargeChart
            buckets={result.per_bucket}
            riskClass={context.riskClass}
            expanded={chartExpanded}
            onToggle={onToggleChart}
            renderDrilldown={(b) => renderDrilldown(b, "chart")}
          />
        </div>
      </section>

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

// Wave 5.21a: GIRR Delta/Vega risk_value is a tenor-keyed object since 5.17a
// (`{ "3M": n, ..., "30Y": n }`). Drilldown sparklines need a positional array
// in canonical tenor order. We also keep the legacy `number[]` fallback so the
// generator's defensive array branch (missing tenor metadata) still renders.
function extractTenorArray(rv: unknown, tenors: string[]): number[] {
  if (rv && typeof rv === "object" && !Array.isArray(rv)) {
    const obj = rv as Record<string, unknown>;
    if (tenors.some((t) => t in obj)) {
      return tenors.map((t) => {
        const v = obj[t];
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      });
    }
    return [];
  }
  return toFiniteArray(rv);
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
      const rvObj =
        rv && typeof rv === "object" && !Array.isArray(rv) ? (rv as Record<string, unknown>) : null;
      const up = extractTenorArray(rvObj?.cvr_up ?? [], GIRR_TENORS);
      const down = extractTenorArray(rvObj?.cvr_down ?? [], GIRR_TENORS);
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
    const pts = extractTenorArray(rv, GIRR_TENORS);
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
    const up = readScalar(rv, "cvr_up");
    const down = readScalar(rv, "cvr_down");
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

// Wave 5.96A — per-bucket K_b formula + Redis command block. Sits above the
// existing tenor-vector drilldown so users see (a) HOW K_b was derived from
// this bucket's actual ΣWS² and ρ·cross-term and (b) WHICH Redis command
// produced it, with the round-trip ms badge. Fast-path responses render the
// substituted closed form; Lua-path responses (engine="fcall_lua") fall back
// to a "computed in Lua FCALL, intermediates not surfaced" line since the
// kernel does not surface the breakdown (option B in the spec).
function BucketKbDrilldown({
  bucket,
  riskClass,
  sensitivityType,
  bucketResult,
}: {
  bucket: string;
  riskClass: RiskClass;
  sensitivityType: SensitivityType;
  bucketResult: BucketResult | undefined;
}) {
  if (!bucketResult) return null;
  const { K_b, S_b, count, ms, intermediate, resolved_command } = bucketResult;
  const fmt5 = (n: number): string => n.toFixed(5);
  const fmtMs = (n: number): string => (Math.round(n * 1000) / 1000).toString();
  // Component-aware symbolic formula. Delta/Vega share the constant-ρ closed
  // form (§21.4(5)/(7)); Curvature is the §21.5(3) max of the two ψ-gated
  // scenarios. Strings are KaTeX-compatible (\rho, \sum, \max, etc).
  const isCurvature = sensitivityType === "Curvature";
  const symbolic = isCurvature
    ? "K_b = \\max\\!\\left(K_b^{+},\\;K_b^{-}\\right),\\quad K_b^{\\pm} = \\sqrt{\\sum_k \\mathrm{CVR}_k^{\\pm\\,2} + \\sum_{k\\neq l}\\rho_{kl}\\,\\mathrm{CVR}_k^{\\pm}\\,\\mathrm{CVR}_l^{\\pm}}"
    : "K_b = \\sqrt{\\sum_k \\mathrm{WS}_k^{2} + \\sum_{k\\neq l}\\rho_{kl}\\,\\mathrm{WS}_k\\,\\mathrm{WS}_l}";
  const path = intermediate?.path;
  const wsSq = intermediate?.ws_squared_sum;
  const cross = intermediate?.cross_term;
  const haveBreakdown = path === "fast" && wsSq !== undefined && cross !== undefined;
  const curvature = intermediate?.curvature;
  return (
    <div className="bucket-drilldown__kb" data-testid="bucket-drilldown-kb" data-bucket={bucket}>
      <section className="bucket-drilldown__kb-formula" data-testid="bucket-drilldown-formula">
        <h4 className="bucket-drilldown__kb-title">How K_b was calculated</h4>
        <div className="bucket-drilldown__kb-symbolic" data-testid="bucket-drilldown-formula-symbolic">
          <BlockMath math={symbolic} />
        </div>
        {haveBreakdown ? (
          <>
            {isCurvature && curvature ? (
              <div className="bucket-drilldown__kb-curvature" data-testid="bucket-drilldown-formula-curvature">
                <BlockMath
                  math={
                    `K_b^{+} = ${fmt5(curvature.k_plus)},\\quad ` +
                    `K_b^{-} = ${fmt5(curvature.k_minus)}\\;\\Rightarrow\\;` +
                    `\\text{binding direction} = K_b^{${curvature.winner === "plus" ? "+" : "-"}}`
                  }
                />
              </div>
            ) : null}
            <div className="bucket-drilldown__kb-substituted" data-testid="bucket-drilldown-formula-substituted">
              <BlockMath
                math={`K_b = \\sqrt{${fmt5(wsSq!)} + ${fmt5(cross!)}} = ${fmt5(K_b)}`}
              />
            </div>
            <p className="bucket-drilldown__kb-sb" data-testid="bucket-drilldown-formula-sb">
              S_b = Σ<sub>k</sub> WS<sub>k</sub> = {fmt5(S_b)} ({count} sensitivities)
            </p>
          </>
        ) : (
          <p
            className="bucket-drilldown__kb-lua"
            data-testid="bucket-drilldown-formula-lua"
          >
            K<sub>b</sub> = {fmt5(K_b)} — computed in Lua FCALL · {fmtMs(ms)} ms · intermediate
            values not surfaced (fast path required).
          </p>
        )}
      </section>
      <section className="bucket-drilldown__kb-command" data-testid="bucket-drilldown-command">
        <h4 className="bucket-drilldown__kb-title">Redis · {fmtMs(ms)} ms</h4>
        {resolved_command ? (
          <CommandPreview
            command={resolved_command}
            preTestId="bucket-drilldown-command-pre"
            preClassName="bucket-drilldown__kb-command-pre"
          />
        ) : (
          <p className="bucket-drilldown__kb-command-missing">
            (resolved command not available)
          </p>
        )}
      </section>
      {/* Wave 5.96A.1 — collapsible per-component breakdowns. Delta/Vega
          buckets render the WS_k² + cross-term tables; Curvature buckets
          render the CVR_k^± tables. All sections are collapsed by default
          via the native <details> disclosure. */}
      {haveBreakdown && !isCurvature && intermediate?.ws_components ? (
        <WsComponentsBreakdown
          components={intermediate.ws_components}
          total={wsSq!}
        />
      ) : null}
      {haveBreakdown && !isCurvature && intermediate?.cross_components ? (
        <CrossComponentsBreakdown
          components={intermediate.cross_components}
          truncated={intermediate.cross_components_truncated ?? false}
          totalCount={
            intermediate.cross_components_total_count ?? intermediate.cross_components.length
          }
          crossTerm={cross!}
          bucket={bucket}
          riskClass={riskClass}
          sensitivityType={sensitivityType}
        />
      ) : null}
      {haveBreakdown && isCurvature && curvature?.cvr_components ? (
        <CvrComponentsBreakdown
          components={curvature.cvr_components}
          kPlus={curvature.k_plus}
          kMinus={curvature.k_minus}
          winner={curvature.winner}
        />
      ) : null}
    </div>
  );
}

// Wave 5.96A.1 — natural tenor sort. Reuses GIRR_TENORS so 3M < 6M < 1Y, with
// non-matching component keys falling back to lexicographic order.
function componentSort<T extends { k: string }>(a: T, b: T): number {
  const ia = GIRR_TENORS.indexOf(a.k);
  const ib = GIRR_TENORS.indexOf(b.k);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
}

function WsComponentsBreakdown({
  components,
  total,
}: {
  components: WsComponent[];
  total: number;
}) {
  const fmt5 = (n: number): string => n.toFixed(5);
  const sorted = [...components].sort(componentSort);
  return (
    <details
      className="bucket-drilldown__ws-breakdown"
      data-testid="bucket-drilldown-ws-breakdown"
    >
      <summary className="bucket-drilldown__breakdown-summary">
        Σ WS<sub>k</sub>² breakdown ({sorted.length} components)
      </summary>
      <div className="bucket-drilldown__breakdown-scroll">
        <table
          className="bucket-drilldown__breakdown-table"
          data-testid="bucket-drilldown-ws-table"
        >
          <thead>
            <tr>
              <th scope="col">k</th>
              <th scope="col">WS<sub>k</sub></th>
              <th scope="col">WS<sub>k</sub>²</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.k} data-testid="bucket-drilldown-ws-row" data-k={c.k}>
                <td>{c.k}</td>
                <td>{fmt5(c.ws)}</td>
                <td>{fmt5(c.ws_squared)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid="bucket-drilldown-ws-total">
              <td>Total</td>
              <td></td>
              <td>{fmt5(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  );
}

function CrossComponentsBreakdown({
  components,
  truncated,
  totalCount,
  crossTerm,
  bucket,
  riskClass,
  sensitivityType,
}: {
  components: CrossComponent[];
  truncated: boolean;
  totalCount: number;
  crossTerm: number;
  bucket: string;
  riskClass: RiskClass;
  sensitivityType: SensitivityType;
}) {
  const fmt5 = (n: number): string => n.toFixed(5);
  const [showingAll, setShowingAll] = useState(false);
  const [fullList, setFullList] = useState<CrossComponent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onToggle() {
    if (showingAll) {
      setShowingAll(false);
      return;
    }
    if (fullList) {
      setShowingAll(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await postBucketCrossDetail({
        risk_class: riskClass,
        sensitivity_type: sensitivityType,
        bucket,
      });
      setFullList(resp.cross_components);
      setShowingAll(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const rows = showingAll && fullList ? fullList : components;
  return (
    <details
      className="bucket-drilldown__cross-breakdown"
      data-testid="bucket-drilldown-cross-breakdown"
    >
      <summary className="bucket-drilldown__breakdown-summary">
        Cross-term breakdown ({truncated ? `top ${components.length} of ${totalCount}` : `${components.length} pairs`})
      </summary>
      <div className="bucket-drilldown__breakdown-scroll">
        <table
          className="bucket-drilldown__breakdown-table"
          data-testid="bucket-drilldown-cross-table"
        >
          <thead>
            <tr>
              <th scope="col">k</th>
              <th scope="col">l</th>
              <th scope="col">ρ<sub>kl</sub></th>
              <th scope="col">WS<sub>k</sub></th>
              <th scope="col">WS<sub>l</sub></th>
              <th scope="col">contrib</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={`${c.k}|${c.l}|${i}`} data-testid="bucket-drilldown-cross-row" data-k={c.k} data-l={c.l}>
                <td>{c.k}</td>
                <td>{c.l}</td>
                <td>{fmt5(c.rho)}</td>
                <td>{fmt5(c.ws_k)}</td>
                <td>{fmt5(c.ws_l)}</td>
                <td>{fmt5(c.contrib)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid="bucket-drilldown-cross-total">
              <td colSpan={5}>
                {truncated && !showingAll
                  ? `Showing top ${components.length} of ${totalCount} by |contrib|. Total cross_term (all pairs):`
                  : "Total cross_term:"}
              </td>
              <td>{fmt5(crossTerm)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {truncated ? (
        <div className="bucket-drilldown__breakdown-actions">
          <button
            type="button"
            onClick={onToggle}
            disabled={loading}
            data-testid="bucket-drilldown-cross-show-all"
          >
            {loading
              ? "Loading…"
              : showingAll
              ? "Show top 10"
              : `Show all ${totalCount}`}
          </button>
          {error ? (
            <span
              className="bucket-drilldown__breakdown-error"
              data-testid="bucket-drilldown-cross-error"
            >
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function CvrComponentsBreakdown({
  components,
  kPlus,
  kMinus,
  winner,
}: {
  components: CvrComponent[];
  kPlus: number;
  kMinus: number;
  winner: "plus" | "minus";
}) {
  const fmt5 = (n: number): string => n.toFixed(5);
  const sorted = [...components].sort(componentSort);
  const sumUp = sorted.reduce((acc, c) => acc + c.cvr_up, 0);
  const sumDown = sorted.reduce((acc, c) => acc + c.cvr_down, 0);
  return (
    <details
      className="bucket-drilldown__cvr-breakdown"
      data-testid="bucket-drilldown-cvr-breakdown"
    >
      <summary className="bucket-drilldown__breakdown-summary">
        CVR<sub>k</sub><sup>±</sup> breakdown ({sorted.length} components)
      </summary>
      <div className="bucket-drilldown__breakdown-scroll">
        <table
          className="bucket-drilldown__breakdown-table"
          data-testid="bucket-drilldown-cvr-table"
        >
          <thead>
            <tr>
              <th scope="col">k</th>
              <th scope="col">CVR<sub>k</sub><sup>+</sup></th>
              <th scope="col">CVR<sub>k</sub><sup>−</sup></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.k} data-testid="bucket-drilldown-cvr-row" data-k={c.k}>
                <td>{c.k}</td>
                <td>{fmt5(c.cvr_up)}</td>
                <td>{fmt5(c.cvr_down)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-testid="bucket-drilldown-cvr-total">
              <td>
                Σ (binding direction: K<sub>b</sub><sup>{winner === "plus" ? "+" : "−"}</sup>)
              </td>
              <td>
                {fmt5(sumUp)} → K<sub>b</sub><sup>+</sup>={fmt5(kPlus)}
              </td>
              <td>
                {fmt5(sumDown)} → K<sub>b</sub><sup>−</sup>={fmt5(kMinus)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
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
  // Wave 5.21e: trade_id pill → JSON drawer state. Track the originating
  // button so focus returns there on close.
  const [drawerRow, setDrawerRow] = useState<PivotRow | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);

  function openDrawer(row: PivotRow, el: HTMLButtonElement) {
    drawerTriggerRef.current = el;
    setDrawerRow(row);
  }
  function closeDrawer() {
    drawerTriggerRef.current?.focus();
    setDrawerRow(null);
  }

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
      {/* Wave 5.96A — formula + Redis command block sits above the existing
          tenor breakdown so the K_b math + provenance are the first thing the
          user sees on expand. */}
      <BucketKbDrilldown
        bucket={bucket}
        riskClass={riskClass}
        sensitivityType={sensitivityType}
        bucketResult={bucketResult}
      />
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
              {state.rows.map((row) => {
                const tradeLabel = String(row.doc.trade_id ?? row.key);
                return (
                <tr key={row.key} data-testid="drilldown-row" data-trade-id={row.doc.trade_id ?? ""}>
                  <td>
                    <button
                      type="button"
                      className="drilldown-pill drilldown-pill--trade"
                      onClick={(e) => openDrawer(row, e.currentTarget)}
                      aria-label={`View JSON for trade ${tradeLabel}`}
                      data-testid="drilldown-pill-trade"
                    >
                      {tradeLabel}
                    </button>
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
                );
              })}
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
      {drawerRow ? <TradeJsonDrawer row={drawerRow} onClose={closeDrawer} /> : null}
    </div>
  );
}

// Wave 5.21e: side drawer that renders the full JSON document for a trade
// row. Slides in from the right; non-modal so the page below stays scrollable
// but is dimmed. Re-uses the JSON Explorer's pretty-printed <pre> idiom for
// visual consistency. Focus moves to the close button on open; the parent
// (BucketDrilldown) restores focus to the originating pill on close.
function TradeJsonDrawer({ row, onClose }: { row: PivotRow; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [copied, setCopied] = useState(false);
  const tradeLabel = String(row.doc.trade_id ?? row.key);
  const json = JSON.stringify(row.doc, null, 2);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Best effort — clipboard unavailable (e.g. insecure context). Silent.
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      // Stop the surrounding BucketDrilldown's Escape handler from also firing
      // (it would close the entire drill-down accordion).
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <>
      <div
        className="trade-json-drawer__backdrop"
        data-testid="trade-json-drawer-backdrop"
        onClick={onClose}
      />
      <div
        className="trade-json-drawer"
        role="dialog"
        aria-modal="false"
        aria-label={`Trade ${tradeLabel} JSON`}
        data-testid="trade-json-drawer"
        onKeyDown={onKeyDown}
      >
        <div className="trade-json-drawer__header">
          <h4 className="trade-json-drawer__title" data-testid="trade-json-drawer-title">
            {tradeLabel}
          </h4>
          <div className="trade-json-drawer__actions">
            <button
              type="button"
              className="trade-json-drawer__copy"
              onClick={copyJson}
              data-testid="trade-json-drawer-copy"
            >
              {copied ? "Copied" : "Copy JSON"}
            </button>
            <button
              ref={closeRef}
              type="button"
              className="trade-json-drawer__close"
              onClick={onClose}
              aria-label={`Close JSON drawer for trade ${tradeLabel}`}
              data-testid="trade-json-drawer-close"
            >
              ✕
            </button>
          </div>
        </div>
        <pre className="trade-json-drawer__body" data-testid="trade-json-drawer-body">
          {json}
        </pre>
      </div>
    </>
  );
}

// Wave 5.83D-2: engine/cache badge that rides on the "Redis commands executed"
// header. `cache === "hit"` takes precedence over engine — a cache hit didn't
// hit the kernel at all, so labelling it as "via FT.AGGREGATE" would be
// misleading. Three states: green (fast path), amber (legacy Lua), blue
// (cache). `totalMs` is rounded to an integer for compactness.
function CalcEnginePill({
  engine,
  cache,
  totalMs,
}: {
  engine: CalcEngine | undefined;
  cache: CalcCacheState | undefined;
  totalMs: number;
}) {
  const ms = Math.round(totalMs);
  if (cache === "hit") {
    return (
      <span
        className="calc-engine-pill"
        data-testid="calc-engine-pill"
        data-state="cache"
      >
        served from cache · {ms}ms
      </span>
    );
  }
  if (engine === "ft_aggregate") {
    return (
      <span
        className="calc-engine-pill"
        data-testid="calc-engine-pill"
        data-state="ft_aggregate"
      >
        via FT.AGGREGATE · {ms}ms
      </span>
    );
  }
  if (engine === "fcall_lua") {
    return (
      <span
        className="calc-engine-pill"
        data-testid="calc-engine-pill"
        data-state="fcall_lua"
      >
        via FCALL (Lua) · {ms}ms
      </span>
    );
  }
  return null;
}

// Wave 5.16m: read-only observability panel that renders the exact Redis
// commands the api dispatched. Surfaces the Redis Enterprise primitives
// (RediSearch FT.AGGREGATE for discovery, Redis Functions FCALL for the
// slot-local fan-out) in plain view for the bank demo. Display-only — no
// re-execution, no logging beyond the api response.
function CommandsPanel({
  commands,
  engine,
  cache,
  totalMs,
}: {
  commands: CalcCommands;
  engine: CalcEngine | undefined;
  cache: CalcCacheState | undefined;
  totalMs: number;
}) {
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
    <PanelCard
      title="Redis commands executed"
      actions={<CalcEnginePill engine={engine} cache={cache} totalMs={totalMs} />}
    >
      <div aria-live="polite" data-testid="redis-commands">
        <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.9375rem" }}>Discovery (FT.AGGREGATE)</h3>
        <CommandPreview command={discoveryOneLiner} codeTestId="discovery-command" />
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
        <CommandPreview command={f.arg_template} codeTestId="fcall-command" />
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

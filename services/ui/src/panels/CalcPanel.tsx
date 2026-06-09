import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { BlockMath } from "react-katex";
import { EnterpriseCallout, PanelCard, Sparkline, TimingStrip } from "../components";
import { SuggestCombobox } from "../components/SuggestCombobox";
import type { ShardTiming } from "../components/TimingStrip";
import {
  postCalcSbm,
  type BucketResult,
  type CalcCacheState,
  type CalcCommands,
  type CalcEngine,
  type CalcSbmResponse,
  type CorrelationRegime,
  type SensitivityType,
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
                  {o.count !== null ? `${o.label} (${o.count})` : o.label}
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
                  {s.count !== null ? `${s.value} (${s.count})` : s.value}
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
            Computed in {result.total_ms} ms ({result.fanout_ms} ms of Redis fan-out)
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
  sensitivityType,
  bucketResult,
}: {
  bucket: string;
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
                    `\\text{winner} = K_b^{${curvature.winner === "plus" ? "+" : "-"}}`
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
          <pre
            className="bucket-drilldown__kb-command-pre"
            data-testid="bucket-drilldown-command-pre"
          >
            {resolved_command}
          </pre>
        ) : (
          <p className="bucket-drilldown__kb-command-missing">
            (resolved command not available)
          </p>
        )}
      </section>
    </div>
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

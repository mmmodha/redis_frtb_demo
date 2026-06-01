import { useState, type CSSProperties } from "react";
import { EnterpriseCallout, PanelCard, TimingStrip } from "../components";
import type { ShardTiming } from "../components/TimingStrip";
import {
  postCalcSbm,
  type BucketResult,
  type CalcCommands,
  type CalcSbmResponse,
  type SensitivityType,
} from "../lib/calc";

type RiskClass = "GIRR" | "Equity" | "FX";
type SortKey = "bucket" | "K_b" | "S_b" | "count" | "ms";
type Tone = "green" | "amber" | "red";

const RISK_CLASS_OPTIONS: Array<{ value: RiskClass; label: string; live: boolean }> = [
  { value: "GIRR", label: "GIRR", live: true },
  { value: "Equity", label: "Equity", live: true },
  { value: "FX", label: "FX", live: true },
];

const SENSITIVITY_OPTIONS: SensitivityType[] = ["Delta", "Vega"];

function toneFor(totalMs: number): Tone {
  if (totalMs < 2000) return "green";
  if (totalMs < 5000) return "amber";
  return "red";
}

function formatCharge(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

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

// Wave 5.16n: at-a-glance capital-concentration chart. K_b descending,
// per-bucket horizontal bars mirroring TimingStrip's scaleX pattern.
function BucketChargeChart({ buckets }: { buckets: BucketResult[] }) {
  if (buckets.length === 0) {
    return <div className="bucket-chart__empty">no buckets yet</div>;
  }
  const sorted = [...buckets].sort((a, b) => b.K_b - a.K_b);
  const maxK = Math.max(...sorted.map((b) => b.K_b), 1);
  const totalK = sorted.reduce((acc, b) => acc + b.K_b, 0);
  return (
    <div className="bucket-chart" role="list" data-testid="bucket-chart">
      {sorted.map((b) => {
        const share = totalK > 0 ? b.K_b / totalK : 0;
        const tone = bucketToneFor(share);
        const sBSign = b.S_b >= 0 ? "+" : "";
        return (
          <div
            className="bucket-chart__row"
            role="listitem"
            key={b.bucket}
            data-testid="bucket-chart-row"
            data-bucket={b.bucket}
          >
            <span className="bucket-chart__label">{b.bucket}</span>
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
              {b.S_b.toFixed(2)}
            </span>
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
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);

  const isWave4 = riskClass !== "GIRR";

  async function onCalculate() {
    setLoading(true);
    setError(null);
    setResult(null);
    setSortKey(null);
    try {
      const r = await postCalcSbm({ risk_class: riskClass, sensitivity_type: sensitivityType });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

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

      {error ? (
        <div role="alert" className="calc-panel__error">
          {error}
        </div>
      ) : null}

      {!result && !error && !loading ? (
        <PanelCard title="Result">
          <p className="calc-panel__empty">Press Calculate to fan out a slot-local FCALL per bucket.</p>
        </PanelCard>
      ) : null}

      {result ? <CalcResult result={result} sortKey={sortKey} setSortKey={setSortKey} sortedBuckets={sortedBuckets} /> : null}
    </div>
  );
}

function CalcResult({
  result,
  sortKey,
  setSortKey,
  sortedBuckets,
}: {
  result: CalcSbmResponse;
  sortKey: SortKey | null;
  setSortKey: (k: SortKey) => void;
  sortedBuckets: BucketResult[];
}) {
  const tone = toneFor(result.total_ms);
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
        <div className="calc-panel__charge" data-testid="calc-charge">
          {formatCharge(result.charge)}
        </div>
      </PanelCard>

      {hasMeaningfulShardTiming(result) ? (
        <PanelCard title="Per-shard timing">
          <TimingStrip shards={shardsFromResponse(result)} />
        </PanelCard>
      ) : null}

      {result.commands ? <CommandsPanel commands={result.commands} /> : null}

      <PanelCard title="Per-bucket K_b (capital concentration)">
        <BucketChargeChart buckets={result.per_bucket} />
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
            {sortedBuckets.map((b) => (
              <tr key={b.bucket} data-testid="bucket-row" data-bucket={b.bucket}>
                <td>{b.bucket}</td>
                <td>{b.K_b}</td>
                <td>{b.S_b}</td>
                <td>{b.count}</td>
                <td>{b.ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelCard>
    </>
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

// POST /generator/start — in-process synthetic-row generator backed by the
// @frtb/generator library. Drives the Ingest panel "Run generator" button so
// the demo can top up `sensitivities:in` without exec-ing the standalone CLI.
// The container-mode CLI (`services/generator/src/cli.ts`, profiles: ["tools"])
// stays the canonical bulk-seed path; this endpoint is the UI-driven
// small-batch top-up path (≤2000 rows/call).

import { ulid } from "ulid";
import { availableParallelism } from "node:os";
import type { FastifyInstance } from "fastify";
import type { Schema } from "@frtb/schema";
import {
  DEFAULT_FLOW_CONTROL,
  type FlowControlOptions,
} from "@frtb/generator";
// Wave 5.95C — producer construction + per-row XADD loop live in the
// shared helper so the JSON and SSE routes can't drift on MAXLEN /
// flow-control / stop-condition wiring (5.92C-fix had to patch both copies).
import {
  runGeneratorLoop,
  type StopReason,
  type StopWhen,
  type ClassPicker,
} from "../lib/run-generator.ts";
// Wave 5.84C — cluster-adaptive profile module + parsers. Plumbed through
// the api so the seed SSE frame includes the resolved plan (shape + dials)
// for the UI to surface alongside the run.
import {
  parseClusterInfo,
  parseInfoMemory as parseInfoMemoryProbe,
  parseMaxclients,
  fallbackShape,
  BYTES_PER_ROW,
  pickProfile,
  resolveDials,
  refuseOrGo,
  estimateDurationSec,
  type ClusterShape,
  type ProfileName,
  type ResolvedDials,
} from "@frtb/generator";
// Wave 5.92A — hash-tag stream-shard fan-out. The api validates the
// optional `stream_shards` body param and threads it into both the
// producer (router-aware fan-out) and the seed-frame plan (so the UI can
// show "fan-out across N streams" alongside the run).
import {
  createStreamRouter,
  parseStreamShardsFlag,
  type StreamShardsConfig,
} from "@frtb/stream-router";
import { cancelAllBulkRuns, haltBulkLoaderAccept } from "./ingest.ts";
import type { RedisLike } from "../redis-like.ts";
import { getActiveTarget } from "../active-target.ts";
import { corsHeadersForRequest } from "../cors-headers.ts";

// Wave 5.84B — `workers` field plumbed through the api so the UI can surface
// "running with N workers" and so the CLI/api request payloads stay symmetric
// (DoD #7). The api is the UI-driven top-up path (≤2000 rows/call typical);
// at those sizes the worker-spawn overhead (~50ms per worker) dominates the
// throughput gain, so the api runs the existing inline detached-promise loop
// regardless of the requested worker count. The CLI is the canonical
// multi-worker bulk-seed path (see services/generator/src/cli.ts) where the
// shard-out actually wins. The knob is still validated + echoed here so a
// future wave can wire api-side worker_threads without a request-shape break.
const MAX_WORKERS_API = 16;

// Wave 5.92C-fix — default approximate MAXLEN per stream, mirroring the
// CLI's DEFAULT_STREAM_MAXLEN (~2 GB at ~1 KB/entry). Threaded into every
// createStreamProducer constructed by this route so UI / HTTP-initiated
// runs are protected from OOM when consumers fall behind. Body
// `stream_maxlen: 0` opts out (XADD args become bit-identical to pre-5.92C).
const DEFAULT_STREAM_MAXLEN = 2_000_000;

interface GeneratorStartBody {
  rows?: number;
  classes?: string[];
  sensitivity_types?: string[];
  seed?: string | number;
  // Wave 5.17a — tenant reshape: optional pool sizes for aux-RNG trade_id and
  // risk_factor fields. Defaults preserve smoke-run-16 byte-equivalence.
  trade_pool_size?: number;
  factor_pool_size?: number;
  // Wave 5.47d — explicit per-class row counts. When present, the generator
  // draws each class exactly the configured count and the total row count is
  // the sum (or must equal `rows` if both are supplied). When absent, falls
  // back to round-robin via `classes` + `rows`.
  class_split?: Record<string, number>;
  // Wave 5.47c — optional stop conditions. Whichever trips FIRST halts the
  // run. If omitted, behaviour is exactly today's (defaults to rows).
  stop_when?: {
    rows?: number;
    memory_pct?: number;
    elapsed_seconds?: number;
  };
  // Wave 5.84A — generator-throughput knobs. Both optional. batch_size sets
  // the XADD pipeline batch size (default DEFAULT_BATCH_SIZE). pipeline_window
  // bounds how many pipeline.exec() calls may be in flight at once (default
  // DEFAULT_PIPELINE_WINDOW=1, bit-identical to pre-5.84A).
  batch_size?: number;
  pipeline_window?: number;
  // Wave 5.84B — worker_threads shard-out (1..MAX_WORKERS_API). Default 1 is
  // bit-identical to pre-5.84B (skips the worker spawn; runs the existing
  // inline detached-promise loop). When >1, the route spawns N workers each
  // with its own ioredis client + RowGenerator + StreamProducer; coordinator
  // merges per-worker postMessage progress into a single SSE counter.
  workers?: number;
  // Wave 5.84C — cluster-adaptive profile. `auto` (default) probes the
  // target and picks dials by shard count + host cores; explicit
  // small/medium/large overrides autodetect. Manual workers/batch_size/
  // pipeline_window in this same body still override the profile's dials
  // (manual always wins — DoD #4). Invalid values are rejected with 400.
  profile?: "auto" | "small" | "medium" | "large";
  // Wave 5.92A — hash-tag stream-shard fan-out. Positive integer
  // (modulo-N routing) or the literal "per-bucket". Default 1 keeps the
  // pre-5.92 single-stream code path bit-identical. Manual override of
  // the profile-resolved dial follows the same "manual wins" rule.
  stream_shards?: number | "per-bucket";
  // Wave 5.92C-fix — approximate XADD MAXLEN cap. Default 2_000_000
  // (matching CLI / source defaults). 0 disables the cap (no MAXLEN args
  // appended, restoring pre-5.92C XADD command sequence). Threaded through
  // to createStreamProducer at both call sites below.
  stream_maxlen?: number;
  // Wave 5.92C-fix — optional producer-side XLEN credit gate. When omitted
  // the gate is OFF (default), matching the CLI's "no gate unless asked"
  // contract for the UI/HTTP top-up path. When provided, a
  // StreamFlowControl is constructed and passed to the producer; the gate
  // polls XLEN and pauses XADD when the configured high-water mark trips.
  flow_control?: {
    pauseAboveLen?: number;
    resumeBelowLen?: number;
    checkEveryRows?: number;
  };
  // Wave 6.13b — defer per-XADD MAXLEN trim to end-of-run. When true,
  // XADDs omit the `MAXLEN ~ N` args (matching the pre-5.92C command
  // sequence bit-for-bit) and the producer issues one
  // `XTRIM <stream> MAXLEN ~ <stream_maxlen>` per active stream key on
  // close() instead. Default false keeps the per-XADD trim behaviour.
  // Safe ONLY when consumers are expected to drain within the run window;
  // otherwise MAXLEN drift can leave the cluster memory-pressured if a
  // consumer falls behind. No UI control yet — toggle via curl/DevTools.
  defer_trim?: boolean;
}

// Wave 5.84C — accepted profile values for body validation.
const PROFILE_NAMES = new Set<string>(["auto", "small", "medium", "large"]);

// Wave 5.95C — `StopWhen` / `StopReason` now live with the shared
// run-loop helper (the only consumer of the per-row logic). `StopReason`
// is re-exported here for backward compat with any downstream import.
export type { StopReason };

export interface GeneratorRoutesOpts {
  streamName?: string;
  // Wave 5.20c — SSE progress-frame cadence for /generator/start/stream.
  // Tests override this so a small synthetic batch still emits ≥1 progress
  // frame before the terminal frame.
  sseProgressIntervalMs?: number;
  // Wave 5.21i — resolved @fastify/cors allow-list value. Threaded in so the
  // hijacked SSE response carries the matching access-control-allow-origin
  // header that the cors plugin's onSend hook can't inject for a hijack.
  corsAllowed?: true | string | string[];
  // Wave 5.40a — grace window (ms) during which a terminal run remains
  // queryable via GET /generator/runs/:id/status so a refresh right after
  // completion still surfaces the summary. Tests dial this down.
  terminalGraceMs?: number;
  // Wave 6.44.E — upstream base URL for the ingest service used by
  // /admin/cancel-all-runs to call POST /ingest/halt-and-flush after
  // flipping cancel flags. Falls back to INGEST_URL env var, then to the
  // compose-internal default at request time.
  ingestBase?: string;
  // Wave 6.44.E — override the global `fetch` used to call ingest's
  // halt-and-flush. Tests inject a stub to assert headers / response wiring
  // without needing a real upstream.
  fetchImpl?: typeof fetch;
  // Wave 6.44.E — best-effort window (ms) we wait for cancel flags to
  // propagate to status="cancelled" before calling halt-and-flush. Defaults
  // to 2000; tests dial this down.
  cancelDrainMs?: number;
}

const DEFAULT_ROWS = 200;
const DEFAULT_CLASSES = ["GIRR", "Equity", "FX"] as const;
const DEFAULT_SENSITIVITY_TYPES = ["Delta", "Vega", "Curvature"] as const;

// Wave 5.84A — generator throughput defaults. DEFAULT_BATCH_SIZE was bumped
// from 200 to 1000 (the CLI default) to halve round-trip overhead on the
// in-process api path. DEFAULT_PIPELINE_WINDOW=1 keeps single-in-flight
// semantics by default; callers opt into windowing via `pipeline_window`.
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_PIPELINE_WINDOW = 1;
const MAX_BATCH_SIZE = 50_000;
const MAX_PIPELINE_WINDOW_API = 8;

// Wave 5.40a — module-local registry of in-flight + recently-terminal runs.
// The generation loop runs as a detached promise that owns the lifecycle of
// these entries; the SSE handler is now a pure transport that pipes the
// state into frames and stops writing on client disconnect. Cancellation is
// only triggered explicitly via POST /generator/cancel/:run_id (closing the
// browser tab no longer cancels the run — see Wave 5.40 spec).
interface ActiveRun {
  run_id: string;
  status: "running" | "done" | "cancelled" | "error";
  rows_done: number;
  rows_total: number;
  elapsed_ms: number;
  rows_per_sec: number;
  started_at_iso: string;
  classes: string[];
  sensitivity_types: string[];
  cancelFlag: { cancelled: boolean };
  error?: string;
  terminal_at_ms?: number;
  // Wave 5.47c — which condition halted the loop. Defaults to "rows" for
  // backward compat (the historical "ran to row count" terminal).
  stop_reason?: StopReason;
  // Wave 5.84B — resolved worker count for this run. Echoed in the seed +
  // terminal SSE frames so the UI can surface "running with N workers".
  workers?: number;
  // Wave 6.12c — resolved plan dials for this run. Populated by the SSE
  // route from the same object the seed frame surfaces, so a refresh after
  // the seed frame is gone can still confirm what shard count / workers /
  // batch / window were used. The non-streaming /generator/start path omits
  // this (the JSON response shape stays untouched — there's no seed frame
  // there for the UI to lose).
  dials?: {
    workers: number;
    batch_size: number;
    pipeline_window: number;
    // StreamShardsConfig = number | "per-bucket" — matches the seed-frame
    // plan.dials shape so the two surfaces stay byte-identical.
    stream_shards: StreamShardsConfig;
  };
}
const activeRuns = new Map<string, ActiveRun>();

// The producer accepts an ioredis Redis|Cluster client — the only surface it
// uses is `.pipeline()`. RedisLike (the api's narrow interface) is widened
// here at the call site by structural typing; both the real ioredis client
// and the test stub satisfy it.
type PipelineClient = {
  pipeline(): {
    xadd(key: string, id: string, ...fields: string[]): unknown;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
};

// Wave 5.47d — class-sequence pickers. Both return the class to use for the
// i-th row. Round-robin keeps the existing modulo behaviour (O(1) per pick,
// no allocation). The Bresenham-style interleaver expands a class_split map
// so progress events show a consistent mix instead of "all GIRR then all FX".
// Wave 5.95C — `ClassPicker` interface is shared with the run-loop helper
// (imported above) so the picker handed to `runGeneratorLoop` typechecks.
function roundRobinPicker(resolvedClasses: string[]): ClassPicker {
  return { pick: (i) => resolvedClasses[i % resolvedClasses.length]! };
}
// Largest-deficit interleaver: at each output slot, advance the class whose
// next placement is earliest on the fractional timeline (placed+0.5)/count.
// Deterministic and produces an even mix (e.g. {GIRR:100, FX:50} → GFGG FGGF…).
function interleavedSequence(splits: Array<{ klass: string; count: number }>): string[] {
  const active = splits.filter((s) => s.count > 0);
  let total = 0;
  for (const s of active) total += s.count;
  const out: string[] = new Array(total);
  const placed: number[] = active.map(() => 0);
  for (let i = 0; i < total; i++) {
    let bestIdx = -1;
    let bestKey = Infinity;
    for (let j = 0; j < active.length; j++) {
      if (placed[j]! >= active[j]!.count) continue;
      const key = (placed[j]! + 0.5) / active[j]!.count;
      if (key < bestKey) { bestKey = key; bestIdx = j; }
    }
    out[i] = active[bestIdx]!.klass;
    placed[bestIdx]!++;
  }
  return out;
}
function sequencePicker(seq: string[]): ClassPicker {
  return { pick: (i) => seq[i]! };
}

// Wave 5.47d — shared request parser. Validates rows / classes /
// sensitivity_types / pool sizes / class_split and returns the resolved
// values used by both the non-streaming and streaming routes. Returning a
// discriminated union keeps the call sites flat (status + body).
interface ParsedGeneratorRequest {
  ok: true;
  rows: number;
  resolvedClasses: string[];
  sensitivity_types: string[];
  tradePool: number | undefined;
  factorPool: number | undefined;
  picker: ClassPicker;
  stopWhen: StopWhen;
  // Wave 5.84A — resolved generator-throughput knobs (always populated; fall
  // back to DEFAULT_BATCH_SIZE / DEFAULT_PIPELINE_WINDOW when omitted).
  batchSize: number;
  pipelineWindow: number;
  // Wave 5.84B — resolved worker count (always populated; defaults to 1).
  workers: number;
  // Wave 5.84C — explicit profile name from the request (auto|small|
  // medium|large). The seed-frame plan uses this together with the probed
  // shape to compute the resolved dials.
  profile: "auto" | ProfileName;
  // Wave 5.92A — resolved hash-tag stream-shard config from the request
  // body. `undefined` means "use the profile-resolved dial"; explicit
  // values override (manual wins — DoD #4).
  streamShards: StreamShardsConfig | undefined;
  // Wave 5.92C-fix — resolved approximate XADD MAXLEN cap. `undefined`
  // means "opt out" (no MAXLEN args appended); a positive integer is
  // passed through verbatim to createStreamProducer's `streamMaxLen`.
  streamMaxLen: number | undefined;
  // Wave 5.92C-fix — resolved producer-side flow-control options.
  // `undefined` means "no gate" (default for the UI/HTTP top-up path).
  // When present, the route constructs a StreamFlowControl via
  // createStreamFlowControl(redis, opts, app.log) and passes it to the
  // producer.
  flowControlOptions: FlowControlOptions | undefined;
  // Wave 6.13b — resolved deferred-MAXLEN-trim flag. Defaults to false
  // (per-XADD MAXLEN trim). When true the producer omits MAXLEN args from
  // XADD and issues one XTRIM per active stream key on close().
  deferTrim: boolean;
}
interface ParsedGeneratorError {
  ok: false;
  status: number;
  error: string;
}
function parseGeneratorRequest(
  body: GeneratorStartBody,
  schema: Schema,
): ParsedGeneratorRequest | ParsedGeneratorError {
  // Wave 5.47c — validate stop_when up front. Each numeric field must be a
  // positive integer (elapsed_seconds may be a finite positive float). At
  // least one of rows/memory_pct/elapsed_seconds must be present when
  // stop_when is supplied.
  const stopWhen: StopWhen = {};
  if (body.stop_when !== undefined) {
    if (typeof body.stop_when !== "object" || body.stop_when === null || Array.isArray(body.stop_when)) {
      return { ok: false, status: 400, error: "stop_when must be an object" };
    }
    const sw = body.stop_when;
    if (sw.rows !== undefined) {
      if (
        typeof sw.rows !== "number"
        || !Number.isFinite(sw.rows)
        || !Number.isInteger(sw.rows)
        || sw.rows <= 0
      ) {
        return { ok: false, status: 400, error: "stop_when.rows must be a positive integer" };
      }
      stopWhen.rows = sw.rows;
    }
    if (sw.memory_pct !== undefined) {
      if (
        typeof sw.memory_pct !== "number"
        || !Number.isFinite(sw.memory_pct)
        || !Number.isInteger(sw.memory_pct)
        || sw.memory_pct < 1
        || sw.memory_pct > 95
      ) {
        return { ok: false, status: 400, error: "stop_when.memory_pct must be an integer in 1..95" };
      }
      stopWhen.memory_pct = sw.memory_pct;
    }
    if (sw.elapsed_seconds !== undefined) {
      if (
        typeof sw.elapsed_seconds !== "number"
        || !Number.isFinite(sw.elapsed_seconds)
        || sw.elapsed_seconds <= 0
        || sw.elapsed_seconds > 86400
      ) {
        return { ok: false, status: 400, error: "stop_when.elapsed_seconds must be a positive number in 1..86400" };
      }
      stopWhen.elapsed_seconds = sw.elapsed_seconds;
    }
    if (stopWhen.rows === undefined && stopWhen.memory_pct === undefined && stopWhen.elapsed_seconds === undefined) {
      return { ok: false, status: 400, error: "stop_when must contain at least one condition" };
    }
  }

  // class_split (if present) defines the per-class row counts. The total row
  // count is the sum and must agree with `rows` if both are supplied.
  let classSplitResolved: Array<{ klass: string; count: number }> | null = null;
  if (body.class_split !== undefined) {
    if (typeof body.class_split !== "object" || body.class_split === null || Array.isArray(body.class_split)) {
      return { ok: false, status: 400, error: "class_split must be an object mapping risk class → count" };
    }
    const entries = Object.entries(body.class_split);
    if (entries.length === 0) {
      return { ok: false, status: 400, error: "class_split cannot be empty if provided" };
    }
    const resolved: Array<{ klass: string; count: number }> = [];
    for (const [klass, count] of entries) {
      if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
        return { ok: false, status: 400, error: `class_split[${klass}] must be a non-negative integer` };
      }
      const upper = String(klass).toUpperCase();
      const canonical = schema.risk_classes[upper] ? upper : schema.risk_classes[klass] ? klass : null;
      if (!canonical) {
        return { ok: false, status: 400, error: `unknown risk class: ${klass}` };
      }
      resolved.push({ klass: canonical, count });
    }
    classSplitResolved = resolved;
  }

  let rows: number;
  if (classSplitResolved) {
    const sum = classSplitResolved.reduce((acc, s) => acc + s.count, 0);
    if (body.rows !== undefined && body.rows !== sum) {
      return {
        ok: false,
        status: 400,
        error: `class_split totals ${sum} but rows is ${body.rows}; omit rows or set rows=${sum}`,
      };
    }
    // Wave 5.47c — stop_when.rows is also checked against the class_split sum
    // (mirrors the rows-vs-class_split rule).
    if (stopWhen.rows !== undefined && stopWhen.rows !== sum) {
      return {
        ok: false,
        status: 400,
        error: `class_split totals ${sum} but stop_when.rows is ${stopWhen.rows}; omit stop_when.rows or set it to ${sum}`,
      };
    }
    rows = sum;
  } else if (stopWhen.rows !== undefined) {
    // Wave 5.47c — stop_when.rows is the row-stop condition. When body.rows
    // is also provided they must agree; otherwise stop_when.rows wins.
    if (body.rows !== undefined && body.rows !== stopWhen.rows) {
      return {
        ok: false,
        status: 400,
        error: `rows is ${body.rows} but stop_when.rows is ${stopWhen.rows}; omit one or set them equal`,
      };
    }
    rows = stopWhen.rows;
  } else {
    rows = body.rows ?? DEFAULT_ROWS;
  }
  // Wave 5.20c — hard MAX_ROWS cap removed; the cluster sanity check in the
  // UI is the user-facing guardrail. Only structural validation remains here.
  if (
    typeof rows !== "number"
    || !Number.isFinite(rows)
    || !Number.isInteger(rows)
    || rows <= 0
    || rows > Number.MAX_SAFE_INTEGER
  ) {
    return { ok: false, status: 400, error: "rows must be a positive integer" };
  }

  let resolvedClasses: string[];
  if (classSplitResolved) {
    // When class_split is provided it fully determines the class set; the
    // top-level `classes` field is ignored to avoid ambiguous behaviour.
    resolvedClasses = classSplitResolved.map((s) => s.klass);
  } else {
    const classes = body.classes && body.classes.length > 0 ? body.classes : [...DEFAULT_CLASSES];
    for (const c of classes) {
      const upper = String(c).toUpperCase();
      if (!schema.risk_classes[upper] && !schema.risk_classes[c]) {
        return { ok: false, status: 400, error: `unknown risk class: ${c}` };
      }
    }
    // Resolve to the canonical key (UPPERCASE) used everywhere downstream —
    // mirrors the calc.ts §Wave 5.15l convention.
    resolvedClasses = classes.map((c) => {
      const upper = String(c).toUpperCase();
      return schema.risk_classes[upper] ? upper : c;
    });
  }

  const sensitivity_types = body.sensitivity_types && body.sensitivity_types.length > 0
    ? body.sensitivity_types
    : [...DEFAULT_SENSITIVITY_TYPES];

  // Wave 5.17a — validate pool sizes if provided (1..10000 / 1..256).
  const tradePool = body.trade_pool_size;
  if (tradePool !== undefined) {
    if (typeof tradePool !== "number" || !Number.isFinite(tradePool) || tradePool < 1 || tradePool > 10000) {
      return { ok: false, status: 400, error: "trade_pool_size must be a number in 1..10000" };
    }
  }
  const factorPool = body.factor_pool_size;
  if (factorPool !== undefined) {
    if (typeof factorPool !== "number" || !Number.isFinite(factorPool) || factorPool < 1 || factorPool > 256) {
      return { ok: false, status: 400, error: "factor_pool_size must be a number in 1..256" };
    }
  }

  // Wave 5.84A — validate optional generator-throughput knobs.
  let batchSize = DEFAULT_BATCH_SIZE;
  if (body.batch_size !== undefined) {
    const bs = body.batch_size;
    if (
      typeof bs !== "number"
      || !Number.isFinite(bs)
      || !Number.isInteger(bs)
      || bs < 1
      || bs > MAX_BATCH_SIZE
    ) {
      return { ok: false, status: 400, error: `batch_size must be an integer in 1..${MAX_BATCH_SIZE}` };
    }
    batchSize = bs;
  }
  let pipelineWindow = DEFAULT_PIPELINE_WINDOW;
  if (body.pipeline_window !== undefined) {
    const pw = body.pipeline_window;
    if (
      typeof pw !== "number"
      || !Number.isFinite(pw)
      || !Number.isInteger(pw)
      || pw < 1
      || pw > MAX_PIPELINE_WINDOW_API
    ) {
      return { ok: false, status: 400, error: `pipeline_window must be an integer in 1..${MAX_PIPELINE_WINDOW_API}` };
    }
    pipelineWindow = pw;
  }

  // Wave 5.84B — validate optional workers field.
  let workers = 1;
  if (body.workers !== undefined) {
    const w = body.workers;
    if (
      typeof w !== "number"
      || !Number.isFinite(w)
      || !Number.isInteger(w)
      || w < 1
      || w > MAX_WORKERS_API
    ) {
      return { ok: false, status: 400, error: `workers must be an integer in 1..${MAX_WORKERS_API}` };
    }
    workers = w;
  }

  // Wave 5.84C — validate optional profile name (auto|small|medium|large).
  let profile: "auto" | ProfileName = "auto";
  if (body.profile !== undefined) {
    if (typeof body.profile !== "string" || !PROFILE_NAMES.has(body.profile)) {
      return { ok: false, status: 400, error: "profile must be one of auto|small|medium|large" };
    }
    profile = body.profile;
  }

  // Wave 5.92A — validate optional stream_shards (positive integer or
  // "per-bucket"). Reuses the shared parser so the api accepts the same
  // shape as the CLI's --stream-shards flag.
  let streamShards: StreamShardsConfig | undefined;
  if (body.stream_shards !== undefined) {
    const raw = body.stream_shards;
    if (typeof raw !== "string" && typeof raw !== "number") {
      return { ok: false, status: 400, error: "stream_shards must be a positive integer or \"per-bucket\"" };
    }
    try {
      streamShards = parseStreamShardsFlag(raw);
    } catch (e) {
      return { ok: false, status: 400, error: (e instanceof Error ? e.message : String(e)) };
    }
  }

  // Wave 5.92C-fix — resolve approximate XADD MAXLEN cap. Default
  // DEFAULT_STREAM_MAXLEN (parity with CLI's --stream-maxlen default);
  // explicit `0` opts out (XADD args bit-identical to pre-5.92C).
  let streamMaxLen: number | undefined = DEFAULT_STREAM_MAXLEN;
  if (body.stream_maxlen !== undefined) {
    const sm = body.stream_maxlen;
    if (typeof sm !== "number" || !Number.isFinite(sm) || !Number.isInteger(sm) || sm < 0) {
      return { ok: false, status: 400, error: "stream_maxlen must be a non-negative integer (0 to disable)" };
    }
    streamMaxLen = sm > 0 ? sm : undefined;
  }

  // Wave 5.92C-fix — validate optional flow_control gate config. Default
  // is `undefined` (no gate) for the UI/HTTP path — the bench harness in
  // 5.92D passes this explicitly. Each provided field must be a positive
  // integer; cross-field invariant resumeBelowLen < pauseAboveLen is
  // checked here on the merged-with-defaults values so callers get a
  // clean 400 instead of a 500 from createStreamFlowControl.
  let flowControlOptions: FlowControlOptions | undefined;
  if (body.flow_control !== undefined) {
    const fc = body.flow_control;
    if (typeof fc !== "object" || fc === null || Array.isArray(fc)) {
      return { ok: false, status: 400, error: "flow_control must be an object" };
    }
    const opts: FlowControlOptions = {};
    const fieldMap: ReadonlyArray<readonly [keyof NonNullable<GeneratorStartBody["flow_control"]>, keyof FlowControlOptions]> = [
      ["pauseAboveLen", "pauseAboveLen"],
      ["resumeBelowLen", "resumeBelowLen"],
      ["checkEveryRows", "flowCheckEveryRows"],
    ];
    for (const [bodyKey, optKey] of fieldMap) {
      const v = (fc as Record<string, unknown>)[bodyKey];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
        return { ok: false, status: 400, error: `flow_control.${bodyKey} must be a positive integer` };
      }
      opts[optKey] = v;
    }
    const eff = { ...DEFAULT_FLOW_CONTROL, ...opts };
    if (eff.resumeBelowLen >= eff.pauseAboveLen) {
      return { ok: false, status: 400, error: `flow_control.resumeBelowLen (${eff.resumeBelowLen}) must be < pauseAboveLen (${eff.pauseAboveLen})` };
    }
    flowControlOptions = opts;
  }

  // Wave 6.13b — validate optional defer_trim flag. Must be a strict
  // boolean; default false (per-XADD MAXLEN trim path, unchanged).
  let deferTrim = false;
  if (body.defer_trim !== undefined) {
    if (typeof body.defer_trim !== "boolean") {
      return { ok: false, status: 400, error: "defer_trim must be a boolean" };
    }
    deferTrim = body.defer_trim;
  }

  const picker: ClassPicker = classSplitResolved
    ? sequencePicker(interleavedSequence(classSplitResolved))
    : roundRobinPicker(resolvedClasses);

  return {
    ok: true, rows, resolvedClasses, sensitivity_types, tradePool, factorPool, picker, stopWhen,
    batchSize, pipelineWindow, workers, profile, streamShards,
    streamMaxLen, flowControlOptions, deferTrim,
  };
}

// Wave 5.95C — `parseInfoMemory` + `memoryPct` (used only inside the
// per-row stop-condition loop) now live in `lib/run-generator.ts` next
// to the loop body that consumes them.

// Wave 5.84C — light-weight probe used by the api streaming route to build
// the same `plan` payload the CLI logs. Goes through the narrow `RedisLike`
// surface so a `FakeRedis` (or a redis without CLUSTER/CONFIG perms) just
// falls back to the conservative `small` shape instead of erroring. The
// only commands attempted are: CLUSTER INFO, INFO memory, CONFIG GET
// maxclients — each guarded individually so partial info is still used.
async function probeForApi(redis: RedisLike): Promise<ClusterShape> {
  const shape: ClusterShape = { ...fallbackShape() };
  // CLUSTER INFO → shard count + cluster mode. A non-cluster server replies
  // with an error or "cluster_enabled:0"; either path keeps shape.mode as
  // "standalone" and shards=1.
  try {
    const ci = await redis.call("CLUSTER", "INFO");
    if (typeof ci === "string") {
      const parsed = parseClusterInfo(ci);
      if (parsed.enabled) {
        shape.mode = "cluster";
        if (parsed.size > 0) shape.shards = parsed.size;
      }
    }
  } catch { /* non-cluster or no perms — keep standalone defaults */ }
  // INFO memory → used + maxmemory bytes for the refuse-or-go gate.
  try {
    const text = await redis.info("memory");
    if (typeof text === "string") {
      const mem = parseInfoMemoryProbe(text);
      shape.usedMemoryBytes = mem.used_memory;
      shape.maxmemoryBytes = mem.maxmemory;
    }
  } catch { /* INFO denied — leave 0; gate becomes a no-op */ }
  // CONFIG GET maxclients → reported as a [name, value] reply.
  try {
    const reply = await redis.call("CONFIG", "GET", "maxclients");
    const mc = parseMaxclients(reply);
    if (mc > 0) shape.maxclients = mc;
  } catch { /* leave conservative default */ }
  // Mark the shape non-fallback once we collected at least one signal so the
  // UI can distinguish "probe ran, here's what we saw" from "probe failed,
  // using small". An empty-everything return still reads as a fallback.
  if (shape.shards > 1 || shape.maxmemoryBytes > 0 || shape.maxclients !== fallbackShape().maxclients) {
    shape.fallback = false;
  }
  return shape;
}

export function registerGeneratorRoutes(
  app: FastifyInstance,
  // Wave 6.56.D4 — async accessor.
  getRedis: () => RedisLike | Promise<RedisLike>,
  schema: Schema | undefined,
  opts: GeneratorRoutesOpts = {},
): void {
  const streamName = opts.streamName ?? "sensitivities:in";
  const corsAllowed = opts.corsAllowed ?? "http://localhost:3000";
  // Wave 6.44.E — fetch impl + cancel-drain budget are resolved once at
  // route registration; ingestBase is resolved per-request (read from env
  // inside the handler) so test setups can poke INGEST_URL before injecting.
  const cancelFetch: typeof fetch = opts.fetchImpl ?? fetch;
  const cancelDrainMs = opts.cancelDrainMs ?? 2000;

  app.post<{ Body: GeneratorStartBody }>("/generator/start", { config: { category: "heavy-ingest" } }, async (req, reply) => {
    if (!schema) {
      app.log.warn({ evt: "generator-start", err: "schema-missing" });
      reply.code(503);
      return { error: "schema not loaded; api boot incomplete" };
    }

    const body = (req.body ?? {}) as GeneratorStartBody;
    const parsed = parseGeneratorRequest(body, schema);
    if (!parsed.ok) {
      reply.code(parsed.status);
      return { error: parsed.error };
    }
    const { rows, resolvedClasses, sensitivity_types, tradePool, factorPool, picker, stopWhen, batchSize, pipelineWindow, workers, streamShards, streamMaxLen, flowControlOptions, deferTrim } = parsed;

    const run_id = ulid();

    // Wave 5.16t — resolve active redis per-request so the generator writes
    // to the currently-active profile's stream.
    const redis = await getRedis();
    const target_label = getActiveTarget().label;

    // Wave 5.92A — construct the router only when stream_shards is provided
    // AND != 1; the default (no field, or stream_shards=1) goes through the
    // legacy single-stream code path bit-identically.
    const router = streamShards !== undefined && streamShards !== 1
      ? createStreamRouter(streamName, streamShards)
      : undefined;

    // Wave 5.95C — producer setup + per-row XADD loop + stop-condition
    // checks live in the shared helper so the JSON and SSE routes can't
    // drift on MAXLEN / flow-control / stop wiring (5.92C-fix had to
    // touch both copies). The helper never throws; producer/redis errors
    // surface via `result.error`.
    const result = await runGeneratorLoop({
      redis, log: app.log, evt: "generator-start", run_id, target_label,
      schema, seed: body.seed, sensitivity_types, tradePool, factorPool,
      streamName, batchSize, pipelineWindow, router, streamMaxLen, flowControlOptions,
      rows, picker, stopWhen, deferTrim,
    });
    if (result.error) {
      if (result.error.translated) {
        reply.code(result.error.translated.status);
        return result.error.translated.body;
      }
      reply.code(502);
      return { error: `redis unreachable: ${result.error.message}` };
    }

    app.log.info({ evt: "generator-start", run_id, rows_queued: result.rows_queued, classes: resolvedClasses, ms: result.ms });

    return {
      ok: true,
      run_id,
      rows_queued: result.rows_queued,
      classes: resolvedClasses,
      sensitivity_types,
      ms: Math.round(result.ms * 1000) / 1000,
      stop_reason: result.stop_reason,
      // Wave 5.84B — echo the resolved worker count so the UI can surface it
      // alongside the run summary (DoD #7). The non-streaming /generator/start
      // path always runs in the request handler (single-thread); the
      // multi-worker spawn lives behind the streaming route below.
      workers,
    };
  });

  // Wave 5.40a — streaming variant. The generation loop runs as a DETACHED
  // promise that owns the lifecycle of an `activeRuns` entry; the SSE handler
  // is a pure transport that pipes state into frames and stops writing on
  // client disconnect WITHOUT cancelling the run (refresh-survival, see Wave
  // 5.40 spec). Cancellation only happens via POST /generator/cancel/:run_id
  // or via a producer/redis error.
  const progressIntervalMs = opts.sseProgressIntervalMs ?? 200;
  const terminalGraceMs = opts.terminalGraceMs ?? 30_000;

  // Wave 5.95C — the per-row loop body that mutates this run's `state`
  // now lives in `runGeneratorLoop` (lib/run-generator.ts) shared with
  // the JSON route. The SSE caller wires `onTick` to update the same
  // `state` fields and `cancelFlag` to the same flag /generator/cancel
  // flips, so the terminal-frame transition + grace-eviction below
  // continues to be the only SSE-specific orchestration.

  app.post<{ Body: GeneratorStartBody }>("/generator/start/stream", { config: { category: "heavy-ingest" } }, async (req, reply) => {
    if (!schema) {
      app.log.warn({ evt: "generator-stream", err: "schema-missing" });
      reply.code(503);
      return { error: "schema not loaded; api boot incomplete" };
    }

    const body = (req.body ?? {}) as GeneratorStartBody;
    const parsed = parseGeneratorRequest(body, schema);
    if (!parsed.ok) {
      reply.code(parsed.status);
      return { error: parsed.error };
    }
    const { rows, resolvedClasses, sensitivity_types, tradePool, factorPool, picker, stopWhen, batchSize, pipelineWindow, workers, profile, streamShards, streamMaxLen, flowControlOptions, deferTrim } = parsed;

    const run_id = ulid();
    const redis = await getRedis();
    const target_label = getActiveTarget().label;

    // Wave 5.84C — probe the active redis to surface the resolved plan
    // (shape + dials) in the seed SSE frame. Manual workers/batch/window
    // from the request body override the profile's dials (DoD #4); the
    // route already applies those overrides via `parseGeneratorRequest`, so
    // we just thread the body values into `resolveDials` to compute the
    // overrides bitmap consistently with the CLI plan block.
    const shape = await probeForApi(redis);
    const profileName: ProfileName = profile === "auto" ? pickProfile(shape) : profile;
    const dials: ResolvedDials = resolveDials(profileName, shape, availableParallelism(), {
      workers: body.workers,
      batchSize: body.batch_size,
      pipelineWindow: body.pipeline_window,
      // Wave 5.92A — manual stream_shards from the body always wins.
      streamShards,
    });
    const gate = refuseOrGo(shape, rows);
    // Wave 6.11b — soft warning: target reports redis_mode=standalone but
    // the caller asked for multi-shard fan-out. This is the Redis Enterprise
    // DMC-proxy case (cluster hidden behind a single endpoint); we don't
    // block the run, just surface a heads-up on the plan response.
    const warnings: string[] = [];
    if (shape.mode === "standalone" && dials.streamShards !== 1) {
      warnings.push(
        `Target reports redis_mode=standalone; manual stream_shards=${dials.streamShards} is enabled. `
        + "This works on Redis Enterprise behind a DMC proxy. Verify the target accepts "
        + "hash-tagged keys before running at high volume.",
      );
    }
    // Wave 6.12c — dials block shared between the seed-frame `plan` and
    // the per-run ActiveRun, so /generator/runs/:id/status returns identical
    // values after the seed frame is gone (refresh-after-seed survival).
    const dialsBlock = {
      workers: dials.workers,
      batch_size: dials.batchSize,
      pipeline_window: dials.pipelineWindow,
      // Wave 5.92A — resolved stream-shard fan-out surfaces in the plan
      // so the UI can show "fan-out across N streams" from frame 0.
      stream_shards: dials.streamShards,
    };
    const plan: Record<string, unknown> = {
      profile: dials.profile,
      profile_requested: profile,
      shape: {
        mode: shape.mode, shards: shape.shards, maxclients: shape.maxclients,
        maxmemory_bytes: shape.maxmemoryBytes, used_memory_bytes: shape.usedMemoryBytes,
        fallback: !!shape.fallback,
      },
      host_cores: availableParallelism(),
      dials: dialsBlock,
      overrides: dials.overrides,
      rows,
      bytes_per_row: BYTES_PER_ROW,
      estimated_bytes: gate.estimatedBytes,
      memory_gate: { allowed: gate.allowed, threshold_bytes: gate.thresholdBytes },
      estimated_duration_sec: Math.round(estimateDurationSec(rows, dials.workers) * 100) / 100,
    };
    if (warnings.length > 0) plan.warnings = warnings;

    const state: ActiveRun = {
      run_id,
      status: "running",
      rows_done: 0,
      rows_total: rows,
      elapsed_ms: 0,
      rows_per_sec: 0,
      started_at_iso: new Date().toISOString(),
      classes: resolvedClasses,
      sensitivity_types,
      cancelFlag: { cancelled: false },
      workers,
      // Wave 6.12c — surface the resolved plan dials on the status endpoint.
      dials: dialsBlock,
    };
    activeRuns.set(run_id, state);

    // Wave 6.12c — boot log line for this run. Logs the resolved
    // stream_shards alongside the existing stream_maxlen so .run/logs/api.log
    // shows the resolved fan-out shape for the run (the per-MAXLEN status
    // log in runGeneratorLoop only fires when streamMaxLen !== undefined,
    // and never carried stream_shards). This is the on-disk counterpart
    // to the SSE seed frame's `plan.dials` block.
    app.log.info(
      {
        evt: "generator-stream",
        run_id,
        stream_maxlen: streamMaxLen ?? null,
        stream_shards: dials.streamShards,
      },
      `boot: stream_shards=${dials.streamShards} stream_maxlen=${streamMaxLen ?? "off"}`,
    );

    // Open the SSE channel before kicking off generation so the client
    // immediately sees `run_id` in the first progress frame.
    const cors = corsHeadersForRequest(req, corsAllowed);
    reply.raw.writeHead(200, {
      ...cors,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.hijack();

    // Wave 5.40a — client disconnect (browser refresh, tab close, network
    // drop) ONLY stops writing SSE frames. The run continues server-side and
    // the client recovers via GET /generator/runs/:id/status.
    let clientConnected = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopWriting = (): void => {
      if (!clientConnected) return;
      clientConnected = false;
      if (interval) { clearInterval(interval); interval = null; }
    };
    reply.raw.on("close", stopWriting);
    reply.raw.on("error", stopWriting);

    const writeFrame = (obj: unknown): void => {
      if (!clientConnected) return;
      try { reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`); }
      catch { stopWriting(); }
    };
    // Seed frame so the client has the run_id even when generation completes
    // before the first interval tick (small synthetic batches). Wave 5.84B
    // adds `workers` so the UI can surface "running with N workers" from the
    // very first frame (DoD #7). Wave 5.84C adds `plan` (shape + dials) so
    // the UI can show the resolved profile alongside the run from frame 0.
    writeFrame({ run_id, rows_done: 0, rows_total: rows, elapsed_ms: 0, rows_per_sec: 0, workers, plan });

    const emitProgress = (): void => {
      if (!clientConnected) return;
      if (state.status !== "running") return;
      writeFrame({
        run_id,
        rows_done: state.rows_done,
        rows_total: rows,
        elapsed_ms: state.elapsed_ms,
        rows_per_sec: state.rows_per_sec,
      });
    };
    interval = setInterval(emitProgress, progressIntervalMs);

    // Wave 5.92A — use the resolved dial (profile or manual override) to
    // build the router; pre-5.92 behaviour (N=1) skips router construction
    // entirely so the streaming-route XADDs stay byte-for-byte identical
    // when stream_shards is omitted from the body.
    const sseRouter = dials.streamShards !== 1
      ? createStreamRouter(streamName, dials.streamShards)
      : undefined;

    // Wave 5.95C — call the shared run-loop helper. The SSE route
    // keeps its historical `batchSize: 200` + omitted `pipelineWindow`
    // (parity with pre-5.95C XADD command sequence). `onTick` mutates
    // the per-run `state` so the SSE progress timer reads it; the
    // shared `cancelFlag` is the one /generator/cancel flips.
    void runGeneratorLoop({
      redis, log: app.log, evt: "generator-stream", run_id, target_label,
      schema, seed: body.seed, sensitivity_types, tradePool, factorPool,
      streamName, batchSize: 200, router: sseRouter, streamMaxLen, flowControlOptions,
      rows, picker, stopWhen, deferTrim,
      cancelFlag: state.cancelFlag,
      onTick: (rowsSent, elapsedNs) => {
        state.rows_done = rowsSent;
        const elapsed = Number(elapsedNs) / 1e6;
        state.elapsed_ms = Math.round(elapsed);
        state.rows_per_sec = elapsed > 0 ? Math.round((rowsSent / elapsed) * 1000) : 0;
      },
    })
      .then((result) => {
        // Translate the helper's result into the in-place `state`
        // mutations the original inline runGenerator made, preserving
        // the cancelled / error / done precedence (cancel-first, then
        // error, then the loop's resolved stop_reason). Sync rows_done
        // from the helper's final producer.rowsSent so the terminal
        // frame reflects rows that XADDed during flush() (the original
        // inline runGenerator did this via a final tick() in catch).
        state.rows_done = result.rows_queued;
        if (result.error) {
          const errBody = result.error.translated
            ? result.error.translated.body
            : { error: `redis unreachable: ${result.error.message}` };
          state.error = (errBody as { error?: string }).error ?? "redis error";
        }
        if (state.error) {
          state.status = "error";
          state.stop_reason = "error";
        } else if (state.cancelFlag.cancelled) {
          state.status = "cancelled";
          state.stop_reason = "cancelled";
        } else {
          state.status = "done";
          state.stop_reason = result.stop_reason;
        }
        state.terminal_at_ms = Date.now();

        if (interval) { clearInterval(interval); interval = null; }
        const msPrecise = Math.round(state.elapsed_ms * 1000) / 1000;
        const cancelled = state.status === "cancelled";
        const terminalFrame: Record<string, unknown> = {
          run_id,
          done: true,
          rows_queued: state.rows_done,
          ms: msPrecise,
          cancelled,
          // Wave 5.47c — additive terminal-frame field. Existing
          // done/cancelled/error flags are preserved for backward compat.
          stop_reason: state.stop_reason ?? (state.error ? "error" : cancelled ? "cancelled" : "rows"),
          // Wave 5.84B — DoD #7: terminal frame also carries `workers` so
          // late-rendering UI states (refresh-after-completion via the
          // status endpoint) see the same workers value.
          workers,
        };
        if (state.error) terminalFrame.error = state.error;
        if (clientConnected) {
          try { reply.raw.write(`data: ${JSON.stringify(terminalFrame)}\n\n`); } catch { /* socket gone */ }
          try { reply.raw.end(); } catch { /* socket already closed */ }
          clientConnected = false;
        }
        if (!state.error) {
          app.log.info({ evt: "generator-stream", run_id, rows_queued: state.rows_done, cancelled, classes: resolvedClasses, ms: state.elapsed_ms });
        }
        // Grace-eviction: keep the entry around for late-arriving clients
        // (refresh right after completion) so /runs/:id/status still works.
        setTimeout(() => { activeRuns.delete(run_id); }, terminalGraceMs).unref?.();
      })
      .catch((err: unknown) => {
        // Defensive: runGeneratorLoop catches all producer errors
        // internally, so this should never fire. Log + force-evict so
        // a stuck entry can't linger in `activeRuns`.
        const msg = err instanceof Error ? err.message : String(err);
        app.log.error({ evt: "generator-stream", run_id, err: msg, stage: "detached" });
        state.status = "error";
        state.error = msg;
        state.terminal_at_ms = Date.now();
        if (interval) { clearInterval(interval); interval = null; }
        if (clientConnected) {
          try { reply.raw.end(); } catch { /* */ }
          clientConnected = false;
        }
        setTimeout(() => { activeRuns.delete(run_id); }, terminalGraceMs).unref?.();
      });
  });

  // Wave 5.40a — status endpoint for a single run. Returns the public slice
  // of ActiveRun (no cancelFlag internals). 404 if the run is unknown OR has
  // already been grace-evicted.
  app.get<{ Params: { id: string } }>("/generator/runs/:id/status", async (req, reply) => {
    const id = req.params.id;
    const entry = activeRuns.get(id);
    if (!entry) {
      reply.code(404);
      return { error: "unknown run_id" };
    }
    return {
      run_id: entry.run_id,
      status: entry.status,
      rows_done: entry.rows_done,
      rows_total: entry.rows_total,
      rows_per_sec: entry.rows_per_sec,
      elapsed_ms: entry.elapsed_ms,
      started_at_iso: entry.started_at_iso,
      classes: entry.classes,
      sensitivity_types: entry.sensitivity_types,
      ...(entry.error ? { error: entry.error } : {}),
      // Wave 5.47c — surface the resolved stop_reason on terminal entries so
      // late-arriving clients (post-refresh) can render the same label as
      // the SSE terminal frame.
      ...(entry.stop_reason ? { stop_reason: entry.stop_reason } : {}),
      // Wave 6.12c — surface the resolved plan dials (same object the SSE
      // seed frame carries) so a refresh after the seed frame is gone can
      // still confirm what shard count / workers / batch / window were used.
      // Only populated on the streaming route's runs; absent on the
      // non-streaming /generator/start path (no seed frame, no dials).
      ...(entry.dials ? { dials: entry.dials } : {}),
    };
  });

  // Wave 5.40a — orphan-discovery endpoint. The UI hits this on mount to
  // adopt runs whose SSE stream died across a refresh.
  app.get("/generator/runs", async () => {
    const active: Array<{ run_id: string; status: string; rows_done: number; rows_total: number }> = [];
    for (const entry of activeRuns.values()) {
      if (entry.status === "running") {
        active.push({
          run_id: entry.run_id,
          status: entry.status,
          rows_done: entry.rows_done,
          rows_total: entry.rows_total,
        });
      }
    }
    return { active };
  });

  // Wave 5.20c — cancel a streaming run by id. Flips the cancel flag; the
  // detached generation loop notices at the next row boundary, drains the
  // in-flight batch, and transitions to terminal status "cancelled".
  app.post<{ Params: { run_id: string } }>("/generator/cancel/:run_id", async (req, reply) => {
    const id = req.params.run_id;
    const entry = activeRuns.get(id);
    if (!entry) {
      reply.code(404);
      return { ok: false, error: "unknown run_id" };
    }
    entry.cancelFlag.cancelled = true;
    return { ok: true, cancelled: true, run_id: id };
  });

  // Wave 5.44 / 6.44.E — admin "stop all runs" escape hatch. Two-step:
  //   1) Flip the cancel flag on every entry currently `status === "running"`
  //      whose flag isn't already set. Idempotent — a follow-up call returns
  //      cancelled:0 because the previous call already marked the flags.
  //   2) Wait up to `cancelDrainMs` for those entries to transition to a
  //      terminal status (the detached producer loops observe the flag at
  //      batch boundaries), then call POST {ingestBase}/ingest/halt-and-flush
  //      with the internal bearer token. The ingest endpoint drains the
  //      MultiConsumer, XTRIMs every shard input stream to MAXLEN 0, and
  //      SCAN+UNLINKs the `sens:*` doc family so the search-backed Indexing
  //      progress (6.44.D) drops to 0 immediately. If ingest is unreachable
  //      the response still returns 200 with `flush: null` (callers see a
  //      partial-success banner; the cancel flags are already set).
  // Wave 6.44.F — after the drain window, any entry still `status === "running"`
  // is force-marked terminal (`status="cancelled"`, `stop_reason="cancelled"`,
  // `terminal_at_ms=now`) and grace-eviction is scheduled. This guarantees
  // GET /generator/runs/:id/status returns `{status:"cancelled"}` within the
  // bounded `cancelDrainMs` window — the UI's IndexingProgress defensive
  // auto-clear relies on this terminal visibility to drop the bar instead
  // of waiting on the producer's own terminal handler (which may lag if the
  // producer is mid-FCALL). The producer's `.then` will overwrite these
  // fields idempotently when it eventually finishes.
  // Wave 6.53.A — drain+force-terminal extracted into `drainAndForceTerminal`
  // so the new /admin/stop-runs route shares the exact same lifecycle
  // bookkeeping without duplicating the loop.
  // No body required — Fastify accepts an empty POST and we never read req.body.
  app.post("/admin/cancel-all-runs", async () => {
    const run_ids = cancelAllActiveRuns();
    await drainAndForceTerminal(run_ids);
    const bulk_run_ids = cancelAllBulkRuns();
    await haltBulkLoaderAccept();
    const flush = await callIngestHaltAndFlush(app, opts.ingestBase, cancelFetch);
    return { ok: true, cancelled: run_ids.length, run_ids, bulk_cancelled: bulk_run_ids.length, bulk_run_ids, flush };
  });

  // Wave 6.53.A / 6.53.B — non-destructive admin "stop generators" route.
  // Same cancel-flag + drain + force-terminal bookkeeping as
  // /admin/cancel-all-runs, but instead of the destructive halt-and-flush
  // (XTRIM streams + SCAN+UNLINK sens:* docs) it calls the trim-only path
  // via callIngestHaltAndTrim. The shard runtime drains the consumer's
  // in-flight XREAD batch before XTRIMming each shard stream, so writes
  // halt at the next safe boundary while existing sens:* docs stay put.
  // Response carries `trim: { streams_trimmed } | null` — `null` if ingest
  // is unreachable, matching the existing flush-tolerance pattern used by
  // /admin/cancel-all-runs.
  app.post("/admin/stop-runs", async () => {
    const run_ids = cancelAllActiveRuns();
    await drainAndForceTerminal(run_ids);
    const bulk_run_ids = cancelAllBulkRuns();
    await haltBulkLoaderAccept();
    const trim = await callIngestHaltAndTrim(app, opts.ingestBase, cancelFetch);
    return { ok: true, cancelled: run_ids.length, run_ids, bulk_cancelled: bulk_run_ids.length, bulk_run_ids, trim };
  });

  // Wave 6.53.A — shared drain + force-terminal helper used by both
  // /admin/cancel-all-runs and /admin/stop-runs. Polls up to `cancelDrainMs`
  // for entries to transition naturally, then force-marks anything still
  // running as cancelled (with grace-eviction scheduled) so the status
  // endpoint reflects the cancel within the bounded window. Closure-bound
  // to `cancelDrainMs` + `terminalGraceMs` resolved at route registration.
  async function drainAndForceTerminal(run_ids: string[]): Promise<void> {
    if (run_ids.length === 0) return;
    const deadline = Date.now() + cancelDrainMs;
    while (Date.now() < deadline) {
      let stillRunning = false;
      for (const id of run_ids) {
        const e = activeRuns.get(id);
        if (e && e.status === "running") { stillRunning = true; break; }
      }
      if (!stillRunning) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const nowMs = Date.now();
    for (const id of run_ids) {
      const e = activeRuns.get(id);
      if (e && e.status === "running") {
        e.status = "cancelled";
        e.stop_reason = "cancelled";
        e.terminal_at_ms = nowMs;
        setTimeout(() => { activeRuns.delete(id); }, terminalGraceMs).unref?.();
      }
    }
  }
}

// Wave 6.44.F — extracted helper used by the /admin/cancel-all-runs route
// handler. Iterates the module-local `activeRuns` registry and flips the
// cancel flag on every entry currently `status === "running"` whose flag
// isn't already set. Returns the list of run_ids that were just marked so
// the caller can drain and (after timeout) force-mark them terminal.
// Exported so future admin-route consumers don't duplicate registry access.
export function cancelAllActiveRuns(): string[] {
  const run_ids: string[] = [];
  for (const entry of activeRuns.values()) {
    if (entry.status === "running" && !entry.cancelFlag.cancelled) {
      entry.cancelFlag.cancelled = true;
      run_ids.push(entry.run_id);
    }
  }
  return run_ids;
}

export function hasRunningGeneratorRuns(): boolean {
  for (const entry of activeRuns.values()) {
    if (entry.status === "running") return true;
  }
  return false;
}

// Wave 6.44.E — proxy the halt-and-flush call to ingest. Returns the parsed
// upstream report on success; `null` (with a logged warning) on any failure
// so the caller can degrade to a partial-success banner without a 5xx. The
// internal bearer token is read at call time so a dev who rotates
// INTERNAL_API_TOKEN after process start still gets the new value.
async function callIngestHaltAndFlush(
  app: FastifyInstance,
  ingestBase: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; streams_trimmed: number; docs_cleared: number; elapsed_ms?: number } | null> {
  const base = ingestBase ?? process.env.INGEST_URL
    ?? `http://localhost:${process.env.INGEST_PORT ?? 8083}`;
  const token = process.env.INTERNAL_API_TOKEN;
  const url = `${base.replace(/\/+$/, "")}/ingest/halt-and-flush`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  try {
    const r = await fetchImpl(url, { method: "POST", headers, body: "{}" });
    if (!r.ok) {
      app.log.warn({ evt: "cancel-all-runs.flush", status: r.status, url }, "ingest halt-and-flush returned non-2xx");
      return null;
    }
    const body = (await r.json()) as { ok?: boolean; streams_trimmed?: number; docs_cleared?: number; elapsed_ms?: number };
    if (body.ok !== true || typeof body.streams_trimmed !== "number" || typeof body.docs_cleared !== "number") {
      app.log.warn({ evt: "cancel-all-runs.flush", url, body }, "ingest halt-and-flush returned unexpected shape");
      return null;
    }
    return {
      ok: true,
      streams_trimmed: body.streams_trimmed,
      docs_cleared: body.docs_cleared,
      elapsed_ms: typeof body.elapsed_ms === "number" ? body.elapsed_ms : undefined,
    };
  } catch (err) {
    app.log.warn({ evt: "cancel-all-runs.flush", url, err: String(err) }, "ingest halt-and-flush unreachable");
    return null;
  }
}

// Wave 6.53.B — non-destructive variant of callIngestHaltAndFlush used by
// /admin/stop-runs. POSTs `{ clearDocs: false }` to the same ingest
// endpoint so the consumer drains and XTRIMs every shard stream, but the
// SCAN+UNLINK doc-clearing step is skipped — existing sens:* docs stay in
// Redis. Returns just the `streams_trimmed` count (docs_cleared is always
// 0 in this path) so the UI banner can summarise the trim without
// implying a destructive wipe. Returns `null` on any upstream failure,
// matching the partial-success tolerance pattern of callIngestHaltAndFlush.
async function callIngestHaltAndTrim(
  app: FastifyInstance,
  ingestBase: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ streams_trimmed: number } | null> {
  const base = ingestBase ?? process.env.INGEST_URL
    ?? `http://localhost:${process.env.INGEST_PORT ?? 8083}`;
  const token = process.env.INTERNAL_API_TOKEN;
  const url = `${base.replace(/\/+$/, "")}/ingest/halt-and-flush`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  try {
    const r = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify({ clearDocs: false }) });
    if (!r.ok) {
      app.log.warn({ evt: "stop-runs.trim", status: r.status, url }, "ingest halt-and-trim returned non-2xx");
      return null;
    }
    const body = (await r.json()) as { ok?: boolean; streams_trimmed?: number };
    if (body.ok !== true || typeof body.streams_trimmed !== "number") {
      app.log.warn({ evt: "stop-runs.trim", url, body }, "ingest halt-and-trim returned unexpected shape");
      return null;
    }
    return { streams_trimmed: body.streams_trimmed };
  } catch (err) {
    app.log.warn({ evt: "stop-runs.trim", url, err: String(err) }, "ingest halt-and-trim unreachable");
    return null;
  }
}

// Wave 5.44 — test-only accessors for the module-local activeRuns registry.
// Mirrors the resetBootstrapStatusForTests pattern in server.ts. Production
// code paths never touch these.
export interface TestActiveRun {
  run_id: string;
  status: "running" | "done" | "cancelled" | "error";
  cancelFlag: { cancelled: boolean };
  // Wave 6.44.F — expose terminal bookkeeping fields so tests can assert
  // the cancel-all-runs handler force-marks runs terminal after drain.
  stop_reason?: StopReason;
  terminal_at_ms?: number;
}
export function _testInsertActiveRun(run: TestActiveRun): void {
  activeRuns.set(run.run_id, {
    run_id: run.run_id,
    status: run.status,
    rows_done: 0,
    rows_total: 0,
    elapsed_ms: 0,
    rows_per_sec: 0,
    started_at_iso: new Date().toISOString(),
    classes: [],
    sensitivity_types: [],
    cancelFlag: run.cancelFlag,
  });
}
export function _testGetActiveRun(run_id: string): TestActiveRun | undefined {
  const e = activeRuns.get(run_id);
  if (!e) return undefined;
  return {
    run_id: e.run_id,
    status: e.status,
    cancelFlag: e.cancelFlag,
    ...(e.stop_reason ? { stop_reason: e.stop_reason } : {}),
    ...(e.terminal_at_ms !== undefined ? { terminal_at_ms: e.terminal_at_ms } : {}),
  };
}
export function _testResetActiveRuns(): void {
  activeRuns.clear();
}

// PipelineClient is exported for the test stub to keep its mock shape aligned
// with what createStreamProducer actually invokes.
export type { PipelineClient };

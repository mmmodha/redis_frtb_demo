// Typed client for ingest-related api endpoints used by the Ingest panel.
// Kept separate from ./api.ts (which is owned by the UI shell task) so
// cross-task ownership stays clean.
import { apiBase } from "./api";

export interface Source {
  id: string;
  kind: "synthetic" | "file" | string;
  name?: string;
  is_active?: boolean;
  [k: string]: unknown;
}

export interface IngestRunResponse {
  ok: boolean;
  run_id?: string;
  [k: string]: unknown;
}

// Wave 5.17b — body shape for POST /generator/start. Mirrors the Fastify
// route's GeneratorStartBody in services/api/src/routes/generator.ts.
// Wave 5.47d — optional `class_split` overrides round-robin with explicit
// per-class row counts; the server interleaves them so progress events show
// a consistent mix.
// Wave 5.47c — optional stop conditions; whichever trips first halts a run.
// Mirrors the StopWhen shape on the api route.
export interface StopWhen {
  rows?: number;
  memory_pct?: number;
  elapsed_seconds?: number;
}

export type StopReason = "rows" | "memory" | "elapsed" | "cancelled" | "error";

export interface GeneratorConfig {
  rows?: number;
  classes?: string[];
  sensitivity_types?: string[];
  seed?: string | number;
  trade_pool_size?: number;
  factor_pool_size?: number;
  class_split?: Record<string, number>;
  stop_when?: StopWhen;
  // Wave 6.10 — approximate XADD MAXLEN cap. Default cap on the api side is
  // 2_000_000; UI auto-flips this to match `rows` when the user picks a
  // simple-mode row count above the default (no silent truncation).
  stream_maxlen?: number;
  // Wave 6.11b — explicit hash-tag stream fan-out. Omitted ⇒ server uses the
  // profile-derived value (1 on standalone-presenting targets). Numbers map
  // to N modulo-routed streams; "per-bucket" emits one stream per bucket.
  stream_shards?: number | "per-bucket";
  // Wave 6.13b — defer XADD-time trimming; producer issues XTRIM with the
  // resolved stream_maxlen cap at close(). Used by the Large / Overnight
  // presets in IngestPanel where XADD-time MAXLEN would slow the producer.
  defer_trim?: boolean;
}

export interface GeneratorStartResponse extends IngestRunResponse {
  rows_queued?: number;
  classes?: string[];
  sensitivity_types?: string[];
  ms?: number;
  stop_reason?: StopReason;
}

export async function listSources(): Promise<Source[]> {
  const res = await fetch(`${apiBase()}/sources`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`api /sources ${res.status}`);
  const body = (await res.json()) as Source[] | { sources?: Source[] };
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.sources)) return body.sources;
  return [];
}

export async function startIngest(sourceId: string): Promise<IngestRunResponse> {
  const res = await fetch(`${apiBase()}/sources/${sourceId}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`api /sources/${sourceId}/ingest ${res.status}`);
  return (await res.json()) as IngestRunResponse;
}

export async function startGenerator(config?: GeneratorConfig): Promise<GeneratorStartResponse> {
  const body = config ? JSON.stringify(config) : "{}";
  const res = await fetch(`${apiBase()}/generator/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err && typeof err.error === "string") detail = `${res.status}: ${err.error}`;
    } catch { /* response body not json */ }
    throw new Error(`api /generator/start ${detail}`);
  }
  return (await res.json()) as GeneratorStartResponse;
}

// Wave 5.20c — streaming variant. Posts to /generator/start/stream, parses
// SSE `data:` frames, and surfaces per-batch progress + a terminal frame to
// the caller. Returns a handle whose .cancel() flips the server-side cancel
// flag (via POST /generator/cancel/{run_id}) and aborts the fetch.
export interface ProgressFrame {
  run_id: string;
  rows_done: number;
  rows_total: number;
  elapsed_ms: number;
  rows_per_sec: number;
}
export interface TerminalFrame {
  run_id: string;
  done: true;
  rows_queued: number;
  ms: number;
  cancelled: boolean;
  error?: string;
  // Wave 5.47c — which stop condition halted the run. Additive: older api
  // builds simply omit it and the UI falls back to the legacy flags.
  stop_reason?: StopReason;
}
export interface GeneratorStreamHandlers {
  onProgress: (frame: ProgressFrame) => void;
  onTerminal: (frame: TerminalFrame) => void;
  onError: (err: Error) => void;
}
export interface GeneratorStreamHandle {
  cancel: () => Promise<void>;
}

// Wave 5.45 — if the client calls .cancel(), arm a watchdog so the UI does
// not hang on "Cancelling…" forever if the server never delivers a terminal
// frame. The default mirrors the server's own grace window.
const DEFAULT_TERMINAL_TIMEOUT_MS = 30_000;

export function startGeneratorStream(
  config: GeneratorConfig | undefined,
  handlers: GeneratorStreamHandlers,
  opts?: { terminalTimeoutMs?: number },
): GeneratorStreamHandle {
  const body = config ? JSON.stringify(config) : "{}";
  const controller = new AbortController();
  let runId: string | null = null;
  let cancelledByClient = false;

  // Wave 5.21f — once the terminal frame has been dispatched, suppress any
  // further reader errors so a server-closed-socket race does not surface as
  // "Failed to fetch" through handlers.onError after a successful run.
  let terminated = false;

  // Wave 5.45 — watchdog armed by .cancel() so we synthesize an error if the
  // server never sends the terminal frame.
  const terminalTimeoutMs = opts?.terminalTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
  let terminalTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTerminalTimer = (): void => {
    if (terminalTimer !== null) {
      clearTimeout(terminalTimer);
      terminalTimer = null;
    }
  };

  void (async () => {
    try {
      const res = await fetch(`${apiBase()}/generator/start/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let detail = `${res.status}`;
        try {
          const errBody = (await res.json()) as { error?: string };
          if (errBody?.error) detail = `${res.status}: ${errBody.error}`;
        } catch { /* not json */ }
        throw new Error(`api /generator/start/stream ${detail}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            const m = /^data:\s?(.*)$/.exec(line);
            if (!m) continue;
            try {
              const parsed = JSON.parse(m[1]!) as Record<string, unknown>;
              if (typeof parsed.run_id === "string") runId = parsed.run_id;
              if (parsed.done === true) {
                // Set terminated BEFORE dispatching so the flag is honoured
                // even if onTerminal throws.
                terminated = true;
                clearTerminalTimer();
                handlers.onTerminal(parsed as unknown as TerminalFrame);
              } else {
                handlers.onProgress(parsed as unknown as ProgressFrame);
              }
            } catch { /* skip malformed frame */ }
          }
        }
        if (terminated) {
          try { await reader.cancel(); } catch { /* best effort */ }
          break;
        }
      }
    } catch (err) {
      clearTerminalTimer();
      if (terminated) return;
      if (cancelledByClient) return;
      const e = err as Error;
      if (e?.name === "AbortError") return;
      handlers.onError(e);
    }
  })();

  return {
    async cancel(): Promise<void> {
      cancelledByClient = true;
      if (runId) {
        try { await cancelGenerator(runId); } catch { /* swallow — server may have already ended */ }
      }
      // Wave 5.45 — intentionally DO NOT call controller.abort() here.
      // Aborting the fetch tears down the SSE socket before the server can
      // deliver the terminal frame, which leaves the UI stuck on
      // "Cancelling…". We rely on the server to honour the cancel flag and
      // emit a terminal frame with cancelled:true. The watchdog below
      // forces a synthetic error if that never happens.
      if (!terminated && terminalTimer === null) {
        terminalTimer = setTimeout(() => {
          if (terminated) return;
          terminated = true;
          terminalTimer = null;
          handlers.onError(new Error(
            `generator cancel: terminal frame not received within ${terminalTimeoutMs}ms`,
          ));
        }, terminalTimeoutMs);
      }
    },
  };
}

// Wave 5.38c — POST /admin/flush. Wipes the active Redis database (FLUSHDB)
// and returns timing for the success banner. The IngestPanel guards the call
// behind a confirmation modal; this client is intentionally thin.
//
// Wave 5.46 — the api now re-runs bootstrapFrtb after FLUSHDB to rebuild
// idx:sens + the frtb library, and reports the outcome under `bootstrap`.
// Optional so older api builds (or the schema-missing branch) stay
// backward-compatible with the existing client shape.
export interface FlushDbResponse {
  ok: boolean;
  ms: number;
  target_label: string;
  bootstrap?: { ok: boolean; error?: string };
}

export async function flushDb(): Promise<FlushDbResponse> {
  const res = await fetch(`${apiBase()}/admin/flush`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err && typeof err.error === "string") detail = `${res.status}: ${err.error}`;
    } catch { /* response body not json */ }
    throw new Error(`api /admin/flush ${detail}`);
  }
  return (await res.json()) as FlushDbResponse;
}

// Wave 5.44 — POST /admin/cancel-all-runs. Iterates the api's in-process
// `activeRuns` registry and flips the cancel flag on every entry currently
// `status === "running"`. Used by the IngestPanel "Stop all runs" button.
// Sends an empty JSON object body to dodge Fastify's FST_ERR_CTP_EMPTY_JSON_BODY
// when content-type is application/json (same defensive shape as flushDb).
export interface CancelAllGeneratorRunsResponse {
  ok: true;
  cancelled: number;
  run_ids: string[];
}

export async function cancelAllGeneratorRuns(): Promise<CancelAllGeneratorRunsResponse> {
  const res = await fetch(`${apiBase()}/admin/cancel-all-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err && typeof err.error === "string") detail = `${res.status}: ${err.error}`;
    } catch { /* response body not json */ }
    throw new Error(`api /admin/cancel-all-runs ${detail}`);
  }
  return (await res.json()) as CancelAllGeneratorRunsResponse;
}

// Wave 5.47b — GET /admin/preflight. Returns per-check status so the
// IngestPanel can render a banner before a generator run starts. The api
// route is read-only; we keep the client shape mirrored to the response so
// the UI can list missing pieces without bespoke parsing.
export interface PreflightResponse {
  ok: boolean;
  checks: {
    idx_sens: { ok: boolean; missing: string[] };
    frtb_library: { ok: boolean; loaded: boolean };
    stream: { ok: boolean; exists: boolean };
  };
  can_rebuild: boolean;
}

export async function preflight(): Promise<PreflightResponse> {
  const res = await fetch(`${apiBase()}/admin/preflight`);
  if (!res.ok) throw new Error(`api /admin/preflight ${res.status}`);
  return (await res.json()) as PreflightResponse;
}

// Wave 5.47b — POST /admin/rebuild-indexes. Re-runs bootstrapFrtb on the
// active client. Sends body:"{}" to dodge FST_ERR_CTP_EMPTY_JSON_BODY, the
// same defensive shape flushDb / cancelAllGeneratorRuns use.
export interface RebuildIndexesResponse {
  ok: boolean;
  ms: number;
  bootstrap: { ok: boolean; error?: string };
}

export async function rebuildIndexes(): Promise<RebuildIndexesResponse> {
  const res = await fetch(`${apiBase()}/admin/rebuild-indexes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err && typeof err.error === "string") detail = `${res.status}: ${err.error}`;
    } catch { /* response body not json */ }
    throw new Error(`api /admin/rebuild-indexes ${detail}`);
  }
  return (await res.json()) as RebuildIndexesResponse;
}

// Wave 6.17 — preset auto-fix coordinator. Runs preflight; if a check failed
// and the api advertises can_rebuild=true, calls /admin/rebuild-indexes and
// re-runs preflight so the caller observes the post-repair state. The
// rebuilt flag tells the IngestPanel preset flow whether to surface a
// "Repaired indexes" line in the status bar.
export interface PreflightAutoFixResult {
  preflight: PreflightResponse;
  rebuilt: boolean;
}

export async function preflightAndRebuildIfNeeded(): Promise<PreflightAutoFixResult> {
  const initial = await preflight();
  if (initial.ok) return { preflight: initial, rebuilt: false };
  if (!initial.can_rebuild) return { preflight: initial, rebuilt: false };
  await rebuildIndexes();
  const after = await preflight();
  return { preflight: after, rebuilt: true };
}

export async function cancelGenerator(runId: string): Promise<void> {
  const res = await fetch(`${apiBase()}/generator/cancel/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`api /generator/cancel/${runId} ${res.status}`);
  }
}

// Wave 5.40b — single-run status (used by GeneratorRunContext to reconnect
// after a refresh) and orphan-discovery list (active runs the UI is not yet
// tracking). 404 from /generator/runs/:id/status is normalised to null so
// callers can treat "stale localStorage entry" as a non-error.
export interface GeneratorRunStatus {
  run_id: string;
  status: "running" | "done" | "cancelled" | "error";
  rows_done: number;
  rows_total: number;
  rows_per_sec: number;
  elapsed_ms: number;
  error?: string;
  // Wave 5.47c — surfaced on terminal entries by /generator/runs/:id/status
  // so post-refresh clients can render the same stop-reason label.
  stop_reason?: StopReason;
  // Wave 6.12c — resolved plan dials surfaced on streaming runs so a
  // post-refresh / cross-panel reader can confirm the workers / batch /
  // window / stream-shards picked at run start. Undefined for non-streaming
  // runs and on builds older than 6.12c.
  dials?: {
    workers: number;
    batch_size: number;
    pipeline_window: number;
    stream_shards: number | "per-bucket";
  };
}

export interface ActiveGeneratorRun {
  run_id: string;
  status: string;
  rows_done: number;
  rows_total: number;
}

export async function getGeneratorRunStatus(run_id: string): Promise<GeneratorRunStatus | null> {
  const res = await fetch(`${apiBase()}/generator/runs/${encodeURIComponent(run_id)}/status`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`api /generator/runs/${run_id}/status ${res.status}`);
  return (await res.json()) as GeneratorRunStatus;
}

export async function getActiveGeneratorRuns(): Promise<{ active: ActiveGeneratorRun[] }> {
  const res = await fetch(`${apiBase()}/generator/runs`);
  if (!res.ok) throw new Error(`api /generator/runs ${res.status}`);
  return (await res.json()) as { active: ActiveGeneratorRun[] };
}

// Wave 6.12b — typed client for the ingest fan-out card. GET returns the
// runtime snapshot from services/ingest/src/shard-runtime.ts; POST rebuilds
// the consumer at runtime. The runtime surfaces 400 (invalid totalShards)
// and 409 (rebuild already in progress) as JSON errors — both are turned
// into Error.message strings here so the panel can render them as toasts or
// inline errors rather than silently swallowing them.
//
// Wave 6.32.A — the snapshot now also carries `rebuilding` (true while a
// drain+respawn is in flight) and, when true, `rebuild_started_at` (ISO8601)
// so the UI can render a spinner with the elapsed time without polling a
// separate endpoint. Both fields are optional here for forward/backward
// compatibility with older ingest builds.
export interface IngestShardsSnapshot {
  totalShards: number;
  // The runtime also returns `assignment` and `streams` but the UI only
  // reads totalShards; kept optional so the type doesn't lie if the api
  // ever trims the response.
  assignment?: number[];
  streams?: string[];
  rebuilding?: boolean;
  rebuild_started_at?: string;
}

export async function getIngestShards(): Promise<IngestShardsSnapshot> {
  const res = await fetch(`${apiBase()}/ingest/shards`);
  if (!res.ok) throw new Error(`api /ingest/shards ${res.status}`);
  return (await res.json()) as IngestShardsSnapshot;
}

export async function setIngestShards(
  totalShards: number,
  assignment?: string,
): Promise<IngestShardsSnapshot> {
  const body: Record<string, unknown> = { totalShards };
  if (assignment !== undefined) body.assignment = assignment;
  const res = await fetch(`${apiBase()}/ingest/shards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err && typeof err.error === "string") detail = `${res.status}: ${err.error}`;
    } catch { /* response body not json */ }
    throw new Error(`api /ingest/shards ${detail}`);
  }
  return (await res.json()) as IngestShardsSnapshot;
}

// Wave 6.32.B — operator recovery for a stuck rebuild mutex. POST
// /ingest/shards/reset force-clears the in-memory `rebuilding` flag on the
// ingest service and detaches the abandoned MultiConsumer; the caller can
// then POST /ingest/shards again to spawn a fresh one. Destructive: any
// in-flight messages owned by the abandoned multi may be lost. The UI guards
// the call behind a confirmation modal.
export interface ResetIngestShardsResponse {
  rebuilding: false;
  multi_detached: true;
}

export async function resetIngestShards(): Promise<ResetIngestShardsResponse> {
  const res = await fetch(`${apiBase()}/ingest/shards/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err && typeof err.error === "string") detail = `${res.status}: ${err.error}`;
    } catch { /* response body not json */ }
    throw new Error(`api /ingest/shards/reset ${detail}`);
  }
  return (await res.json()) as ResetIngestShardsResponse;
}

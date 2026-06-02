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
export interface GeneratorConfig {
  rows?: number;
  classes?: string[];
  sensitivity_types?: string[];
  seed?: string | number;
  trade_pool_size?: number;
  factor_pool_size?: number;
}

export interface GeneratorStartResponse extends IngestRunResponse {
  rows_queued?: number;
  classes?: string[];
  sensitivity_types?: string[];
  ms?: number;
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
}
export interface GeneratorStreamHandlers {
  onProgress: (frame: ProgressFrame) => void;
  onTerminal: (frame: TerminalFrame) => void;
  onError: (err: Error) => void;
}
export interface GeneratorStreamHandle {
  cancel: () => Promise<void>;
}

export function startGeneratorStream(
  config: GeneratorConfig | undefined,
  handlers: GeneratorStreamHandlers,
): GeneratorStreamHandle {
  const body = config ? JSON.stringify(config) : "{}";
  const controller = new AbortController();
  let runId: string | null = null;
  let cancelledByClient = false;

  // Wave 5.21f — once the terminal frame has been dispatched, suppress any
  // further reader errors so a server-closed-socket race does not surface as
  // "Failed to fetch" through handlers.onError after a successful run.
  let terminated = false;

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
      try { controller.abort(); } catch { /* noop */ }
    },
  };
}

// Wave 5.38c — POST /admin/flush. Wipes the active Redis database (FLUSHDB)
// and returns timing for the success banner. The IngestPanel guards the call
// behind a confirmation modal; this client is intentionally thin.
export interface FlushDbResponse {
  ok: boolean;
  ms: number;
  target_label: string;
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

// Typed client for the api's /loadgen/* surface (proxied to loadgen-service
// by services/api/src/routes/loadgen-proxy.ts).
//
// Kept separate from ./api.ts so panel ownership stays clean across Wave 4
// agents. SSE subscription wraps EventSource and returns a disposer.

import { apiBase } from "./api";

export interface LoadgenMix { pivot: number; calc: number; }

export interface LoadgenStartRequest {
  concurrency: number;
  duration_sec?: number;
  mix?: LoadgenMix;
}

export interface LoadgenStartResponse {
  running: boolean;
  config: { concurrency: number; duration_sec: number; mix: LoadgenMix };
}

export interface LoadgenStopResponse {
  stopped: boolean;
}

export interface LoadgenEndpointStats {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface LoadgenMetricsFrame {
  ts: number;
  throughput_rps: number;
  latency: { p50: number; p95: number; p99: number };
  errors: number;
  total_requests: number;
  per_endpoint: { pivot: LoadgenEndpointStats; calc: LoadgenEndpointStats };
  running: boolean;
  elapsed_sec: number;
}

export interface LoadgenStatus {
  running: boolean;
  config?: { concurrency: number; duration_sec: number; mix: LoadgenMix };
  snapshot?: Omit<LoadgenMetricsFrame, "ts">;
}

async function asError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json() as { error?: string };
    return new Error(body.error ?? fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function startLoadgen(req: LoadgenStartRequest): Promise<LoadgenStartResponse> {
  const res = await fetch(`${apiBase()}/loadgen/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await asError(res, `api /loadgen/start ${res.status}`);
  return (await res.json()) as LoadgenStartResponse;
}

export async function stopLoadgen(): Promise<LoadgenStopResponse> {
  const res = await fetch(`${apiBase()}/loadgen/stop`, { method: "POST" });
  if (!res.ok) throw await asError(res, `api /loadgen/stop ${res.status}`);
  return (await res.json()) as LoadgenStopResponse;
}

export async function getLoadgenStatus(): Promise<LoadgenStatus> {
  const res = await fetch(`${apiBase()}/loadgen/status`);
  if (!res.ok) throw await asError(res, `api /loadgen/status ${res.status}`);
  return (await res.json()) as LoadgenStatus;
}

// Subscribe to the live metrics stream. Returns a disposer that closes the
// underlying EventSource.
export function subscribeMetrics(
  onFrame: (f: LoadgenMetricsFrame) => void,
  onError?: (e: Event) => void,
): () => void {
  const ES = (globalThis as { EventSource?: typeof EventSource }).EventSource;
  if (!ES) {
    // No-op disposer when EventSource is unavailable (server-side render).
    return () => undefined;
  }
  const es = new ES(`${apiBase()}/loadgen/metrics`);
  es.onmessage = (ev: MessageEvent) => {
    try {
      const frame = JSON.parse(String(ev.data)) as LoadgenMetricsFrame;
      onFrame(frame);
    } catch {
      /* malformed frame — ignore so the stream keeps flowing */
    }
  };
  if (onError) es.onerror = onError;
  return () => { try { es.close(); } catch { /* already closed */ } };
}

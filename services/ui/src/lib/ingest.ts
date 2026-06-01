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

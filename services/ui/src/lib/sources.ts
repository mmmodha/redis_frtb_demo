// Typed client for the api's /sources/* surface (proxied to source-service
// by services/api/src/routes/sources-proxy.ts in Wave 3.5C).
//
// Kept separate from ./api.ts and ./ingest.ts so panel ownership stays clean
// across Wave 3.5 A/B/C agents.

import { apiBase } from "./api";

export type SourceFormat = "csv" | "jsonl" | "parquet";
export type SourceOrigin = "upload" | "synthetic";
export type SourceStatus =
  | "uploaded"
  | "inferred"
  | "mapped"
  | "ingesting"
  | "ingested"
  | "error";
export type DetectedType = "NUMERIC" | "TAG" | "TEXT";
export type MappingValueType = "string" | "number" | "array_number";

export interface InferredColumn {
  name: string;
  detected_type: DetectedType;
  sample_values: string[];
}

export interface MappedField {
  from: string | string[];
  type?: MappingValueType;
}

export interface ColumnMapping {
  fields: Record<string, MappedField>;
}

export interface SourceRecord {
  id: string;
  name: string;
  format: SourceFormat;
  origin: SourceOrigin;
  size_bytes?: number;
  row_count_sample?: number;
  columns?: InferredColumn[];
  mapping?: ColumnMapping;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface InferResponse {
  source: SourceRecord;
  columns: InferredColumn[];
  mapping_suggestion: ColumnMapping;
}

// Canonical FRTB binding dimensions surfaced in the mapping wizard. Matches
// the keys in `frtb_binding` in config/schema/frtb-default.yaml — the demo's
// active schema. Kept inline (no schema fetch) so the wizard renders even
// before the schema endpoint is wired.
export const FRTB_BINDING_KEYS: readonly string[] = [
  "risk_class",
  "bucket",
  "tenor",
  "risk_value",
  "weight",
  "sensitivity_type",
] as const;

async function asError(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json() as { error?: string };
    return new Error(body.error ?? fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function listSources(): Promise<SourceRecord[]> {
  const res = await fetch(`${apiBase()}/sources`);
  if (res.status === 404) return [];
  if (!res.ok) throw await asError(res, `api /sources ${res.status}`);
  const body = (await res.json()) as SourceRecord[] | { sources?: SourceRecord[] };
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.sources)) return body.sources;
  return [];
}

export async function uploadSource(file: File): Promise<SourceRecord> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch(`${apiBase()}/sources/upload`, { method: "POST", body: fd });
  if (!res.ok) throw await asError(res, `api /sources/upload ${res.status}`);
  return (await res.json()) as SourceRecord;
}

export async function deleteSource(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (res.status === 204) return;
  if (!res.ok) throw await asError(res, `api DELETE /sources/${id} ${res.status}`);
}

export async function inferSource(id: string): Promise<InferResponse> {
  const res = await fetch(`${apiBase()}/sources/${encodeURIComponent(id)}/infer`, { method: "POST" });
  if (!res.ok) throw await asError(res, `api /sources/${id}/infer ${res.status}`);
  return (await res.json()) as InferResponse;
}

export async function saveMapping(id: string, mapping: ColumnMapping): Promise<SourceRecord> {
  const res = await fetch(`${apiBase()}/sources/${encodeURIComponent(id)}/mapping`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mapping }),
  });
  if (!res.ok) throw await asError(res, `api /sources/${id}/mapping ${res.status}`);
  return (await res.json()) as SourceRecord;
}

export async function ingestSource(id: string): Promise<SourceRecord> {
  const res = await fetch(`${apiBase()}/sources/${encodeURIComponent(id)}/ingest`, { method: "POST" });
  if (!res.ok) throw await asError(res, `api /sources/${id}/ingest ${res.status}`);
  return (await res.json()) as SourceRecord;
}

// Typed client for the api's /sources/* surface (proxied to source-service
// by services/api/src/routes/sources-proxy.ts in Wave 3.5C).
//
// Kept separate from ./api.ts and ./ingest.ts so panel ownership stays clean
// across Wave 3.5 A/B/C agents.

import { apiBase } from "./api";
import { buildApiError } from "./empty-target";

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
  return await buildApiError(res, fallback);
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

// Wave 5.91 — XHR-based upload so we can surface determinate upload progress
// to the UploadsProvider. The public Promise<SourceRecord> contract is
// preserved; existing call sites that omit `opts` still work.
export interface UploadSourceOptions {
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
  signal?: AbortSignal;
}

export function uploadSource(file: File, opts: UploadSourceOptions = {}): Promise<SourceRecord> {
  return new Promise<SourceRecord>((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase()}/sources/upload`);

    const onSignalAbort = (): void => { try { xhr.abort(); } catch { /* noop */ } };
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", onSignalAbort, { once: true });
    }
    const cleanup = (): void => { opts.signal?.removeEventListener("abort", onSignalAbort); };

    if (opts.onProgress) {
      xhr.upload.onprogress = (ev: ProgressEvent): void => {
        const total = ev.lengthComputable && ev.total > 0 ? ev.total : file.size;
        opts.onProgress?.(ev.loaded, total);
      };
    }

    xhr.onload = (): void => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as SourceRecord);
        } catch (e) {
          reject(new Error(`api /sources/upload parse failed: ${(e as Error).message}`));
        }
      } else {
        reject(new Error(`api /sources/upload ${xhr.status}`));
      }
    };
    xhr.onerror = (): void => {
      cleanup();
      reject(new Error(`api /sources/upload network error`));
    };
    xhr.onabort = (): void => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    xhr.send(fd);
  });
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

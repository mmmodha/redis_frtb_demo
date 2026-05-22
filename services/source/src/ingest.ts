// Source → Stream ingest stage.
//
// Walks a source file row-by-row, applies the confirmed column mapping, and
// emits one XADD per row to the locked Wave-2 inbound stream
// `sensitivities:in`. The downstream ingest worker (services/ingest) is
// responsible for the final JSON.SET into Redis under
// `sens:{risk_class:bucket}:{ulid}` slot-locally — we just publish the
// canonical event with `_hash_tag` precomputed so the worker can route
// without re-deriving it.

import { sampleCsv } from "./readers/csv.ts";
import { sampleJsonl } from "./readers/jsonl.ts";
import type { ColumnMapping, MappedField } from "./infer/mapping.ts";
import type { RedisLike } from "./store.ts";

export const INBOUND_STREAM = "sensitivities:in";

export interface IngestArgs {
  redis: RedisLike;
  path: string;
  format: "csv" | "jsonl";
  mapping: ColumnMapping;
  onProgress?: (rows_ingested: number) => void;
  progressEvery?: number;
}

export interface IngestStats {
  rows_ingested: number;
}

export async function ingestFile(args: IngestArgs): Promise<IngestStats> {
  const rows = await readAllRows(args.path, args.format);
  const progressEvery = args.progressEvery ?? 1000;
  let n = 0;

  for (const row of rows) {
    const fields = applyMapping(row, args.mapping);
    const hashTag = `${fields.risk_class ?? ""}:${fields.bucket ?? ""}`;
    const xargs: string[] = ["_hash_tag", hashTag];
    for (const [k, v] of Object.entries(fields)) xargs.push(k, v);
    await args.redis.call("XADD", INBOUND_STREAM, "*", ...xargs);
    n += 1;
    if (args.onProgress && n % progressEvery === 0) args.onProgress(n);
  }
  if (args.onProgress && n > 0 && n % progressEvery !== 0) args.onProgress(n);
  return { rows_ingested: n };
}

async function readAllRows(
  path: string,
  format: "csv" | "jsonl",
): Promise<Record<string, string>[]> {
  const limit = Number.MAX_SAFE_INTEGER;
  if (format === "csv") return (await sampleCsv(path, { limit })).rows;
  return (await sampleJsonl(path, { limit })).rows;
}

function applyMapping(
  row: Record<string, string>,
  mapping: ColumnMapping,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [binding, field] of Object.entries(mapping.fields)) {
    const value = resolveField(row, field);
    if (value !== undefined) out[binding] = value;
  }
  return out;
}

function resolveField(row: Record<string, string>, field: MappedField): string | undefined {
  if (Array.isArray(field.from)) {
    const arr = field.from.map((col) => {
      const raw = row[col] ?? "";
      if (field.type === "array_number") {
        const n = Number(raw);
        return Number.isFinite(n) ? n : 0;
      }
      return raw;
    });
    return JSON.stringify(arr);
  }
  const raw = row[field.from] ?? "";
  if (field.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? String(n) : "";
  }
  return raw;
}

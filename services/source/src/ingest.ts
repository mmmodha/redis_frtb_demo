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
import {
  createStreamRouter,
  parseStreamShardsFlag,
  type StreamShardsConfig,
} from "@frtb/stream-router";

export const INBOUND_STREAM = "sensitivities:in";

// Wave 5.92C — default approximate MAXLEN for source-ingest XADDs (~2 GB
// at ~1 KB/entry). Tunable via STREAM_MAXLEN env. The producer-side cap
// protects holding shards from OOM when downstream ingest falls behind.
export const DEFAULT_STREAM_MAXLEN = 2_000_000;

export interface IngestArgs {
  redis: RedisLike;
  path: string;
  format: "csv" | "jsonl";
  mapping: ColumnMapping;
  onProgress?: (rows_ingested: number) => void;
  progressEvery?: number;
  // Wave 5.92A — hash-tag stream-shard fan-out. Number (modulo-N), the
  // literal "per-bucket", or undefined. When undefined the function reads
  // SOURCE_STREAM_SHARDS from the env; if that is also unset it defaults to
  // 1, preserving the pre-5.92 single-stream XADD path bit-identically.
  streamShards?: StreamShardsConfig;
  // Wave 5.92C — approximate MAXLEN cap appended as `MAXLEN ~ N` on every
  // XADD. Resolves arg > STREAM_MAXLEN env > DEFAULT_STREAM_MAXLEN. Pass
  // `0` to disable the cap entirely (tests / opt-out).
  streamMaxLen?: number;
}

export interface IngestStats {
  rows_ingested: number;
}

export async function ingestFile(args: IngestArgs): Promise<IngestStats> {
  const rows = await readAllRows(args.path, args.format);
  const progressEvery = args.progressEvery ?? 1000;
  // Wave 5.92A — resolve shards config: explicit arg > SOURCE_STREAM_SHARDS
  // env > default 1. parseStreamShardsFlag throws on garbage so misconfig
  // surfaces at boot rather than silently routing to one stream. When the
  // resolved shard count is 1 we skip router construction entirely so the
  // XADD payload is byte-for-byte identical to the pre-5.92 ingest.
  const shards: StreamShardsConfig = args.streamShards
    ?? parseStreamShardsFlag(process.env.SOURCE_STREAM_SHARDS);
  const router = shards === 1 ? null : createStreamRouter(INBOUND_STREAM, shards);
  // Wave 5.92C — resolve MAXLEN cap: explicit arg > STREAM_MAXLEN env >
  // DEFAULT_STREAM_MAXLEN. `0` disables the cap so the XADD command stays
  // byte-identical to pre-5.92C (tests that drive a strict stub-Redis can
  // opt out). The MAXLEN prefix is pre-computed once so the per-row XADD
  // call is a plain spread.
  const maxLen = resolveStreamMaxLen(args.streamMaxLen);
  const maxLenArgs: readonly string[] = maxLen > 0 ? ["MAXLEN", "~", String(maxLen)] : [];
  let n = 0;

  for (const row of rows) {
    const fields = applyMapping(row, args.mapping);
    const hashTag = `${fields.risk_class ?? ""}:${fields.bucket ?? ""}`;
    const streamKey = router ? router.route(hashTag) : INBOUND_STREAM;
    const xargs: string[] = ["_hash_tag", hashTag];
    for (const [k, v] of Object.entries(fields)) xargs.push(k, v);
    await args.redis.call("XADD", streamKey, ...maxLenArgs, "*", ...xargs);
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

// Wave 5.92C — resolve the MAXLEN ~ N cap from explicit arg > STREAM_MAXLEN
// env > DEFAULT_STREAM_MAXLEN. `0` (env or arg) disables the cap; any other
// non-finite / negative value also disables it so a typo can't OOM the host.
function resolveStreamMaxLen(explicit: number | undefined): number {
  if (explicit !== undefined) {
    return Number.isFinite(explicit) && explicit >= 0 ? Math.floor(explicit) : DEFAULT_STREAM_MAXLEN;
  }
  const raw = process.env.STREAM_MAXLEN;
  if (raw === undefined || raw === "") return DEFAULT_STREAM_MAXLEN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STREAM_MAXLEN;
  return Math.floor(n);
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

// Streaming JSONL sampler. Reads up to `limit` lines from a file where each
// line is a complete JSON object. Returns rows with all values coerced to
// strings so downstream type inference sees a consistent shape with CSV.

import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

export interface JsonlSample {
  columns: string[];
  rows: Record<string, string>[];
  row_count_seen: number;
}

export interface JsonlSampleOptions {
  limit: number;
}

export async function sampleJsonl(
  path: string,
  opts: JsonlSampleOptions,
): Promise<JsonlSample> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const rows: Record<string, string>[] = [];
  const cols = new Set<string>();
  let seen = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    seen += 1;
    if (rows.length >= opts.limit) { rl.close(); stream.destroy(); break; }
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      cols.add(k);
      row[k] = v == null ? "" : typeof v === "string" ? v : String(v);
    }
    rows.push(row);
  }
  return { columns: [...cols], rows, row_count_seen: seen };
}

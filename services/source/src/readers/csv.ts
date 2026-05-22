// Streaming CSV sampler: reads up to `limit` body rows without buffering the
// whole file. Built on a simple RFC-4180 state machine so we don't pull in a
// CSV library for what is effectively a typed-array walk.

import { createReadStream } from "node:fs";

export interface CsvSample {
  columns: string[];
  rows: Record<string, string>[];
  row_count_seen: number;
}

export interface CsvSampleOptions {
  limit: number;
}

export async function sampleCsv(
  path: string,
  opts: CsvSampleOptions,
): Promise<CsvSample> {
  const records = await readRecords(path, opts.limit + 1);
  const header = records[0] ?? [];
  const bodyAll = records.slice(1);
  const body = bodyAll.slice(0, opts.limit);
  const rows: Record<string, string>[] = body.map((rec) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i += 1) {
      obj[header[i] ?? `col_${i}`] = rec[i] ?? "";
    }
    return obj;
  });
  return { columns: header, rows, row_count_seen: bodyAll.length };
}

// Read at most `maxRecords` records (rows including header) from a CSV file
// using a per-byte state machine. Stops as soon as we have enough rows.
async function readRecords(path: string, maxRecords: number): Promise<string[][]> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let lastWasQuote = false;

  const flushField = () => { row.push(field); field = ""; };
  const flushRow = () => {
    // Skip purely-empty trailing rows (single empty field).
    if (!(row.length === 1 && row[0] === "")) records.push(row);
    row = [];
  };

  for await (const chunkRaw of stream) {
    const chunk = chunkRaw as string;
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i]!;
      if (inQuotes) {
        if (ch === '"') {
          if (lastWasQuote) { field += '"'; lastWasQuote = false; }
          else { lastWasQuote = true; }
        } else {
          if (lastWasQuote) { inQuotes = false; lastWasQuote = false; i -= 1; continue; }
          field += ch;
        }
      } else {
        if (ch === '"' && field === "") { inQuotes = true; }
        else if (ch === ",") { flushField(); }
        else if (ch === "\n") { flushField(); flushRow(); if (records.length >= maxRecords) { stream.destroy(); return records; } }
        else if (ch === "\r") { /* swallow \r; \n handles end-of-line */ }
        else { field += ch; }
      }
    }
  }
  // Final flush if file does not end with newline.
  if (inQuotes && lastWasQuote) inQuotes = false;
  if (field !== "" || row.length > 0) { flushField(); flushRow(); }
  return records;
}

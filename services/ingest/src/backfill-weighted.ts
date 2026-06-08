#!/usr/bin/env node
// Wave 5.83B — one-off backfill CLI. Scans existing `sens:*` JSON docs, runs
// enrichDoc against the loaded schema, and JSON.SETs the enriched payload back
// when (and only when) the doc is missing the new pre-weighted fields or the
// `_calibration` tag. Idempotent — re-running on already-enriched data is a
// no-op aside from a SCAN pass. Prints `{patched: N, skipped: M}` to stdout
// on completion.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Redis } from "ioredis";
import { createRedisClient } from "@frtb/redis-client";
import { loadSchema, type Schema } from "@frtb/schema";
import { enrichDoc, CALIBRATION_TAG, type RedisLike } from "./consumer.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_PATH = resolve(
  process.env.SCHEMA_FILE ?? join(REPO_ROOT, "config/schema/frtb-default.yaml"),
);
const SCAN_COUNT = Number(process.env.BACKFILL_SCAN_COUNT ?? "500");
const KEY_MATCH = process.env.BACKFILL_KEY_MATCH ?? "sens:*";

export interface BackfillReport { patched: number; skipped: number; errors: number; scanned: number }

// A doc needs patching when any expected pre-weighted field is absent or
// when the `_calibration` tag is missing/wrong. Curvature → weighted_cvr_*;
// Delta/Vega → weighted_value. Docs with unknown sensitivity_type still get
// the `_calibration` tag stamped.
function needsPatch(doc: Record<string, unknown>): boolean {
  if (doc._calibration !== CALIBRATION_TAG) return true;
  const sensType = typeof doc.sensitivity_type === "string" ? doc.sensitivity_type : "";
  if (sensType === "Curvature") {
    return doc.weighted_cvr_up === undefined || doc.weighted_cvr_down === undefined;
  }
  return doc.weighted_value === undefined;
}

export async function backfill(client: RedisLike, schema: Schema, opts?: { match?: string; count?: number }): Promise<BackfillReport> {
  const match = opts?.match ?? KEY_MATCH;
  const count = opts?.count ?? SCAN_COUNT;
  const report: BackfillReport = { patched: 0, skipped: 0, errors: 0, scanned: 0 };
  let cursor = "0";
  do {
    const reply = (await (client as Redis).scan(cursor, "MATCH", match, "COUNT", count)) as [string, string[]];
    cursor = reply[0]!;
    const keys = reply[1]!;
    if (keys.length === 0) continue;
    // Pipeline the JSON.GETs so a 6k-row backfill stays fast.
    const getPipe = client.pipeline();
    for (const k of keys) getPipe.call("JSON.GET", k);
    const getResults = await getPipe.exec();
    const setPipe = client.pipeline();
    let setCount = 0;
    for (let i = 0; i < keys.length; i++) {
      report.scanned++;
      const row = getResults?.[i];
      if (!row || row[0]) { report.errors++; continue; }
      const raw = row[1];
      if (typeof raw !== "string") { report.skipped++; continue; }
      let doc: Record<string, unknown>;
      try { doc = JSON.parse(raw) as Record<string, unknown>; }
      catch { report.errors++; continue; }
      if (!needsPatch(doc)) { report.skipped++; continue; }
      const enriched = enrichDoc(doc, schema);
      setPipe.call("JSON.SET", keys[i]!, "$", JSON.stringify(enriched));
      setCount++;
    }
    if (setCount > 0) {
      const setResults = await setPipe.exec();
      for (const r of setResults ?? []) {
        if (r && r[0]) report.errors++;
        else report.patched++;
      }
    }
  } while (cursor !== "0");
  return report;
}

async function main(): Promise<void> {
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`schema file not found: ${SCHEMA_PATH}`);
  }
  const schema = loadSchema(SCHEMA_PATH);
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const client = createRedisClient({ url: redisUrl }) as unknown as RedisLike;
  try {
    const t0 = Date.now();
    const report = await backfill(client, schema);
    const ms = Date.now() - t0;
    // Final line is JSON so it's machine-parseable by demo scripts.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...report, elapsed_ms: ms, schema: SCHEMA_PATH, redis: redisUrl }));
  } finally {
    await (client as Redis).quit().catch(() => undefined);
  }
}

// Only run main() when this file is the entry point — keeps the module
// safely importable from tests without side effects.
const invokedDirectly = (() => {
  try { return process.argv[1] === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ err: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}

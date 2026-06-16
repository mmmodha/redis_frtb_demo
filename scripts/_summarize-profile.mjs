// scripts/_summarize-profile.mjs — Wave 6.15a diagnostic helper. Aggregates
// per-shard ingest-profile 5s window samples from .run/logs/ingest.log and
// prints weighted per-shard fetch / parse / pipe_build / pipe_exec ms-per-row
// plus rows_read totals. Reads stdin or .run/logs/ingest.log.
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? ".run/logs/ingest.log";
const lines = readFileSync(path, "utf8").split("\n");
const agg = new Map();
let firstTs = Infinity, lastTs = 0;
for (const line of lines) {
  if (!line.includes('"ingest profile 5s window"')) continue;
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }
  const s = obj.shard_id;
  const rr = obj.rows_read | 0;
  if (rr === 0) continue;
  const m = obj.ms_per_row ?? {};
  const w = agg.get(s) ?? { rows: 0, fetch: 0, parse: 0, build: 0, exec: 0, idle: 0, windows: 0, windows_busy: 0 };
  w.rows += rr;
  w.fetch += (m.fetch || 0) * rr;
  w.parse += (m.parse || 0) * rr;
  w.build += (m.pipe_build || 0) * rr;
  w.exec += (m.pipe_exec || 0) * rr;
  w.idle += obj.idle_ms || 0;
  w.windows += 1;
  agg.set(s, w);
  firstTs = Math.min(firstTs, obj.time);
  lastTs = Math.max(lastTs, obj.time);
}

const shards = [...agg.keys()].sort((a, b) =>
  Number(a.replace(/[^0-9]/g, "")) - Number(b.replace(/[^0-9]/g, "")),
);
let totalRows = 0, totalIdle = 0;
const wallSec = (lastTs - firstTs) / 1000 + 5;
console.log("shard | rows  | fetch ms/row | parse ms/row | build ms/row | exec ms/row | idle ms");
console.log("------+-------+--------------+--------------+--------------+-------------+--------");
for (const s of shards) {
  const w = agg.get(s);
  totalRows += w.rows;
  totalIdle += w.idle;
  const div = (x) => (w.rows > 0 ? x / w.rows : 0);
  console.log(
    `${s.padEnd(5)} | ${String(w.rows).padStart(5)} | ` +
    `${div(w.fetch).toFixed(3).padStart(12)} | ${div(w.parse).toFixed(4).padStart(12)} | ` +
    `${div(w.build).toFixed(4).padStart(12)} | ${div(w.exec).toFixed(3).padStart(11)} | ${String(w.idle).padStart(6)}`,
  );
}
const rps = totalRows / wallSec;
console.log("------+-------+--------------+--------------+--------------+-------------+--------");
console.log(`TOTAL rows_read=${totalRows}  wall=${wallSec.toFixed(1)}s  aggregate_rps=${rps.toFixed(0)}  total_idle_ms=${totalIdle}`);

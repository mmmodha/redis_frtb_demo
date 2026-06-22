// Wave 7.0.4.A parser — extracted in Wave 7.0.6.5 so plain-Node scripts (the
// 450M pre-flight tooling under scripts/*.mjs) can import the SAME parser the
// observability route uses, without dragging tsx into the script runtime.
//
// services/api/src/routes/observability.ts re-exports parseRladminMemory /
// parseRladminShards / RladminShardRow from this module so existing imports
// (tests, route code) keep working unchanged.
//
// Wave 7.0.6.5 addition: when the `rladmin info shards` header contains a
// KEYS / OBJECTS / NUM_KEYS column, the parser populates `key_count` on each
// row. Older snapshots without those columns leave `key_count` undefined —
// callers that need keys (assert-shard-balance.mjs --check keys) must error
// rather than silently producing zero deltas.

const KEY_COUNT_HEADER_CANDIDATES = ["KEYS", "OBJECTS", "NUM_KEYS"];

export function parseRladminMemory(s) {
  const trimmed = (s ?? "").trim();
  const m = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)B?$/i);
  if (!m) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] ?? "").toUpperCase();
  const mult =
    unit === "K" ? 1024 :
    unit === "M" ? 1024 ** 2 :
    unit === "G" ? 1024 ** 3 :
    unit === "T" ? 1024 ** 4 : 1;
  return Math.round(n * mult);
}

function parseKeyCount(cell) {
  const trimmed = (cell ?? "").trim();
  if (!trimmed || trimmed === "—" || trimmed === "-") return undefined;
  // rladmin sometimes formats large counts as "1,234,567" — drop separators.
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function parseRladminShards(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\bSHARD:ID\b/i.test(line) && /\bROLE\b/i.test(line)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];
  const headers = (lines[headerIdx] ?? "").trim().split(/\s+/);
  const idCol = headers.findIndex((h) => h.toUpperCase() === "SHARD:ID");
  const roleCol = headers.findIndex((h) => h.toUpperCase() === "ROLE");
  const memCol = headers.findIndex((h) => h.toUpperCase() === "USED_MEMORY");
  const nodeCol = headers.findIndex((h) => h.toUpperCase() === "NODE:ID");
  const keysCol = headers.findIndex((h) => KEY_COUNT_HEADER_CANDIDATES.includes(h.toUpperCase()));
  if (idCol < 0 || roleCol < 0) return [];
  const out = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const parts = (lines[i] ?? "").trim().split(/\s+/);
    if (parts.length < headers.length) continue;
    const id = parts[idCol] ?? "";
    if (!/^redis:\d+$/.test(id)) continue;
    const role = parts[roleCol];
    if (role !== "master" && role !== "slave") continue;
    const memory_used = memCol >= 0 ? parseRladminMemory(parts[memCol] ?? "") : 0;
    const row = { shard_id: id, role, memory_used };
    if (nodeCol >= 0 && parts[nodeCol]) row.node_id = parts[nodeCol];
    if (keysCol >= 0) {
      const kc = parseKeyCount(parts[keysCol] ?? "");
      if (kc !== undefined) row.key_count = kc;
    }
    out.push(row);
  }
  return out;
}

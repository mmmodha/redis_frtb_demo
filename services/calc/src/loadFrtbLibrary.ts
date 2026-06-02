// Loads the cross-agent Redis Functions library `frtb` (Wave 2 locked name).
// Multiple snippets — one per function — are concatenated under a single
// `#!lua name=frtb` shebang and submitted via FUNCTION LOAD REPLACE.
// This lets the Delta and Vega agents contribute their function source
// independently while still ending up in the single library required by
// the locked contract.

import type { Redis, Cluster } from "ioredis";

export interface FrtbLibrarySnippet {
  /** Function name registered inside the snippet (e.g. "sbm_vega_bucket"). */
  name: string;
  /** Raw Lua source — must call redis.register_function exactly once. */
  code: string;
}

const LIBRARY_NAME = "frtb";
const SHEBANG = `#!lua name=${LIBRARY_NAME}`;

// Wave 5.31c — shared Lua predicate helpers injected once at library scope so
// every kernel can apply the exclude filters without copy-pasting the parse +
// check logic across nine .lua files. Each registered function captures these
// locals via closure so they remain callable from inside redis.register_function
// bodies. CSV is the wire format (kernel arg shape stays flat; no cjson.decode
// per call). Order: book → trade_id → risk_factor — cheapest-cardinality first
// per the locked design decision so the typical hit short-circuits fast.
const FRTB_PRELUDE = `
local function _frtb_parse_csv_set(csv)
  if not csv or csv == '' then return nil end
  local set = {}
  local has = false
  for token in string.gmatch(csv, '([^,]+)') do
    set[token] = true
    has = true
  end
  if not has then return nil end
  return set
end

local function _frtb_excluded(doc, book_set, trade_set, factor_set)
  if book_set then
    local v = doc.book
    if v and book_set[v] then return true end
  end
  if trade_set then
    local v = doc.trade_id
    if v and trade_set[v] then return true end
  end
  if factor_set then
    local v = doc.risk_factor
    if v and factor_set[v] then return true end
  end
  return false
end
`;

export function buildFrtbLibrarySource(
  snippets: ReadonlyArray<FrtbLibrarySnippet>,
): string {
  if (snippets.length === 0) {
    throw new Error("buildFrtbLibrarySource: at least one snippet is required");
  }
  // Stable, alphabetical order keeps the library source deterministic across
  // runs and across whichever agent happens to load it first.
  const ordered = [...snippets].sort((a, b) => a.name.localeCompare(b.name));
  // Strip any shebangs from individual snippets — only the library-level one
  // counts.
  const bodies = ordered.map((s) =>
    s.code.replace(/^#!lua\s+name=[^\n]*\n?/m, "").trim(),
  );
  return [SHEBANG, "", FRTB_PRELUDE.trim(), "", ...bodies.map((b) => `${b}\n`)].join("\n");
}

export interface LoadResult {
  libraryName: string;
  functionsRegistered: string[];
}

type RedisLike = Redis | Cluster;

export async function loadFrtbLibrary(
  client: RedisLike,
  snippets: ReadonlyArray<FrtbLibrarySnippet>,
): Promise<LoadResult> {
  const source = buildFrtbLibrarySource(snippets);
  // FUNCTION LOAD REPLACE <source> — REPLACE so reloading during tests /
  // schema swaps is idempotent.
  await client.call("FUNCTION", "LOAD", "REPLACE", source);
  return {
    libraryName: LIBRARY_NAME,
    functionsRegistered: snippets.map((s) => s.name),
  };
}

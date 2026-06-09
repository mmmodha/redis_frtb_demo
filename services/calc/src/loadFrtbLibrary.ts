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

-- Wave 5.96.5 — shared slot-local SCAN + JSON.GET + sensitivity_type gate +
-- exclude-predicate iterator used by every per-bucket kernel. Each kernel
-- supplies on_row(doc), which owns the per-row weighting / tenor / curvature
-- math AND any kernel-specific row counting (count semantics differ across
-- kernels — GIRR counts every type+exclude pass, equity/fx count only when
-- risk_value parses — so the closure decides). SCAN/JSON.GET/decoder/type
-- check live here exactly once.
local function _frtb_scan_bucket(risk_class, bucket, expected_type,
                                  book_set, trade_set, factor_set, on_row)
  local pattern = 'sens:{' .. risk_class .. ':' .. bucket .. '}:*'
  local cursor = '0'
  repeat
    local res = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = res[1]
    local keys = res[2]
    for i = 1, #keys do
      local ok_j, raw = pcall(redis.call, 'JSON.GET', keys[i])
      if not ok_j then
        local ok_g, plain = pcall(redis.call, 'GET', keys[i])
        raw = ok_g and plain or nil
      end
      if raw then
        local ok, doc = pcall(cjson.decode, raw)
        if ok and type(doc) == 'table'
           and doc.sensitivity_type == expected_type
           and not _frtb_excluded(doc, book_set, trade_set, factor_set) then
          on_row(doc)
        end
      end
    end
  until cursor == '0'
end

-- Wave 5.96.5 — scalar risk_value reader shared by equity/fx Delta+Vega
-- kernels. Production rows emit a table with a numeric "spot" field; legacy
-- and test fixtures may still emit a bare number. Returns nil for any other
-- shape so the caller's "if s then" gate keeps its existing semantics.
local function _frtb_read_scalar(rv)
  if type(rv) == 'number' then
    return rv
  elseif type(rv) == 'table' then
    return tonumber(rv.spot)
  end
  return nil
end

-- Wave 5.96.5 — constant-ρ K_b for Delta/Vega kernels (Basel constant-ρ
-- specialisation: K_b² = ΣWS² + ρ · ((ΣWS)² − ΣWS²), K_b = √max(0, K_b²)).
-- Identical shape across GIRR/Equity/FX Delta+Vega so it lives in one place.
local function _frtb_constant_rho_kb(sum_ws, sum_ws_sq, rho)
  local cross = sum_ws * sum_ws - sum_ws_sq
  if cross < 0 then cross = 0 end
  local kb_sq = sum_ws_sq + rho * cross
  if kb_sq < 0 then kb_sq = 0 end
  return math.sqrt(kb_sq)
end

-- Wave 5.96.5 — curvature K_b² inner kernel (Basel MAR21 §21.5(3) with the
-- ψ gate: cross-term drops when both arguments are strictly negative).
-- Identical body across GIRR/Equity/FX Curvature, so it lives in one place.
local function _frtb_curv_kb_sq(cvr, rho)
  local sum_sq = 0.0
  local cross = 0.0
  local n = #cvr
  for k = 1, n do
    local a = cvr[k]
    sum_sq = sum_sq + a * a
    for l = 1, n do
      if l ~= k then
        local b = cvr[l]
        -- §21.5(3) ψ: zero when both arguments strictly negative, else one.
        if not (a < 0 and b < 0) then
          cross = cross + rho * a * b
        end
      end
    end
  end
  return sum_sq + cross
end

-- Wave 5.96.5 — curvature direction-winner picker shared by every Curvature
-- kernel. Returns (K_b, S_b, direction) where direction ∈ {'up','down','tie'}.
local function _frtb_curv_winner(kb_up, kb_down, s_up, s_down)
  if kb_up > kb_down then
    return kb_up, s_up, 'up'
  elseif kb_down > kb_up then
    return kb_down, s_down, 'down'
  else
    return kb_up, s_up, 'tie'
  end
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

-- frtb.girr_curvature — GIRR Curvature per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{<risk_class>:<bucket>}:* on the
-- shard that owns that hash-tag (the FCALL is dispatched via a single key
-- that pins the slot, and the SCAN MATCH pattern keeps the read set scoped
-- to that bucket — no cross-slot fan-out).
--
-- Math (Basel MAR21 §21.5(2)–(3), GIRR Curvature; bucket-local):
--   CVR_k^{+|-} pre-computed per row per §21.5(2); aggregated per-tenor across
--   rows within the bucket (mirrors how girr_delta.lua aggregates per-tenor
--   sensitivities).
--   K_b^{up|down}² = Σ_k CVR_k² + Σ_{k≠l} ρ_curv · CVR_k · CVR_l · ψ(CVR_k, CVR_l)
--   ψ = 0 if both CVRs are strictly negative, 1 otherwise per §21.5(3).
--     (Distinct from Delta — Delta has no ψ gate; do not copy-paste.)
--   K_b = max(K_b^up, K_b^down); direction = winner; S_b = Σ_k CVR_k^direction
--   ρ_curv = (ρ_delta)² per §21.5(3) — the loader substitutes the already-
--   squared value into __GIRR_CURVATURE_RHO__.
-- Across-bucket §21.5(5) aggregation (γ², §21.5(5)(b) fallback) lives in TS
-- (services/api/src/sbm/reduce.ts in 5.16c) — this function returns bucket-
-- local K_b/S_b/direction only.
-- The loader substitutes __GIRR_CURVATURE_TENORS__ (integer) and
-- __GIRR_CURVATURE_RHO__ (Lua float literal of ρ_curv) at load time, mirroring
-- the girr_delta.lua substitution scheme.
-- Only rows with sensitivity_type == "Curvature" contribute.

-- Wave 5.31c: args 3/4/5 carry the exclude_book / trade / factor CSV sets.
local function _curv_iter_bucket(risk_class, bucket, T, book_set, trade_set, factor_set)
  local pattern = 'sens:{' .. risk_class .. ':' .. bucket .. '}:*'
  local cursor = '0'
  local sum_up = {}
  local sum_down = {}
  for k = 1, T do
    sum_up[k] = 0.0
    sum_down[k] = 0.0
  end
  local row_count = 0
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
        if ok and type(doc) == 'table' and doc.sensitivity_type == 'Curvature'
           and not _frtb_excluded(doc, book_set, trade_set, factor_set) then
          local rv = doc.risk_value
          if type(rv) == 'table' then
            local up = rv.cvr_up
            local down = rv.cvr_down
            if type(up) == 'table' then
              local kmax = #up
              if kmax > T then kmax = T end
              for k = 1, kmax do
                local s = tonumber(up[k])
                if s then sum_up[k] = sum_up[k] + s end
              end
            end
            if type(down) == 'table' then
              local kmax = #down
              if kmax > T then kmax = T end
              for k = 1, kmax do
                local s = tonumber(down[k])
                if s then sum_down[k] = sum_down[k] + s end
              end
            end
          end
          row_count = row_count + 1
        end
      end
    end
  until cursor == '0'
  return sum_up, sum_down, row_count
end

local function _curv_kb_sq(cvr, rho)
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

redis.register_function('girr_curvature', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('girr_curvature: requires (risk_class, bucket) args')
  end
  local book_set = _frtb_parse_csv_set(args[3])
  local trade_set = _frtb_parse_csv_set(args[4])
  local factor_set = _frtb_parse_csv_set(args[5])
  local T = __GIRR_CURVATURE_TENORS__
  local rho = __GIRR_CURVATURE_RHO__
  local t0 = redis.call('TIME')
  local sum_up, sum_down, count = _curv_iter_bucket(risk_class, bucket, T, book_set, trade_set, factor_set)
  local kb_up_sq = _curv_kb_sq(sum_up, rho)
  local kb_down_sq = _curv_kb_sq(sum_down, rho)
  if kb_up_sq < 0 then kb_up_sq = 0 end
  if kb_down_sq < 0 then kb_down_sq = 0 end
  local kb_up = math.sqrt(kb_up_sq)
  local kb_down = math.sqrt(kb_down_sq)
  local s_up = 0.0
  local s_down = 0.0
  for k = 1, T do
    s_up = s_up + sum_up[k]
    s_down = s_down + sum_down[k]
  end
  local kb, sb, direction
  if kb_up > kb_down then
    kb = kb_up; sb = s_up; direction = 'up'
  elseif kb_down > kb_up then
    kb = kb_down; sb = s_down; direction = 'down'
  else
    kb = kb_up; sb = s_up; direction = 'tie'
  end
  local t1 = redis.call('TIME')
  local ms = (tonumber(t1[1]) - tonumber(t0[1])) * 1000.0
              + (tonumber(t1[2]) - tonumber(t0[2])) / 1000.0
  return cjson.encode({
    K_b = kb, K_b_up = kb_up, K_b_down = kb_down,
    S_b = sb, S_b_up = s_up, S_b_down = s_down,
    direction = direction, count = count, ms = ms,
  })
end)

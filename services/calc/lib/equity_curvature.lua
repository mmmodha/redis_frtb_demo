-- frtb.equity_curvature — Equity Curvature per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{Equity:<bucket>}:* on the
-- shard that owns that hash-tag.
--
-- Math (Basel MAR21 §21.5(2)–(3), Equity Curvature; bucket-local):
--   CVR^{+|-} pre-computed scalar per row per §21.5(2); each row is a
--   distinct issuer factor k (mirrors equity_delta.lua's per-row factor
--   treatment).
--   K_b^{up|down}² = Σ_k CVR_k² + Σ_{k≠l} ρ_curv · CVR_k · CVR_l · ψ(CVR_k, CVR_l)
--   ψ = 0 if both CVRs are strictly negative, 1 otherwise per §21.5(3).
--     (Distinct from Delta — Delta has no ψ gate; do not copy-paste.)
--   K_b = max(K_b^up, K_b^down); direction = winner; S_b = Σ_k CVR_k^direction
--   ρ_curv = (ρ_delta)² per §21.5(3) — the loader substitutes the already-
--   squared value into __EQUITY_CURVATURE_RHO__.
-- Across-bucket §21.5(5) aggregation (γ², §21.5(5)(b) fallback) lives in TS
-- (5.16c) — bucket-13 specialisation also lives at the cross-bucket γ level
-- per MAR21, so this per-bucket function has no bucket-13 branch.
-- Only rows with sensitivity_type == "Curvature" contribute.

local function _eq_curv_iter_bucket(risk_class, bucket)
  local pattern = 'sens:{' .. risk_class .. ':' .. bucket .. '}:*'
  local cursor = '0'
  local up_arr = {}
  local down_arr = {}
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
        if ok and type(doc) == 'table' and doc.sensitivity_type == 'Curvature' then
          local rv = doc.risk_value
          if type(rv) == 'table' then
            local up = tonumber(rv.cvr_up)
            local down = tonumber(rv.cvr_down)
            if up and down then
              row_count = row_count + 1
              up_arr[row_count] = up
              down_arr[row_count] = down
            end
          end
        end
      end
    end
  until cursor == '0'
  return up_arr, down_arr, row_count
end

local function _eq_curv_kb_sq(cvr, rho)
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

redis.register_function('equity_curvature', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('equity_curvature: requires (risk_class, bucket) args')
  end
  local rho = __EQUITY_CURVATURE_RHO__
  local t0 = redis.call('TIME')
  local up_arr, down_arr, count = _eq_curv_iter_bucket(risk_class, bucket)
  local kb_up_sq = _eq_curv_kb_sq(up_arr, rho)
  local kb_down_sq = _eq_curv_kb_sq(down_arr, rho)
  if kb_up_sq < 0 then kb_up_sq = 0 end
  if kb_down_sq < 0 then kb_down_sq = 0 end
  local kb_up = math.sqrt(kb_up_sq)
  local kb_down = math.sqrt(kb_down_sq)
  local s_up = 0.0
  local s_down = 0.0
  for k = 1, count do
    s_up = s_up + up_arr[k]
    s_down = s_down + down_arr[k]
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

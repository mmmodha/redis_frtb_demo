-- frtb.fx_delta — FX Delta per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{FX:<pair>}:* on the shard that
-- owns that hash-tag.
--
-- Math (MAR21 §21.88–§21.91, FX Delta) with the constant-ρ specialisation
-- (matches the Python reference oracle's scalar_constant kernel):
--   WS_k = w · s_k                                 -- per-row weighted Δ-sensi
--   S_b  = Σ WS_k                                  -- signed; used by reduce
--   K_b² = Σ WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²)
--   K_b  = √max(0, K_b²)
-- The loader substitutes __FX_DELTA_WEIGHT__ and __FX_DELTA_RHO__ with
-- numeric literals (ρ defaults to 0 → K_b = |Σ WS_k|, the legacy
-- single-factor specialisation).
-- Only rows with sensitivity_type == "Delta" contribute.

local function _fx_delta_iter_bucket(risk_class, bucket, w)
  local pattern = 'sens:{' .. risk_class .. ':' .. bucket .. '}:*'
  local cursor = '0'
  local sum_ws = 0.0
  local sum_ws_sq = 0.0
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
        if ok and type(doc) == 'table' and doc.sensitivity_type == 'Delta' then
          local s = tonumber(doc.risk_value)
          if s then
            local ws = w * s
            sum_ws = sum_ws + ws
            sum_ws_sq = sum_ws_sq + ws * ws
            row_count = row_count + 1
          end
        end
      end
    end
  until cursor == '0'
  return sum_ws, sum_ws_sq, row_count
end

redis.register_function('fx_delta', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('fx_delta: requires (risk_class, bucket) args')
  end
  local w = __FX_DELTA_WEIGHT__
  local rho = __FX_DELTA_RHO__
  local t0 = redis.call('TIME')
  local sum_ws, sum_ws_sq, count = _fx_delta_iter_bucket(risk_class, bucket, w)
  local cross = sum_ws * sum_ws - sum_ws_sq
  if cross < 0 then cross = 0 end
  local kb_sq = sum_ws_sq + rho * cross
  if kb_sq < 0 then kb_sq = 0 end
  local kb = math.sqrt(kb_sq)
  local t1 = redis.call('TIME')
  local ms = (tonumber(t1[1]) - tonumber(t0[1])) * 1000.0
              + (tonumber(t1[2]) - tonumber(t0[2])) / 1000.0
  return cjson.encode({ K_b = kb, S_b = sum_ws, count = count, ms = ms })
end)

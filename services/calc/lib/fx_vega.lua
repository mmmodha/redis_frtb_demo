-- frtb.fx_vega — FX Vega per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{FX:<pair>}:* on the shard that
-- owns that hash-tag.
--
-- Math (MAR21 §21.92, FX Vega) — single risk factor per currency pair:
--   s_b = Σ vega_row    (sensitivity_type == "Vega" only)
--   WS  = w · s_b
--   S_b = WS
--   K_b = |WS|
-- The loader substitutes __FX_VEGA_WEIGHT__ with a numeric literal.

local function _fx_vega_iter_bucket(bucket)
  local pattern = 'sens:{FX:' .. bucket .. '}:*'
  local cursor = '0'
  local sum_s = 0.0
  local row_count = 0
  repeat
    local res = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = res[1]
    local keys = res[2]
    for i = 1, #keys do
      local raw = redis.call('GET', keys[i])
      if raw then
        local ok, doc = pcall(cjson.decode, raw)
        if ok and type(doc) == 'table' and doc.sensitivity_type == 'Vega' then
          local s = tonumber(doc.risk_value)
          if s then
            sum_s = sum_s + s
            row_count = row_count + 1
          end
        end
      end
    end
  until cursor == '0'
  return sum_s, row_count
end

redis.register_function('fx_vega', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('fx_vega: requires (risk_class, bucket) args')
  end
  local w = __FX_VEGA_WEIGHT__
  local t0 = redis.call('TIME')
  local sum_s, count = _fx_vega_iter_bucket(bucket)
  local ws = w * sum_s
  local kb = ws
  if kb < 0 then kb = -kb end
  local t1 = redis.call('TIME')
  local ms = (tonumber(t1[1]) - tonumber(t0[1])) * 1000.0
              + (tonumber(t1[2]) - tonumber(t0[2])) / 1000.0
  return cjson.encode({ K_b = kb, S_b = ws, count = count, ms = ms })
end)

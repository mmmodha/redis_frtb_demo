-- frtb.sbm_vega_bucket — GIRR Vega per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{<risk_class>:<bucket>}:* on the
-- shard that owns that hash-tag.
--
-- Math (Basel CRE22.62 / MAR21 §21.92, GIRR Vega):
--   WS_k = w * s_k                                    -- weighted vega sensi
--   K_b  = sqrt( ΣWS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l )
--   S_b  = Σ WS_k
-- Constant-ρ specialisation used here:
--   K_b² = ΣWS² + ρ · ((ΣWS)² − ΣWS²)
-- ρ_kl is the option-maturity-pair correlation per CRE22.66.
-- The loader substitutes __GIRR_VEGA_WEIGHT__ and __GIRR_VEGA_RHO__ with
-- numeric literals derived from config/schema/frtb-default.yaml.

local function _vega_iter_bucket(risk_class, bucket)
  local pattern = 'sens:{' .. risk_class .. ':' .. bucket .. '}:*'
  local cursor = '0'
  local sum_ws = 0.0
  local sum_ws_sq = 0.0
  local row_count = 0
  local w = __GIRR_VEGA_WEIGHT__
  repeat
    local res = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 500)
    cursor = res[1]
    local keys = res[2]
    for i = 1, #keys do
      local raw = redis.call('GET', keys[i])
      if raw then
        local doc = cjson.decode(raw)
        local rv = doc.risk_value
        if type(rv) == 'table' then
          for t = 1, #rv do
            local s = tonumber(rv[t])
            if s then
              local ws = w * s
              sum_ws = sum_ws + ws
              sum_ws_sq = sum_ws_sq + ws * ws
            end
          end
        elseif rv then
          local s = tonumber(rv)
          if s then
            local ws = w * s
            sum_ws = sum_ws + ws
            sum_ws_sq = sum_ws_sq + ws * ws
          end
        end
        row_count = row_count + 1
      end
    end
  until cursor == '0'
  return sum_ws, sum_ws_sq, row_count
end

redis.register_function('sbm_vega_bucket', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('sbm_vega_bucket: requires (risk_class, bucket) args')
  end
  local t0 = redis.call('TIME')
  local sum_ws, sum_ws_sq, count = _vega_iter_bucket(risk_class, bucket)
  local rho = __GIRR_VEGA_RHO__
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

-- frtb.sbm_delta_bucket — GIRR Delta per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{<risk_class>:<bucket>}:* on the
-- shard that owns that hash-tag (the FCALL is dispatched via a single key
-- that pins the slot, and the SCAN MATCH pattern keeps the read set scoped
-- to that bucket — no cross-slot fan-out).
--
-- Math (Basel CRE22.30 / MAR21 §21.4(2)–(4), GIRR Delta):
--   WS_k = w_k · Σ_rows s_k                        -- weighted Δ-sensi per tenor
--   K_b  = sqrt( Σ_k WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l )
--   S_b  = Σ_k WS_k
-- Constant-ρ specialisation used here (ρ_kk=1, ρ_kl=ρ k≠l):
--   K_b² = ΣWS² + ρ · ((ΣWS)² − ΣWS²)
-- The loader substitutes __GIRR_DELTA_WEIGHTS__ (Lua array literal),
-- __GIRR_DELTA_RHO__, and __GIRR_TENORS__ (Lua array of tenor label strings)
-- with literals derived from config/schema/frtb-default.yaml.
-- Only rows with sensitivity_type == "Delta" contribute; other types skipped.
--
-- Wave 5.17a — risk_value reshape: production rows emit `{ "3M": v0, "6M":
-- v1, ..., "30Y": v9 }` keyed by the GIRR tenor labels. Legacy / test
-- fixtures may still emit a plain `[v0, v1, ...]` array. Both shapes
-- iterate in declared tenor order so floating-point summation is identical.

local function _delta_iter_bucket(risk_class, bucket, weights, tenors)
  local pattern = 'sens:{' .. risk_class .. ':' .. bucket .. '}:*'
  local cursor = '0'
  local T = #weights
  local sum_s = {}
  for k = 1, T do sum_s[k] = 0.0 end
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
          local rv = doc.risk_value
          if type(rv) == 'table' then
            if rv[1] ~= nil then
              -- Array form (legacy / hand-seeded test fixtures).
              local kmax = #rv
              if kmax > T then kmax = T end
              for k = 1, kmax do
                local s = tonumber(rv[k])
                if s then sum_s[k] = sum_s[k] + s end
              end
            else
              -- Object form keyed by tenor labels (Wave 5.17a production).
              for k = 1, T do
                local s = tonumber(rv[tenors[k]])
                if s then sum_s[k] = sum_s[k] + s end
              end
            end
          end
          row_count = row_count + 1
        end
      end
    end
  until cursor == '0'
  return sum_s, row_count
end

redis.register_function('sbm_delta_bucket', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('sbm_delta_bucket: requires (risk_class, bucket) args')
  end
  local weights = __GIRR_DELTA_WEIGHTS__
  local rho = __GIRR_DELTA_RHO__
  local tenors = __GIRR_TENORS__
  local T = #weights
  local t0 = redis.call('TIME')
  local sum_s, count = _delta_iter_bucket(risk_class, bucket, weights, tenors)
  local sum_ws = 0.0
  local sum_ws_sq = 0.0
  for k = 1, T do
    local ws = weights[k] * sum_s[k]
    sum_ws = sum_ws + ws
    sum_ws_sq = sum_ws_sq + ws * ws
  end
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

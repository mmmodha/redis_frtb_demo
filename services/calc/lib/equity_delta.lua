-- frtb.equity_delta — Equity Delta per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{Equity:<bucket>}:* on the
-- shard that owns that hash-tag.
--
-- Math (MAR21 §21.78–§21.83, Equity Delta):
--   WS_k = w_bucket · s_k                          -- per-row weighted Δ-sensi
--   K_b  = sqrt( Σ_k WS_k² + Σ_{k≠l} ρ_kl · WS_k · WS_l )
--   S_b  = Σ_k WS_k
-- Constant-ρ specialisation used here (ρ_kk=1, ρ_kl=ρ k≠l):
--   K_b² = ΣWS² + ρ · ((ΣWS)² − ΣWS²)
-- Each row inside a bucket is a distinct issuer factor k.
-- The loader substitutes __EQUITY_DELTA_WEIGHTS__ (Lua table indexed by
-- bucket string) and __EQUITY_DELTA_RHO__ with numeric literals derived
-- from config/schema/frtb-default.yaml.
-- Only rows with sensitivity_type == "Delta" contribute.

-- Wave 5.31c: args 3/4/5 carry the exclude_book / trade / factor CSV sets.
local function _eq_delta_iter_bucket(risk_class, bucket, w, book_set, trade_set, factor_set)
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
        if ok and type(doc) == 'table' and doc.sensitivity_type == 'Delta'
           and not _frtb_excluded(doc, book_set, trade_set, factor_set) then
          -- Wave 5.17a — Equity Delta risk_value reshape: production rows
          -- emit `{ spot: number }`; legacy / test fixtures may still emit a
          -- bare number. Read both shapes; rng-isolated reshape preserves
          -- the underlying numeric value byte-for-byte.
          local rv = doc.risk_value
          local s
          if type(rv) == 'number' then
            s = rv
          elseif type(rv) == 'table' then
            s = tonumber(rv.spot)
          end
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

redis.register_function('equity_delta', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('equity_delta: requires (risk_class, bucket) args')
  end
  local book_set = _frtb_parse_csv_set(args[3])
  local trade_set = _frtb_parse_csv_set(args[4])
  local factor_set = _frtb_parse_csv_set(args[5])
  local weights = __EQUITY_DELTA_WEIGHTS__
  local rho = __EQUITY_DELTA_RHO__
  local w = weights[bucket]
  if not w then
    return redis.error_reply('equity_delta: no weight for bucket ' .. tostring(bucket))
  end
  local t0 = redis.call('TIME')
  local sum_ws, sum_ws_sq, count = _eq_delta_iter_bucket(risk_class, bucket, w, book_set, trade_set, factor_set)
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

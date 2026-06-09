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
-- Wave 5.96.5: SCAN+JSON.GET+type/exclude gate live in _frtb_scan_bucket
-- (FRTB_PRELUDE); risk_value reshape (number vs `{ spot }`) lives in
-- _frtb_read_scalar. Equity count semantics: only rows where risk_value
-- parses count (matches pre-refactor behavior).
local function _eq_delta_iter_bucket(risk_class, bucket, w, book_set, trade_set, factor_set)
  local sum_ws = 0.0
  local sum_ws_sq = 0.0
  local row_count = 0
  _frtb_scan_bucket(risk_class, bucket, 'Delta',
    book_set, trade_set, factor_set, function(doc)
      local s = _frtb_read_scalar(doc.risk_value)
      if s then
        local ws = w * s
        sum_ws = sum_ws + ws
        sum_ws_sq = sum_ws_sq + ws * ws
        row_count = row_count + 1
      end
    end)
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
  local kb = _frtb_constant_rho_kb(sum_ws, sum_ws_sq, rho)
  local t1 = redis.call('TIME')
  local ms = (tonumber(t1[1]) - tonumber(t0[1])) * 1000.0
              + (tonumber(t1[2]) - tonumber(t0[2])) / 1000.0
  return cjson.encode({ K_b = kb, S_b = sum_ws, count = count, ms = ms })
end)

-- frtb.fx_vega — FX Vega per-bucket K_b function.
-- Loaded as part of the cross-agent `frtb` library (see src/loadFrtbLibrary.ts).
-- Slot-local: only reads keys matching sens:{FX:<pair>}:* on the shard that
-- owns that hash-tag.
--
-- Math (MAR21 §21.92, FX Vega) with the constant-ρ specialisation
-- (matches the Python reference oracle's scalar_constant kernel):
--   WS_k = w · s_k                                 -- per-row weighted vega
--   S_b  = Σ WS_k
--   K_b² = Σ WS_k² + ρ · ((Σ WS_k)² − Σ WS_k²)
--   K_b  = √max(0, K_b²)
-- The loader substitutes __FX_VEGA_WEIGHT__ and __FX_VEGA_RHO__ with
-- numeric literals (ρ defaults to 0 → K_b = |Σ WS_k|).
-- Only rows with sensitivity_type == "Vega" contribute.

-- Wave 5.31c: args 3/4/5 carry the exclude_book / trade / factor CSV sets.
-- Wave 5.96.5: SCAN+JSON.GET+type/exclude gate live in _frtb_scan_bucket
-- (FRTB_PRELUDE); risk_value reshape lives in _frtb_read_scalar.
-- FX count semantics: only rows where risk_value parses count.
local function _fx_vega_iter_bucket(risk_class, bucket, w, book_set, trade_set, factor_set)
  local sum_ws = 0.0
  local sum_ws_sq = 0.0
  local row_count = 0
  _frtb_scan_bucket(risk_class, bucket, 'Vega',
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

redis.register_function('fx_vega', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('fx_vega: requires (risk_class, bucket) args')
  end
  local book_set = _frtb_parse_csv_set(args[3])
  local trade_set = _frtb_parse_csv_set(args[4])
  local factor_set = _frtb_parse_csv_set(args[5])
  local w = __FX_VEGA_WEIGHT__
  local rho = __FX_VEGA_RHO__
  local t0 = redis.call('TIME')
  local sum_ws, sum_ws_sq, count = _fx_vega_iter_bucket(risk_class, bucket, w, book_set, trade_set, factor_set)
  local kb = _frtb_constant_rho_kb(sum_ws, sum_ws_sq, rho)
  local t1 = redis.call('TIME')
  local ms = (tonumber(t1[1]) - tonumber(t0[1])) * 1000.0
              + (tonumber(t1[2]) - tonumber(t0[2])) / 1000.0
  return cjson.encode({ K_b = kb, S_b = sum_ws, count = count, ms = ms })
end)

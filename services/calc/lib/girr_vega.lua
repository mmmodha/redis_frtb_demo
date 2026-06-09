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
-- The loader substitutes __GIRR_VEGA_WEIGHT__, __GIRR_VEGA_RHO__, and
-- __GIRR_TENORS__ (Lua array of tenor label strings) with literals derived
-- from config/schema/frtb-default.yaml.
--
-- Wave 5.17a — risk_value reshape: production rows emit `{ "3M": v0, ...,
-- "30Y": v9 }`. Legacy / test fixtures may still emit a plain array or a
-- bare number. All three shapes iterate in declared tenor order so the
-- floating-point summation is order-stable across the reshape.

-- Wave 5.31c: args 3/4/5 carry the exclude_book / trade / factor CSV sets.
-- Wave 5.96.5: SCAN+JSON.GET+type/exclude gate live in _frtb_scan_bucket
-- (FRTB_PRELUDE). GIRR vega count semantics: every type+exclude pass
-- counts (matches pre-refactor behavior).
local function _vega_iter_bucket(risk_class, bucket, tenors, book_set, trade_set, factor_set)
  local sum_ws = 0.0
  local sum_ws_sq = 0.0
  local row_count = 0
  local w = __GIRR_VEGA_WEIGHT__
  local T = #tenors
  _frtb_scan_bucket(risk_class, bucket, 'Vega',
    book_set, trade_set, factor_set, function(doc)
      local rv = doc.risk_value
      if type(rv) == 'table' then
        if rv[1] ~= nil then
          -- Array form (legacy / test fixtures).
          for t = 1, #rv do
            local s = tonumber(rv[t])
            if s then
              local ws = w * s
              sum_ws = sum_ws + ws
              sum_ws_sq = sum_ws_sq + ws * ws
            end
          end
        else
          -- Object form keyed by tenor labels (Wave 5.17a production).
          for k = 1, T do
            local s = tonumber(rv[tenors[k]])
            if s then
              local ws = w * s
              sum_ws = sum_ws + ws
              sum_ws_sq = sum_ws_sq + ws * ws
            end
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
    end)
  return sum_ws, sum_ws_sq, row_count
end

redis.register_function('sbm_vega_bucket', function(keys, args)
  local risk_class = args[1]
  local bucket = args[2]
  if not risk_class or not bucket then
    return redis.error_reply('sbm_vega_bucket: requires (risk_class, bucket) args')
  end
  local book_set = _frtb_parse_csv_set(args[3])
  local trade_set = _frtb_parse_csv_set(args[4])
  local factor_set = _frtb_parse_csv_set(args[5])
  local tenors = __GIRR_TENORS__
  local t0 = redis.call('TIME')
  local sum_ws, sum_ws_sq, count = _vega_iter_bucket(risk_class, bucket, tenors, book_set, trade_set, factor_set)
  local rho = __GIRR_VEGA_RHO__
  local kb = _frtb_constant_rho_kb(sum_ws, sum_ws_sq, rho)
  local t1 = redis.call('TIME')
  local ms = (tonumber(t1[1]) - tonumber(t0[1])) * 1000.0
              + (tonumber(t1[2]) - tonumber(t0[2])) / 1000.0
  return cjson.encode({ K_b = kb, S_b = sum_ws, count = count, ms = ms })
end)

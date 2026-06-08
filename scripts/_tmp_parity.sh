#!/usr/bin/env bash
# Wave 5.83I — parity sweep across 6 live variants
set -u
URL="http://localhost:8080/calc/sbm"
echo "class,leg,lua_charge,fast_charge,delta_abs,lua_engine,fast_engine,lua_ms,fast_ms"
for cls in GIRR EQUITY FX; do
  for leg in delta vega; do
    lua=$(curl -s -X POST -H "content-type: application/json" \
      -d "{\"risk_class\":\"$cls\",\"sensitivity_type\":\"$leg\"}" \
      "$URL?force_path=lua&nocache=1")
    fast=$(curl -s -X POST -H "content-type: application/json" \
      -d "{\"risk_class\":\"$cls\",\"sensitivity_type\":\"$leg\"}" \
      "$URL?force_path=fast&nocache=1")
    lua_c=$(echo "$lua" | jq -r .charge)
    fast_c=$(echo "$fast" | jq -r .charge)
    lua_e=$(echo "$lua" | jq -r .engine)
    fast_e=$(echo "$fast" | jq -r .engine)
    lua_t=$(echo "$lua" | jq -r .total_ms)
    fast_t=$(echo "$fast" | jq -r .total_ms)
    delta=$(python3 -c "print(abs(float('$lua_c') - float('$fast_c')))")
    echo "$cls,$leg,$lua_c,$fast_c,$delta,$lua_e,$fast_e,$lua_t,$fast_t"
  done
done

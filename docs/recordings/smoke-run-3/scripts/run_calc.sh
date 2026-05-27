#!/bin/bash
# Wave 5.7 — 6 SBM variants against the live api on localhost:8080.
OUT=docs/recordings/smoke-run-3/calc-results.json
echo "[" > $OUT
FIRST=1
for rc in GIRR Equity FX; do
  for m in Delta Vega; do
    BODY=$(printf '{"risk_class":"%s","sensitivity_type":"%s"}' "$rc" "$m")
    RESP=$(curl -sS -o /tmp/calc_body -w '{"http":%{http_code},"time_total_s":%{time_total}}' \
      -X POST -H 'Content-Type: application/json' \
      -d "$BODY" http://localhost:8080/calc/sbm 2>&1)
    BODY_RESP=$(cat /tmp/calc_body | head -c 500 | sed 's/"/\\"/g')
    if [ $FIRST -eq 0 ]; then echo "," >> $OUT; fi
    FIRST=0
    printf '  {"risk_class":"%s","measure":"%s","timing":%s,"body":"%s"}' "$rc" "$m" "$RESP" "$BODY_RESP" >> $OUT
    echo "  → $rc $m: $RESP"
  done
done
echo "" >> $OUT; echo "]" >> $OUT

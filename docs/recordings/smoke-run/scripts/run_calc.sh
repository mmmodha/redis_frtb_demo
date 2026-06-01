#!/bin/bash
OUT=docs/recordings/smoke-run/calc-results.json
echo "[" > $OUT
FIRST=1
for rc in GIRR Equity FX; do
  for st in Delta Vega; do
    BODY=$(printf '{"risk_class":"%s","sensitivity_type":"%s"}' "$rc" "$st")
    RESP=$(curl -sS -o /tmp/calc_body -w '{"http":%{http_code},"time_total_s":%{time_total}}' -X POST -H 'Content-Type: application/json' -d "$BODY" http://localhost:8080/calc/sbm 2>&1)
    BODY_RESP=$(cat /tmp/calc_body | head -c 500 | sed 's/"/\\"/g')
    if [ $FIRST -eq 0 ]; then echo "," >> $OUT; fi
    FIRST=0
    printf '  {"risk_class":"%s","sensitivity_type":"%s","timing":%s,"body":"%s"}' "$rc" "$st" "$RESP" "$BODY_RESP" >> $OUT
    echo "  → $rc $st: $RESP"
  done
done
echo "" >> $OUT; echo "]" >> $OUT
echo "--- calc-results.json ---"
cat $OUT

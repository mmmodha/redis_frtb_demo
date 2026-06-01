#!/usr/bin/env bash
set -u
LOG=docs/recordings/smoke-run-15/logs/calc-6variants.log
RESULTS=docs/recordings/smoke-run-15/calc-results.json
: > "$LOG"
echo "[]" > "$RESULTS"
for rc in girr equity fx; do
  for m in delta vega; do
    echo "--- $rc $m ---" | tee -a "$LOG"
    START=$(python3 -c "import time;print(int(time.time()*1000))")
    RESP_FILE=$(mktemp)
    STATUS=$(curl -sS -o "$RESP_FILE" -w "%{http_code}" -X POST \
      -H "content-type: application/json" \
      -d "{\"risk_class\":\"$rc\",\"sensitivity_type\":\"$m\"}" \
      http://localhost:8080/calc/sbm)
    END=$(python3 -c "import time;print(int(time.time()*1000))")
    WC=$((END-START))
    BODY=$(cat "$RESP_FILE")
    echo "HTTP_STATUS=$STATUS WALLCLOCK_MS=$WC" | tee -a "$LOG"
    echo "$BODY" | tee -a "$LOG"
    echo "" | tee -a "$LOG"
    python3 - "$rc" "$m" "$STATUS" "$WC" "$RESP_FILE" <<'PY'
import json, sys
rc, m, status, wc, fp = sys.argv[1:6]
body_raw = open(fp).read()
try:
    body = json.loads(body_raw)
except Exception:
    body = body_raw
out_fp = 'docs/recordings/smoke-run-15/calc-results.json'
data = json.load(open(out_fp))
data.append({'risk_class': rc, 'sensitivity_type': m, 'status': int(status), 'wallclock_ms': int(wc), 'body': body})
json.dump(data, open(out_fp, 'w'), indent=2)
PY
    rm -f "$RESP_FILE"
  done
done
echo "--- summary ---"
python3 -c "
import json
d=json.load(open('docs/recordings/smoke-run-15/calc-results.json'))
for r in d:
    body=r['body']
    if isinstance(body, dict):
        charge=body.get('sbm_charge', body.get('charge','-'))
        per_b=len(body.get('per_bucket') or [])
        nonzero=sum(1 for pb in (body.get('per_bucket') or []) if (pb.get('count') or 0) > 0)
        print(f\"{r['risk_class']:7s} {r['sensitivity_type']:5s}  http={r['status']}  {r['wallclock_ms']}ms  charge={charge}  per_bucket={per_b}  nonzero_buckets={nonzero}\")
    else:
        print(f\"{r['risk_class']:7s} {r['sensitivity_type']:5s}  http={r['status']}  {r['wallclock_ms']}ms  body={body[:80]}\")
"

#!/usr/bin/env bash
set -u
OUT=docs/recordings/smoke-run-15/logs/image-staleness.txt
: > "$OUT"
{
  echo "=== Wave 5.15n smoke-run-15 — Image freshness check ==="
  echo
  echo "=== IN-TREE SOURCE: services/generator/src/row-generator.ts ==="
  grep -nE "SENSITIVITY_TYPES" services/generator/src/row-generator.ts
  echo
  echo "=== IN-TREE SOURCE: services/api/src/routes/calc.ts (Wave 5.15l UPPERCASE) ==="
  grep -nE "toUpperCase|risk_class_raw|const risk_class " services/api/src/routes/calc.ts | head -10
  echo
  echo "=== Pre-rebuild generator image (if any) ==="
  docker image inspect frtb-sbm-redis-pov-generator:latest \
    --format '{{.Created}} {{.Id}}' 2>/dev/null || echo "no pre-existing image"
  echo
  echo "=== Pre-rebuild api image (if any) ==="
  docker image inspect frtb-sbm-redis-pov-api:latest \
    --format '{{.Created}} {{.Id}}' 2>/dev/null || echo "no pre-existing image"
} | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== docker compose run --build --rm generator (rebuild + inspect compiled SENSITIVITY_TYPES) ===" | tee -a "$OUT"

docker compose run --build --rm --entrypoint sh generator \
  -c 'echo "--- dist/row-generator.js SENSITIVITY_TYPES ---"; grep -A2 "SENSITIVITY_TYPES" /app/dist/row-generator.js | head -20; echo "--- src/row-generator.ts SENSITIVITY_TYPES ---"; grep -n "SENSITIVITY_TYPES" /app/src/row-generator.ts || grep -nR "SENSITIVITY_TYPES" /app/services/generator/src/ 2>/dev/null | head -5' \
  2>&1 | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== api container — verify Wave 5.15l UPPERCASE fix in running image ===" | tee -a "$OUT"
docker compose exec -T api sh -c 'grep -nE "toUpperCase|risk_class_raw" /app/dist/routes/calc.js | head -10' 2>&1 | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== Post-rebuild image metadata ===" | tee -a "$OUT"
docker image inspect frtb-sbm-redis-pov-generator:latest \
  --format 'generator: {{.Created}} {{.Id}}' 2>&1 | tee -a "$OUT"
docker image inspect frtb-sbm-redis-pov-api:latest \
  --format 'api:       {{.Created}} {{.Id}}' 2>&1 | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== Reference smoke-run-13 api SHA captured in image-staleness.txt for diff ===" | tee -a "$OUT"

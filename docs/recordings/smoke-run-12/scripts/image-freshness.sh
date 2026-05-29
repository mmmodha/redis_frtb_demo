#!/usr/bin/env bash
set -u
OUT=docs/recordings/smoke-run-12/logs/image-staleness.txt
: > "$OUT"
{
  echo "=== Wave 5.15k smoke-run-12 — Image freshness check ==="
  echo
  echo "=== IN-TREE SOURCE: services/generator/src/row-generator.ts ==="
  grep -nE "SENSITIVITY_TYPES" services/generator/src/row-generator.ts
  echo
  echo "=== Pre-rebuild generator image (if any) ==="
  docker image inspect frtb-sbm-redis-pov-generator:latest \
    --format '{{.Created}} {{.Id}}' 2>/dev/null || echo "no pre-existing image"
} | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== docker compose run --build --rm generator (rebuild + inspect compiled SENSITIVITY_TYPES) ===" | tee -a "$OUT"

docker compose run --build --rm --entrypoint sh generator \
  -c 'echo "--- dist/row-generator.js SENSITIVITY_TYPES ---"; grep -A2 "SENSITIVITY_TYPES" /app/dist/row-generator.js | head -20; echo "--- src/row-generator.ts SENSITIVITY_TYPES ---"; grep -n "SENSITIVITY_TYPES" /app/src/row-generator.ts || grep -nR "SENSITIVITY_TYPES" /app/services/generator/src/ 2>/dev/null | head -5' \
  2>&1 | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== Post-rebuild image metadata ===" | tee -a "$OUT"
docker image inspect frtb-sbm-redis-pov-generator:latest \
  --format '{{.Created}} {{.Id}}' 2>&1 | tee -a "$OUT"

echo "" | tee -a "$OUT"
echo "=== Reference smoke-run-11 stale build was: 2026-05-27T12:20:58Z sha256:603b9523... ===" | tee -a "$OUT"

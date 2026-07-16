#!/usr/bin/env bash
# Wave 5.1 docker smoke test — proves the ui, calc, generator images build and
# run. The ui must serve the real React shell (not a healthz stub); calc must
# expose /healthz inside the container; generator must boot without the
# "Cannot find module" CrashLoopBackOff that current Wave 4.8 SUMMARY captured.
#
# This test is intentionally Redis-free: Wave 5.2 owns env wiring, so the
# generator is expected to exit cleanly on missing REDIS_URL/SCHEMA_FILE —
# what we assert here is that the entrypoint resolves and node executes it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PROJECT="frtb-sbm-wave51-smoke"
SERVICES=(ui calc generator)
FAILURES=()

log() { printf '[smoke] %s\n' "$*"; }
fail() { FAILURES+=("$1"); log "FAIL: $1"; }

cleanup() {
  log "tearing down compose project"
  docker compose -p "$PROJECT" down --remove-orphans --timeout 5 >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "step 1: docker compose build ${SERVICES[*]}"
BUILD_START=$(date +%s)
if ! docker compose -p "$PROJECT" build "${SERVICES[@]}"; then
  fail "docker compose build exited non-zero"
fi
BUILD_ELAPSED=$(( $(date +%s) - BUILD_START ))
log "step 1 took ${BUILD_ELAPSED}s"

log "step 2: image sizes"
for svc in "${SERVICES[@]}"; do
  IMG="${PROJECT}-${svc}"
  SIZE=$(docker image inspect "$IMG" --format '{{.Size}}' 2>/dev/null || echo "0")
  HUMAN=$(awk -v b="$SIZE" 'BEGIN{printf "%.1f MB", b/1024/1024}')
  log "  $svc: $HUMAN"
done

log "step 3: ensure TLS certs + docker compose up -d ${SERVICES[*]}"
bash scripts/ensure-tls-certs.sh
if ! docker compose -p "$PROJECT" up -d "${SERVICES[@]}"; then
  fail "docker compose up exited non-zero"
fi

log "step 4: wait up to 45s for ui + calc healthchecks"
DEADLINE=$(( $(date +%s) + 45 ))
UI_OK=0; CALC_OK=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  UI_STATE=$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-ui-1" 2>/dev/null || echo "missing")
  CALC_STATE=$(docker inspect -f '{{.State.Health.Status}}' "${PROJECT}-calc-1" 2>/dev/null || echo "missing")
  [ "$UI_STATE" = "healthy" ] && UI_OK=1
  [ "$CALC_STATE" = "healthy" ] && CALC_OK=1
  if [ "$UI_OK" = "1" ] && [ "$CALC_OK" = "1" ]; then break; fi
  sleep 2
done
log "  ui health: $UI_STATE"
log "  calc health: $CALC_STATE"
[ "$UI_OK" = "1" ] || fail "ui did not reach healthy within 45s (last: $UI_STATE)"
[ "$CALC_OK" = "1" ] || fail "calc did not reach healthy within 45s (last: $CALC_STATE)"

log "step 5: curl host :443 (TLS) — must return real React shell"
BODY=$(curl -fskS --max-time 5 https://localhost/ 2>&1 || echo "")
if printf '%s' "$BODY" | grep -q 'id="root"'; then
  log "  ui served React shell (found id=\"root\")"
else
  fail "ui did not serve React shell HTML (no id=\"root\" found)"
fi

log "step 6: generator must not be in CrashLoop with 'Cannot find module'"
GEN_LOGS=$(docker logs "${PROJECT}-generator-1" 2>&1 || echo "")
if printf '%s' "$GEN_LOGS" | grep -qi "cannot find module"; then
  fail "generator log shows 'Cannot find module' (entrypoint resolution broken)"
else
  log "  generator entrypoint resolved (no Cannot-find-module errors)"
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then
  log "SMOKE FAILED with ${#FAILURES[@]} failure(s):"
  for f in "${FAILURES[@]}"; do log "  - $f"; done
  exit 1
fi
log "SMOKE OK — build=${BUILD_ELAPSED}s, ui+calc healthy, generator entrypoint resolved"
exit 0

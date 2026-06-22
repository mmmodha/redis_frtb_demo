#!/usr/bin/env bash
# scripts/capture-shard-snapshot-loop.sh — Wave 7.0.6.5
#
# Wraps scripts/capture-shard-snapshot.sh (Wave 7.0.4.A) in a loop that fires
# every <interval-seconds> (default 300). The inner script already writes the
# envelope to the Redis key `ops:per-shard-snapshot`; this loop additionally
# saves a timestamped copy under SNAPSHOT_DIR (default /tmp/wave705C-snapshots)
# so post-run analysis has a per-interval audit trail.
#
# Logs one line per tick to stdout:
#   <UTC> · captured · masters=N · total_keys=X
# (masters / total_keys derived from the envelope's `extras` map; `?` when
# unavailable.)
#
# Usage:
#   nohup bash scripts/capture-shard-snapshot-loop.sh [interval-seconds] \
#     > /tmp/shard-snapshots.log 2>&1 &
#
# Env (passed through to inner): REDIS_URL, INDEX_NAME, SNAPSHOT_KEY.
#   SNAPSHOT_DIR — destination for timestamped JSON copies.
#
# Secrets policy: NEVER echo REDIS_URL or the password (matches inner script).

set -euo pipefail
set +x; set +v

INTERVAL="${1:-300}"
case "$INTERVAL" in
  ''|*[!0-9]*) echo "ERROR: interval-seconds must be a positive integer, got: $INTERVAL" >&2; exit 2 ;;
esac
if (( INTERVAL <= 0 )); then echo "ERROR: interval-seconds must be > 0" >&2; exit 2; fi

SNAPSHOT_DIR="${SNAPSHOT_DIR:-/tmp/wave705C-snapshots}"
SNAPSHOT_KEY="${SNAPSHOT_KEY:-ops:per-shard-snapshot}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INNER="${SCRIPT_DIR}/capture-shard-snapshot.sh"

if [[ ! -f "$INNER" ]]; then
  echo "ERROR: inner script not found: $INNER" >&2
  exit 1
fi
for tool in redis-cli jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool not on PATH: $tool" >&2
    exit 1
  fi
done
if [[ -z "${REDIS_URL:-}" ]]; then
  echo "ERROR: REDIS_URL must be set (no value is printed)." >&2
  exit 1
fi

mkdir -p "$SNAPSHOT_DIR"

# Mirror the URL parser from scripts/capture-shard-snapshot.sh so we can GET
# the envelope back without ever placing the password on argv.
_strip_scheme="${REDIS_URL#*://}"
REDIS_PASSWORD=""
if [[ "$_strip_scheme" == *@* ]]; then
  _auth_part="${_strip_scheme%%@*}"
  if [[ "$_auth_part" == *:* ]]; then REDIS_PASSWORD="${_auth_part#*:}"; else REDIS_PASSWORD="$_auth_part"; fi
fi
_after_at="${_strip_scheme##*@}"
REDIS_HOST="${_after_at%%:*}"
REDIS_PORT_AND_PATH="${_after_at#*:}"
REDIS_PORT="${REDIS_PORT_AND_PATH%%/*}"
unset _strip_scheme _auth_part _after_at REDIS_PORT_AND_PATH
export REDISCLI_AUTH="$REDIS_PASSWORD"

RUNNING=1
trap 'RUNNING=0; echo "$(date -u +%FT%TZ) · shutdown requested" >&2' INT TERM

while (( RUNNING )); do
  TS_FILE="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  OUT="${SNAPSHOT_DIR}/snapshot-${TS_FILE}.json"

  if INNER_ERR="$("$INNER" 2>&1 >/dev/null)"; then
    # Read the envelope back so we can both archive it and derive log fields.
    ENVELOPE="$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --no-raw GET "$SNAPSHOT_KEY" 2>/dev/null || true)"
    MASTERS="?"
    TOTAL_KEYS="?"
    if [[ -n "$ENVELOPE" ]]; then
      printf '%s\n' "$ENVELOPE" > "$OUT"
      MASTERS="$(printf '%s' "$ENVELOPE" | jq -r '.extras | length' 2>/dev/null || echo "?")"
      TOTAL_KEYS="$(printf '%s' "$ENVELOPE" | jq -r '[.extras[].key_count // 0] | add // 0' 2>/dev/null || echo "?")"
    fi
    printf '%s · captured · masters=%s · total_keys=%s\n' "$(date -u +%FT%TZ)" "$MASTERS" "$TOTAL_KEYS"
  else
    # Inner script writes its own error context to stderr (already captured).
    printf '%s · capture-failed · %s\n' "$(date -u +%FT%TZ)" "$INNER_ERR" >&2
  fi

  # Interruptible sleep — break out of the loop within ~1s of SIGINT/SIGTERM.
  REMAINING="$INTERVAL"
  while (( RUNNING && REMAINING > 0 )); do
    sleep 1
    REMAINING=$(( REMAINING - 1 ))
  done
done

echo "$(date -u +%FT%TZ) · loop exited" >&2

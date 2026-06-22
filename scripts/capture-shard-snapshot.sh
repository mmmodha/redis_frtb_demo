#!/usr/bin/env bash
# scripts/capture-shard-snapshot.sh
#
# Wave 7.0.4.A — Capture per-shard observability data from a Redis Enterprise
# cluster node and write a snapshot JSON envelope to the Redis key
# `ops:per-shard-snapshot`. The API service reads that key from
# GET /observability/per-shard; the snapshot must be refreshed every <30s
# (PER_SHARD_STALENESS_MS in services/api/src/routes/observability.ts) or the
# endpoint falls back to a degraded aggregated row.
#
# Run this script ON A CLUSTER NODE that has `rladmin` + `redis-cli` + `jq`
# available. The API service NEVER SSHes into the cluster — credentials live
# only on the cluster node (typically driven by a cron job or a small loop).
#
# Captured fields (per master shard):
#   shard_id, role, memory_used, key_count, write_ops_per_sec, index_lag
#
# Envelope shape (consumed by observability.ts):
#   { captured_at: "<ISO>", shards_raw: "<rladmin info shards text>",
#     extras: { "<shard_id>": { key_count, write_ops_per_sec, index_lag } } }
#
# Usage:
#   REDIS_URL='redis://:<pass>@<host>:<port>' \
#     scripts/capture-shard-snapshot.sh
#   scripts/capture-shard-snapshot.sh --help
#
# Hard secrets-safety (mirrors scripts/diagnose-cluster.sh):
#   1. NEVER print $REDIS_URL or any password to stdout/stderr.
#   2. NEVER enable shell tracing (set -x / set -v).
#   3. Pass auth via REDISCLI_AUTH env var, not on argv.

set -euo pipefail
set +x; set +v

INDEX_NAME="${INDEX_NAME:-idx:sens}"
SNAPSHOT_KEY="${SNAPSHOT_KEY:-ops:per-shard-snapshot}"

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ---- Required tools ---------------------------------------------------------
for tool in rladmin redis-cli jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool not on PATH: $tool" >&2
    exit 1
  fi
done

# ---- REDIS_URL --------------------------------------------------------------
if [[ -z "${REDIS_URL:-}" ]]; then
  echo "ERROR: REDIS_URL must be set (no value is printed)." >&2
  exit 1
fi

# Extract password without ever placing it on argv. Mirrors the parser used
# in scripts/diagnose-cluster.sh.
_strip_scheme="${REDIS_URL#*://}"
REDIS_PASSWORD=""
if [[ "$_strip_scheme" == *@* ]]; then
  _auth_part="${_strip_scheme%%@*}"
  if [[ "$_auth_part" == *:* ]]; then
    REDIS_PASSWORD="${_auth_part#*:}"
  else
    REDIS_PASSWORD="$_auth_part"
  fi
fi
_after_at="${_strip_scheme##*@}"
REDIS_HOST="${_after_at%%:*}"
REDIS_PORT_AND_PATH="${_after_at#*:}"
REDIS_PORT="${REDIS_PORT_AND_PATH%%/*}"
unset _strip_scheme _auth_part _after_at REDIS_PORT_AND_PATH
export REDISCLI_AUTH="$REDIS_PASSWORD"

# ---- Capture rladmin output -------------------------------------------------
SHARDS_RAW="$(rladmin info shards 2>&1)"
if [[ -z "$SHARDS_RAW" ]]; then
  echo "ERROR: \`rladmin info shards\` produced no output." >&2
  exit 1
fi

# ---- Per-shard extras (key_count, write_ops_per_sec, index_lag) ------------
# rladmin's shard table doesn't expose ops/sec or per-shard key counts; we
# fetch them via `rladmin info shard <id>` (which surfaces the bound port)
# and a `redis-cli` round-trip per master. Slaves are skipped.
EXTRAS_JSON='{}'

# Extract master shard IDs from the table. `rladmin info shards` uses a
# stable column order: SHARD:ID is column 1, ROLE is column 3.
MASTER_IDS=$(echo "$SHARDS_RAW" \
  | awk 'NR==1 || /^SHARD:ID/ { next } $3 == "master" { print $1 }' \
  | grep -E '^redis:[0-9]+$' || true)

for SID in $MASTER_IDS; do
  # `rladmin info shard <id>` prints "port: <n>" among other lines.
  SHARD_INFO="$(rladmin info shard "$SID" 2>/dev/null || true)"
  PORT="$(echo "$SHARD_INFO" | awk -F: '/^[[:space:]]*port[[:space:]]*:/ { gsub(/[^0-9]/, "", $2); print $2; exit }')"
  if [[ -z "$PORT" ]]; then
    # No port discoverable — skip; the endpoint surfaces missing extras as null.
    continue
  fi

  STATS_OUT="$(redis-cli -h 127.0.0.1 -p "$PORT" --no-raw INFO stats 2>/dev/null || true)"
  WRITE_OPS="$(echo "$STATS_OUT" | awk -F: '/^instantaneous_ops_per_sec:/ { gsub(/[[:cntrl:]]/, "", $2); print $2; exit }')"
  WRITE_OPS="${WRITE_OPS:-0}"

  KEY_COUNT="$(redis-cli -h 127.0.0.1 -p "$PORT" DBSIZE 2>/dev/null || echo 0)"
  KEY_COUNT="${KEY_COUNT:-0}"

  # index_lag := dbsize - FT.INFO num_docs (proxy for keys not yet indexed).
  # FT.INFO is a flat array of alternating field/value; awk picks num_docs.
  FT_INFO="$(redis-cli -h 127.0.0.1 -p "$PORT" FT.INFO "$INDEX_NAME" 2>/dev/null || true)"
  NUM_DOCS="$(echo "$FT_INFO" \
    | awk 'BEGIN { f=0 } /^num_docs$/ { f=1; next } f { gsub(/[^0-9]/, "", $0); print; exit }')"
  NUM_DOCS="${NUM_DOCS:-0}"
  INDEX_LAG=$(( KEY_COUNT - NUM_DOCS ))
  [[ $INDEX_LAG -lt 0 ]] && INDEX_LAG=0

  EXTRAS_JSON="$(jq -nc \
    --argjson cur "$EXTRAS_JSON" \
    --arg sid "$SID" \
    --argjson kc "$KEY_COUNT" \
    --argjson wo "$WRITE_OPS" \
    --argjson il "$INDEX_LAG" \
    '$cur + { ($sid): { key_count: $kc, write_ops_per_sec: $wo, index_lag: $il } }')"
done

# ---- Assemble envelope + SET ------------------------------------------------
CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ENVELOPE_JSON="$(jq -nc \
  --arg captured_at "$CAPTURED_AT" \
  --arg shards_raw  "$SHARDS_RAW" \
  --argjson extras  "$EXTRAS_JSON" \
  '{captured_at: $captured_at, shards_raw: $shards_raw, extras: $extras}')"

# SET via stdin so the envelope JSON never appears on argv.
SET_RESULT="$(printf 'SET %s %s\n' "$SNAPSHOT_KEY" "$ENVELOPE_JSON" \
  | redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" 2>&1)"
if [[ "$SET_RESULT" != "OK" ]]; then
  echo "ERROR: SET $SNAPSHOT_KEY failed: $SET_RESULT" >&2
  exit 1
fi

echo "captured_at=$CAPTURED_AT key=$SNAPSHOT_KEY shards_seen=$(echo "$EXTRAS_JSON" | jq 'length')"

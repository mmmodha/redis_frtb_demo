#!/usr/bin/env bash
# scripts/smoke-reset-cluster.sh
#
# Wave 5.8.3 — Drain the remote Redis cluster between smoke runs so the
# generator starts each run against an empty key-space. The Wave 5.7 smoke
# discovered that `docker compose down -v` only flushes LOCAL volumes; the
# remote Redis Enterprise cluster kept ~455k rows / 1.43GB from the prior
# run, OOM-killing the generator on its first XADD.
#
# Strategy: FLUSHALL on every master shard. We pick FLUSHALL (vs. scoped
# DEL idx:sens / DEL sensitivities:in / DEL sens:* via SCAN) because the
# OOM symptom comes from key COUNT in the millions, and SCAN-then-DEL would
# itself take longer than the smoke window we are trying to recover.
# Operators who want a scoped reset should run those commands by hand.
#
# Hard secrets-safety rules (Wave 5.8 spec):
#   1. NEVER print $REDIS_URL or any password to stdout/stderr.
#   2. NEVER enable shell tracing (`set -x` / `set -v`).
#   3. Pass auth via REDISCLI_AUTH env var, never as `-a <pw>` argv.
#   4. Final leak-guard greps captured output for $REDIS_URL and aborts
#      non-zero if it ever appears.
#
# Usage:
#   scripts/smoke-reset-cluster.sh --yes        # destructive, non-interactive
#   scripts/smoke-reset-cluster.sh              # destructive, prompts y/N
#   scripts/smoke-reset-cluster.sh --self-test  # leak-check, no destructive ops
#   scripts/smoke-reset-cluster.sh --help

set -euo pipefail
# Explicitly disable tracing in case the parent shell exported it.
set +x
set +v

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.local"

YES=0
SELF_TEST=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --self-test) SELF_TEST=1 ;;
    --help|-h)
      sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Try --help" >&2
      exit 2
      ;;
  esac
done

# -- Load REDIS_URL from .env.local without ever printing it ------------------
if [[ -z "${REDIS_URL:-}" && -f "$ENV_FILE" ]]; then
  # Pull only the last REDIS_URL= line; strip optional surrounding quotes.
  _line="$(grep -E '^REDIS_URL=' "$ENV_FILE" | tail -n1 || true)"
  if [[ -n "$_line" ]]; then
    _val="${_line#REDIS_URL=}"
    _val="${_val%\"}"; _val="${_val#\"}"
    _val="${_val%\'}"; _val="${_val#\'}"
    REDIS_URL="$_val"
  fi
  unset _line _val
fi

if [[ -z "${REDIS_URL:-}" ]]; then
  echo "ERROR: REDIS_URL is unset (checked env and ${ENV_FILE#${REPO_ROOT}/})." >&2
  exit 1
fi
export REDIS_URL

# Extract password from REDIS_URL into REDISCLI_AUTH so it never appears in
# argv (and thus never in `ps`). Best-effort parse of redis[s]://[user:pw]@host
_strip_scheme="${REDIS_URL#*://}"
if [[ "$_strip_scheme" == *@* ]]; then
  _auth_part="${_strip_scheme%%@*}"
  if [[ "$_auth_part" == *:* ]]; then
    REDISCLI_AUTH="${_auth_part#*:}"
  else
    REDISCLI_AUTH="$_auth_part"
  fi
  export REDISCLI_AUTH
fi
unset _strip_scheme _auth_part

# -- Self-test mode: prove the script never leaks $REDIS_URL ------------------
if [[ "$SELF_TEST" -eq 1 ]]; then
  _tmp="$(mktemp)"
  {
    echo "[smoke-reset] self-test: REDIS_URL loaded from .env.local (value redacted)"
    echo "[smoke-reset] self-test: would flush master shards here"
    echo "[smoke-reset] self-test: XLEN / used_memory_human reporting redacted"
  } > "$_tmp" 2>&1
  if grep -F -q -- "$REDIS_URL" "$_tmp"; then
    echo "FAIL: REDIS_URL leaked to self-test output." >&2
    rm -f "$_tmp"
    exit 1
  fi
  if [[ -n "${REDISCLI_AUTH:-}" ]] && grep -F -q -- "$REDISCLI_AUTH" "$_tmp"; then
    echo "FAIL: REDISCLI_AUTH leaked to self-test output." >&2
    rm -f "$_tmp"
    exit 1
  fi
  rm -f "$_tmp"
  echo "OK: self-test passed (no REDIS_URL / REDISCLI_AUTH leak)"
  exit 0
fi

# -- Confirmation gate --------------------------------------------------------
if [[ "$YES" -ne 1 ]]; then
  if [[ ! -t 0 ]]; then
    echo "ERROR: refusing destructive op without --yes (stdin is not a TTY)." >&2
    exit 1
  fi
  echo "About to FLUSHALL every master shard of the remote Redis cluster."
  echo "This is destructive and cannot be undone."
  read -r -p "Type 'y' to proceed: " _reply || _reply=""
  if [[ "$_reply" != "y" && "$_reply" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# -- Destructive flow, captured for the leak guard ----------------------------
OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT

# url-cli: redis-cli using the proxy/url endpoint (cluster-aware)
url_cli() { redis-cli -u "$REDIS_URL" -c "$@"; }
# shard-cli: redis-cli at a specific host:port, auth via env var
shard_cli() { local h="$1" p="$2"; shift 2; redis-cli -h "$h" -p "$p" "$@"; }

shard_mem_human() {
  local h="$1" p="$2"
  shard_cli "$h" "$p" INFO memory 2>/dev/null \
    | awk -F: '/^used_memory_human:/ {gsub(/\r/,"",$2); print $2; exit}'
}

url_mem_human() {
  url_cli INFO memory 2>/dev/null \
    | awk -F: '/^used_memory_human:/ {gsub(/\r/,"",$2); print $2; exit}'
}

discover_masters() {
  local nodes
  nodes="$(url_cli CLUSTER NODES 2>/dev/null || true)"
  [[ -z "$nodes" ]] && return 0
  printf '%s\n' "$nodes" | awk '
    {
      flags = $3
      addr  = $2
      sub(/@.*/, "", addr)
      if (index(flags, "master") > 0 && index(flags, "fail") == 0 && addr != "")
        print addr
    }
  '
}

run_reset() {
  echo "[smoke-reset] querying cluster topology"
  MASTERS=()
  while IFS= read -r _addr; do
    [[ -n "$_addr" ]] && MASTERS+=("$_addr")
  done < <(discover_masters || true)

  local xlen_before xlen_after
  xlen_before="$(url_cli XLEN sensitivities:in 2>/dev/null || echo 'n/a')"
  echo "[smoke-reset] XLEN sensitivities:in before: ${xlen_before}"

  if [[ ${#MASTERS[@]} -eq 0 ]]; then
    echo "[smoke-reset] CLUSTER NODES returned no masters; treating endpoint as standalone/proxied"
    echo "[smoke-reset] used_memory_human before: $(url_mem_human || echo '?')"
    echo "[smoke-reset] running FLUSHALL via URL endpoint"
    url_cli FLUSHALL >/dev/null
    echo "[smoke-reset] used_memory_human after:  $(url_mem_human || echo '?')"
  else
    echo "[smoke-reset] discovered ${#MASTERS[@]} master shard(s)"

    echo "[smoke-reset] used_memory_human (before):"
    local m host port mem
    for m in "${MASTERS[@]}"; do
      host="${m%:*}"; port="${m##*:}"
      mem="$(shard_mem_human "$host" "$port" || echo '?')"
      echo "  shard@${port}: ${mem:-?}"
    done

    echo "[smoke-reset] running FLUSHALL on each master"
    local failed=0
    for m in "${MASTERS[@]}"; do
      host="${m%:*}"; port="${m##*:}"
      if shard_cli "$host" "$port" FLUSHALL >/dev/null 2>&1; then
        echo "  shard@${port}: OK"
      else
        echo "  shard@${port}: direct FLUSHALL failed (will fall back to URL endpoint)"
        failed=1
      fi
    done

    if [[ $failed -eq 1 ]]; then
      echo "[smoke-reset] one or more direct shard flushes failed; issuing FLUSHALL via URL endpoint"
      url_cli FLUSHALL >/dev/null
    fi

    echo "[smoke-reset] used_memory_human (after):"
    for m in "${MASTERS[@]}"; do
      host="${m%:*}"; port="${m##*:}"
      mem="$(shard_mem_human "$host" "$port" || echo '?')"
      echo "  shard@${port}: ${mem:-?}"
    done
  fi

  xlen_after="$(url_cli XLEN sensitivities:in 2>/dev/null || echo 'n/a')"
  echo "[smoke-reset] XLEN sensitivities:in after:  ${xlen_after}"

  if [[ "$xlen_after" != "0" && "$xlen_after" != "n/a" ]]; then
    echo "[smoke-reset] WARNING: stream sensitivities:in is not empty after flush (${xlen_after})" >&2
    return 1
  fi
  echo "[smoke-reset] done"
}

# Run the reset, capture every line for the leak guard.
set +e
run_reset 2>&1 | tee "$OUTPUT_FILE"
EXIT_CODE=${PIPESTATUS[0]}
set -e

# -- Leak guard: nothing we printed may contain $REDIS_URL or password --------
if grep -F -q -- "$REDIS_URL" "$OUTPUT_FILE"; then
  echo "FATAL: REDIS_URL leaked in script output; aborting." >&2
  exit 99
fi
if [[ -n "${REDISCLI_AUTH:-}" ]] && grep -F -q -- "$REDISCLI_AUTH" "$OUTPUT_FILE"; then
  echo "FATAL: cluster password leaked in script output; aborting." >&2
  exit 99
fi

exit "$EXIT_CODE"

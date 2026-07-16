#!/usr/bin/env bash
# Primary deployment entrypoint — Docker Compose (Wave 7.0.8+).
#
# Usage:
#   scripts/docker-up.sh              # default: 4 bulk-loader replicas
#   scripts/docker-up.sh --dev        # single bulk-loader (laptop / dev-redis)
#   scripts/docker-up.sh --scale 400m # 400M-row ingest profile (8 replicas)
#   scripts/docker-up.sh --build      # force image rebuild
#
# Requires Docker Engine 24+ and Compose v2. Redis is NOT started by this
# stack — configure Redis via the UI Connections panel after boot (REDIS_URL
# in .env.local is an optional bootstrap shortcut only).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_LOCAL="${REPO_ROOT}/.env.local"
COMPOSE=(docker compose -f "${REPO_ROOT}/docker-compose.yml")

SCALE_BULK_LOADER="${SCALE_BULK_LOADER:-4}"
FORCE_BUILD=0
PROFILE="default"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)
      SCALE_BULK_LOADER=1
      PROFILE="dev"
      shift
      ;;
    --scale)
      shift
      case "${1:-}" in
        400m|400M)
          SCALE_BULK_LOADER=8
          export BULK_LOADER_POOL_SIZE="${BULK_LOADER_POOL_SIZE:-16}"
          export BULK_LOADER_BATCH_SIZE="${BULK_LOADER_BATCH_SIZE:-2000}"
          export RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC="${RUNTIME_REDIS_POOL_SIZE_HEAVY_CALC:-8}"
          PROFILE="400m"
          ;;
        *)
          echo "Unknown scale profile: ${1:-}" >&2
          echo "Supported: 400m" >&2
          exit 1
          ;;
      esac
      shift
      ;;
    --build)
      FORCE_BUILD=1
      shift
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

ensure_env_local() {
  if [[ -f "${ENV_LOCAL}" ]]; then
    return 0
  fi
  echo "Creating minimal ${ENV_LOCAL} with generated secrets…"
  local conn_key token
  conn_key="$(openssl rand -hex 32 2>/dev/null || echo "dev-only-change-in-prod")"
  token="$(openssl rand -hex 16 2>/dev/null || echo "dev-internal-token")"
  cat > "${ENV_LOCAL}" <<EOF
# Auto-created by scripts/docker-up.sh — edit as needed.
CONN_STORE_KEY=${conn_key}
INTERNAL_API_TOKEN=${token}
# REDIS_URL=redis://localhost:6379
EOF
  echo "  → Configure Redis via https://localhost/connections (REDIS_URL optional)."
}

cd "${REPO_ROOT}"
ensure_env_local
bash "${REPO_ROOT}/scripts/ensure-tls-certs.sh"

echo "Starting FRTB stack (profile=${PROFILE}, bulk-loader replicas=${SCALE_BULK_LOADER})…"
UP_ARGS=(-d --wait --scale "bulk-loader=${SCALE_BULK_LOADER}")
[[ "${FORCE_BUILD}" == "1" ]] && UP_ARGS=(--build "${UP_ARGS[@]}")
"${COMPOSE[@]}" up "${UP_ARGS[@]}"

echo ""
echo "Stack healthy. Open https://localhost → Connections → Set active Redis target."
echo "  (Self-signed cert by default — accept the browser warning, or replace certs/.)"
echo "Bulk ingest: Ingest panel → Start preset (uses api → bulk-loader × ${SCALE_BULK_LOADER})."
if [[ "${PROFILE}" == "400m" ]]; then
  echo ""
  echo "400M profile active. After load completes, run post-load finalisation:"
  echo "  node --env-file=.env.local scripts/finalise-rollups.mjs"
  echo "  node --env-file=.env.local scripts/finalise-seen-sets.mjs"
  echo "See docs/docker-deploy.md for the full 400M playbook."
fi

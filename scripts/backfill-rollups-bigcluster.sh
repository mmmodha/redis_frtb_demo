#!/usr/bin/env bash
# Wave 6.30.B5 — one-shot wrapper to invoke services/ingest/src/backfill-rollups.ts
# against a remote Redis target (typically bigcluster) without modifying the
# module itself. Idempotent — HSET overwrites with the same fields, so re-runs
# on the same corpus are no-ops.
#
# Usage:
#   REDIS_URL="redis://host:port" scripts/backfill-rollups-bigcluster.sh [logfile]
#
# Emits the single JSON report line to stdout AND to the optional logfile.
set -euo pipefail

if [[ -z "${REDIS_URL:-}" ]]; then
  echo "REDIS_URL is required" >&2
  exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG="${1:-.run/logs/backfill-rollups.log}"
mkdir -p "$(dirname "$LOG")"

# tsx is a dev-dep of @frtb/ingest; node --import tsx loads the module's TS.
exec node --import tsx services/ingest/src/backfill-rollups.ts 2>&1 | tee -a "$LOG"

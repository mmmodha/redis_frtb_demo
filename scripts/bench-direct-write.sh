#!/usr/bin/env bash
# Wave 6.39.A — direct-write benchmark harness.
#
# Runs the generator against the operator's local redis-stack-server with
# GENERATOR_MODE=direct + DISTRIBUTION=uniform and measures wall time.
# Target per DoD: 100M rows in <20 min on a single redis-stack node.
#
# Defaults are tuned for a 16-core local box; override via env:
#   ROWS, WORKERS, BATCH, REDIS_URL, SCHEMA_FILE, STORAGE_FORMAT, DISTRIBUTION
#
# Example:
#   REDIS_URL=redis://127.0.0.1:6379 SCHEMA_FILE=config/schema/frtb-default.yaml \
#     ROWS=100000000 WORKERS=8 bash scripts/bench-direct-write.sh

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

: "${ROWS:=100000000}"
: "${WORKERS:=8}"
: "${BATCH:=2000}"
: "${REDIS_URL:?REDIS_URL must be set (e.g. redis://127.0.0.1:6379)}"
: "${SCHEMA_FILE:?SCHEMA_FILE must be set (e.g. config/schema/frtb-default.yaml)}"
: "${STORAGE_FORMAT:=hash-sidetable}"
: "${DISTRIBUTION:=uniform}"

echo "bench-direct-write — rows=$ROWS workers=$WORKERS batch=$BATCH"
echo "                     storage=$STORAGE_FORMAT distribution=$DISTRIBUTION"
echo "                     redis=$REDIS_URL schema=$SCHEMA_FILE"
echo

cd services/generator
GENERATOR_MODE=direct \
DISTRIBUTION="$DISTRIBUTION" \
STORAGE_FORMAT="$STORAGE_FORMAT" \
SCHEMA_FILE="$SCHEMA_FILE" \
REDIS_URL="$REDIS_URL" \
time npx tsx src/cli.ts \
  --rows "$ROWS" \
  --workers "$WORKERS" \
  --batch-size "$BATCH" \
  --profile auto

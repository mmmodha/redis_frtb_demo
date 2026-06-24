#!/bin/sh
# Idle by default under `docker compose up` (keeps the container healthy).
# `docker compose run --rm generator --rows N …` forwards CLI flags.
set -e
if [ "$#" -eq 0 ]; then
  exec sleep infinity
fi
exec npx tsx src/cli.ts "$@"

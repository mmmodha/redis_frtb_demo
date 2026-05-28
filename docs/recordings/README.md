# Recordings

This directory holds the recorded demo assets for the HSBC walkthrough.

## Deliverables

- `dry-run-15min.mp4` — full 15-min recorded walkthrough. **Recorded after Wave 4.1 (Equity+FX calc), 4.2 (loadgen), and 4.6 (observability + CI hardening) are GREEN**, so steps 8, 9, and 10 demo cleanly. Owned by Task 4.4. See [../demo-script.md](../demo-script.md) for the 11-step storyboard.
- `scale-pivot.mp4` — short clip of just step 10 (the climax), used as a fallback when the live `scale-cluster` is unreachable.
- `ingest-burst.mp4` — short clip of step 3, used as a fallback if the live throughput chart stalls.
- `screenshots/step-*.png` — auto-captured per-step screenshots produced by [`../../e2e/full-demo.spec.ts`](../../e2e/full-demo.spec.ts) on every CI run. These double as the asset-pack source images.

## How to record

1. Confirm Waves 4.1 / 4.2 / 4.6 are GREEN per the spec's Wave 4 status.
2. Walk the [presenter checklist](../presenter-checklist.md) end-to-end with a clean stack.
3. Run the full 11-step flow once at presentation pace (target ≤15 min).
4. Capture with Loom or QuickTime at 1440×900 viewport, mic on, second monitor disabled.
5. Save to `dry-run-15min.mp4`, no trimming heavier than splash/outro.

## Running the e2e spec — mocks vs. live

The 11-step spec (`e2e/full-demo.spec.ts`) has two modes, gated by the `INTEGRATION` env var:

- **Mocks mode (default, fast, CI)** — every API call is intercepted by `installCommonRoutes(page)` so the spec runs against the Vite dev server with no backend.

      npx playwright test --config e2e/playwright.config.ts e2e/full-demo.spec.ts

- **Live mode (Wave 5.5 smoke)** — mocks are bypassed and the spec hits the real `ui` container at `http://localhost:3000`, which in turn talks to the live `api` / `calc` / `generator` services and Redis Enterprise.

      npm run test:e2e:live

  ⚠️ **Live mode requires** a populated `.env.local` at repo root (Redis Cloud creds + active connection profile) **and** the full stack already running. Bring it up with plain `docker compose up -d --wait` — every Redis-touching service has `env_file: .env.local` declared, so Compose loads it automatically; **do not** pass `--env-file`. Playwright will **not** start the dev server in this mode; it expects the ui container on port 3000.

Override the live base URL with `UI_BASE_URL=http://… npm run test:e2e:live` if the ui is exposed elsewhere.

### Seed connection prerequisite

The live e2e asserts `getByText('demo-cluster')` (and `scale-cluster`) on the Connections panel at Step 2a. These profiles are auto-created on api boot by `seedConnections()`, which reads `SEED_CONNECTIONS_FILE` — wired in `docker-compose.yml` to bind-mount `services/api/fixtures/seed-connections.json` at `/app/fixtures/seed-connections.json` on the api container. No manual UI step is needed; `docker compose up -d --wait` is sufficient.

### Before-run reset (Wave 5.8.3)

The remote Redis Enterprise cluster is **not** wiped by `docker compose down -v`, which only drops local volumes. If a previous smoke run left ~455k rows in `sensitivities:in`, the generator will OOM on its first XADD. Before any smoke run against a non-empty remote cluster, run:

      scripts/smoke-reset-cluster.sh --yes

The script reads `REDIS_URL` from `.env.local`, walks every master via `CLUSTER NODES`, runs `FLUSHALL` on each shard, and asserts `XLEN sensitivities:in == 0` on the way out. Without `--yes` it prompts interactively or exits non-zero if stdin is not a TTY. The script never echoes `REDIS_URL` or cluster credentials — it self-checks via a final leak-guard grep. Run `scripts/smoke-reset-cluster.sh --self-test` to verify the leak guard offline.

## Pre-flight (mandatory before every smoke run — Wave 5.14b.1)

The Wave 5.14a diagnostic ([smoke-run-6/diagnostic.md](smoke-run-6/diagnostic.md)) named two latent failure modes that survive `docker compose down -v`: (a) OOM inheritance from a non-empty remote cluster, and (b) an **orphaned RediSearch index** left over from a previous boot that made the next `FT.CREATE idx:sens` return `Index already exists` and silently abort `bootstrapFrtb()` — the api then answered `/healthz` 200 with no idx behind it. Step 0.5 below closes both reproducers, and Wave 5.14b.1 also gates `/healthz` on bootstrap success (api returns 503 until `bootstrapFrtb()` resolves cleanly).

| Step | Command | Why |
|------|---------|-----|
| 0    | `docker compose down -v` | Drop local volumes. |
| **0.5** | **`scripts/smoke-reset-cluster.sh --yes`** | **Mandatory.** FLUSHALL every master shard, then `FT._LIST`-assert each master has 0 indexes. Closes the orphaned-index reproducer surfaced by Wave 5.14a; also prevents OOM inheritance. |
| 1    | `docker compose up -d --wait` | Compose only marks `api` healthy once `/healthz` is 200 — i.e. only after `bootstrapFrtb()` has actually created idx:sens + loaded the Functions library. A bootstrap failure now correctly cascades through every dependent service's healthcheck. |

Skipping step 0.5 reproduces the Wave 5.14a failure mode and is **not** an optional optimisation — the orphaned-index path is silent and only surfaces three steps later as `SEARCH_INDEX_NOT_FOUND` on the first `/calc/sbm` call.



## Why MP4s are not in git

Large binary assets — track via Git LFS or cloud storage. Add the link to `docs/asset-pack/README.md` when the recording lands.

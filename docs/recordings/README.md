# Recordings

This directory holds the recorded demo assets for the bank walkthrough.

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
| 1    | `docker compose up -d --build --wait` | **Wave 5.15h:** `--build` is mandatory. Compose only marks `api` healthy once `/healthz` is 200 — i.e. only after `bootstrapFrtb()` has actually created idx:sens + loaded the Functions library. A bootstrap failure now correctly cascades through every dependent service's healthcheck. **Wave 5.15d.2:** the `generator` service is now in the `tools` profile, so this command brings up `ui`, `api`, `source`, `ingest`, `calc`, `loadgen` (6 services) and **does not** start the generator. `docker compose ps` will not list generator at all until it is explicitly invoked at step 4. |

Skipping step 0.5 reproduces the Wave 5.14a failure mode and is **not** an optional optimisation — the orphaned-index path is silent and only surfaces three steps later as `SEARCH_INDEX_NOT_FOUND` on the first `/calc/sbm` call.

**Always rebuild service images before a smoke run.** Compose otherwise reuses cached layers and any `.ts` / `.py` / `.lua` source change that does not also touch a `Dockerfile` will not propagate to the running container. See Wave 5.15g (smoke-run-10) for the reference failure mode: the Wave 5.15f case-mismatch fix to `services/generator/src/row-generator.ts` landed in git but never reached the running container because step 1 of this runbook used `docker compose up -d --wait` (no `--build`), so Compose reused a generator image built 34 h before the fix and the smoke run RED-ed with `sbm_charge=0` across every variant.

### Step 4 — generator invocation (unchanged contract)

The generator is the only ingest trigger, invoked explicitly (per the Wave 5.14b.2 ENTRYPOINT contract):

      docker compose run --build --rm generator --rows <N> --classes <X,Y>

Because `generator` is in the `tools` profile (Wave 5.15d.2), `compose run` auto-activates the profile for the named service — no `--profile tools` flag is needed. Dependencies (`api`) are auto-started if not already healthy; in the normal smoke flow they were brought up at step 1. Rows are no longer pumped behind the runbook by an autostart container, so the smoke-tuned `--rows` value is the only ingest pressure on the 2 GB cluster.

**Wave 5.15n smoke-tuned default:** `--rows 200000 --classes GIRR,EQUITY,FX`.

      docker compose run --build --rm generator --rows 200000 --classes GIRR,EQUITY,FX

Rationale: smoke-run-13 ([SUMMARY](smoke-run-13/SUMMARY.md)) recorded a peak of **738.30 M** per shard at `--rows 300000`, crossing each shard's 700 M `maxmemory` ceiling and triggering `volatile-lru` eviction of shard A's entire `sens:*` cohort (post-ingest distribution: shard A = 0 keys, shard B = 115,796 keys — see [smoke-run-13/logs/per-shard-data-distribution.json](smoke-run-13/logs/per-shard-data-distribution.json)). At the smoke-run-13 738 M / 300 k ratio, `--rows 200000` projects to ≈ **492 M** peak per shard — ~33 % headroom under the 700 M ceiling — so both shards should retain their `sens:*` cohort and the multi-shard `FCALL` fan-out is exercised end-to-end. If the post-step-6 density gate still shows a single-shard distribution, drop to `--rows 150000` and re-run; do not raise rows mid-run.

**Wave 5.15j:** the `--build` flag on the step-4 `compose run` invocation is mandatory and is the only thing that rebuilds the generator image. Step 1's `docker compose up --build` (Wave 5.15h) only rebuilds services in the **default** profile — `ui`, `api`, `source`, `ingest`, `calc`, `loadgen` — and explicitly does **not** touch services in the `tools` profile (Wave 5.15d.2), where `generator` now lives. See Wave 5.15i ([smoke-run-11](smoke-run-11/SUMMARY.md)) for the reference failure mode: the runbook had `--build` on step 1 but not on step 4, the freshness gate STOP-ed the run because the generator image SHA was identical to smoke-run-10's, and no generator source changes since Wave 5.15f reached the running container. Adding `--build` to `compose run` closes that gap.



## Why MP4s are not in git

Large binary assets — track via Git LFS or cloud storage. Add the link to `docs/asset-pack/README.md` when the recording lands.

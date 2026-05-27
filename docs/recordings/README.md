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

  ⚠️ **Live mode requires** a populated `.env.local` (Redis Cloud creds + active connection profile) **and** the full stack already running via `docker compose up`. Playwright will **not** start the dev server in this mode; it expects the ui container on port 3000.

Override the live base URL with `UI_BASE_URL=http://… npm run test:e2e:live` if the ui is exposed elsewhere.

## Why MP4s are not in git

Large binary assets — track via Git LFS or cloud storage. Add the link to `docs/asset-pack/README.md` when the recording lands.

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.UI_E2E_PORT ?? 5174);

// INTEGRATION=1 — point at the live ui container (docker compose) and skip
// the dev-server webServer block. Mocks mode (default) keeps the fast vite
// dev-server flow exactly as before.
const INTEGRATION = process.env.INTEGRATION === "1";
const LIVE_BASE_URL = process.env.UI_BASE_URL ?? "https://localhost";

// Top-level e2e config — drives the UI dev server end-to-end through the
// 11-step demo flow (e2e/full-demo.spec.ts). Per-panel happy-paths live
// under services/ui/e2e/ and are owned by the panel implementors.
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  // Under INTEGRATION the whole 11-step flow hits real services; bump the
  // per-test timeout. Mocks mode keeps the Playwright default (30s).
  ...(INTEGRATION ? { timeout: 120_000 } : {}),
  use: {
    baseURL: INTEGRATION ? LIVE_BASE_URL : `http://127.0.0.1:${PORT}`,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    // Live Docker UI uses a self-signed cert by default.
    ...(INTEGRATION ? { ignoreHTTPSErrors: true } : {}),
    // 30s per-action/navigation ceiling for live mode; mocks mode keeps the
    // Playwright default (0 = no per-action ceiling).
    ...(INTEGRATION ? { actionTimeout: 30_000, navigationTimeout: 30_000 } : {}),
  },
  outputDir: "../docs/recordings/playwright-artifacts",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // In INTEGRATION mode the ui container is brought up by `docker compose up`;
  // Playwright does not start its own dev server.
  ...(INTEGRATION
    ? {}
    : {
        webServer: {
          command: `npm run -w @frtb/ui dev -- --port ${PORT} --host 127.0.0.1`,
          url: `http://127.0.0.1:${PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          stdout: "pipe" as const,
          stderr: "pipe" as const,
        },
      }),
});

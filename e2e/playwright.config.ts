import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.UI_E2E_PORT ?? 5174);

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
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  outputDir: "../docs/recordings/playwright-artifacts",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run -w @frtb/ui dev -- --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

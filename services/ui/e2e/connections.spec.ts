import { test, expect } from "@playwright/test";

// Wave 3.5A — Playwright happy-path for the Connections panel.
//
// The webServer in playwright.config boots a real Vite dev server, but the
// api is not running in CI, so we mock the api routes here. Other panels
// (Calc, Ingest) follow the same pattern.

const demoProfile = {
  id: "01J", name: "demo-cluster", host: "redis-1.lab", port: 12000,
  tls: { enabled: true }, created_at: "t", updated_at: "t",
};
const scaleProfile = {
  id: "01K", name: "scale-cluster", host: "redis-2.lab", port: 12001,
  tls: { enabled: true }, created_at: "t", updated_at: "t",
};

test.describe("Connections panel — happy path", () => {
  test.beforeEach(async ({ page }) => {
    // Shell + other panels' background calls — keep them quiet.
    await page.route("**/observability/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
    );
  });

  test("loads + lists clusters + shows active badge + 3 buying-signal callouts", async ({ page }) => {
    await page.route("**/redis/active-target", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" }) }),
    );
    await page.route("**/connections", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([demoProfile, scaleProfile]) }),
    );

    await page.goto("/connections");
    await expect(page.getByRole("heading", { name: /^Connections$/, level: 1 })).toBeVisible();
    await expect(page.getByText("demo-cluster")).toBeVisible();
    await expect(page.getByText("scale-cluster")).toBeVisible();
    await expect(page.getByText(/redis-1\.lab:12000/)).toBeVisible();

    // Three buying-signal callouts (natural-language copy):
    await expect(page.getByText(/Deploy in your perimeter/i)).toBeVisible();
    await expect(page.getByText(/Module bundle/i)).toBeVisible();
    await expect(page.getByText(/TLS \+ ACL \+ data sovereignty/i)).toBeVisible();

    // Active target pill in the shell header shows the active cluster.
    const pill = page.getByRole("status", { name: /active cluster/i });
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/demo-cluster/);
  });

  test("shows an empty-state CTA when no clusters are configured", async ({ page }) => {
    await page.route("**/redis/active-target", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ host: "127.0.0.1", port: 6379, tls: false, db: 0, label: "default" }) }),
    );
    await page.route("**/connections", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
    );

    await page.goto("/connections");
    await expect(page.getByText(/no clusters configured yet/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /add cluster/i })).toBeVisible();
  });

  test("Test button runs POST /connections/:id/test and shows module ticks + latency", async ({ page }) => {
    await page.route("**/redis/active-target", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ host: "redis-1.lab", port: 12000, tls: true, db: 0, label: "demo-cluster" }) }),
    );
    await page.route("**/connections", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([demoProfile]) }),
    );
    await page.route("**/connections/01J/test", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true, latency_ms: 11,
          modules: [
            { name: "ReJSON", present: true },
            { name: "search", present: true },
            { name: "redisgears", present: true },
          ],
          errors: [],
        }),
      }),
    );

    await page.goto("/connections");
    await page.getByRole("button", { name: /^Test$/ }).click();
    const result = page.getByTestId("test-result-01J");
    await expect(result).toBeVisible();
    await expect(result).toContainText(/ReJSON/);
    await expect(result).toContainText(/search/);
    await expect(result).toContainText(/redisgears/);
    await expect(result).toContainText(/11\s*ms/);
  });

  test("shows an error panel with a retry button when /connections fails", async ({ page }) => {
    await page.route("**/redis/active-target", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ host: "h", port: 1, tls: false, db: 0, label: "x" }) }),
    );
    await page.route("**/connections", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }),
    );

    await page.goto("/connections");
    await expect(page.getByText(/failed to load connections/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
  });
});

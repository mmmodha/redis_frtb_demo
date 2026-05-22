import { test, expect } from "@playwright/test";

// Default routes used by the shell scaffold; tests below override per-case.
test.beforeEach(async ({ page }) => {
  await page.route("**/observability/shards", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [] }) }),
  );
  await page.route("**/sources", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
});

test.describe("Ingest panel", () => {
  test("renders the Ingest heading, JSON|Streams callout, and live charts on success", async ({ page }) => {
    await page.route("**/observability/keys**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          prefix: "sens:",
          dbsize: 1234,
          sample: [
            "sens:{GIRR:USD-IRS}:01HXAA",
            "sens:{GIRR:EUR-IRS}:01HXBB",
            "sens:{Equity:B1}:01HXCC",
          ],
          sample_size: 3,
          ms: 2,
        }),
      }),
    );
    await page.route("**/observability/memory", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ used_memory: 2097152, used_memory_human: "2.00M", ms: 1 }),
      }),
    );

    await page.goto("/ingest");
    await expect(page.getByRole("heading", { name: /^Ingest$/, level: 1 })).toBeVisible();
    await expect(page.getByText(/JSON\|Streams/)).toBeVisible();
    await expect(page.getByText("1,234")).toBeVisible();
    await expect(page.getByText("sens:{GIRR:USD-IRS}:01HXAA")).toBeVisible();
    await expect(page.getByText("sens:{Equity:B1}:01HXCC")).toBeVisible();
    await expect(page.locator('[data-testid="chart-throughput"]')).toBeVisible();
    await expect(page.locator('[data-testid="chart-memory"]')).toBeVisible();
  });

  test("shows an empty state when there are no rows yet", async ({ page }) => {
    await page.route("**/observability/keys**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 0 }),
      }),
    );
    await page.route("**/observability/memory", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ used_memory: 0, used_memory_human: "0B", ms: 0 }),
      }),
    );

    await page.goto("/ingest");
    await expect(page.getByText(/no rows ingested yet/i)).toBeVisible();
  });

  test("shows an error state when the api is unreachable", async ({ page }) => {
    await page.route("**/observability/keys**", (route) => route.abort("failed"));
    await page.route("**/observability/memory", (route) => route.abort("failed"));

    await page.goto("/ingest");
    await expect(page.getByText(/failed to load ingest telemetry/i)).toBeVisible();
  });

  test("shows the generator fallback button when no sources exist", async ({ page }) => {
    await page.route("**/observability/keys**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 0 }) }),
    );
    await page.route("**/observability/memory", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
    );

    await page.goto("/ingest");
    await expect(page.getByRole("button", { name: /run generator/i })).toBeVisible();
  });
});

import { test, expect } from "@playwright/test";

test.describe("Observability panel", () => {
  test("shows total keys, memory and per-shard breakdown on success", async ({ page }) => {
    await page.route("**/observability/keys**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ prefix: "sens:", dbsize: 1234, sample: [], sample_size: 0, ms: 2 }),
      }),
    );
    await page.route("**/observability/memory", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ used_memory: 1048576, used_memory_human: "1.00M", ms: 1 }),
      }),
    );
    await page.route("**/observability/shards", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          shards: [
            { id: "shard-1", role: "master", ops_per_sec: 1200, keys: 600, used_memory: 524288 },
            { id: "shard-2", role: "master", ops_per_sec: 980, keys: 634, used_memory: 524288 },
          ],
        }),
      }),
    );

    await page.goto("/observability");
    await expect(page.getByText("1,234")).toBeVisible();
    await expect(page.getByText(/1\.00M/)).toBeVisible();
    await expect(page.getByText("shard-1")).toBeVisible();
    await expect(page.getByText("shard-2")).toBeVisible();
    await expect(page.getByText(/ObservabilityModule/)).toBeVisible();
  });

  test("shows an empty state when the cluster has no data", async ({ page }) => {
    await page.route("**/observability/keys**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ prefix: "sens:", dbsize: 0, sample: [], sample_size: 0, ms: 0 }) }),
    );
    await page.route("**/observability/memory", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
    );
    await page.route("**/observability/shards", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [] }) }),
    );
    await page.goto("/observability");
    await expect(page.getByText(/no sensitivities loaded yet/i)).toBeVisible();
  });

  test("shows an error state when the api is unreachable", async ({ page }) => {
    await page.route("**/observability/**", (route) => route.abort("failed"));
    await page.goto("/observability");
    await expect(page.getByText(/failed to load observability/i)).toBeVisible();
  });
});

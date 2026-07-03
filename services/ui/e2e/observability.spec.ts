import { test, expect } from "@playwright/test";

function debugBody(overrides: { dbsize?: number; used_memory_human?: string; ops?: number; index_count?: number } = {}) {
  const dbsize = overrides.dbsize ?? 1234;
  return {
    keys: { prefix: "sens:", dbsize, sample: [], sample_size: 0, ms: 2 },
    memory: {
      used_memory: 1048576,
      used_memory_human: overrides.used_memory_human ?? "1.00M",
      instantaneous_ops_per_sec: overrides.ops ?? 2180,
      ms: 1,
    },
    index_count: { count: overrides.index_count ?? dbsize, refreshing: false, index_name: "idx:sens" },
    calc_recent: { items: [] },
    bootstrap: { phase: "ready", target_label: "local", err: null },
  };
}

test.describe("Observability panel", () => {
  test("shows cluster snapshot tiles on success", async ({ page }) => {
    await page.route("**/observability/debug**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(debugBody()),
      }),
    );
    await page.route("**/ingest/snapshot", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          target_label: "local",
          cluster: { sens_count: 100, sens_count_refreshing: false, memory_bytes: 1, memory_human: "1B" },
          loader: { in_flight: 0, flush_rps: 0, flushed_total: 0, throttled: false, recent_429_count: 0 },
          runs: [],
          focused_run_id: null,
        }),
      }),
    );
    await page.route("**/admin/stream-status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ xlen: 0, maxlen: 10000, peak_rate_per_sec: 0, consumed: 0 }),
      }),
    );
    await page.route("**/admin/drift-status", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ threshold_pct: 0.01, results: [] }) }),
    );
    await page.route("**/generator/runs", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active: [] }) }),
    );
    await page.route("**/ingest/bulk/runs", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active: [] }) }),
    );
    await page.route("**/ingest/bulk/load-status", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workers: [], dispatcher: { in_flight: 0 } }) }),
    );
    await page.route("**/ingest/run-history", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) }),
    );

    await page.goto("/observability");
    await expect(page.getByText("1,234")).toBeVisible();
    await expect(page.getByText(/1\.00M/)).toBeVisible();
    await expect(page.getByText("2,180")).toBeVisible();
    await expect(page.getByText(/ObservabilityModule/)).toBeVisible();
  });

  test("shows an empty state when the cluster has no data", async ({ page }) => {
    await page.route("**/observability/debug**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(debugBody({ dbsize: 0, used_memory_human: "0B", ops: 0, index_count: 0 })),
      }),
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

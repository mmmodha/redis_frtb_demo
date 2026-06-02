import { test, expect } from "@playwright/test";

const fastResponse = {
  charge: 1234567.89,
  per_bucket: [
    { bucket: "USD-IRS", K_b: 200, S_b: 180, count: 5000, ms: 12 },
    { bucket: "EUR-IRS", K_b: 100, S_b: 90, count: 2500, ms: 7 },
  ],
  total_ms: 1500,
  shard_breakdown: [
    { shard: "shard-1", buckets: ["USD-IRS"], ms: 12 },
    { shard: "shard-2", buckets: ["EUR-IRS"], ms: 7 },
  ],
  fanout_ms: 14.6,
};

const slowResponse = { ...fastResponse, total_ms: 7100 };

test.describe("Calc panel — happy path", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/observability/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
    );
  });

  test("Calculate button → loading → success result with green badge", async ({ page }) => {
    let resolveCalc: (value: void) => void = () => {};
    const calcRequested = new Promise<void>((resolve) => {
      resolveCalc = resolve;
    });
    await page.route("**/calc/sbm", async (route) => {
      resolveCalc();
      await new Promise((r) => setTimeout(r, 150));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fastResponse),
      });
    });

    await page.goto("/calc");
    await expect(page.getByRole("heading", { name: /^Calculation$/, level: 1 })).toBeVisible();

    const calculate = page.getByRole("button", { name: /calculate sbm risk charge/i });
    await calculate.click();
    await calcRequested;
    await expect(calculate).toBeDisabled();
    await expect(page.getByText(/calculating/i)).toBeVisible();

    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("calc-charge")).toContainText(/1[,\s]?234[,\s]?567/);

    const badge = page.getByTestId("wallclock-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("data-tone", "green");

    await expect(page.getByRole("table", { name: /per-bucket/i })).toBeVisible();
    await expect(page.getByText("shard-1")).toBeVisible();
    await expect(page.getByText("shard-2")).toBeVisible();
  });

  test("wall-clock badge is red when total_ms exceeds the MVP gate", async ({ page }) => {
    await page.route("**/calc/sbm", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(slowResponse) }),
    );
    await page.goto("/calc");
    await page.getByRole("button", { name: /calculate sbm risk charge/i }).click();
    const badge = page.getByTestId("wallclock-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("data-tone", "red");
  });
});

test.describe("Calc panel — error state", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/observability/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
    );
  });

  test("renders an error alert and re-enables the button when /calc/sbm fails", async ({ page }) => {
    await page.route("**/calc/sbm", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "calc failed" }),
      }),
    );
    await page.goto("/calc");
    const calculate = page.getByRole("button", { name: /calculate sbm risk charge/i });
    await calculate.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(/calc failed|error|failed/i);
    await expect(calculate).not.toBeDisabled();
  });
});

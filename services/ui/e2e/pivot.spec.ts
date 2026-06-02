import { test, expect, type Route } from "@playwright/test";

type PivotResp = { total: number; limit: number; offset: number; ms: number; rows: Array<{ key: string; doc: Record<string, unknown> }> };

function makeRow(key: string, doc: Record<string, unknown>): { key: string; doc: Record<string, unknown> } {
  return { key, doc };
}

const happyResponse: PivotResp = {
  total: 2,
  limit: 100,
  offset: 0,
  ms: 11.7,
  rows: [
    makeRow("sens:{GIRR:USD-IRS}:01HXAA", { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", book: "RATES-LDN", risk_value: [0.1, 0.2] }),
    makeRow("sens:{GIRR:USD-IRS}:01HXBB", { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", book: "RATES-LDN", risk_value: [0.3] }),
  ],
};

const emptyResponse: PivotResp = { total: 0, limit: 100, offset: 0, ms: 1.2, rows: [] };

async function stubObservability(page: import("@playwright/test").Page) {
  await page.route("**/observability/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }),
    })
  );
}

test.describe("/pivot — Query/Pivot panel", () => {
  test.beforeEach(async ({ page }) => {
    await stubObservability(page);
  });

  test("happy path: runs a pivot, renders results table and latency histogram", async ({ page }) => {
    let lastUrl = "";
    await page.route(/\/pivot\?/, async (route: Route) => {
      lastUrl = route.request().url();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(happyResponse) });
    });

    await page.goto("/pivot");
    await expect(page.getByRole("heading", { name: /^Search$/, level: 1 })).toBeVisible();
    await expect(page.getByText(/RedisQueryEngine/)).toBeVisible();

    await page.getByLabel(/risk class/i).selectOption("GIRR");
    await page.getByLabel(/^bucket$/i).selectOption("USD-IRS");
    await page.getByLabel(/sensitivity type/i).selectOption("Delta");
    await page.getByRole("button", { name: /run query/i }).click();

    const table = page.getByRole("table", { name: /search results/i });
    await expect(table).toBeVisible();
    await expect(table.getByText("sens:{GIRR:USD-IRS}:01HXAA")).toBeVisible();
    await expect(table.getByText("sens:{GIRR:USD-IRS}:01HXBB")).toBeVisible();
    expect(lastUrl).toContain("risk_class=GIRR");
    expect(lastUrl).toContain("bucket=USD-IRS");
    expect(lastUrl).toContain("sensitivity_type=Delta");

    await expect(page.getByTestId("latency-strip")).toContainText(/11\.7/);
  });

  test("bucket dropdown options change with the selected risk_class", async ({ page }) => {
    await page.goto("/pivot");
    await page.getByLabel(/risk class/i).selectOption("GIRR");
    const bucket = page.getByLabel(/^bucket$/i);
    await expect(bucket.locator("option", { hasText: /^USD-IRS$/ })).toHaveCount(1);
    await page.getByLabel(/risk class/i).selectOption("Equity");
    await expect(bucket.locator("option", { hasText: /^B1$/ })).toHaveCount(1);
    await expect(bucket.locator("option", { hasText: /^USD-IRS$/ })).toHaveCount(0);
  });

  test("empty-result state shows the friendly empty message and no table", async ({ page }) => {
    await page.route(/\/pivot\?/, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyResponse) })
    );
    await page.goto("/pivot");
    await page.getByLabel(/risk class/i).selectOption("FX");
    await page.getByRole("button", { name: /run query/i }).click();
    await expect(page.getByText(/no sensitivities match these filters/i)).toBeVisible();
    await expect(page.getByRole("table", { name: /search results/i })).toHaveCount(0);
  });

  test("error state surfaces an alert when the api responds 5xx", async ({ page }) => {
    await page.route(/\/pivot\?/, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
    );
    await page.goto("/pivot");
    await page.getByRole("button", { name: /run query/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(/500|failed/i);
  });

  test("error state surfaces an alert when fetch fails entirely", async ({ page }) => {
    await page.route(/\/pivot\?/, (route) => route.abort("failed"));
    await page.goto("/pivot");
    await page.getByRole("button", { name: /run query/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("filter combination: book free-text is forwarded as a TAG filter", async ({ page }) => {
    let observedUrl = "";
    await page.route(/\/pivot\?/, async (route) => {
      observedUrl = route.request().url();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyResponse) });
    });
    await page.goto("/pivot");
    await page.getByLabel(/^book$/i).fill("RATES-LDN");
    await page.getByRole("button", { name: /run query/i }).click();
    await expect(page.getByText(/no sensitivities match these filters/i)).toBeVisible();
    expect(observedUrl).toContain("book=RATES-LDN");
  });

  test("pagination Next advances offset by limit", async ({ page }) => {
    let calls: string[] = [];
    await page.route(/\/pivot\?/, async (route) => {
      calls.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...happyResponse, total: 250 }),
      });
    });
    await page.goto("/pivot");
    await page.getByRole("button", { name: /run query/i }).click();
    await expect(page.getByRole("table", { name: /search results/i })).toBeVisible();
    await page.getByRole("button", { name: /next/i }).click();
    await expect.poll(() => calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]).toContain("offset=100");
  });
});

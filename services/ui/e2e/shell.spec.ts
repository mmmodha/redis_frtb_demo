import { test, expect } from "@playwright/test";

test.describe("UI shell", () => {
  test("renders the brand header and the 6 navigation sections", async ({ page }) => {
    await page.route("**/observability/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
    );
    await page.goto("/observability");
    await expect(page.getByRole("banner")).toContainText(/FRTB SBM/i);
    const nav = page.getByRole("navigation", { name: /primary/i });
    for (const label of ["Connections", "Sources", "Ingest", "Pivot", "Calc", "Observability"]) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
  });

  test("uses dark mode by default", async ({ page }) => {
    await page.route("**/observability/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
    );
    await page.goto("/observability");
    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
  });
});

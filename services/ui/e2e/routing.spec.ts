import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/observability/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
  );
});

const routes: Array<{ path: string; label: string; heading: RegExp }> = [
  { path: "/connections", label: "Connections", heading: /^Connections$/ },
  { path: "/sources", label: "Sources", heading: /^Sources$/ },
  { path: "/ingest", label: "Ingest", heading: /^Ingest$/ },
  { path: "/pivot", label: "Search", heading: /^Search$/ },
  { path: "/calc", label: "Calculation", heading: /^Calculation$/ },
  { path: "/observability", label: "Observability", heading: /^Observability$/ },
];

for (const route of routes) {
  test(`renders ${route.label} panel at ${route.path}`, async ({ page }) => {
    await page.goto(route.path);
    await expect(page.getByRole("heading", { name: route.heading, level: 1 })).toBeVisible();
  });
}

test("clicking nav links routes between panels", async ({ page }) => {
  await page.goto("/observability");
  await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calculation" }).click();
  await expect(page).toHaveURL(/\/calc$/);
  await expect(page.getByRole("heading", { name: /^Calculation$/, level: 1 })).toBeVisible();
});

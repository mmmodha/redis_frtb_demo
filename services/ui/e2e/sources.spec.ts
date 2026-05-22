import { test, expect } from "@playwright/test";

// Wave 3.5B happy-path: list sources → configure mapping → save & ingest.
// All upstream /sources/* responses are stubbed so the spec compiles and runs
// without source-service or Redis. The full integration is covered by
// services/api/tests/sources-proxy.test.ts.

const sourceSeed = {
  id: "src-e2e",
  name: "girr-100k.csv",
  format: "csv",
  origin: "upload",
  size_bytes: 1_048_576,
  status: "uploaded",
  created_at: "2026-05-22T10:00:00Z",
  updated_at: "2026-05-22T10:00:00Z",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/sources", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([sourceSeed]) }),
  );
  await page.route("**/sources/src-e2e/infer", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: { ...sourceSeed, status: "inferred" },
        columns: [
          { name: "risk_class", detected_type: "TAG", sample_values: ["GIRR", "Equity"] },
          { name: "bucket", detected_type: "TAG", sample_values: ["B1", "B2"] },
          { name: "tenor_3m", detected_type: "NUMERIC", sample_values: ["0.10", "0.12"] },
          { name: "tenor_1y", detected_type: "NUMERIC", sample_values: ["0.20", "0.22"] },
        ],
        mapping_suggestion: {
          fields: {
            risk_class: { from: "risk_class" },
            bucket: { from: "bucket" },
            risk_value: { from: ["tenor_3m", "tenor_1y"], type: "array_number" },
          },
        },
      }),
    }),
  );
  await page.route("**/sources/src-e2e/mapping", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...sourceSeed, status: "mapped" }),
    }),
  );
  await page.route("**/sources/src-e2e/ingest", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...sourceSeed, status: "ingesting" }),
    }),
  );
});

test.describe("Sources panel", () => {
  test("lists sources, opens mapping wizard, auto-suggests, saves and ingests", async ({ page }) => {
    await page.goto("/sources");
    await expect(page.getByRole("heading", { name: /^Sources$/, level: 1 })).toBeVisible();
    await expect(page.getByTestId("sources-dropzone")).toBeVisible();
    await expect(page.getByTestId("source-row-src-e2e")).toBeVisible();
    await expect(page.getByText("girr-100k.csv")).toBeVisible();

    await page.getByRole("button", { name: /configure mapping/i }).click();
    await expect(page.getByTestId("mapping-wizard")).toBeVisible();
    await expect(page.getByText("risk_class")).toBeVisible();
    await expect(page.getByText("tenor_3m")).toBeVisible();

    await page.getByRole("button", { name: /auto-suggest/i }).click();
    await page.getByRole("button", { name: /save & ingest/i }).click();

    // After save+ingest the wizard closes and the list refreshes.
    await expect(page.getByTestId("mapping-wizard")).toBeHidden();
  });

  test("shows the empty-state copy when there are no sources", async ({ page }) => {
    await page.route("**/sources", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
    );
    await page.goto("/sources");
    await expect(page.getByText(/no sources yet/i)).toBeVisible();
  });

  test("shows the error state with a retry button when /sources fails", async ({ page }) => {
    await page.route("**/sources", (route) => route.fulfill({ status: 500, body: "boom" }));
    await page.goto("/sources");
    await expect(page.getByText(/failed to load sources/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
  });
});

import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

// Full 11-step HSBC demo flow — Wave 4.4.
// Acts as (a) demo-protection regression and (b) storyboard for the recorded
// dry-run. Each step takes a screenshot into docs/recordings/screenshots/.
//
// TDD state: this spec is RED today. It asserts on UI surfaces that are
// scheduled to land in Wave 4 — specifically:
//   - Step 8 expects a /loadgen route (Wave 4.2).
//   - Step 9 expects Equity Delta to compute with a green wall-clock (Wave 4.1).
//   - Step 8 + 10 expect a ShardMetricsStrip with per-shard ops/sec (Wave 4.6).
// Verifier should re-run this spec after 4.1, 4.2, 4.6 land — it should turn
// GREEN with no spec changes.

const SCREENSHOT_DIR = path.resolve(__dirname, "../docs/recordings/screenshots");

function shot(page: Page, step: string): Promise<Buffer> {
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${step}.png`),
    fullPage: true,
  });
}

// ---------- shared fixtures (all upstream api calls are mocked) ----------

const demoProfile = {
  id: "01J-demo", name: "demo-cluster", host: "redis-demo.lab", port: 12000,
  tls: { enabled: true }, created_at: "t", updated_at: "t",
};
const scaleProfile = {
  id: "01K-scale", name: "scale-cluster", host: "redis-scale.lab", port: 12001,
  tls: { enabled: true }, created_at: "t", updated_at: "t",
};

const seedSource = {
  id: "src-girr-100k", name: "girr-sample-100k.csv", format: "csv", origin: "upload",
  size_bytes: 1_048_576, status: "uploaded",
  created_at: "2026-05-27T08:00:00Z", updated_at: "2026-05-27T08:00:00Z",
};
const seedSource450M = {
  id: "src-450M", name: "frtb-450M.parquet", format: "parquet", origin: "mounted",
  size_bytes: 450_000_000_000, status: "mapped",
  created_at: "2026-05-27T08:00:00Z", updated_at: "2026-05-27T08:00:00Z",
};

const fastCalcResponse = {
  charge: 1234567.89,
  per_bucket: [
    { bucket: "USD-IRS", K_b: 200, S_b: 180, count: 5000, ms: 12 },
    { bucket: "EUR-IRS", K_b: 100, S_b: 90, count: 2500, ms: 7 },
    { bucket: "GBP-IRS", K_b: 50, S_b: 45, count: 1100, ms: 5 },
  ],
  total_ms: 1500,
  shard_breakdown: [
    { shard: "shard-1", buckets: ["USD-IRS"], ms: 12 },
    { shard: "shard-2", buckets: ["EUR-IRS"], ms: 7 },
    { shard: "shard-3", buckets: ["GBP-IRS"], ms: 5 },
  ],
  fanout_ms: 14.6,
};

const pivotResponse = {
  total: 2, limit: 100, offset: 0, ms: 11.7,
  rows: [
    { key: "sens:{GIRR:USD-IRS}:01HXAA", doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", book: "RATES-LDN", risk_value: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] } },
    { key: "sens:{GIRR:USD-IRS}:01HXBB", doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", book: "RATES-LDN", risk_value: [0.11, 0.22, 0.33] } },
  ],
};

const inferResponse = {
  source: { ...seedSource, status: "inferred" },
  columns: [
    { name: "risk_class", detected_type: "TAG", sample_values: ["GIRR"] },
    { name: "bucket", detected_type: "TAG", sample_values: ["USD-IRS", "EUR-IRS"] },
    { name: "tenor_3m", detected_type: "NUMERIC", sample_values: ["0.10"] },
    { name: "tenor_1y", detected_type: "NUMERIC", sample_values: ["0.20"] },
    { name: "tenor_10y", detected_type: "NUMERIC", sample_values: ["0.40"] },
  ],
  mapping_suggestion: {
    fields: {
      risk_class: { from: "risk_class" },
      bucket: { from: "bucket" },
      risk_value: { from: ["tenor_3m", "tenor_1y", "tenor_10y"], type: "array_number" },
    },
  },
};

async function installCommonRoutes(page: Page, opts: { activeName?: string } = {}): Promise<void> {
  const activeName = opts.activeName ?? "demo-cluster";
  await page.route("**/redis/active-target", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ host: "redis-demo.lab", port: 12000, tls: true, db: 0, label: activeName }),
    }),
  );
  await page.route("**/connections", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([demoProfile, scaleProfile]) }),
  );
  await page.route("**/connections/01J-demo/test", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, modules: { ReJSON: true, search: true, redisgears: true }, tls: true, acl: true }) }),
  );
  await page.route("**/connections/01K-scale/test", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, modules: { ReJSON: true, search: true, redisgears: true }, tls: true, acl: true }) }),
  );
  await page.route("**/connections/01K-scale/activate", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...scaleProfile, is_active: true }) }),
  );
  await page.route("**/sources", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([seedSource, seedSource450M]) }),
  );
  await page.route("**/sources/src-girr-100k/infer", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(inferResponse) }),
  );
  await page.route("**/sources/src-girr-100k/mapping", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...seedSource, status: "mapped" }) }),
  );
  await page.route("**/sources/src-girr-100k/ingest", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...seedSource, status: "ingesting" }) }),
  );
  await page.route("**/sources/src-450M/ingest", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...seedSource450M, status: "ingesting" }) }),
  );

  // Observability — keys/memory used by Ingest panel.
  await page.route("**/observability/keys**", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ prefix: "sens:", dbsize: 10_000_000, sample: ["sens:{GIRR:USD-IRS}:01HXAA"], sample_size: 1, ms: 2 }),
    }),
  );
  await page.route("**/observability/memory", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ used_memory: 2_147_483_648, used_memory_human: "2.00G", ms: 1 }),
    }),
  );
  await page.route("**/observability/shards", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ shards: [
        { id: "shard-1", role: "primary", ops_per_sec: 51_200, memory_used: 8_589_934_592, slot_range: "0-5460" },
        { id: "shard-2", role: "primary", ops_per_sec: 49_800, memory_used: 8_321_499_136, slot_range: "5461-10922" },
        { id: "shard-3", role: "primary", ops_per_sec: 50_100, memory_used: 8_456_716_864, slot_range: "10923-16383" },
      ] }),
    }),
  );
  await page.route("**/observability/**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
  );

  await page.route("**/pivot?**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pivotResponse) }),
  );
  await page.route("**/calc/sbm", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fastCalcResponse) }),
  );

  // Wave 4.2 — loadgen control routes (mocked so spec can drive Step 8).
  await page.route("**/loadgen/start", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, run_id: "run-200x" }) }),
  );
  await page.route("**/loadgen/status", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ running: true, concurrency: 200, p99_ms: 412, ops_per_sec: 12_500, run_id: "run-200x" }),
    }),
  );
  // Wave 5.14b.2: realign to the actual SSE route the UI subscribes to
  // (services/ui/src/lib/loadgen.ts → /loadgen/metrics). The previous
  // **/loadgen/stream glob matched nothing and left the EventSource unmocked.
  await page.route("**/loadgen/metrics", (route: Route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
}

test.describe.configure({ mode: "serial" });

// INTEGRATION=1 — bypass page.route() mocks so the spec drives the live stack
// (Wave 5.5 smoke). Unset (default) keeps fully-mocked fast CI behaviour.
const INTEGRATION = process.env.INTEGRATION === "1";

test.describe("Full HSBC demo — 11-step flow (storyboard + protection)", () => {
  test.beforeEach(async ({ page }) => {
    if (!INTEGRATION) {
      await installCommonRoutes(page);
    }
  });

  test("drives all 11 steps end-to-end and screenshots each", async ({ page }) => {
    // ----- Step 2 — land on the app (deck steps 1+2 are slides; we screenshot the entry) -----
    await page.goto("/observability");
    await expect(page.getByRole("heading", { name: /^Observability$/, level: 1 })).toBeVisible();
    await shot(page, "step-02-architecture-landing");

    // ----- Step 2a — Connections + Sources -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Connections" }).click();
    await expect(page.getByRole("heading", { name: /^Connections$/, level: 1 })).toBeVisible();
    await expect(page.getByText("demo-cluster")).toBeVisible();
    await expect(page.getByText("scale-cluster")).toBeVisible();
    await shot(page, "step-02a-connections");

    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Sources" }).click();
    await expect(page.getByRole("heading", { name: /^Sources$/, level: 1 })).toBeVisible();
    await expect(page.getByText("girr-sample-100k.csv")).toBeVisible();
    await shot(page, "step-02a-sources");

    // ----- Step 3 — Live ingest -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Ingest" }).click();
    await expect(page.getByRole("heading", { name: /^Ingest$/, level: 1 })).toBeVisible();
    await shot(page, "step-03-ingest");

    // ----- Step 4 — Native array shape (pivot row inspector) -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Pivot" }).click();
    await expect(page.getByRole("heading", { name: /^Pivot$/, level: 1 })).toBeVisible();
    await page.getByLabel(/risk class/i).selectOption("GIRR");
    await page.getByLabel(/^bucket$/i).selectOption("USD-IRS");
    await page.getByLabel(/sensitivity type/i).selectOption("Delta");
    await page.getByRole("button", { name: /^run pivot$/i }).click();
    await shot(page, "step-04-array-shape");

    // ----- Step 5 — Pivot at speed (rerun once more for p99 visible) -----
    await page.getByRole("button", { name: /^run pivot$/i }).click();
    await shot(page, "step-05-pivot-speed");

    // ----- Step 6 — SBM Delta calc (THE MVP moment) -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calc" }).click();
    await expect(page.getByRole("heading", { name: /^Calc$/, level: 1 })).toBeVisible();
    await page.getByLabel(/risk class/i).selectOption("GIRR");
    await page.getByLabel(/sensitivity type/i).selectOption("Delta");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    const deltaBadge = page.getByTestId("wallclock-badge");
    await expect(deltaBadge).toHaveAttribute("data-tone", "green");
    await shot(page, "step-06-delta-mvp");

    // ----- Step 7 — SBM Vega calc -----
    await page.getByLabel(/sensitivity type/i).selectOption("Vega");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-07-vega");

    // ----- Step 8 — Concurrent workforce (Loadgen panel — Wave 4.2) -----
    // RED until 4.2 ships /loadgen route + the panel control.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Loadgen" }).click();
    await expect(page.getByRole("heading", { name: /^Loadgen$/, level: 1 })).toBeVisible();
    await page.getByLabel(/concurrency/i).fill("200");
    await page.getByRole("button", { name: /^start( load)?$/i }).click();
    await expect(page.getByTestId("loadgen-p99")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("loadgen-p99")).toContainText(/4\d\d/);
    await shot(page, "step-08-concurrent");

    // ShardMetricsStrip (Wave 4.6) — visible on Observability while load runs.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Observability" }).click();
    const strip = page.getByTestId("shard-metrics-strip");
    await expect(strip).toBeVisible();
    await expect(strip.getByText(/shard-1/)).toBeVisible();
    await expect(strip.getByText(/shard-2/)).toBeVisible();
    await expect(strip.getByText(/shard-3/)).toBeVisible();
    await shot(page, "step-08-shard-metrics");

    // ----- Step 9 — Extensibility — Equity + FX calc (Wave 4.1) -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calc" }).click();
    await page.getByLabel(/risk class/i).selectOption("Equity");
    await page.getByLabel(/sensitivity type/i).selectOption("Delta");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    // RED until 4.1: Equity is gated as wave4 in the panel today (no green calc).
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-09-equity");

    await page.getByLabel(/risk class/i).selectOption("FX");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-09-fx");

    // ----- Step 10 — Scale pivot — Activate scale-cluster + ingest 450M source -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Connections" }).click();
    await page.getByRole("button", { name: /activate.*scale-cluster|scale-cluster.*activate/i }).click();
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Sources" }).click();
    await expect(page.getByText("frtb-450M.parquet")).toBeVisible();
    // Drive ingest from the 450M row's CTA (panel-internal selectors are panel-owned).
    const row450 = page.getByRole("row", { name: /frtb-450M\.parquet/i });
    await row450.getByRole("button", { name: /ingest|run|save & ingest/i }).click();
    await shot(page, "step-10-scale-pivot");

    // Re-run Calc against scale-cluster — same MVP code path, green wall-clock expected.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calc" }).click();
    await page.getByLabel(/risk class/i).selectOption("GIRR");
    await page.getByLabel(/sensitivity type/i).selectOption("Delta");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-10-calc-at-scale");

    // ----- Step 11 — Kill a node (optional; observability resilience) -----
    // The actual failover is driven from the RS admin UI, not the app. We
    // assert that the ShardMetricsStrip surfaces shard role/health so the
    // SA can narrate the failover from inside the app.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Observability" }).click();
    const strip2 = page.getByTestId("shard-metrics-strip");
    await expect(strip2).toBeVisible();
    await expect(strip2).toContainText(/primary/i);
    await shot(page, "step-11-failover-view");

    // ----- Step 12 — Close (handoff screen) -----
    await shot(page, "step-12-close");
  });
});

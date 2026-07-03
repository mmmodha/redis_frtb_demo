import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

// Full 11-step demo flow — Wave 4.4.
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
//
// Wave 5.64: the boot-time seed of `demo-cluster` / `scale-cluster` profiles
// has been removed (SEED_CONNECTIONS_FILE wiring + seed-connections.json are
// gone). Step 2a's `demo-cluster` / `scale-cluster` visibility assertions are
// now gated to mocked mode only — `installCommonRoutes()` still returns both
// profiles via the `**/connections` route stub, so mocked-CI screenshot
// fidelity is preserved. In INTEGRATION=1 mode the panel starts empty and the
// spec only asserts the Connections heading is present.

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
    { key: "sens:01HXAA", doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", book: "RATES-LDN", risk_value: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] } },
    { key: "sens:01HXBB", doc: { risk_class: "GIRR", bucket: "USD-IRS", sensitivity_type: "Delta", book: "RATES-LDN", risk_value: [0.11, 0.22, 0.33] } },
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

  // Benign fallback for unmocked API calls — register first; specific stubs below win.
  await page.route("**/api/**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
  );

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
  // Wave 5.69: /connections/{id}/test returns ConnectionTestResult with
  // `modules: Array<{ name; present }>` (see services/ui/src/lib/connections.ts).
  // The previous stub returned modules as a plain object, which made
  // `(tr.modules ?? []).map(...)` blow up the ConnectionsPanel on render and
  // unmount the page heading the spec asserts on.
  const testOk = JSON.stringify({
    ok: true,
    latency_ms: 4,
    modules: [
      { name: "ReJSON", present: true },
      { name: "search", present: true },
      { name: "timeseries", present: true },
      { name: "bf", present: true },
    ],
  });
  await page.route("**/connections/01J-demo/test", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: testOk }),
  );
  await page.route("**/connections/01K-scale/test", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: testOk }),
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

  // Observability API stubs — scope to /api/observability so Vite assets such as
  // src/styles/observability.css are not intercepted as JSON (blank page).
  await page.route("**/api/observability/**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) }),
  );
  await page.route("**/api/observability/debug**", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        keys: { prefix: "sens:", dbsize: 10_000_000, sample: ["sens:01HXAA"], sample_size: 1, ms: 2 },
        memory: {
          used_memory: 2_147_483_648,
          used_memory_human: "2.00G",
          instantaneous_ops_per_sec: 101_100,
          ms: 1,
        },
        index_count: { count: 10_000_000, refreshing: false, index_name: "idx:sens" },
        calc_recent: { items: [] },
        bootstrap: { phase: "ready", target_label: "demo", err: null },
      }),
    }),
  );
  await page.route("**/api/observability/keys**", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ prefix: "sens:", dbsize: 10_000_000, sample: ["sens:01HXAA"], sample_size: 1, ms: 2 }),
    }),
  );
  await page.route("**/api/observability/memory", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ used_memory: 2_147_483_648, used_memory_human: "2.00G", ms: 1 }),
    }),
  );
  // Wave 5.69: GET /observability/shards returns a bare ObservabilityShard[]
  // (see services/ui/src/lib/api.ts and services/api/src/routes/observability.ts).
  // The previous stub wrapped the array in `{ shards: [...] }` with snake_case
  // fields, which made `data.shards.reduce is not a function` blow up the
  // Observability route and unmount the AppShell — causing every subsequent
  // nav-link click in the spec (starting with Step 2a "Connections") to time
  // out on a blank page.
  await page.route("**/api/observability/shards", (route: Route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify([
        { shardId: "shard-1", role: "primary", opsPerSec: 51_200, slotCount: 5461, usedMemoryBytes: 8_589_934_592, netInBytes: 0, netOutBytes: 0 },
        { shardId: "shard-2", role: "primary", opsPerSec: 49_800, slotCount: 5462, usedMemoryBytes: 8_321_499_136, netInBytes: 0, netOutBytes: 0 },
        { shardId: "shard-3", role: "primary", opsPerSec: 50_100, slotCount: 5461, usedMemoryBytes: 8_456_716_864, netInBytes: 0, netOutBytes: 0 },
      ]),
    }),
  );
  await page.route("**/api/observability/per-shard**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { shard_id: "shard-1", memory_used: 8_589_934_592, key_count: 3_333_333, write_ops_per_sec: 51_200, index_lag: 0, degraded: false },
        { shard_id: "shard-2", memory_used: 8_321_499_136, key_count: 3_333_333, write_ops_per_sec: 49_800, index_lag: 0, degraded: false },
        { shard_id: "shard-3", memory_used: 8_456_716_864, key_count: 3_333_334, write_ops_per_sec: 50_100, index_lag: 0, degraded: false },
      ]),
    }),
  );

  const facetsSnapshot = {
    ok: true,
    total_rows: 10_000_000,
    risk_class: { GIRR: 5_000_000, Equity: 2_500_000, FX: 2_500_000 },
    sensitivity_type: { Delta: 8_000_000, Vega: 2_000_000 },
    bucket_by_risk_class: {
      GIRR: { "USD-IRS": 2_500_000, "EUR-IRS": 2_500_000 },
      Equity: { B1: 2_500_000 },
      FX: { EURUSD: 2_500_000 },
    },
  };
  const bucketFacets = {
    ok: true,
    buckets: [
      { risk_class: "GIRR", bucket: "USD-IRS", count: 2_500_000 },
      { risk_class: "GIRR", bucket: "EUR-IRS", count: 2_500_000 },
      { risk_class: "Equity", bucket: "B1", count: 2_500_000 },
      { risk_class: "FX", bucket: "EURUSD", count: 2_500_000 },
    ],
  };
  await page.route("**/api/facets**", (route: Route) => {
    const url = route.request().url();
    if (url.includes("/facets/bucket")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bucketFacets) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(facetsSnapshot) });
  });

  await page.route("**/api/ingest/bulk/runs/history**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) }),
  );
  await page.route("**/api/ingest/bulk/runs", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active: [] }) }),
  );
  await page.route("**/api/observability/history**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "unavailable",
        metric: "total_keys",
        windowMs: 18_000_000,
        points: [],
        reason: "module-not-loaded",
        target_label: activeName,
      }),
    }),
  );
  await page.route("**/api/ingest/snapshot**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        target_label: activeName,
        cluster: { sens_count: 10_000_000, sens_count_refreshing: false, memory_bytes: 0, memory_human: "2.00G" },
        loader: { in_flight: 0, flush_rps: 0, flushed_total: 0, throttled: false, recent_429_count: 0 },
        runs: [],
        focused_run_id: null,
      }),
    }),
  );
  await page.route("**/api/admin/drift-status**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) }),
  );
  await page.route("**/api/admin/calc-jobs**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active: [] }) }),
  );
  await page.route("**/api/admin/recent-errors**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.route("**/api/generator/runs**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ active: [] }) }),
  );
  await page.route("**/api/ingest/bulk/load-status**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workers: [], dispatcher: { in_flight: 0 } }),
    }),
  );
  await page.route("**/api/redis/active-target/bootstrap-status**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ phase: "ready", target_label: activeName }),
    }),
  );
  await page.route("**/api/inflight**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ count: 0, items: [] }) }),
  );

  await page.route("**/pivot?**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pivotResponse) }),
  );
  await page.route("**/calc/sbm", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fastCalcResponse) }),
  );
  await page.route("**/calc/recent**", (route: Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }),
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

test.describe.configure({ mode: "serial", timeout: 120_000 });

// INTEGRATION=1 — bypass page.route() mocks so the spec drives the live stack
// (Wave 5.5 smoke). Unset (default) keeps fully-mocked fast CI behaviour.
const INTEGRATION = process.env.INTEGRATION === "1";

test.describe("Full demo — 11-step flow (storyboard + protection)", () => {
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
    // Wave 5.64: gate the demo-cluster / scale-cluster name assertions to
    // mocked mode. In INTEGRATION=1 the panel is operator-driven and starts
    // empty; in mocked mode `installCommonRoutes()` returns both profiles.
    if (!INTEGRATION) {
      // Wave 5.69: scope to the profile-card headings so the assertion does
      // not strict-mode-collide with the active-target pill in the top bar
      // (which also renders the active cluster's label on every page).
      await expect(page.getByRole("heading", { name: "demo-cluster" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "scale-cluster" })).toBeVisible();
    }
    await shot(page, "step-02a-connections");

    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Sources" }).click();
    await expect(page.getByRole("heading", { name: /^Sources$/, level: 1 })).toBeVisible();
    await expect(page.getByText("girr-sample-100k.csv")).toBeVisible();
    await shot(page, "step-02a-sources");

    // ----- Step 3 — Live ingest -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Ingest" }).click();
    await expect(page.getByRole("heading", { name: /^Ingest$/, level: 1 })).toBeVisible();
    await shot(page, "step-03-ingest");

    // ----- Step 4 — Native array shape (Search row inspector) -----
    // Wave 5.71: "Pivot" surface was renamed to "Search" in Wave 5.28; the nav
    // link, heading and Run button labels all moved with it. /pivot route +
    // PivotPanel internals are unchanged.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Search" }).click();
    await expect(page.getByRole("heading", { name: /^Search$/, level: 1 })).toBeVisible();
    await page.getByLabel(/risk class/i).selectOption("GIRR");
    await page.getByLabel(/^bucket$/i).selectOption("USD-IRS");
    await page.getByLabel(/sensitivity type/i).selectOption("Delta");
    await page.getByRole("button", { name: /^run query$/i }).click();
    await shot(page, "step-04-array-shape");

    // ----- Step 5 — Search at speed (rerun once more for p99 visible) -----
    await page.getByRole("button", { name: /^run query$/i }).click();
    await shot(page, "step-05-pivot-speed");

    // ----- Step 6 — SBM Delta calc (THE MVP moment) -----
    // Wave 5.71: "Calc" nav label was renamed to "Calculation" in Wave 5.34a
    // and the CalcPanel sensitivity field span dropped the trailing "type"
    // (5.52/5.53 generator/calc UX). Calc testids (calc-cta, calc-charge,
    // wallclock-badge) are unchanged.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calculation" }).click();
    await expect(page.getByRole("heading", { name: /^Calculation$/, level: 1 })).toBeVisible();
    await page.getByLabel(/risk class/i).selectOption("GIRR");
    // Wave 5.71: the CalcPanel field span reads exactly "Sensitivity" (no
    // trailing "type"). Use getByRole on the combobox accessible name so we
    // never collide with the PivotPanel's "Sensitivity type" select or with
    // option text that getByLabel folds into the wrapping-label name.
    const calcSensitivity = page.getByRole("combobox", { name: "Sensitivity" });
    await calcSensitivity.selectOption("Delta");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    const deltaBadge = page.getByTestId("wallclock-badge");
    await expect(deltaBadge).toHaveAttribute("data-tone", "green");
    await shot(page, "step-06-delta-mvp");

    // ----- Step 7 — SBM Vega calc -----
    await calcSensitivity.selectOption("Vega");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-07-vega");

    // ----- Step 8 — Concurrent workforce (Loadgen panel — Wave 4.2) -----
    // Wave 5.71: Loadgen was removed from the primary nav (panel + /loadgen
    // route survive) — navigate by URL instead. The /loadgen/status stub
    // returns running:true with concurrency=200 already, so the panel mounts
    // in the live state: the concurrency input is disabled and the CTA is
    // "Stop", not "Start". Assert directly on the "p99 latency" MetricTile
    // heading (no `loadgen-p99` testid exists today).
    await page.goto("/loadgen");
    await expect(page.getByRole("heading", { name: /^Loadgen$/, level: 1 })).toBeVisible();
    await expect(page.getByLabel(/concurrency/i)).toHaveValue("200");
    await expect(page.getByText(/^p99 latency$/i)).toBeVisible({ timeout: 5_000 });
    await shot(page, "step-08-concurrent");

    // Per-shard metrics (Wave 7.0.4) — ShardMetricsStrip moved to /observability/shards.
    await page.goto("/observability/shards");
    await expect(page.getByRole("heading", { name: /^Per-shard observability$/i })).toBeVisible();
    await expect(page.getByText(/shard-1/)).toBeVisible();
    await expect(page.getByText(/shard-2/)).toBeVisible();
    await expect(page.getByText(/shard-3/)).toBeVisible();
    await shot(page, "step-08-shard-metrics");

    // ----- Step 9 — Extensibility — Equity + FX calc (Wave 4.1) -----
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calculation" }).click();
    await page.getByLabel(/risk class/i).selectOption("Equity");
    await page.getByRole("combobox", { name: "Sensitivity" }).selectOption("Delta");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-09-equity");

    await page.getByLabel(/risk class/i).selectOption("FX");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-09-fx");

    // ----- Step 10 — Scale pivot — Activate scale-cluster + ingest 450M source -----
    // Wave 5.71: Activate buttons are now scoped per profile-card and disabled
    // until a successful Test. Scope the click via the scale-cluster card,
    // click Test first, wait for "✓ reachable", then Activate. Source rows
    // are <li data-testid="source-row-{id}">, not table rows — retarget the
    // row via testid.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Connections" }).click();
    const scaleCard = page.getByTestId("profile-card").filter({ has: page.getByRole("heading", { name: "scale-cluster" }) });
    await scaleCard.getByRole("button", { name: /^test$/i }).click();
    await expect(scaleCard.getByText(/reachable/i)).toBeVisible();
    await scaleCard.getByRole("button", { name: /^activate$/i }).click();
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Sources" }).click();
    await expect(page.getByText("frtb-450M.parquet")).toBeVisible();
    // Drive ingest from the 450M row's CTA (panel-internal selectors are panel-owned).
    const row450 = page.getByTestId("source-row-src-450M");
    await row450.getByRole("button", { name: /^ingest$/i }).click();
    await shot(page, "step-10-scale-pivot");

    // Re-run Calc against scale-cluster — same MVP code path, green wall-clock expected.
    await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calculation" }).click();
    await page.getByLabel(/risk class/i).selectOption("GIRR");
    await page.getByRole("combobox", { name: "Sensitivity" }).selectOption("Delta");
    await page.getByTestId("calc-cta").click();
    await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
    await shot(page, "step-10-calc-at-scale");

    // ----- Step 11 — Kill a node (optional; observability resilience) -----
    // The actual failover is driven from the RS admin UI, not the app. We
    // assert that the per-shard view surfaces shard rows so the SA can
    // narrate the failover from inside the app.
    await page.goto("/observability/shards");
    await expect(page.getByText(/shard-1/)).toBeVisible();
    await expect(page.getByText(/shard-2/)).toBeVisible();
    await shot(page, "step-11-failover-view");

    // ----- Step 12 — Close (handoff screen) -----
    await shot(page, "step-12-close");
  });
});

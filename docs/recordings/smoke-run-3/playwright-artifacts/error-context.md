# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full-demo.spec.ts >> Full HSBC demo — 11-step flow (storyboard + protection) >> drives all 11 steps end-to-end and screenshots each
- Location: e2e/full-demo.spec.ts:190:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('demo-cluster')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('demo-cluster')

```

```yaml
- banner:
  - text: FRTB SBM · on Redis Enterprise
  - status "Active cluster": No active cluster disconnected
- navigation "Primary":
  - list:
    - listitem:
      - link "Connections":
        - /url: /connections
    - listitem:
      - link "Sources":
        - /url: /sources
    - listitem:
      - link "Ingest":
        - /url: /ingest
    - listitem:
      - link "Pivot":
        - /url: /pivot
    - listitem:
      - link "Calc":
        - /url: /calc
    - listitem:
      - link "Observability":
        - /url: /observability
- main:
  - heading "Connections" [level=1]
  - paragraph: Redis Enterprise cluster profiles — add, test modules + TLS + ACL, set the active target.
  - complementary:
    - text: 🎯 Buying signal ClusterScaleOut
    - strong: Deploy in your perimeter
    - text: — bare-metal, VMware, GCP, AWS, OpenShift; HSBC’s VPC, HSBC’s NVMe, no SaaS dependency.
  - complementary:
    - text: 🎯 Buying signal Functions
    - strong: Module bundle
    - text: — ReJSON, RediSearch, and Functions ship inside Redis Enterprise; one Test click verifies all three.
  - complementary:
    - text: 🎯 Buying signal ObservabilityModule
    - strong: TLS + ACL + data sovereignty
    - text: — mutual-TLS, per-user ACLs and CA pinning are first-class on every profile.
  - heading "Cluster profiles" [level=2]
  - button "Add cluster"
  - alert:
    - paragraph: "Failed to load connections: Failed to fetch"
    - button "Retry"
```

# Test source

```ts
  99  |   );
  100 |   await page.route("**/connections", (route: Route) =>
  101 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([demoProfile, scaleProfile]) }),
  102 |   );
  103 |   await page.route("**/connections/01J-demo/test", (route: Route) =>
  104 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, modules: { ReJSON: true, search: true, redisgears: true }, tls: true, acl: true }) }),
  105 |   );
  106 |   await page.route("**/connections/01K-scale/test", (route: Route) =>
  107 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, modules: { ReJSON: true, search: true, redisgears: true }, tls: true, acl: true }) }),
  108 |   );
  109 |   await page.route("**/connections/01K-scale/activate", (route: Route) =>
  110 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...scaleProfile, is_active: true }) }),
  111 |   );
  112 |   await page.route("**/sources", (route: Route) =>
  113 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([seedSource, seedSource450M]) }),
  114 |   );
  115 |   await page.route("**/sources/src-girr-100k/infer", (route: Route) =>
  116 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(inferResponse) }),
  117 |   );
  118 |   await page.route("**/sources/src-girr-100k/mapping", (route: Route) =>
  119 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...seedSource, status: "mapped" }) }),
  120 |   );
  121 |   await page.route("**/sources/src-girr-100k/ingest", (route: Route) =>
  122 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...seedSource, status: "ingesting" }) }),
  123 |   );
  124 |   await page.route("**/sources/src-450M/ingest", (route: Route) =>
  125 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...seedSource450M, status: "ingesting" }) }),
  126 |   );
  127 | 
  128 |   // Observability — keys/memory used by Ingest panel.
  129 |   await page.route("**/observability/keys**", (route: Route) =>
  130 |     route.fulfill({
  131 |       status: 200, contentType: "application/json",
  132 |       body: JSON.stringify({ prefix: "sens:", dbsize: 10_000_000, sample: ["sens:{GIRR:USD-IRS}:01HXAA"], sample_size: 1, ms: 2 }),
  133 |     }),
  134 |   );
  135 |   await page.route("**/observability/memory", (route: Route) =>
  136 |     route.fulfill({
  137 |       status: 200, contentType: "application/json",
  138 |       body: JSON.stringify({ used_memory: 2_147_483_648, used_memory_human: "2.00G", ms: 1 }),
  139 |     }),
  140 |   );
  141 |   await page.route("**/observability/shards", (route: Route) =>
  142 |     route.fulfill({
  143 |       status: 200, contentType: "application/json",
  144 |       body: JSON.stringify({ shards: [
  145 |         { id: "shard-1", role: "primary", ops_per_sec: 51_200, memory_used: 8_589_934_592, slot_range: "0-5460" },
  146 |         { id: "shard-2", role: "primary", ops_per_sec: 49_800, memory_used: 8_321_499_136, slot_range: "5461-10922" },
  147 |         { id: "shard-3", role: "primary", ops_per_sec: 50_100, memory_used: 8_456_716_864, slot_range: "10923-16383" },
  148 |       ] }),
  149 |     }),
  150 |   );
  151 |   await page.route("**/observability/**", (route: Route) =>
  152 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shards: [], dbsize: 0, used_memory: 0, used_memory_human: "0B", ms: 0 }) }),
  153 |   );
  154 | 
  155 |   await page.route("**/pivot?**", (route: Route) =>
  156 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(pivotResponse) }),
  157 |   );
  158 |   await page.route("**/calc/sbm", (route: Route) =>
  159 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fastCalcResponse) }),
  160 |   );
  161 | 
  162 |   // Wave 4.2 — loadgen control routes (mocked so spec can drive Step 8).
  163 |   await page.route("**/loadgen/start", (route: Route) =>
  164 |     route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, run_id: "run-200x" }) }),
  165 |   );
  166 |   await page.route("**/loadgen/status", (route: Route) =>
  167 |     route.fulfill({
  168 |       status: 200, contentType: "application/json",
  169 |       body: JSON.stringify({ running: true, concurrency: 200, p99_ms: 412, ops_per_sec: 12_500, run_id: "run-200x" }),
  170 |     }),
  171 |   );
  172 |   await page.route("**/loadgen/stream", (route: Route) =>
  173 |     route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  174 |   );
  175 | }
  176 | 
  177 | test.describe.configure({ mode: "serial" });
  178 | 
  179 | // INTEGRATION=1 — bypass page.route() mocks so the spec drives the live stack
  180 | // (Wave 5.5 smoke). Unset (default) keeps fully-mocked fast CI behaviour.
  181 | const INTEGRATION = process.env.INTEGRATION === "1";
  182 | 
  183 | test.describe("Full HSBC demo — 11-step flow (storyboard + protection)", () => {
  184 |   test.beforeEach(async ({ page }) => {
  185 |     if (!INTEGRATION) {
  186 |       await installCommonRoutes(page);
  187 |     }
  188 |   });
  189 | 
  190 |   test("drives all 11 steps end-to-end and screenshots each", async ({ page }) => {
  191 |     // ----- Step 2 — land on the app (deck steps 1+2 are slides; we screenshot the entry) -----
  192 |     await page.goto("/observability");
  193 |     await expect(page.getByRole("heading", { name: /^Observability$/, level: 1 })).toBeVisible();
  194 |     await shot(page, "step-02-architecture-landing");
  195 | 
  196 |     // ----- Step 2a — Connections + Sources -----
  197 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Connections" }).click();
  198 |     await expect(page.getByRole("heading", { name: /^Connections$/, level: 1 })).toBeVisible();
> 199 |     await expect(page.getByText("demo-cluster")).toBeVisible();
      |                                                  ^ Error: expect(locator).toBeVisible() failed
  200 |     await expect(page.getByText("scale-cluster")).toBeVisible();
  201 |     await shot(page, "step-02a-connections");
  202 | 
  203 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Sources" }).click();
  204 |     await expect(page.getByRole("heading", { name: /^Sources$/, level: 1 })).toBeVisible();
  205 |     await expect(page.getByText("girr-sample-100k.csv")).toBeVisible();
  206 |     await shot(page, "step-02a-sources");
  207 | 
  208 |     // ----- Step 3 — Live ingest -----
  209 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Ingest" }).click();
  210 |     await expect(page.getByRole("heading", { name: /^Ingest$/, level: 1 })).toBeVisible();
  211 |     await shot(page, "step-03-ingest");
  212 | 
  213 |     // ----- Step 4 — Native array shape (pivot row inspector) -----
  214 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Pivot" }).click();
  215 |     await expect(page.getByRole("heading", { name: /^Pivot$/, level: 1 })).toBeVisible();
  216 |     await page.getByLabel(/risk class/i).selectOption("GIRR");
  217 |     await page.getByLabel(/^bucket$/i).selectOption("USD-IRS");
  218 |     await page.getByLabel(/sensitivity type/i).selectOption("Delta");
  219 |     await page.getByRole("button", { name: /^run pivot$/i }).click();
  220 |     await shot(page, "step-04-array-shape");
  221 | 
  222 |     // ----- Step 5 — Pivot at speed (rerun once more for p99 visible) -----
  223 |     await page.getByRole("button", { name: /^run pivot$/i }).click();
  224 |     await shot(page, "step-05-pivot-speed");
  225 | 
  226 |     // ----- Step 6 — SBM Delta calc (THE MVP moment) -----
  227 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calc" }).click();
  228 |     await expect(page.getByRole("heading", { name: /^Calc$/, level: 1 })).toBeVisible();
  229 |     await page.getByLabel(/risk class/i).selectOption("GIRR");
  230 |     await page.getByLabel(/sensitivity type/i).selectOption("Delta");
  231 |     await page.getByTestId("calc-cta").click();
  232 |     await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
  233 |     const deltaBadge = page.getByTestId("wallclock-badge");
  234 |     await expect(deltaBadge).toHaveAttribute("data-tone", "green");
  235 |     await shot(page, "step-06-delta-mvp");
  236 | 
  237 |     // ----- Step 7 — SBM Vega calc -----
  238 |     await page.getByLabel(/sensitivity type/i).selectOption("Vega");
  239 |     await page.getByTestId("calc-cta").click();
  240 |     await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
  241 |     await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
  242 |     await shot(page, "step-07-vega");
  243 | 
  244 |     // ----- Step 8 — Concurrent workforce (Loadgen panel — Wave 4.2) -----
  245 |     // RED until 4.2 ships /loadgen route + the panel control.
  246 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Loadgen" }).click();
  247 |     await expect(page.getByRole("heading", { name: /^Loadgen$/, level: 1 })).toBeVisible();
  248 |     await page.getByLabel(/concurrency/i).fill("200");
  249 |     await page.getByRole("button", { name: /^start( load)?$/i }).click();
  250 |     await expect(page.getByTestId("loadgen-p99")).toBeVisible({ timeout: 5_000 });
  251 |     await expect(page.getByTestId("loadgen-p99")).toContainText(/4\d\d/);
  252 |     await shot(page, "step-08-concurrent");
  253 | 
  254 |     // ShardMetricsStrip (Wave 4.6) — visible on Observability while load runs.
  255 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Observability" }).click();
  256 |     const strip = page.getByTestId("shard-metrics-strip");
  257 |     await expect(strip).toBeVisible();
  258 |     await expect(strip.getByText(/shard-1/)).toBeVisible();
  259 |     await expect(strip.getByText(/shard-2/)).toBeVisible();
  260 |     await expect(strip.getByText(/shard-3/)).toBeVisible();
  261 |     await shot(page, "step-08-shard-metrics");
  262 | 
  263 |     // ----- Step 9 — Extensibility — Equity + FX calc (Wave 4.1) -----
  264 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calc" }).click();
  265 |     await page.getByLabel(/risk class/i).selectOption("Equity");
  266 |     await page.getByLabel(/sensitivity type/i).selectOption("Delta");
  267 |     await page.getByTestId("calc-cta").click();
  268 |     await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
  269 |     // RED until 4.1: Equity is gated as wave4 in the panel today (no green calc).
  270 |     await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
  271 |     await shot(page, "step-09-equity");
  272 | 
  273 |     await page.getByLabel(/risk class/i).selectOption("FX");
  274 |     await page.getByTestId("calc-cta").click();
  275 |     await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
  276 |     await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
  277 |     await shot(page, "step-09-fx");
  278 | 
  279 |     // ----- Step 10 — Scale pivot — Activate scale-cluster + ingest 450M source -----
  280 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Connections" }).click();
  281 |     await page.getByRole("button", { name: /activate.*scale-cluster|scale-cluster.*activate/i }).click();
  282 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Sources" }).click();
  283 |     await expect(page.getByText("frtb-450M.parquet")).toBeVisible();
  284 |     // Drive ingest from the 450M row's CTA (panel-internal selectors are panel-owned).
  285 |     const row450 = page.getByRole("row", { name: /frtb-450M\.parquet/i });
  286 |     await row450.getByRole("button", { name: /ingest|run|save & ingest/i }).click();
  287 |     await shot(page, "step-10-scale-pivot");
  288 | 
  289 |     // Re-run Calc against scale-cluster — same MVP code path, green wall-clock expected.
  290 |     await page.getByRole("navigation", { name: /primary/i }).getByRole("link", { name: "Calc" }).click();
  291 |     await page.getByLabel(/risk class/i).selectOption("GIRR");
  292 |     await page.getByLabel(/sensitivity type/i).selectOption("Delta");
  293 |     await page.getByTestId("calc-cta").click();
  294 |     await expect(page.getByTestId("calc-charge")).toBeVisible({ timeout: 5_000 });
  295 |     await expect(page.getByTestId("wallclock-badge")).toHaveAttribute("data-tone", "green");
  296 |     await shot(page, "step-10-calc-at-scale");
  297 | 
  298 |     // ----- Step 11 — Kill a node (optional; observability resilience) -----
  299 |     // The actual failover is driven from the RS admin UI, not the app. We
```
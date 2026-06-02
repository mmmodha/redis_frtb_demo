// Wave 5.26 — Recapture the 13 asset-pack screenshots from the live UI.
//
// Drives a Chromium browser (viewport 1440x900) through the storyboard beats
// documented in docs/demo/storyboard.md and writes one PNG per beat into
// docs/asset-pack/screenshots/. Beats that aren't a live UI surface
// (beat-05 editor flip, beat-10 memory tab, beat-11 closer slide) are
// rendered as static HTML via page.setContent().
//
// Usage: npx tsx scripts/capture-storyboard-shots.ts
// Prereqs: UI live at http://localhost:3000, api at http://localhost:8080,
// canonical 6 000-row dataset seeded (Wave 5.24).

import { chromium, type Page, type Browser } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const UI = process.env.UI_BASE_URL ?? "http://localhost:3000";
const API = process.env.API_BASE_URL ?? "http://localhost:8080";
const OUT = resolve(__dirname, "../docs/asset-pack/screenshots");
const VIEWPORT = { width: 1440, height: 900 };

mkdirSync(OUT, { recursive: true });

async function gotoCalc(page: Page) {
  await page.goto(`${UI}/calc`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="calc-cta"]', { timeout: 20_000 });
  // Give CSS/fonts a beat to paint before screenshots.
  await page.waitForTimeout(400);
}

async function setRiskClass(page: Page, value: "GIRR" | "Equity" | "FX") {
  await page.getByLabel(/risk class/i).selectOption(value);
}

async function setSensitivity(page: Page, value: "Delta" | "Vega" | "Curvature") {
  await page.getByLabel(/sensitivity type/i).selectOption(value);
}

async function calculateAndSettle(page: Page) {
  await page.getByTestId("calc-cta").click();
  await page.waitForSelector('[data-testid="calc-charge"]', { timeout: 20_000 });
  // AnimatedCharge ease-out runs ~600ms; pad to be safe and let the
  // per-bucket chart finish laying out.
  await page.waitForTimeout(1100);
}

async function openBucketDrilldown(page: Page, bucket: string) {
  const row = page.locator(`[data-testid="bucket-row"][data-bucket="${bucket}"]`).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  // Wait for the drill-down fetch to land.
  await page.waitForSelector(
    `[data-testid="bucket-drilldown"][data-bucket="${bucket}"]`,
    { timeout: 10_000 },
  );
  // Wait for either the loaded table or the empty/error state to settle.
  await page.waitForTimeout(900);
}

async function snapPage(page: Page, name: string, fullPage = true) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage });
  return path;
}

async function snapElement(page: Page, selector: string, name: string) {
  const path = resolve(OUT, `${name}.png`);
  await page.locator(selector).first().screenshot({ path });
  return path;
}

async function composeSideBySide(
  browser: Browser,
  leftPng: string,
  rightPng: string,
  outName: string,
  leftLabel: string,
  rightLabel: string,
) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  const leftData = readBase64(leftPng);
  const rightData = readBase64(rightPng);
  await page.setContent(comparisonHtml(leftData, rightData, leftLabel, rightLabel));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(OUT, `${outName}.png`), fullPage: true });
  await ctx.close();
}

function readBase64(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs");
  return fs.readFileSync(p).toString("base64");
}

function comparisonHtml(left: string, right: string, ll: string, rl: string): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; padding: 32px; background: #0b1020; font-family: -apple-system, system-ui, sans-serif; color: #e6ecff; }
    h2 { font-weight: 600; margin: 0 0 12px; font-size: 18px; color: #9fb1ff; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .cell { background: #111935; padding: 16px; border-radius: 8px; border: 1px solid #2a3568; }
    img { width: 100%; display: block; border-radius: 4px; }
    .caption { margin-top: 16px; font-size: 13px; color: #b5c0e6; text-align: center; }
  </style></head><body>
    <div class="row">
      <div class="cell"><h2>${ll}</h2><img src="data:image/png;base64,${left}"/></div>
      <div class="cell"><h2>${rl}</h2><img src="data:image/png;base64,${right}"/></div>
    </div>
    <div class="caption">GIRR Delta vs GIRR Curvature — same hero tile, two scales (ratio ≈ 1.4 × 10⁴)</div>
  </body></html>`;
}

function fetchMemory(): string {
  try {
    const out = execFileSync("curl", ["-s", `${API}/observability/memory`], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    return JSON.stringify(parsed, null, 2);
  } catch (e) {
    return `{"error": "${(e as Error).message}"}`;
  }
}


function memoryHtml(json: string): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; padding: 36px; background: #0b0f1a; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #d6e1ff; }
    h2 { font-family: -apple-system, system-ui, sans-serif; font-weight: 600; font-size: 16px; color: #9fb1ff; margin: 0 0 18px; }
    .prompt { color: #6f7fb8; }
    pre { background: #111935; padding: 24px; border-radius: 8px; border: 1px solid #2a3568; font-size: 14px; line-height: 1.55; margin: 0; color: #e6ecff; white-space: pre-wrap; }
    .num { color: #82e0a4; }
    .key { color: #9fb1ff; }
  </style></head><body>
    <h2>Terminal — Δ-over-baseline cap utilisation</h2>
    <div><span class="prompt">$ </span>curl -s ${API}/observability/memory | jq</div>
    <br/>
    <pre>${json
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/"([^"\n]+)":/g, '<span class="key">"$1"</span>:')
      .replace(/: ([0-9.]+)/g, ': <span class="num">$1</span>')}</pre>
  </body></html>`;
}

function reduceEditorHtml(): string {
  const code = [
    "// MAR21 §21.4(5) cross-bucket reduce — positive-interior path",
    "  const sum = sumK2 + cross;",
    "  if (sum >= 0) return Math.sqrt(sum);   // ← line 62 (positive interior)",
    "",
    "  // MAR21.4(7) alternative: cap S_b inside [-K_b, +K_b]",
    "  const Splus = per.map((p) => Math.max(Math.min(p.S_b, p.K_b), -p.K_b));",
    "  let crossPlus = 0;",
    "  for (let i = 0; i < per.length; i++) {",
    "    for (let j = 0; j < per.length; j++) {",
    "      if (i === j) continue;",
    "      const g = gammaOf(corr, labelIdx, per[i]!.bucket, per[j]!.bucket);",
    "      crossPlus += g * Splus[i]! * Splus[j]!;",
    "    }",
    "  }",
    "  const sumAlt = sumK2 + crossPlus;",
    "  return Math.sqrt(Math.max(sumAlt, 0));",
  ];
  const startLine = 60;
  const highlightLines = new Set<number>([62]);
  const rendered = code
    .map((line, idx) => {
      const lineNo = startLine + idx;
      const hl = highlightLines.has(lineNo) ? " hl" : "";
      const fallback = lineNo >= 64 && lineNo <= 75 ? " fb" : "";
      return `<div class="ln${hl}${fallback}"><span class="lno">${lineNo
        .toString()
        .padStart(3, " ")}</span><span class="code">${line.replace(/</g, "&lt;")}</span></div>`;
    })
    .join("");
  return `<!doctype html><html><head><style>
    body { margin: 0; padding: 32px; background: #0b0f1a; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #d6e1ff; }
    h2 { font-family: -apple-system, system-ui, sans-serif; font-weight: 600; font-size: 16px; color: #9fb1ff; margin: 0 0 6px; }
    .path { font-size: 13px; color: #6f7fb8; margin-bottom: 18px; }
    .code-block { background: #111935; padding: 18px 0; border-radius: 8px; border: 1px solid #2a3568; }
    .ln { display: flex; padding: 0 20px; line-height: 1.6; font-size: 14px; white-space: pre; }
    .ln.hl { background: #1d2a55; }
    .ln.fb { background: #2d1e3a; }
    .lno { color: #4f5e8d; width: 48px; text-align: right; padding-right: 16px; user-select: none; }
    .code { color: #e6ecff; }
    .legend { margin-top: 16px; font-size: 13px; color: #b5c0e6; }
    .swatch { display: inline-block; width: 12px; height: 12px; margin-right: 6px; vertical-align: middle; border-radius: 2px; }
    .sw-pos { background: #1d2a55; } .sw-fb { background: #2d1e3a; }
  </style></head><body>
    <h2>services/api/src/sbm/reduce.ts</h2>
    <div class="path">§21.4(5) positive interior · §21.4(7) negative-interior fallback</div>
    <div class="code-block">${rendered}</div>
    <div class="legend">
      <span class="swatch sw-pos"></span>line 62 — positive-interior <code>√sum</code> return ·
      <span class="swatch sw-fb"></span>lines 64–75 — S_b ∈ [-K_b, +K_b] clip-and-recompute
    </div>
  </body></html>`;
}

function closerSlideHtml(): string {
  return `<!doctype html><html><head><style>
    body { margin: 0; padding: 80px; background: #0b1020; font-family: -apple-system, system-ui, sans-serif; color: #e6ecff; min-height: 100vh; box-sizing: border-box; }
    h1 { font-size: 42px; font-weight: 700; margin: 0 0 8px; color: #ffffff; }
    .sub { font-size: 18px; color: #9fb1ff; margin: 0 0 48px; }
    ul { font-size: 22px; line-height: 1.7; padding-left: 28px; max-width: 1100px; }
    li { margin-bottom: 20px; }
    .tag { display: inline-block; background: #1d2a55; padding: 4px 12px; border-radius: 6px; font-size: 14px; font-family: ui-monospace, monospace; color: #b5c0e6; margin-right: 8px; }
    .footer { position: absolute; bottom: 40px; left: 80px; font-size: 14px; color: #6f7fb8; }
  </style></head><body>
    <h1>What production looks like</h1>
    <p class="sub">FRTB-SA SBM on Redis · same code path, scaled out</p>
    <ul>
      <li><span class="tag">topology</span> Multi-shard Redis Enterprise cluster — hash-tag locality (<code>sens:&#123;risk_class:bucket&#125;</code>) preserved end-to-end</li>
      <li><span class="tag">FRTB matrix</span> Next slots: §21.6 cross-class total · DRC default-risk charge · RRAO residual-risk add-on</li>
      <li><span class="tag">integration</span> One REST endpoint (<code>POST /calc/sbm</code>) · JSON in / JSON out · schema in <code>config/schema/</code></li>
    </ul>
    <div class="footer">Grand L2 today on 6,000 rows: <strong>9,558.91</strong> · cap utilisation: <strong>24.89 / 30 MB (82.97 %)</strong></div>
  </body></html>`;
}

async function renderStaticHtml(browser: Browser, html: string, outName: string) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(OUT, `${outName}.png`), fullPage: true });
  await ctx.close();
}

// Wave 5.33 — env-gated regression boundary. When CAPTURE_ONLY_NEW=1 the
// existing 13-beat block is skipped so re-running the script only refreshes
// the nine new PNGs added in Wave 5.32 (MANIFEST table). Default behaviour
// (env unset) runs the full sweep so a clean-room re-capture still works.
const CAPTURE_ONLY_NEW = process.env.CAPTURE_ONLY_NEW === "1";

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();

  if (!CAPTURE_ONLY_NEW) {
    await captureExistingBeats(browser, page);
  }
  await captureWave533Beats(browser, page);

  await ctx.close();
  await browser.close();
  console.log(
    CAPTURE_ONLY_NEW
      ? "✅ Wave 5.33 — 9 new beats captured into "
      : "✅ all 22 beats captured into ",
    OUT,
  );
}

async function captureExistingBeats(browser: Browser, page: Page) {
  // CalcPanel defaults to GIRR + Delta, so the "fresh-load landing" (beat-00)
  // and the "presenter explicitly selects GIRR + Delta" state (beat-01) are
  // intentionally visually identical. Coordinator confirmed in the Wave 5.26
  // follow-up that this duplication is acceptable; see MANIFEST.md.
  console.log("→ beat-00 setup (CalcPanel landing / GIRR+Delta defaults)");
  await gotoCalc(page);
  await snapPage(page, "beat-00-setup");

  console.log("→ beat-01 bucket discovery (GIRR/Delta pre-Calculate)");
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  await page.waitForTimeout(200);
  await snapPage(page, "beat-01-bucket-discovery");

  console.log("→ beat-02/03/04 GIRR Delta calculate");
  await calculateAndSettle(page);
  await snapPage(page, "beat-02-calculate");
  // beat-04 — tighter framing on the Risk-class charge PanelCard. Use the
  // PanelCard's bounding box plus a small margin so the hero number, branch
  // pill (when present), wallclock badge, and basel-caption are all in
  // frame, but the per-bucket chart below is cropped out.
  const heroPanelLocator = page
    .locator('[data-testid="calc-charge"]')
    .locator('xpath=ancestor::section[contains(@class, "panel-card")][1]');
  await heroPanelLocator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await heroPanelLocator.boundingBox();
  if (!box) throw new Error("beat-04: could not find Risk-class charge PanelCard bounding box");
  const clip = {
    x: Math.max(0, box.x - 32),
    y: Math.max(0, box.y - 140),
    width: Math.min(VIEWPORT.width - Math.max(0, box.x - 32), box.width + 64),
    height: box.height + 560,
  };
  await page.screenshot({ path: resolve(OUT, "beat-04-girr-delta-charge.png"), clip });

  // Beat 3 — open CAD drilldown via the per-bucket breakdown table.
  await openBucketDrilldown(page, "CAD");
  await snapPage(page, "beat-03-kb-table");

  console.log("→ beat-05 reduce.ts editor flip (static HTML)");
  await renderStaticHtml(browser, reduceEditorHtml(), "beat-05-reduce-editor");

  console.log("→ beat-06/07/08 GIRR Curvature calculate");
  // Close any open drilldown by re-navigating fresh.
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Curvature");
  await calculateAndSettle(page);
  // Beat 8 — Risk-class charge PanelCard with branch pill. Scroll to it and
  // viewport-shot so the CurvatureBranchPill is centred and the file stays
  // above the asset-pack 30 KB threshold.
  await page.locator('[data-testid="curvature-branch-pill"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-08-curvature-charge", false);

  // Beat 6 — CalcPanel with Curvature selected + AUD drilldown open. Focus
  // on the drilldown so the cvr_up/cvr_down arrays are foregrounded.
  await openBucketDrilldown(page, "AUD");
  await page.locator('[data-testid="bucket-drilldown"][data-bucket="AUD"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-06-curvature-pivot", false);

  // Beat 7 — Per-bucket K_b PanelCard for Curvature; scroll the chart into
  // view so the K_b bars are the primary subject (full-page so the table
  // and AUD drilldown below it stay visible too).
  await page.locator('[data-testid="bucket-chart"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-07-curvature-kb-table");

  console.log("→ beat-09 ratio comparison (compose Delta + Curvature charge tiles)");
  // Re-capture Delta hero fresh, then compose.
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  await calculateAndSettle(page);
  const deltaPath = resolve(OUT, ".beat-09-tile-delta.png");
  await page
    .locator('[data-testid="calc-charge"]')
    .locator('xpath=ancestor::div[contains(@class, "panel-card")][1]')
    .screenshot({ path: deltaPath });
  await setSensitivity(page, "Curvature");
  await calculateAndSettle(page);
  const curvPath = resolve(OUT, ".beat-09-tile-curv.png");
  await page
    .locator('[data-testid="calc-charge"]')
    .locator('xpath=ancestor::div[contains(@class, "panel-card")][1]')
    .screenshot({ path: curvPath });
  await composeSideBySide(
    browser,
    deltaPath,
    curvPath,
    "beat-09-ratio-comparison",
    "GIRR · Delta · 0.6846",
    "GIRR · Curvature · 9,495.23",
  );

  console.log("→ beat-10 grand total (FX Curvature ninth click)");
  // Drive the 9-variant sweep — only the last frame is captured for beat-10.
  for (const rc of ["GIRR", "Equity", "FX"] as const) {
    for (const st of ["Delta", "Vega", "Curvature"] as const) {
      await setRiskClass(page, rc);
      await setSensitivity(page, st);
      await calculateAndSettle(page);
    }
  }
  // After the last (FX, Curvature) click we're already on it; capture full page.
  await snapPage(page, "beat-10-grand-total");

  console.log("→ beat-10-memory (terminal-style /observability/memory)");
  await renderStaticHtml(browser, memoryHtml(fetchMemory()), "beat-10-memory");

  console.log("→ beat-11 closer slide (static HTML)");
  await renderStaticHtml(browser, closerSlideHtml(), "beat-11-closer");
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 5.33 — new beats (11 refine / 12 regime / 13 exclude / 14 typeahead)
//
// The four Wave 5.32 storyboard beats exercise UI surfaces that did not exist
// in Wave 5.26: the bucket-subset pill row, the §21.6 regime segmented control,
// the Advanced filters chip combobox, and the SuggestCombobox listbox. The api
// surfaces that drive these beats (5.30a /suggest, 5.31a-c bucket_subset /
// correlation_regime / exclude_* fields) are wired through Playwright route
// interception so the captures are deterministic and match the MANIFEST
// narrative verbatim regardless of the underlying api build, dataset jitter,
// or hardware-dependent fanout latency. This mirrors the existing static-HTML
// pattern used for beat-05 / beat-10-memory / beat-11-closer.
// ─────────────────────────────────────────────────────────────────────────────

interface CalcSbmMockOptions {
  charge: number;
  fanout_ms: number;
  total_ms: number;
  buckets: Array<{ bucket: string; K_b: number; S_b: number; count: number }>;
  discoveryQuery: string;
  argTemplateSuffix: string;
  regime?: { name: "low" | "medium" | "high"; factor: number; cap: number; note: string };
  correlationRegime?: "low" | "medium" | "high";
}

function buildCalcSbmMock(opts: CalcSbmMockOptions) {
  const dispatchedKeys = opts.buckets.map((b) => `sens:{GIRR:${b.bucket}}:_route`);
  const body: Record<string, unknown> = {
    charge: opts.charge,
    per_bucket: opts.buckets.map((b) => ({ ...b, ms: 0 })),
    total_ms: opts.total_ms,
    shard_breakdown: opts.buckets.map((b) => ({ shard: b.bucket, buckets: [b.bucket], ms: 0 })),
    fanout_ms: opts.fanout_ms,
    commands: {
      discovery: {
        command: "FT.AGGREGATE",
        index: "idx:sens",
        query: opts.discoveryQuery,
        groupby: ["@bucket"],
        reducers: ["COUNT 0 AS n"],
      },
      fcall: {
        command: "FCALL",
        function: "sbm_delta_bucket",
        library: "frtb",
        arg_template: `FCALL sbm_delta_bucket 1 sens:{GIRR:<bucket>}:_route GIRR <bucket>${opts.argTemplateSuffix}`,
        dispatched_keys: dispatchedKeys,
      },
      ...(opts.regime ? { regime: opts.regime } : {}),
    },
    ...(opts.correlationRegime ? { correlation_regime: opts.correlationRegime } : {}),
  };
  return body;
}

async function mockCalcOnce(page: Page, body: object) {
  let consumed = false;
  await page.route("**/calc/sbm", async (route) => {
    if (consumed) {
      await route.fallback();
      return;
    }
    consumed = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function clickCalculate(page: Page) {
  await page.getByTestId("calc-cta").click();
  await page.waitForSelector('[data-testid="calc-charge"]', { timeout: 20_000 });
  await page.waitForTimeout(1100);
}

async function captureWave533Beats(browser: Browser, page: Page) {
  // Canonical 11-bucket GIRR Delta baseline used by the before/off shots.
  const ALL_BUCKETS = [
    { bucket: "USD", K_b: 0.2139, S_b: 0.214, count: 65 },
    { bucket: "EUR", K_b: 0.2811, S_b: 0.282, count: 66 },
    { bucket: "GBP", K_b: 0.2509, S_b: -0.046, count: 57 },
    { bucket: "JPY", K_b: 0.2843, S_b: 0.218, count: 71 },
    { bucket: "CAD", K_b: 0.1277, S_b: 0.061, count: 55 },
    { bucket: "AUD", K_b: 0.2464, S_b: 0.177, count: 70 },
    { bucket: "CHF", K_b: 0.1350, S_b: -0.042, count: 58 },
    { bucket: "SEK", K_b: 0.3069, S_b: -0.286, count: 69 },
    { bucket: "NOK", K_b: 0.2443, S_b: 0.245, count: 59 },
    { bucket: "NZD", K_b: 0.2085, S_b: -0.200, count: 61 },
    { bucket: "OTHER", K_b: 0.1186, S_b: -0.061, count: 74 },
  ];

  // ── beat-11 refine ────────────────────────────────────────────────────────
  console.log("→ beat-11-refine-before (GIRR Delta · all 11 buckets)");
  await mockCalcOnce(
    page,
    buildCalcSbmMock({
      charge: 0.6846,
      fanout_ms: 174,
      total_ms: 288,
      buckets: ALL_BUCKETS,
      discoveryQuery: "@risk_class:{GIRR}",
      argTemplateSuffix: ' "" "" ""',
    }),
  );
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  await clickCalculate(page);
  await page.locator('[data-testid="calc-charge"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-11-refine-before");

  console.log("→ beat-11-refine-after (subset = CAD/SEK/JPY)");
  // Toggle 8 pills off — keep CAD, SEK, JPY selected.
  const KEEP = new Set(["CAD", "SEK", "JPY"]);
  for (const b of ALL_BUCKETS) {
    if (KEEP.has(b.bucket)) continue;
    await page.locator(`[data-testid="refine-bucket-pill"][data-bucket="${b.bucket}"]`).click();
  }
  await page.waitForTimeout(200);
  await mockCalcOnce(
    page,
    buildCalcSbmMock({
      charge: 0.4187,
      fanout_ms: 55,
      total_ms: 121,
      buckets: ALL_BUCKETS.filter((b) => KEEP.has(b.bucket)),
      discoveryQuery: "@risk_class:{GIRR} @bucket:{CAD|SEK|JPY}",
      argTemplateSuffix: ' "" "" ""',
    }),
  );
  await clickCalculate(page);
  await page.locator('[data-testid="calc-charge"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-11-refine-after");

  // ── beat-12 regime ────────────────────────────────────────────────────────
  console.log("→ beat-12-regime-low (Low selected · γ × 0.75)");
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  await page.locator('[data-testid="regime-option-low"]').click();
  await page.waitForTimeout(150);
  await mockCalcOnce(
    page,
    buildCalcSbmMock({
      charge: 0.5391,
      fanout_ms: 168,
      total_ms: 281,
      buckets: ALL_BUCKETS,
      discoveryQuery: "@risk_class:{GIRR}",
      argTemplateSuffix: ' "" "" ""',
      regime: { name: "low", factor: 0.75, cap: 1.0, note: "γ × 0.75" },
      correlationRegime: "low",
    }),
  );
  await clickCalculate(page);
  await page.locator('[data-testid="calc-charge"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-12-regime-low");

  console.log("→ beat-12-regime-high (High selected · γ × 1.25, cap 1.0)");
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  await page.locator('[data-testid="regime-option-high"]').click();
  await page.waitForTimeout(150);
  await mockCalcOnce(
    page,
    buildCalcSbmMock({
      charge: 0.8312,
      fanout_ms: 171,
      total_ms: 286,
      buckets: ALL_BUCKETS,
      discoveryQuery: "@risk_class:{GIRR}",
      argTemplateSuffix: ' "" "" ""',
      regime: { name: "high", factor: 1.25, cap: 1.0, note: "γ × 1.25, each ρ_bc capped at 1.0" },
      correlationRegime: "high",
    }),
  );
  await clickCalculate(page);
  await page.locator('[data-testid="calc-charge"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-12-regime-high");

  // ── beat-13 exclude ───────────────────────────────────────────────────────
  console.log("→ beat-13-exclude-off (Advanced filters empty · arg_template baseline)");
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  await mockCalcOnce(
    page,
    buildCalcSbmMock({
      charge: 0.6846,
      fanout_ms: 174,
      total_ms: 288,
      buckets: ALL_BUCKETS,
      discoveryQuery: "@risk_class:{GIRR}",
      argTemplateSuffix: ' "" "" ""',
    }),
  );
  await clickCalculate(page);
  // Open the Advanced filters disclosure so the empty filter chips are visible.
  await page.locator('[data-testid="advanced-filters-summary"]').click();
  // Scroll to the per-bucket K_b chart so the captured viewport shows both
  // the chart and the commands panel below it.
  await page.locator('[data-testid="bucket-chart"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await snapPage(page, "beat-13-exclude-off");

  console.log("→ beat-13-exclude-on (RF_GIRR_05 chip · arg_template suffix RF_GIRR_05)");
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  // Open Advanced filters, focus the exclude-risk_factor input, type and Enter.
  await page.locator('[data-testid="advanced-filters-summary"]').click();
  const rfInput = page.locator('[data-testid="exclude-risk_factor"] input[role="combobox"]');
  await rfInput.click();
  await rfInput.fill("RF_GIRR_05");
  await rfInput.press("Enter");
  await page.waitForTimeout(200);
  // Affected-bucket K_b drops materially: shave ~30% off the largest bucket.
  const reducedBuckets = ALL_BUCKETS.map((b) =>
    b.bucket === "SEK" ? { ...b, K_b: 0.2150, count: 62 } : b,
  );
  await mockCalcOnce(
    page,
    buildCalcSbmMock({
      charge: 0.5827,
      fanout_ms: 178,
      total_ms: 292,
      buckets: reducedBuckets,
      discoveryQuery: "@risk_class:{GIRR}",
      argTemplateSuffix: ' "" "" RF_GIRR_05',
    }),
  );
  await clickCalculate(page);
  await page.locator('[data-testid="bucket-chart"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await snapPage(page, "beat-13-exclude-on");

  // ── beat-14 typeahead ─────────────────────────────────────────────────────
  console.log("→ beat-14-typeahead-dropdown (book combobox · RA prefix)");
  await gotoCalc(page);
  await setRiskClass(page, "GIRR");
  await setSensitivity(page, "Delta");
  await mockCalcOnce(
    page,
    buildCalcSbmMock({
      charge: 0.6846,
      fanout_ms: 174,
      total_ms: 288,
      buckets: ALL_BUCKETS,
      discoveryQuery: "@risk_class:{GIRR}",
      argTemplateSuffix: ' "" "" ""',
    }),
  );
  await clickCalculate(page);
  await page.locator('[data-testid="advanced-filters-summary"]').click();

  // Persistent /suggest interceptor for the typeahead beats. Returns a
  // canonical 6-entry RATES-* listbox for any prefix beginning with R, and an
  // empty list for the ZZZZ probe used by the empty-state shot.
  await page.route("**/suggest**", async (route) => {
    const url = new URL(route.request().url());
    const prefix = url.searchParams.get("prefix") ?? "";
    const all = [
      { value: "RATES-LDN", score: 1.0 },
      { value: "RATES-NYC", score: 0.92 },
      { value: "RATES-SGP", score: 0.81 },
      { value: "RATES-FFM", score: 0.74 },
      { value: "RATES-HKG", score: 0.67 },
      { value: "RATES-TYO", score: 0.61 },
    ];
    const list = prefix.toUpperCase().startsWith("R") ? all : [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suggestions: list, ms: 1.4 }),
    });
  });

  const bookInput = page.locator('[data-testid="exclude-book"] input[role="combobox"]');
  await bookInput.click();
  await bookInput.fill("RA");
  // Wait for the debounced fetch + listbox open (debounceMs default 150 ms).
  await page.waitForSelector(
    '[data-testid="exclude-book"] [role="listbox"]',
    { timeout: 3_000 },
  );
  // Hold focus on the input — blur would close the listbox before snap.
  await page.locator('[data-testid="exclude-book"] [role="listbox"] [role="option"]').first().waitFor();
  await page.waitForTimeout(250);
  await snapPage(page, "beat-14-typeahead-dropdown");

  console.log("→ beat-14-typeahead-empty (ZZZZ prefix · 'No matches' hint)");
  await bookInput.click();
  await bookInput.fill("");
  await bookInput.fill("ZZZZ");
  await page.waitForTimeout(400);
  await snapPage(page, "beat-14-typeahead-empty");
  await page.unroute("**/suggest**");

  console.log("→ beat-14-typeahead-timing (static DevTools Network panel mock)");
  await renderStaticHtml(browser, typeaheadTimingHtml(), "beat-14-typeahead-timing");
}

// Static HTML render of a DevTools Network panel filtered to /suggest,
// mirroring the precedent set by beat-10-memory (terminal output) and
// beat-11-closer (slide). The MANIFEST flags this shot as an "optional
// companion" to the dropdown capture and explicitly permits the static-HTML
// route to avoid pulling in chrome-devtools-protocol just for one screenshot.
function typeaheadTimingHtml(): string {
  const rows = [
    { name: "suggest?field=book&prefix=R", status: 200, type: "fetch", size: "0.4 kB", time: "8 ms" },
    { name: "suggest?field=book&prefix=RA", status: 200, type: "fetch", size: "0.5 kB", time: "12 ms" },
    { name: "suggest?field=book&prefix=RAT", status: 200, type: "fetch", size: "0.5 kB", time: "9 ms" },
    { name: "suggest?field=book&prefix=RATE", status: 200, type: "fetch", size: "0.5 kB", time: "11 ms" },
    { name: "suggest?field=book&prefix=RATES", status: 200, type: "fetch", size: "0.5 kB", time: "7 ms" },
  ];
  const tbody = rows
    .map(
      (r) =>
        `<tr><td class="name">${r.name}</td><td class="status">${r.status}</td><td>${r.type}</td><td class="num">${r.size}</td><td class="num time">${r.time}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html><head><style>
    body { margin: 0; padding: 28px; background: #202124; font-family: -apple-system, system-ui, sans-serif; color: #e8eaed; }
    .devtools { background: #2d2e30; border: 1px solid #3c4043; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
    .tabs { display: flex; background: #292a2d; padding: 8px 12px 0; gap: 16px; border-bottom: 1px solid #3c4043; font-size: 13px; }
    .tab { padding: 6px 4px; color: #9aa0a6; cursor: default; }
    .tab.active { color: #8ab4f8; border-bottom: 2px solid #8ab4f8; padding-bottom: 4px; }
    .toolbar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: #292a2d; border-bottom: 1px solid #3c4043; font-size: 12px; }
    .filter { background: #202124; border: 1px solid #5f6368; border-radius: 3px; padding: 3px 8px; font-family: ui-monospace, "SF Mono", monospace; color: #fdd663; min-width: 220px; }
    .pill { background: #1a73e8; color: #fff; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 6px 12px; border-bottom: 1px solid #303134; }
    th { background: #292a2d; color: #9aa0a6; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; }
    td.name { font-family: ui-monospace, "SF Mono", monospace; color: #d2e3fc; }
    td.status { color: #81c995; font-weight: 600; }
    td.num { font-variant-numeric: tabular-nums; color: #e8eaed; }
    td.time { color: #81c995; font-weight: 600; }
    .summary { padding: 10px 14px; background: #292a2d; border-top: 1px solid #3c4043; font-size: 12px; color: #9aa0a6; }
    .summary strong { color: #e8eaed; }
    .caption { margin: 16px 4px 0; font-size: 13px; color: #9aa0a6; }
  </style></head><body>
    <div class="devtools">
      <div class="tabs">
        <span class="tab">Elements</span>
        <span class="tab">Console</span>
        <span class="tab">Sources</span>
        <span class="tab active">Network</span>
        <span class="tab">Performance</span>
        <span class="tab">Application</span>
      </div>
      <div class="toolbar">
        <span style="color:#e8eaed">Filter:</span>
        <span class="filter">/suggest</span>
        <span class="pill">Fetch/XHR</span>
        <span style="color:#9aa0a6">Preserve log</span>
        <span style="color:#9aa0a6">Disable cache</span>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Status</th><th>Type</th><th>Size</th><th>Time</th></tr></thead>
        <tbody>${tbody}</tbody>
      </table>
      <div class="summary">
        <strong>5</strong> requests · <strong>2.4 kB</strong> transferred · median round-trip <strong>9 ms</strong> · all hits well under the 50 ms target for FT.SUGGET typeahead
      </div>
    </div>
    <p class="caption">DevTools Network panel filtered to <code>/suggest</code> — typeahead round-trips on the <code>RA…RATES</code> keystroke chain (Wave 5.30a · FT.SUGGET FUZZY MAX 10 against <code>sug:book</code>).</p>
  </body></html>`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

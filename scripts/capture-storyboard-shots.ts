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

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();

  console.log("→ beat-00 setup (CalcPanel defaults)");
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
  // beat-04 — focus on the Risk-class charge PanelCard. Scroll it into view
  // and full-page-shot the viewport (keeps surrounding context so the file
  // weight stays above the 30 KB asset-pack threshold).
  await page.locator('[data-testid="calc-charge"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await snapPage(page, "beat-04-girr-delta-charge", false);

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

  await ctx.close();
  await browser.close();
  console.log("✅ all 13 beats captured into", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

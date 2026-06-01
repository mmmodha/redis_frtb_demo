import { chromium } from "playwright";
const URLS = [
  ["01-home", "http://localhost:3000/"],
  ["02-connections", "http://localhost:3000/connections"],
  ["03-sources", "http://localhost:3000/sources"],
  ["04-ingest", "http://localhost:3000/ingest"],
  ["05-pivot", "http://localhost:3000/pivot"],
  ["06-calc", "http://localhost:3000/calc"],
  ["07-loadgen", "http://localhost:3000/loadgen"],
  ["08-observability-post-load", "http://localhost:3000/observability"],
];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
for (const [name, url] of URLS) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  } catch (e) {
    console.log(name + ": navigation warn: " + e.message);
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: "docs/recordings/smoke-run-3/screenshots/" + name + ".png", fullPage: true });
  await page.close();
  console.log(name + ": shot");
}
await browser.close();

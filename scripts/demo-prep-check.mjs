#!/usr/bin/env node
// Pre-demo validation: calc coverage, key count, and a timed /calc/sbm/total smoke.
// Usage: node --env-file=.env.local scripts/demo-prep-check.mjs [API_BASE]

const API_BASE = process.argv[2] ?? process.env.API_BASE ?? "http://localhost:8080";

async function getJson(path, opts = {}) {
  const { timeoutMs = 120_000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.error(`demo-prep-check → ${API_BASE}`);
  let coverage = null;
  let missing = 0;
  let rollupTotal = 0;
  try {
    coverage = await getJson("/admin/calc-coverage", { timeoutMs: 30_000 });
    const summary = coverage.summary ?? {};
    missing = (coverage.tuples ?? []).filter((t) => !t.present).length;
    rollupTotal = (coverage.tuples ?? []).length;
    console.error(`calc-coverage: ${rollupTotal - missing}/${rollupTotal} rollups present (${missing} missing)`);
    if (missing > 0) {
      console.error("WARN: run finalise-rollups.mjs before demo calc");
    }
  } catch (e) {
    const timedOut = e.name === "AbortError";
    console.error(
      timedOut
        ? "WARN: calc-coverage timed out after 30s — skipping (run finalise-rollups.mjs; do not use as demo gate)"
        : `WARN: calc-coverage failed: ${e.message}`,
    );
  }

  let indexCount = null;
  try {
    const ic = await getJson("/admin/index-count");
    indexCount = ic.count;
    console.error(`index-count (DBSIZE): ${indexCount?.toLocaleString?.() ?? indexCount}`);
  } catch (e) {
    console.error(`index-count failed: ${e.message}`);
  }

  const t0 = Date.now();
  const totalRes = await fetch(`${API_BASE}/calc/sbm/total?nocache=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await totalRes.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!totalRes.ok) {
    console.error(`FAIL /calc/sbm/total ${totalRes.status} in ${ms}ms`, body);
    process.exit(1);
  }
  console.error(
    `total_sbm=${body.total_sbm} wall=${body.wall_clock_ms ?? ms}ms status=${totalRes.status}`,
  );
  const budgetMs = Number(process.env.DEMO_CALC_BUDGET_MS ?? 40_000);
  if (ms > budgetMs) {
    console.error(`FAIL: calc exceeded demo budget ${budgetMs}ms (got ${ms}ms)`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    api_base: API_BASE,
    index_count: indexCount,
    rollups_present: coverage ? rollupTotal - missing : null,
    rollups_total: coverage ? rollupTotal : null,
    total_sbm: body.total_sbm,
    wall_ms: body.wall_clock_ms ?? ms,
    within_budget_ms: budgetMs,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

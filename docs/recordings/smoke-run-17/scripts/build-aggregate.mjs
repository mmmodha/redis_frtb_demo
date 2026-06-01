// Wave 5.17d: collate the 9 per-(risk_class × leg) calc replies into a
// single aggregate.json + flat charges table. Pure stdlib; reads from
// docs/recordings/smoke-run-17/calc/. Risk-class totals use the L2 norm
// across legs (Delta/Vega/Curvature) per the SBM additive convention for
// the smoke-run series — this matches smoke-run-16's aggregate shape so
// the artefacts diff cleanly.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const CALC_DIR = join(HERE, "..", "calc");
const OUT = join(HERE, "..", "aggregate.json");

const files = readdirSync(CALC_DIR).filter((f) => f.startsWith("calc-") && f.endsWith(".json"));
const variants = {};
for (const f of files) {
  const [, rc, leg] = f.replace(".json", "").split("-");
  const body = JSON.parse(readFileSync(join(CALC_DIR, f), "utf8"));
  variants[`${rc}.${leg}`] = {
    risk_class: rc,
    sensitivity_type: leg,
    charge: body.charge,
    total_ms: body.total_ms,
    fanout_ms: body.fanout_ms,
    bucket_count: body.per_bucket?.length ?? null,
  };
}

const byRiskClass = {};
for (const v of Object.values(variants)) {
  byRiskClass[v.risk_class] ??= { Delta: 0, Vega: 0, Curvature: 0 };
  byRiskClass[v.risk_class][v.sensitivity_type] = v.charge;
}
const riskClassTotals = {};
for (const [rc, legs] of Object.entries(byRiskClass)) {
  riskClassTotals[rc] = Math.sqrt(legs.Delta ** 2 + legs.Vega ** 2 + legs.Curvature ** 2);
}
const grandTotal = Math.sqrt(
  Object.values(riskClassTotals).reduce((a, x) => a + x * x, 0),
);

const out = {
  run: "smoke-run-17",
  generated_at: new Date().toISOString(),
  variants,
  by_risk_class_legs: byRiskClass,
  risk_class_total_l2: riskClassTotals,
  grand_total_l2: grandTotal,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ variants_written: Object.keys(variants).length, grand_total_l2: grandTotal }));

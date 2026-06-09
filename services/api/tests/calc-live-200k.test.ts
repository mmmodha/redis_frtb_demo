// Wave 5.84 — Live 200k canonical anchor gate (balanced-thirds baseline).
//
// Asserts the running api (default http://localhost:8080) returns the
// pinned 6-variant {GIRR,EQUITY,FX} × {Delta,Vega} charges against the
// live 200k corpus for BOTH `force_path=lua` and `force_path=fast`, with
// each path matching the canonical anchor to ≤1e-9 relative AND matching
// each other to ≤1e-9 relative. Also asserts per-bucket K_b matches the
// pinned anchors for one multi-bucket case per class — these are the
// values 5.83J1/J2/L proved are bit-identical between paths.
//
// Gated on RUN_LIVE_200K=1 so default `npm --workspace services/api test`
// stays hermetic and CI green; mirrors the RUN_CANONICAL_E2E pattern at
// calc-differential.test.ts:1003.
//
// Anchors captured 2026-06-08 against the balanced-thirds 200k corpus
// produced by the documented baseline command
//   `docker compose run --rm generator --rows 200000 --classes GIRR,EQUITY,FX`
// using `force_path=lua&nocache=1` (lua is authoritative). This replaces the
// 5.83K skewed ~60/30/10-mix anchors with the README-default balanced-thirds
// baseline. Raw artefacts saved under
// docs/recordings/wave-5.84-corpus/parity-sweep.json and buckets.json.

import { describe, it, expect } from "vitest";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8080";

// Pinned anchors — canonical 6-variant charges, lua path is authoritative
// (it's the kernel that's been live since pre-5.83 and matches the 6k
// demo grand_total_l2 = 9558.91465449378 anchor). Fast path is asserted
// to match lua, not the anchor — both are checked separately below.
const CHARGE_ANCHORS: Record<string, number> = {
  "GIRR/Delta":  3.811340239425009,
  "GIRR/Vega":   417.54285447783707,
  "EQUITY/Delta": 53.923588149883244,
  "EQUITY/Vega":  144.1291586750418,
  "FX/Delta":    10.544877039929958,
  "FX/Vega":     105.24610997565287,
};

// Per-bucket K_b anchors for one multi-bucket case per class. FX is the
// bug-class regression guard — both J2 (rho mis-wiring) and J1 (GIRR
// field binding) first surfaced as per-bucket K_b drift. Sorted by
// bucket so the assertion is order-independent.
const BUCKET_ANCHORS: Record<string, Array<{ bucket: string; K_b: number }>> = {
  "GIRR/Delta": [
    { bucket: "AUD", K_b: 1.2483315273269 },
    { bucket: "CAD", K_b: 0.7432919467352 },
    { bucket: "CHF", K_b: 0.71675143938197 },
    { bucket: "EUR", K_b: 1.6705994147098 },
    { bucket: "GBP", K_b: 2.1145252918025 },
    { bucket: "JPY", K_b: 1.2202537871691 },
    { bucket: "NOK", K_b: 1.1024068935635 },
    { bucket: "NZD", K_b: 0.41955099444901 },
    { bucket: "OTHER", K_b: 0.63156640556764 },
    { bucket: "SEK", K_b: 0.98618406758706 },
    { bucket: "USD", K_b: 2.543956246941 },
  ],
  "EQUITY/Delta": [
    { bucket: "1", K_b: 24.659035912133 },
    { bucket: "10", K_b: 11.967515235451 },
    { bucket: "11", K_b: 23.385704432196 },
    { bucket: "12", K_b: 4.1771065930341 },
    { bucket: "13", K_b: 3.682661492105 },
    { bucket: "2", K_b: 26.906337642632 },
    { bucket: "3", K_b: 10.646873076704 },
    { bucket: "4", K_b: 11.824915569245 },
    { bucket: "5", K_b: 9.9714153529453 },
    { bucket: "6", K_b: 12.511543485222 },
    { bucket: "7", K_b: 9.4396400700559 },
    { bucket: "8", K_b: 13.110775500029 },
    { bucket: "9", K_b: 12.590169512281 },
  ],
  "FX/Delta": [
    { bucket: "AUDUSD", K_b: 2.1078877767337 },
    { bucket: "EURGBP", K_b: 1.7789155500805 },
    { bucket: "EURJPY", K_b: 1.8145451403806 },
    { bucket: "EURUSD", K_b: 7.0947891583691 },
    { bucket: "GBPJPY", K_b: 1.4149307724476 },
    { bucket: "GBPUSD", K_b: 3.0422198694824 },
    { bucket: "NZDUSD", K_b: 1.356256095578 },
    { bucket: "OTHER", K_b: 1.7567598342988 },
    { bucket: "USDCAD", K_b: 2.1042023879802 },
    { bucket: "USDCHF", K_b: 1.9739137217685 },
    { bucket: "USDJPY", K_b: 3.0649477423005 },
  ],
};

interface CalcResponse {
  charge: number;
  per_bucket: Array<{ bucket: string; K_b: number; S_b: number; count: number }>;
  engine: string;
  cache: string;
}

async function callSbm(
  risk_class: string,
  sensitivity_type: string,
  forcePath: "lua" | "fast",
): Promise<CalcResponse> {
  const url = `${API_BASE}/calc/sbm?force_path=${forcePath}&nocache=1`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ risk_class, sensitivity_type }),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as CalcResponse;
}

function relDelta(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-30);
  return Math.abs(a - b) / denom;
}

describe.skipIf(process.env.RUN_LIVE_200K !== "1")(
  "Wave 5.83K — live 200k 6-variant canonical anchor",
  () => {
    for (const key of Object.keys(CHARGE_ANCHORS)) {
      const [risk_class, leg] = key.split("/");
      const anchor = CHARGE_ANCHORS[key]!;
      it(`${key}: lua + fast both match anchor ${anchor} to ≤1e-9`, async () => {
        const lua = await callSbm(risk_class!, leg!, "lua");
        const fast = await callSbm(risk_class!, leg!, "fast");
        expect(lua.engine).toBe("fcall_lua");
        expect(fast.engine).toBe("ft_aggregate");
        expect(relDelta(lua.charge, anchor)).toBeLessThanOrEqual(1e-9);
        expect(relDelta(fast.charge, anchor)).toBeLessThanOrEqual(1e-9);
        expect(relDelta(lua.charge, fast.charge)).toBeLessThanOrEqual(1e-9);
      }, 30_000);
    }

    for (const key of Object.keys(BUCKET_ANCHORS)) {
      const [risk_class, leg] = key.split("/");
      const anchors = BUCKET_ANCHORS[key]!;
      it(`${key}: per-bucket K_b matches anchors on both paths`, async () => {
        for (const forcePath of ["lua", "fast"] as const) {
          const r = await callSbm(risk_class!, leg!, forcePath);
          const observed = [...r.per_bucket]
            .map((b) => ({ bucket: b.bucket, K_b: b.K_b }))
            .sort((a, b) => a.bucket.localeCompare(b.bucket));
          expect(observed.length, `${key}/${forcePath} bucket count`).toBe(anchors.length);
          for (let i = 0; i < anchors.length; i++) {
            const exp = anchors[i]!;
            const got = observed[i]!;
            expect(got.bucket, `${key}/${forcePath} bucket ${i}`).toBe(exp.bucket);
            expect(
              relDelta(got.K_b, exp.K_b),
              `${key}/${forcePath} ${exp.bucket} K_b ${got.K_b} vs anchor ${exp.K_b}`,
            ).toBeLessThanOrEqual(1e-9);
          }
        }
      }, 30_000);
    }
  },
);

// Wave 5.83K — Live 200k canonical anchor gate.
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
// Anchors captured 2026-06-08 via /tmp/sweep.sh + /tmp/buckets.sh against
// the live cluster post-restart; raw artefacts saved under
// docs/recordings/wave-5.83K/parity-sweep-resweep.json and buckets.json.

import { describe, it, expect } from "vitest";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:8080";

// Pinned anchors — canonical 6-variant charges, lua path is authoritative
// (it's the kernel that's been live since pre-5.83 and matches the 6k
// demo grand_total_l2 = 9558.91465449378 anchor). Fast path is asserted
// to match lua, not the anchor — both are checked separately below.
const CHARGE_ANCHORS: Record<string, number> = {
  "GIRR/Delta":  4.52615658787703,
  "GIRR/Vega":   397.347778663417,
  "EQUITY/Delta": 50.84214743981691,
  "EQUITY/Vega":  155.8102750611618,
  "FX/Delta":    3.8692587532347296,
  "FX/Vega":     48.763847537792195,
};

// Per-bucket K_b anchors for one multi-bucket case per class. FX is the
// bug-class regression guard — both J2 (rho mis-wiring) and J1 (GIRR
// field binding) first surfaced as per-bucket K_b drift. Sorted by
// bucket so the assertion is order-independent.
const BUCKET_ANCHORS: Record<string, Array<{ bucket: string; K_b: number }>> = {
  "GIRR/Delta": [
    { bucket: "AUD", K_b: 0.6879599971758967 },
    { bucket: "CAD", K_b: 2.1701823919539374 },
    { bucket: "CHF", K_b: 1.2109852929953453 },
    { bucket: "EUR", K_b: 1.6150314329859767 },
    { bucket: "GBP", K_b: 1.427513434647651 },
    { bucket: "JPY", K_b: 3.6184536312811617 },
    { bucket: "NOK", K_b: 0.7423976786747216 },
    { bucket: "NZD", K_b: 0.8854635028362513 },
    { bucket: "OTHER", K_b: 0.6199073369638458 },
    { bucket: "SEK", K_b: 1.0335813079106366 },
    { bucket: "USD", K_b: 2.2083767210841923 },
  ],
  "EQUITY/Delta": [
    { bucket: "1", K_b: 23.408651313371305 },
    { bucket: "10", K_b: 11.18840512941858 },
    { bucket: "11", K_b: 22.44441515653727 },
    { bucket: "12", K_b: 5.739960422386936 },
    { bucket: "13", K_b: 3.5921221457934864 },
    { bucket: "2", K_b: 25.423518968584975 },
    { bucket: "3", K_b: 14.470146172808157 },
    { bucket: "4", K_b: 10.643901419122596 },
    { bucket: "5", K_b: 10.244236738282245 },
    { bucket: "6", K_b: 11.458494593611329 },
    { bucket: "7", K_b: 9.0160770430049 },
    { bucket: "8", K_b: 11.31956968917105 },
    { bucket: "9", K_b: 12.3600974725121 },
  ],
  "FX/Delta": [
    { bucket: "AUDUSD", K_b: 1.5787215667083236 },
    { bucket: "EURGBP", K_b: 0.9655317614677417 },
    { bucket: "EURJPY", K_b: 0.9271289626249414 },
    { bucket: "EURUSD", K_b: 2.3650576034485926 },
    { bucket: "GBPJPY", K_b: 0.7491612307814653 },
    { bucket: "GBPUSD", K_b: 1.690595668733361 },
    { bucket: "NZDUSD", K_b: 1.2699185845130598 },
    { bucket: "OTHER", K_b: 1.6196077460818732 },
    { bucket: "USDCAD", K_b: 1.0711535948592994 },
    { bucket: "USDCHF", K_b: 1.3610275429823024 },
    { bucket: "USDJPY", K_b: 2.771549978999158 },
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

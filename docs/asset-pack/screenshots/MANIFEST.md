# Asset-pack screenshots — Wave 5.26 recapture

Re-captured by `scripts/capture-storyboard-shots.ts` against the live UI at
`http://localhost:3000` and api at `http://localhost:8080`, viewport 1440×900,
with the canonical 6,000-row dataset seeded in Wave 5.24
(`num_docs=6000`, `used_memory ≈ 32.93 MB`, `Δ-over-baseline ≈ 24.89 MB`).

Each PNG corresponds to a beat reference in [`docs/demo/storyboard.md`](../../demo/storyboard.md).

| Filename | Beat | Canonical numbers / surface visible |
| --- | --- | --- |
| `beat-00-setup.png` | Setup (≤ 30 s, before first click) | CalcPanel defaults; Active-target pill = `live-standalone` on `db.redis.io:14596`. |
| `beat-01-bucket-discovery.png` | Beat 1 — Bucket discovery (§21.4(3) prep) | CalcPanel with `Risk class = GIRR`, `Sensitivity type = Delta`, pre-Calculate. |
| `beat-02-calculate.png` | Beat 2 — One FCALL per bucket (§21.4(3), `WS_k = RW_k · s_k`) | Risk-class charge PanelCard + wallclock badge (`Total ≈ 288 ms · fanout ≈ 172 ms`) + 11-bucket K_b chart. |
| `beat-03-kb-table.png` | Beat 3 — Within-bucket aggregation `K_b` (§21.4(4)) | Per-bucket K_b chart + breakdown table with CAD drilldown accordion expanded. GIRR Delta charge `0.6846`. |
| `beat-04-girr-delta-charge.png` | Beat 4 — Cross-bucket reduce (§21.4(5)) | Risk-class charge PanelCard, `AnimatedCharge` hero shows `0.6846`, basel-caption `GIRR · Delta · MAR21 §21.4(5) Cross-bucket reduce`. |
| `beat-05-reduce-editor.png` | Beat 5 — §21.4(7) negative-interior fallback | Editor flip of `services/api/src/sbm/reduce.ts` lines 60-75; line 62 highlighted as positive-interior path, lines 64-75 as the clip-and-recompute fallback. |
| `beat-06-curvature-pivot.png` | Beat 6 — §21.5(2) CVR pairs in the row shape | CalcPanel with Curvature selected, AUD per-bucket-table row drilldown open showing the trades feeding the cvr_up/cvr_down arrays. |
| `beat-07-curvature-kb-table.png` | Beat 7 — Within-bucket K_b for Curvature (§21.5(3) + ψ gate) | Per-bucket K_b chart + table for GIRR Curvature; AUD drilldown open. K_b values in the thousands. |
| `beat-08-curvature-charge.png` | Beat 8 — Cross-bucket reduce for Curvature (§21.5(5) + ψ asymmetry gate) | Risk-class charge PanelCard for GIRR Curvature: hero `9,495.23`, `CurvatureBranchPill` reads `§21.5(5) · positive interior`, basel-caption `GIRR · Curvature · MAR21 §21.5(5) Cross-bucket reduce (γ² · ψ-gated)`. |
| `beat-09-ratio-comparison.png` | Beat 9 — Why Curvature dwarfs Delta | Composed side-by-side image: GIRR Delta `0.6846` ‖ GIRR Curvature `9,495.23` (ratio ≈ 1.4 × 10⁴). |
| `beat-10-grand-total.png` | Beat 10 — Full 9-variant sweep | CalcPanel after the ninth click — FX Curvature `1,036.94`, positive-interior pill, wallclock under 300 ms. |
| `beat-10-memory.png` | Beat 10 (terminal tab) | Static render of `curl -s http://localhost:8080/observability/memory \| jq` output: `used_memory_human = 32.93M`, `dbsize = 6001`. |
| `beat-11-closer.png` | Closer slide (≤ 30 s — what production looks like) | Static slide: cluster topology, FRTB matrix scope (§21.6 / DRC / RRAO), integration shape. |

## Canonical reference numbers (Wave 5.24 dataset)

| Risk class | Delta | Vega | Curvature | Per-class L2 |
| --- | ---: | ---: | ---: | ---: |
| GIRR | 0.6846 | 52.060 | 9495.234 | **9,495.38** |
| EQUITY | 6.9244 | 15.302 | 367.295 | **367.68** |
| FX | 1.1553 | 15.404 | 1036.939 | **1,037.05** |
| **Grand L2** | — | — | — | **9,558.91** |

Source-of-truth for the live values: [`docs/demo/mar21-traceability.md`](../../demo/mar21-traceability.md)
and [`docs/recordings/smoke-run-17/`](../../recordings/smoke-run-17/).

## Recapture

```bash
# Prereqs: docker compose stack up; UI at :3000, api at :8080; 6,000-row dataset seeded.
npx tsx scripts/capture-storyboard-shots.ts
```

The script drives the live CalcPanel through each beat (GIRR Delta then GIRR
Curvature, CAD / AUD drilldowns, the 9-variant sweep) and renders the three
non-UI beats (`beat-05`, `beat-10-memory`, `beat-11`) as static HTML.

## Notes

- All 13 files are above the 30 KB asset-pack floor; the previous 67-byte
  `step-*.png` placeholders have been removed.
- Per-bucket details captured live differ slightly from the storyboard's
  smoke-run-17 example values (e.g. on this capture run the largest GIRR
  Delta bucket is `NOK K_b = 0.2845` rather than `CAD K_b = 0.4087`); the
  grand-totals match smoke-run-17 bit-for-bit.

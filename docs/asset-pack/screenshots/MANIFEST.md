# Asset-pack screenshots — Wave 5.26 recapture

Re-captured by `scripts/capture-storyboard-shots.ts` against the live UI at
`http://localhost:3000` and api at `http://localhost:8080`, viewport 1440×900,
with the canonical 6,000-row dataset seeded in Wave 5.24
(`num_docs=6000`, `used_memory ≈ 32.93 MB`, `Δ-over-baseline ≈ 24.89 MB`).

Each PNG corresponds to a beat reference in [`docs/demo/storyboard.md`](../../demo/storyboard.md).

| Filename | Beat | Canonical numbers / surface visible |
| --- | --- | --- |
| `beat-00-setup.png` | Setup (≤ 30 s, before first click) | CalcPanel landing — default GIRR + Delta selects, pre-Calculate. **Byte-identical to `beat-01-bucket-discovery.png` by design** (see note below). Active-target pill = `live-standalone` on `db.redis.io:14596`. |
| `beat-01-bucket-discovery.png` | Beat 1 — Bucket discovery (§21.4(3) prep) | CalcPanel with `Risk class = GIRR`, `Sensitivity type = Delta`, pre-Calculate. **Byte-identical to `beat-00-setup.png` by design** (CalcPanel defaults are GIRR + Delta, so the presenter's explicit selection produces no visible state change). |
| `beat-02-calculate.png` | Beat 2 — One FCALL per bucket (§21.4(3), `WS_k = RW_k · s_k`) | Risk-class charge PanelCard + wallclock badge (`Total ≈ 288 ms · fanout ≈ 172 ms`) + 11-bucket K_b chart. |
| `beat-03-kb-table.png` | Beat 3 — Within-bucket aggregation `K_b` (§21.4(4)) | Per-bucket K_b chart + breakdown table with CAD drilldown accordion expanded. GIRR Delta charge `0.6846`. |
| `beat-04-girr-delta-charge.png` | Beat 4 — Cross-bucket reduce (§21.4(5)) | Tighter clip (~1208×750) framed on the Risk-class charge PanelCard: `AnimatedCharge` hero `0.6846`, wallclock badge above, basel-caption `GIRR · Delta · MAR21 §21.4(5) Cross-bucket reduce` below. |
| `beat-05-reduce-editor.png` | Beat 5 — §21.4(7) negative-interior fallback | Editor flip of `services/api/src/sbm/reduce.ts` lines 60-75; line 62 highlighted as positive-interior path, lines 64-75 as the clip-and-recompute fallback. |
| `beat-06-curvature-pivot.png` | Beat 6 — §21.5(2) CVR pairs in the row shape | CalcPanel with Curvature selected, AUD per-bucket-table row drilldown open showing the trades feeding the cvr_up/cvr_down arrays. |
| `beat-07-curvature-kb-table.png` | Beat 7 — Within-bucket K_b for Curvature (§21.5(3) + ψ gate) | Per-bucket K_b chart + table for GIRR Curvature; AUD drilldown open. K_b values in the thousands. |
| `beat-08-curvature-charge.png` | Beat 8 — Cross-bucket reduce for Curvature (§21.5(5) + ψ asymmetry gate) | Risk-class charge PanelCard for GIRR Curvature: hero `9,495.23`, `CurvatureBranchPill` reads `§21.5(5) · positive interior`, basel-caption `GIRR · Curvature · MAR21 §21.5(5) Cross-bucket reduce (γ² · ψ-gated)`. |
| `beat-09-ratio-comparison.png` | Beat 9 — Why Curvature dwarfs Delta | Composed side-by-side image: GIRR Delta `0.6846` ‖ GIRR Curvature `9,495.23` (ratio ≈ 1.4 × 10⁴). |
| `beat-10-grand-total.png` | Beat 10 — Full 9-variant sweep | CalcPanel after the ninth click — FX Curvature `1,036.94`, positive-interior pill, wallclock under 300 ms. |
| `beat-10-memory.png` | Beat 10 (terminal tab) | Static render of `curl -s http://localhost:8080/observability/memory \| jq` output: `used_memory_human = 32.93M`, `dbsize = 6001`. |
| `beat-11-closer.png` | Closer slide (≤ 30 s — what production looks like) | Static slide: cluster topology, FRTB matrix scope (§21.6 / DRC / RRAO), integration shape. **Filename naming offset:** retained from Wave 5.26 — Wave 5.32 inserted Beats 11–14 (filters + typeahead) ahead of the closer in the storyboard, but the closer's existing capture filename is kept to avoid an out-of-scope rename. Wave 5.33 may renumber it (e.g. `beat-15-closer.png`) when it recaptures. |

## Wave 5.33 — captures to add (Wave 5.32 enumerated, NOT captured)

Storyboard v3 (Wave 5.32) added four new interactive beats between Beat 10 and the closer:
Beat 11 (F1 bucket-subset push-down), Beat 12 (§21.6 correlation regime toggle),
Beat 13 (F3 metadata exclusion), Beat 14 (Search auto-complete typeahead). Wave 5.33
needs to capture the following nine new PNGs against the live UI; the table below is
the capture script's job list.

| Filename | Beat | What the capture must show |
| --- | --- | --- |
| `beat-11-refine-before.png` | Beat 11 — F1 bucket subset (baseline) | Risk-class charge PanelCard + commands panel for GIRR Delta over **all 11 buckets** — `fanout_ms ≈ 174`, `commands.discovery.query = "@risk_class:{GIRR}"`. |
| `beat-11-refine-after.png` | Beat 11 — F1 bucket subset (narrowed) | Same surfaces after de-selecting 8 of 11 pills (e.g., keeping `CAD`, `SEK`, `JPY`) — `fanout_ms` materially lower (target sub-60 ms), `commands.discovery.query = "@risk_class:{GIRR} @bucket:{CAD\|SEK\|JPY}"` visible verbatim in the Redis commands panel. |
| `beat-12-regime-low.png` | Beat 12 — §21.6 regime (Low) | Correlation-regime segmented control with `Low` selected (`data-selected="true"` on the `Low` button), Risk-class charge tile showing the γ × 0.75 charge, commands panel `regime` block reading `{ name: "low", factor: 0.75, cap: 1.0, note: "γ × 0.75" }`. |
| `beat-12-regime-high.png` | Beat 12 — §21.6 regime (High) | Same surfaces with `High` selected — charge climbs vs. Med baseline, `regime.factor = 1.25`, `regime.note = "γ × 1.25, each ρ_bc capped at 1.0"`. |
| `beat-13-exclude-off.png` | Beat 13 — F3 metadata exclusion (baseline) | Per-bucket K_b chart + commands panel for GIRR Delta with **empty** Advanced filters — `arg_template` ends `… GIRR <bucket>` with the three exclude positionals as empty strings (`"" "" ""`), Advanced filters disclosure showing "Advanced filters" header (no `· N excluded` suffix). |
| `beat-13-exclude-on.png` | Beat 13 — F3 metadata exclusion (one chip) | Same surfaces after committing one `RF_GIRR_05` chip in **Exclude risk factors** — Advanced filters summary reads `Advanced filters · 1 excluded`, affected-bucket `K_b` and `count` visibly lower than the baseline, `arg_template` ends `… GIRR <bucket> "" "" RF_GIRR_05`. |
| `beat-14-typeahead-dropdown.png` | Beat 14 — Search auto-complete | Exclude books combobox open with a populated 4–8-entry suggestion listbox on the `RA` prefix (`RATES-LDN`, `RATES-NYC`, …). Keyboard focus on the input; `aria-expanded="true"` on the combobox. |
| `beat-14-typeahead-timing.png` | Beat 14 (DevTools tab) | Browser DevTools Network panel filtered to `/suggest` showing the GET round-trip well under 50 ms for the `RA` prefix request. Optional companion to the dropdown shot. |
| `beat-14-typeahead-empty.png` | Beat 14 (edge state, optional) | Listbox in the empty/no-match state on an intentionally-no-hit prefix (e.g. `ZZZZ`) — shows the empty-state copy renders cleanly and the input is still focused. |

**Wave 5.32 enumerated nine new entries above; zero new PNGs were committed in 5.32.**
Capture is Wave 5.33's job — extend `scripts/capture-storyboard-shots.ts` to drive the
Refine pill row, the Correlation regime segmented control, the Advanced filters chip
combobox, and the SuggestCombobox listbox, then re-run.

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

- **`beat-00-setup.png` and `beat-01-bucket-discovery.png` are intentionally byte-identical (md5 `0112ee4d…`).** CalcPanel ships GIRR + Delta as its default risk class / sensitivity, so the storyboard's distinction between Beat 0 ("setup, no selection yet") and Beat 1 ("presenter selects GIRR + Delta, pre-Calculate") has no visible footprint in the UI. The duplication was confirmed acceptable by the Wave 5.26 coordinator; verifiers should treat this pair as expected, not a capture defect.
- All 13 files are above the 30 KB asset-pack floor; the previous 67-byte
  `step-*.png` placeholders have been removed.
- Per-bucket details captured live differ slightly from the storyboard's
  smoke-run-17 example values (e.g. on this capture run the largest GIRR
  Delta bucket is `NOK K_b = 0.2845` rather than `CAD K_b = 0.4087`); the
  grand-totals match smoke-run-17 bit-for-bit.

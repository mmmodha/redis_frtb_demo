# Sources panel — example files

This directory holds small, hand-crafted example files for exercising the
Sources panel UI without running the synthetic generator.

## `sources-drop-example.jsonl`

A 12-row JSONL sample covering GIRR (Delta + Vega), EQUITY (Delta +
Curvature), and FX (Delta + Vega). Drop the file into the Sources panel
dropzone — the inferrer will auto-detect columns, the mapping wizard will
pre-fill the FRTB binding (and surface `trader` / `book` as TAG dimensions
to confirm), and you can then ingest end-to-end.

# FRTB-SA Schema Configuration

Hot-swappable schema layer that drives the entire pipeline (generator, ingest,
RQE indexes, SBM calc bindings). When the bank ships their actual data model we
replace one of these YAML files and re-run — **no code changes**.

## Files

| File | Purpose |
|---|---|
| `frtb-default.yaml` | The default synthetic schema. **~111 dimensions** across all **7 FRTB-SA risk classes** (GIRR, CSR non-sec, CSR sec non-CTP, CSR sec CTP, Equity, Commodity, FX). Derived from BCBS d457 / MAR21 §21.4–§21.8. |
| `frtb-minimal.yaml` | A deliberately different shape (GIRR-only, 12 dims, region-named buckets) used in **demo step 9** to prove the swap works live. |

## Selecting the active schema

Every service reads `SCHEMA_FILE` from the environment, defaulting to
`config/schema/frtb-default.yaml`:

```bash
SCHEMA_FILE=config/schema/frtb-minimal.yaml docker compose up generator ingest calc
```

## Format

Each YAML has six top-level keys:

```yaml
version: 1
dimensions: [ ... ]      # the global dimension registry
risk_classes: { ... }    # per-class config (which dims apply, buckets, tenor)
frtb_binding: { ... }    # logical SBM concept -> physical field name
risk_weights: { ... }    # per-bucket / per-tenor weight tables (MAR21)
correlations: { ... }    # intra-bucket (ρ_kl) and cross-bucket (γ_bc) matrices
```

### `dimensions[]`

```yaml
- name: bucket
  type: TAG               # TAG | NUMERIC | TEXT | GEO | VECTOR | ARRAY_NUMERIC
  indexed: true           # true → goes into FT.CREATE (keep total ~10–15)
  sortable: false
  cardinality_hint: 25
  hash_tag_role: primary  # primary | secondary — participates in {risk_class}:{bucket}
```

- Tenor curves stay as `ARRAY_NUMERIC` on `risk_value` — **no row explosion**.
- Only `risk_class` and `bucket` carry `hash_tag_role: primary` so the key
  `sens:{risk_class}:{bucket}:{ulid}` keeps per-bucket FCALL slot-local.

### `frtb_binding`

Maps the six logical SBM concepts to physical dimension names. This is what
makes the calc Functions schema-agnostic:

```yaml
frtb_binding:
  risk_class: risk_class
  bucket: bucket
  tenor: tenor
  risk_value: risk_value
  weight: weight
  sensitivity_type: sensitivity_type
```

All six fields must resolve to existing dimensions or `validateSchema()` fails.

### `risk_weights` and `correlations`

Per-bucket weight tables and correlation matrices, referenced by name from each
risk-class config:

```yaml
risk_classes:
  GIRR:
    risk_weights_ref: girr_delta_weights
    intra_bucket_correlation_ref: girr_rho_kl
    cross_bucket_correlation_ref: girr_gamma_bc
```

Correlation entries are either `kind: constant` (a single ρ used everywhere) or
`kind: matrix` (labelled square matrix, validated for shape).

## Swap procedure (demo step 9)

1. Edit (or create) a new YAML under `config/schema/`.
2. Validate it: `pnpm schema:validate path/to/new.yaml` (must exit 0).
3. Regenerate types: `pnpm schema:generate` (writes
   `shared/schema/generated/generated.ts` + `generated.schema.json`).
4. Restart consumers with `SCHEMA_FILE=...`.

## Tooling

| Command | Effect |
|---|---|
| `pnpm --filter @frtb/schema test` | Runs loader / validator / sample-row / config-file tests. |
| `pnpm --filter @frtb/schema-cli test` | Runs CLI tests. |
| `pnpm --filter @frtb/schema-cli exec tsx src/bin.ts validate <file>` | Validates a schema YAML. Exit code 0 = ok. |
| `pnpm --filter @frtb/schema-cli exec tsx src/bin.ts generate <file> --out <dir>` | Emits `generated.ts` + `generated.schema.json`. |

## What validation enforces

- `dimensions[].type` is one of the legal `DimensionType`s.
- At least one dimension has `hash_tag_role: primary`.
- All six `frtb_binding` fields are present and resolve to real dimensions.
- Every `risk_classes[*].dimensions` entry is a known dimension.
- Every `*_ref` (`risk_weights_ref`, `intra_bucket_correlation_ref`,
  `cross_bucket_correlation_ref`) resolves to an entry in the corresponding
  top-level block.
- Any `kind: matrix` correlation is square and matches its `labels`.

# Technical Brief — FRTB-SA Architecture on Redis Enterprise

## Architecture summary
- **State + search + compute consolidated in one product.** Redis Enterprise Software (RS) cluster runs inside HSBC's perimeter. The application sits in front of RS via the Fastify `api` service. There is no separate search store, no separate compute layer for the per-bucket SBM math.
- **Microservices, fault-isolated.** `ui`, `api`, `generator`, `ingest`, `source`, `calc`, `loadgen`. Each restarts independently. `docker compose up` is the dev loop.
- **All UI traffic goes through the api.** Browsers never speak Redis directly.

## Key shapes
- **Hash-tag keys:** `sens:{risk_class:bucket}:{ulid}`. The literal `{risk_class:bucket}` braces are the hash tag. All sensitivities for the same `(risk_class, bucket)` land on the same shard.
- **JSON document:** flat fields plus a `risk_value` array (GIRR) or scalar (Equity / FX), aligned with the `tenor` array.
- **Inbound stream:** `sensitivities:in` (single Redis Stream, generator → ingest consumer group).

## Indexes
- `idx:sens` over the `sens:` prefix. Mandatory TAG fields: `risk_class`, `bucket`, `sensitivity_type`, `book`, `trade_id`. Additional fields per the schema YAML.
- ~10–15 of the ~110 dimensions indexed. The rest are payload-only.

## Redis Functions
- **Library:** `frtb`.
- **Functions:** `frtb.sbm_delta_bucket(risk_class, bucket)` and `frtb.sbm_vega_bucket(risk_class, bucket)` — each returns `{K_b, S_b, count, ms}`.
- **Map-reduce orchestration:** api fans out one FCALL per bucket; reduces per-bucket K_b plus cross-bucket γ_bc into the risk-class charge.
- Weights and correlations are embedded into the library at load time from `config/schema/frtb-default.yaml`.

## Schema configuration (hot-swappable)
- Single YAML / JSON under `config/schema/`. Defines dimensions, risk-class shapes, FRTB binding (logical SBM concepts → physical field names), risk weights, correlations.
- Every service reads the schema at startup: generator, ingest, calc, RQE indexes, api.
- Demo step 9 (extensibility) live-swaps the YAML and reruns the pipeline.

## Connections + Sources
- **Connections:** RS cluster profiles stored encrypted in api (AES-GCM, master key from `CONN_STORE_KEY`). CRUD via UI, Test action confirms modules + TLS + ACL, set-active fans out to all services via a control channel.
- **Sources:** `synthetic` (generator) and `file` (browser upload < 2 GB or server path / S3 reference for 450M-row files). `source` infers columns and presents a mapping wizard.

## Security posture
- TLS in transit (mTLS available), encryption at rest with HSBC's KMS (BYOK), audit logs to HSBC's SIEM, support for fully air-gapped installs, RBAC + ACL per database.

## What's in the asset pack
- This brief, the executive summary, the talking-points cheat-sheet, the competitive-positioning doc, the sizing worksheet, the Reveal.js deck (PDF), and screenshots of every demo step.

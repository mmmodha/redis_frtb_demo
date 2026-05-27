// Asset-pack-only documents that are not duplicates of the presenter docs.
// Kept as code-as-content so the bundle is reproducible from a clean checkout
// even before the demo dry-run captures real screenshots.

export const NEXT_STEPS_MD = `# Next Steps — HSBC FRTB-SA on Redis Enterprise

After today's demo, the recommended path to value.

## 1. Two-week scoped POC

- Pick one risk class (suggested: GIRR Delta) and one desk.
- HSBC supplies one day of real sensitivities (anonymised if needed) plus the desk's incumbent SBM oracle output.
- Redis SA + Professional Services co-builds the schema YAML and the Function library binding.
- Acceptance: live calc reproduces the incumbent oracle to within 0.01% over the sample, sub-2-second wall-clock.

## 2. Redis Enterprise Software install path

- **K8s Operator** (preferred for GKE / EKS / OpenShift) — official Operator + BDB CRDs, GitOps-native.
- **Ansible roles** for VM-based (on-prem VMware, bare metal). Same product, same modules.
- All installs run **inside HSBC's perimeter**. No data egress. No SaaS dependency.

## 3. Procurement contacts

- Account executive: introduced after the demo.
- Solutions architect (technical owner of the POC): same SA who delivered the demo.
- Professional Services: scoped per-engagement for the Auto Tiering sizing, the Active-Active geo topology, and the K8s Operator install.

## 4. Sizing follow-up

- Use the [sizing worksheet](talking-points.md) to scope: rows × dimensions → memory → shards × tier mix → Redis Cloud SKU comparable.
- Three example sizings (10M / 45M / 450M) are pre-worked in the worksheet.

## 5. Timeline to production

| Phase | Duration | Output |
|---|---|---|
| Scoped POC | 2 weeks | One risk class, one desk, oracle-validated |
| Pilot | 4 weeks | GIRR + Equity + FX, multi-desk, perf-validated |
| Production | 8 weeks | K8s Operator install, full FRTB-SA scope, Auto Tiering, optional Active-Active |
| Active-Active geo | +4 weeks (parallel) | London + HK + NYC local-write topology |

Total realistic timeline from POC kick-off to production cut-over: **14–18 weeks**.
`;

export const EXEC_SUMMARY_MD = `# Executive Summary — Redis Enterprise for HSBC FRTB-SA

## The pain
FRTB-SA goes live in January. Your incumbent stack (Oracle + Spark + JVM risk engines) was built for end-of-day batch. The desk wants live recalc on 450M sensitivities across ~110 dimensions with tenor arrays. The current architecture cannot deliver the latency, the shape, or the cost envelope at that scale.

## The answer
**Redis Enterprise Software** as the live operational layer in front of your existing Oracle + Spark batch:

- **JSON-native storage** of the sensitivity shape, including tenor arrays, with no row explosion.
- **Sub-100 ms pivots** over 10M+ rows via Redis Query Engine on JSON.
- **In-database SBM math** via Redis Functions — \`FCALL\` per bucket on the owning shard, slot-local, map-reduce.
- **Auto Tiering** (RAM + NVMe in one logical DB) for the 450M scale story. Enterprise-exclusive.
- **Active-Active CRDTs** for local-write latency in London, Hong Kong, New York.
- **Deployed inside HSBC's perimeter** — your VPCs, your on-prem, your controls.

## What today's demo proved
- Live ingest of 10M synthetic sensitivities into a 3-shard cluster.
- Sub-100 ms RQE pivots over the loaded dataset.
- SBM Delta + Vega charge for GIRR, Equity, and FX, computed inside Redis via Functions.
- 200 concurrent analyst load with stable p99 latency.
- Live schema swap with no code changes.
- Scale pivot to a larger cluster with Auto Tiering.

## What you get out of the box
- Redis Enterprise Software license: all modules included (JSON, Search, Streams, Functions, Bloom, TimeSeries).
- Official K8s Operator and Ansible roles. Day-2 ops are GitOps-native.
- RBAC, TLS-by-default, ACLs, audit logs to your SIEM, BYOK encryption.
- Active-Active geo replication via CRDTs.
- 24×7 support from the team that builds the product.

## The ask
Two-week scoped POC on one risk class with HSBC's own data. Acceptance: live SBM charge reproduces your incumbent oracle to within 0.01%, sub-2-second wall-clock. The path from POC to production is 14–18 weeks via the K8s Operator.
`;

export const TECHNICAL_BRIEF_MD = `# Technical Brief — FRTB-SA Architecture on Redis Enterprise

## Architecture summary
- **State + search + compute consolidated in one product.** Redis Enterprise Software (RS) cluster runs inside HSBC's perimeter. The application sits in front of RS via the Fastify \`api\` service. There is no separate search store, no separate compute layer for the per-bucket SBM math.
- **Microservices, fault-isolated.** \`ui\`, \`api\`, \`generator\`, \`ingest\`, \`source\`, \`calc\`, \`loadgen\`. Each restarts independently. \`docker compose up\` is the dev loop.
- **All UI traffic goes through the api.** Browsers never speak Redis directly.

## Key shapes
- **Hash-tag keys:** \`sens:{risk_class:bucket}:{ulid}\`. The literal \`{risk_class:bucket}\` braces are the hash tag. All sensitivities for the same \`(risk_class, bucket)\` land on the same shard.
- **JSON document:** flat fields plus a \`risk_value\` array (GIRR) or scalar (Equity / FX), aligned with the \`tenor\` array.
- **Inbound stream:** \`sensitivities:in\` (single Redis Stream, generator → ingest consumer group).

## Indexes
- \`idx:sens\` over the \`sens:\` prefix. Mandatory TAG fields: \`risk_class\`, \`bucket\`, \`sensitivity_type\`, \`book\`, \`trade_id\`. Additional fields per the schema YAML.
- ~10–15 of the ~110 dimensions indexed. The rest are payload-only.

## Redis Functions
- **Library:** \`frtb\`.
- **Functions:** \`frtb.sbm_delta_bucket(risk_class, bucket)\` and \`frtb.sbm_vega_bucket(risk_class, bucket)\` — each returns \`{K_b, S_b, count, ms}\`.
- **Map-reduce orchestration:** api fans out one FCALL per bucket; reduces per-bucket K_b plus cross-bucket γ_bc into the risk-class charge.
- Weights and correlations are embedded into the library at load time from \`config/schema/frtb-default.yaml\`.

## Schema configuration (hot-swappable)
- Single YAML / JSON under \`config/schema/\`. Defines dimensions, risk-class shapes, FRTB binding (logical SBM concepts → physical field names), risk weights, correlations.
- Every service reads the schema at startup: generator, ingest, calc, RQE indexes, api.
- Demo step 9 (extensibility) live-swaps the YAML and reruns the pipeline.

## Connections + Sources
- **Connections:** RS cluster profiles stored encrypted in api (AES-GCM, master key from \`CONN_STORE_KEY\`). CRUD via UI, Test action confirms modules + TLS + ACL, set-active fans out to all services via a control channel.
- **Sources:** \`synthetic\` (generator) and \`file\` (browser upload < 2 GB or server path / S3 reference for 450M-row files). \`source\` infers columns and presents a mapping wizard.

## Security posture
- TLS in transit (mTLS available), encryption at rest with HSBC's KMS (BYOK), audit logs to HSBC's SIEM, support for fully air-gapped installs, RBAC + ACL per database.

## What's in the asset pack
- This brief, the executive summary, the talking-points cheat-sheet, the competitive-positioning doc, the sizing worksheet, the Reveal.js deck (PDF), and screenshots of every demo step.
`;

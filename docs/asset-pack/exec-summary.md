# Executive Summary — Redis Enterprise for HSBC FRTB-SA

## The pain
FRTB-SA goes live in January. Your incumbent stack (Oracle + Spark + JVM risk engines) was built for end-of-day batch. The desk wants live recalc on 450M sensitivities across ~110 dimensions with tenor arrays. The current architecture cannot deliver the latency, the shape, or the cost envelope at that scale.

## The answer
**Redis Enterprise Software** as the live operational layer in front of your existing Oracle + Spark batch:

- **JSON-native storage** of the sensitivity shape, including tenor arrays, with no row explosion.
- **Sub-100 ms pivots** over 10M+ rows via Redis Query Engine on JSON.
- **In-database SBM math** via Redis Functions — `FCALL` per bucket on the owning shard, slot-local, map-reduce.
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

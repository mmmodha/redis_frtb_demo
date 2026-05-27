# Competitive Positioning — Redis Enterprise vs the Alternatives for FRTB-SA

How to position Redis Enterprise against the stores HSBC is already running or evaluating. Each section names a competitor, the workload-specific weakness vs Redis Enterprise, and a one-line rebuttal the SA can deliver verbatim.

The buying signals referenced (#1 .. #13) are defined in the "Why Redis Enterprise" table of the spec.

---

## OSS Redis

**Where HSBC will raise it:** "Redis is free. Why pay for Enterprise?"

**What OSS Redis cannot do for this workload:**

- **Single-threaded shards.** OSS Redis is single-threaded per shard. Enterprise shards are multi-threaded and the Enterprise proxy is multi-threaded — for the same FRTB ingest + concurrent-pivot workload you need 2–3× fewer Enterprise nodes (signal #10).
- **No Auto Tiering.** OSS holds the entire dataset in RAM. The 450M-row scale story does not exist on OSS — full stop. Auto Tiering (RAM + NVMe in one logical DB) is a Redis Enterprise *exclusive* (signal #5).
- **No Active-Active CRDTs.** HSBC London / Hong Kong / New York / Singapore each need local-write latency. OSS Redis offers only async replication. Active-Active is Enterprise-exclusive (signal #12).
- **No RBAC, no ACL UI, no TLS-by-default, no audit log SIEM integration.** Bolt-on at best on OSS. First-class on Enterprise (signals #7, #13).
- **No K8s Operator with BDB CRDs.** Day-2 ops on OSS in K8s is a custom Helm chart you maintain. Enterprise gives you the official Operator on GKE/EKS/OpenShift (signal #11).
- **Module bundle not included.** ReJSON, RediSearch, RedisGears (Functions), Bloom, TimeSeries — you self-assemble these on OSS, manage their upgrade cycle individually, and have no commercial support contract. Enterprise bundles all of them in one license (signal #9).

**Rebuttal one-liner:** "OSS Redis is the right pick for a single-shard cache. For a multi-shard, multi-region, audited, tiered FRTB workload — none of the features you actually need to deploy this in tier-1 bank production exist in OSS."

---

## ClickHouse / Snowflake / columnar warehouses

**Where HSBC will raise it:** "We already pivot trade data in ClickHouse / Snowflake."

**What columnar warehouses cannot do for this workload:**

- **Analytical, not operational.** Optimised for OLAP scans over historical data. SBM is operational: the desk wants to re-hedge and re-run the charge in seconds, not batch-refresh nightly. RQE returns sub-100 ms over millions of nested docs (signal #2).
- **No in-database SBM math.** ClickHouse UDFs run in a sandbox, can't do the per-bucket map-reduce against JSON-shaped sensitivities. Redis Functions / `FCALL` runs the K_b formula on the shard that owns the bucket — no data movement (signal #3).
- **Row explosion to store the shape.** A GIRR sensitivity with a 10-tenor `risk_value` array becomes 10 columnar rows. With ~110 dims and 450M sensitivities, the columnar table is multi-billion-row. ReJSON stores the array natively (signal #1).
- **Wrong layer.** Columnar is the right home for post-trade analytics and regulatory archiving. Redis Enterprise is the right home for the *live* calc, sitting in front of the warehouse.

**Rebuttal one-liner:** "Use ClickHouse for end-of-day analytics; Redis Enterprise is the operational layer that feeds it and serves the desk in real time. They are complementary — not competing."

---

## Aerospike / ScyllaDB / DynamoDB

**Where HSBC will raise it:** "We're standardising on Aerospike / Scylla / DynamoDB for low-latency KV."

**What other KV stores cannot do for this workload:**

- **No JSON-native shape with partial updates.** They all store opaque blobs or wide rows. ReJSON gives JSONPath partial updates on a 10-tenor array — your tenor + risk_value shape lives in place (signal #1).
- **No search index over nested fields.** RQE indexes `$.risk_class`, `$.bucket`, `$.sensitivity_type` over JSON in one declaration. On Aerospike / Scylla you either denormalise into secondary tables or bolt on Elasticsearch (signal #2).
- **No in-database compute over typed data.** DynamoDB has Streams + Lambda (network hop per record), Aerospike has UDFs (no module ecosystem for math libraries), Scylla has Workload Prioritization but no compute. Redis Functions runs the SBM K_b formula on the owning shard, slot-local (signal #3).
- **No module bundle.** None of them ship Search + JSON + Functions + TimeSeries as one license. You assemble these features yourself or live without them (signal #9).
- **No Active-Active CRDTs at the Enterprise SLA tier.** DynamoDB Global Tables come close but tie you to AWS. Active-Active on Redis Enterprise runs in *any* cloud or on-prem (signal #12).

**Rebuttal one-liner:** "Aerospike, Scylla, and DynamoDB are KV stores. Redis Enterprise is a multi-model data platform — JSON, Search, Streams, Functions — with the operational maturity to be the live FRTB calc layer."

---

## KDB+ (kx Systems)

**Where HSBC will raise it:** "Market risk teams have always used KDB."

**What KDB cannot do for this workload going forward:**

- **License cost.** KDB+ enterprise licenses are seven-figure per cluster. Redis Enterprise is fraction-of-the-cost and the module bundle is included (signal #10 TCO; signal #9 module bundle).
- **Talent scarcity.** q/k4 developers are rare and expensive. The pool is shrinking, not growing. Redis Functions are Lua and JavaScript — every developer on the desk can read them. Schema is YAML.
- **Vendor lock-in.** KDB on-disk format, q query language, kdb+tick architecture — once in, exit cost is years of rewrite. Redis Enterprise uses standard JSON shape and the open RediSearch query syntax. Schema YAML is portable.
- **Operational pain.** KDB clustering and HA story is bespoke per deployment; failover is custom-engineered. Redis Enterprise gives you BDB CRDs in K8s, sub-five-second replica promotion, the Operator, and the Ansible roles (signals #6, #11).
- **No JSON nested shape.** KDB is columnar timeseries. The 10-tenor `risk_value` array is unnatural; the typical KDB shop denormalises it. ReJSON stores it in place (signal #1).

**Rebuttal one-liner:** "KDB was the right answer in 2010 when tick capture was the workload and the talent existed. For FRTB-SA in 2026 with cost pressure, talent flight, and JSON-shaped data — Redis Enterprise wins on TCO, talent availability, and operational maturity."

---

## Oracle + Spark + JVM risk engines (HSBC's likely incumbent stack)

**Where HSBC will raise it:** "We already have Oracle for state, Spark for ETL, and JVM-based risk engines for calc — why change?"

**What the incumbent stack cannot do well:**

- **Wrong shape.** Oracle relational schema flattens the tenor array into a child table — every SBM calc starts with a 10× row join. ReJSON keeps the array native (signal #1).
- **Wrong latency.** Spark is batch; the desk wants live recalc. JVM risk engines marshal every sensitivity row across the network from Oracle to the JVM heap — GC pauses, network round-trips, per-row overhead. Redis Functions runs the math where the data lives, FCALL per bucket, slot-local (signal #3, signal #4 hash-tag locality).
- **Wrong scale economics.** Scaling Spark = more JVMs + bigger Oracle = bigger license + bigger storage. Scaling Redis Enterprise = more shards (multi-threaded, in the same RAM + NVMe topology). Order-of-magnitude lower per-row cost at FRTB scale (signal #10).
- **Wrong operational posture.** Three vendors, three upgrade cycles, three failure modes. Redis Enterprise consolidates state + search + compute + streams in one product, one license, one Operator, one set of audit logs (signals #7, #9, #11).
- **Wrong perimeter story.** Oracle + Spark deployments rarely span on-prem, GCP, and AWS cleanly. Redis Enterprise runs identically across all three via the same Operator and Ansible roles (signal #8).

**Rebuttal one-liner:** "Keep Oracle and Spark for what they're best at — system-of-record and end-of-day batch. Put Redis Enterprise in front for the live calc layer. You don't rip-and-replace, you augment — and the FRTB live moment becomes a single-shard FCALL instead of a multi-system orchestration."

---

## Summary table

| Capability the workload needs | OSS Redis | ClickHouse / Snowflake | Aerospike / Scylla / DynamoDB | KDB+ | Oracle + Spark | **Redis Enterprise** |
|---|---|---|---|---|---|---|
| JSON-native nested arrays (`risk_value[10]`) | partial | flattened | opaque | denormalised | child table | ✅ ReJSON |
| Search over JSON fields (RQE) | partial | scan-based | bolt-on Elastic | q/sql | denorm + index | ✅ RediSearch |
| In-database SBM compute | partial | UDF (sandboxed) | UDFs, no ecosystem | q | JVM round-trip | ✅ Redis Functions / FCALL |
| Multi-threaded shards | ❌ | n/a | varies | n/a | n/a | ✅ |
| Auto Tiering (RAM + NVMe) | ❌ | n/a | partial | ❌ | n/a | ✅ Enterprise-only |
| Active-Active CRDT (geo) | async only | ❌ | DynamoDB Global Tables only | ❌ | ❌ | ✅ Enterprise-only |
| K8s Operator + Ansible | DIY | DIY | varies | DIY | DIY | ✅ official |
| RBAC + TLS + audit-ready | bolt-on | ✅ | ✅ | bolt-on | ✅ | ✅ |
| Module bundle in one license | self-assemble | n/a | n/a | n/a | n/a | ✅ |
| HSBC perimeter, no SaaS dependency | ✅ | varies | DynamoDB AWS-only | ✅ | ✅ | ✅ |

The pattern: **no single competitor checks every box for the FRTB-SA operational workload.** Redis Enterprise does. That is the close.

# Presenter Talking Points — Tier-1 bank FRTB-SA Demo

The Solutions Architect's pocket reference for running the 15–20 min demo. One entry per step in the [Demo Flow](../../README.md). Every entry gives the **business value** being proven, the **narration** to say out loud, the **objection** the bank is most likely to raise, the **rebuttal** (Enterprise-specific, never generic), and a **fallback** if the live moment misbehaves.

Business-value numbers refer to the "Why Redis Enterprise" table in the spec.

---

## Step 1 — The problem (1 min, slide)

- **Business value:** FRTB-SA goes live in January 2026 and the overnight Murex + Oracle + Spark batch can't keep up with the re-hedge math desks need in seconds — staying on the incumbent stack means missing the deadline or shipping it on three middleware tiers with three on-call rotations. *Capabilities used: framing for the rest of the demo.*
- **Narration:** "450 million sensitivities, ~110 dimensions, tenor arrays, non-linear SBM math, FRTB go-live in January. Your current Murex / Calypso plus Oracle plus Spark stack was not designed for this shape or this latency."
- **Objection:** "We can scale our existing Spark cluster."
- **Rebuttal:** "Spark gives you batch ETL throughput; it does not give you sub-second live recalc when the desk wants to re-hedge. Redis Enterprise is the *operational* layer in front of your batch — JSON-native, in-database compute via Redis Functions, multi-threaded shards. Spark stays where it is; Redis Enterprise sits in front of it for the live moment."
- **Fallback:** Slide is static; if the deck won't render, narrate the problem from memory and skip to the architecture slide.

## Step 2 — Architecture + deployment (1 min)

- **Business value:** The platform team installs Redis Enterprise inside the bank's own VPCs and OpenShift clusters via the official Operator — no SaaS dependency, no data egress out of the perimeter, and no second procurement track for a managed-service vendor; FRTB data sits on infrastructure the platform team already operates. *Capabilities used: Deploy in your perimeter, Kubernetes Operator + Ansible automation.*
- **Narration:** "This is Redis Enterprise Software running inside the bank's own perimeter — your VPC, your VMs, your OpenShift cluster. Same product as Redis Cloud, you operate it. K8s Operator for GKE/EKS/OpenShift, Ansible roles for VM-based. No SaaS dependency, no data egress."
- **Objection:** "We already standardise on Redis Cloud / we can't take a SaaS dependency."
- **Rebuttal:** "Redis Enterprise Software is the self-managed install of the exact same product. Same modules, same Active-Active CRDTs, same Auto Tiering. Your platform team installs it via the official Operator; day-2 ops are GitOps-native via BDB CRDs."
- **Fallback:** If the architecture diagram doesn't load, show the static PNG from the asset pack or the deck slide directly.

## Step 2a — Connections + Sources (1 min)

- **Business value:** Risk and security officers see a Redis Enterprise cluster running on the bank's own infrastructure with TLS, ACL and BYOK green and JSON + Search + Functions bundled in a single license — no SaaS dependency for FRTB data and one vendor invoice instead of negotiating each module separately. *Capabilities used: Deploy in your perimeter, Module bundle, Data sovereignty + BYOK.*
- **Narration:** "Two pre-seeded clusters — demo and scale — both Redis Enterprise Software, both in our perimeter. Test action confirms ReJSON, RediSearch and RedisGears modules present plus TLS and ACL green. Drag-drop a CSV, column mapping wizard auto-infers."
- **Objection:** "You're bundling commercial modules we'd pay for separately."
- **Rebuttal:** "One Enterprise license, all modules included — JSON, Search, Streams, Functions, Bloom, TimeSeries. With OSS Redis you self-assemble those modules, manage upgrades, and lose vendor support. With Enterprise the bundle is the product."
- **Fallback:** If the Test action errors, narrate the security model from the slide and switch to a pre-recorded screenshot.

## Step 3 — Live ingest (3 min)

- **Business value:** Risk officers see FRTB sensitivities seconds after the trade lands instead of waiting for the overnight Spark batch — same dataset, smaller infra footprint and one stack to operate instead of Spark + Oracle + ES. *Capabilities used: RQE on JSON, multi-threaded scale-out, hash-tag locality.*
- **Narration:** "Two million synthetic FRTB sensitivities streaming into `demo-cluster` — multi-threaded shards. Every GIRR/USD/B1 row lands on the same shard thanks to the `{risk_class:bucket}` hash tag, so the calc stays slot-local. Throughput climbs in real time; memory grows linearly. Architecture proves <2s; 10M-row production scales linearly per-shard."
- **Objection:** "OSS Redis is free and does the same thing."
- **Rebuttal:** "OSS Redis is single-threaded per shard; Enterprise shards are multi-threaded. The proxy alone is multi-threaded. For the same workload you need fewer Enterprise nodes — lower TCO and lower operational surface. Plus RBAC, Active-Active, Auto Tiering, BDB lifecycle — none of that exists in OSS."
- **Fallback:** If live ingest stalls, switch to a recorded video of a prior run; the rest of the demo runs against the pre-loaded dataset.

## Step 4 — Native array shape (1 min)

- **Business value:** The bank's tenor-array sensitivity row lands in Redis untouched — no 10× row-explosion in Oracle, no flattening ETL job to maintain, no JOIN-tax on the storage bill — so risk officers reason about the same shape they receive while IT retires a layer of ETL middleware. *Capabilities used: JSON as a native data shape (ReJSON).*
- **Narration:** "Open one GIRR row in the inspector — `risk_value` is a ten-tenor JSON array, stored in place. No row explosion, no flattening, no JOIN tax. Your file shape, untouched. This is ReJSON, bundled in the Enterprise module set."
- **Objection:** "We can store this in Oracle as JSON too."
- **Rebuttal:** "Oracle JSON is parsed on read — sub-second searches over 10M nested docs are not on the menu. ReJSON in Redis Enterprise gives you JSONPath partial updates *and* a search index over JSON fields. No other operational store offers both."
- **Fallback:** If the inspector won't render the row, drop into a terminal and run `JSON.GET sens:{GIRR:USD-IRS}:01HZ...` so the bank sees the raw shape.

## Step 5 — Search at speed (3 min)

- **Business value:** Risk officers run live pivots over millions of sensitivities from the desk in under a second instead of queuing an overnight ClickHouse or Snowflake job — replacing a separate warehouse-for-pivots tier with the same operational store that already holds the data. *Capabilities used: Redis Query Engine on JSON.*
- **Narration:** "Same JSON document we showed in step 4 — Redis Query Engine indexed it, GROUPBY + REDUCE returns in 80 ms over 2M rows. Architecture proves <2s; 10M-row production scales linearly per-shard. Try that on your current store."
- **Objection:** "We could do this in ClickHouse / Snowflake."
- **Rebuttal:** "Those are columnar warehouses. They cannot run in-database SBM math, they cannot be the live calc engine, and they cannot store this shape without flattening. Redis is the *operational* layer that feeds them and serves your analysts in real time."
- **Fallback:** If the search stalls past 1 s, drop the limit to 1M rows and re-run; narrate that the p99 latency in the histogram is the real number, not the single-query wall-clock.

## Step 6 — SBM Delta calc (3 min)

- **Business value:** The SBM K_b math runs where the data already lives, so risk officers see the regulatory charge in seconds and IT stops paying for a separate JVM compute farm whose only job was shipping 450M rows over the network to a Spark job. *Capabilities used: In-database compute via Redis Functions, map-reduce across shards.*
- **Narration:** "GIRR Delta SBM charge. The math runs *inside Redis* — one `FCALL` per bucket on the owning shard, each shard computes `K_b = √(ΣWS² + ΣΣρWSWS)` locally, the coordinator aggregates. No row leaves the cluster."
- **Objection:** "We can do this in our JVM risk engine — the math is straightforward."
- **Rebuttal:** "In your JVM engine, every sensitivity row crosses the network from your store to your compute. Multiply by 450M and that's your bottleneck. Redis Functions run the bucket-local math where the data lives — millisecond round-trip, predictable per-shard load, no JVM GC pauses."
- **Fallback:** If FCALL errors, re-run with `risk_class=GIRR sensitivity_type=Delta` against the 1M-row backup dataset; total time on that set is ≈100 ms.

## Step 7 — SBM Vega calc (2 min)

- **Business value:** Adding the Vega leg is the same one-library deployment as Delta — no second microservice, no second Spark job, no second on-call rotation — so the risk team ships new SBM measures in days instead of running a separate change-management track per leg. *Capabilities used: In-database compute via Redis Functions (reinforcement).*
- **Narration:** "Same `frtb` Function library, same map-reduce pattern, Vega leg this time. One library, both legs, three risk classes — the Function pattern generalises."
- **Objection:** "Functions are still Lua — slow, hard to debug."
- **Rebuttal:** "Redis Functions are loaded once and compiled, not interpreted per call. They run in the shard's main thread next to the data — no marshalling. Debug via `FUNCTION DUMP` and the RedisInsight Functions tab. For predictable, bucket-local SBM math this is faster and far simpler than a microservice."
- **Fallback:** If Vega fails but Delta passed, narrate that Vega is the same pattern and skip to step 8 — the calc story is already told.

## Step 8 — Concurrent workforce scenario (3 min)

- **Business value:** 200 desk analysts hit the FRTB store concurrently without p99 blowing past the SLA — the bank runs the workload on fewer Enterprise nodes instead of triple-provisioning OSS shards or buying more JVM compute capacity to mask thread contention. *Capabilities used: Redis Query Engine, in-database compute, multi-threaded performance per node.*
- **Narration:** "200 simulated tenant analysts running mixed search + calc queries. Watch the p99 latency — it holds. Ops/sec per shard stays high, memory is stable, no thread contention. This is what multi-threaded Enterprise shards give you that OSS does not."
- **Objection:** "We'd just scale our existing stack horizontally."
- **Rebuttal:** "Your incumbent stack scales by adding JVM instances and load-balancing — every instance is a stateless replica of the calc logic but still hits the same Oracle bottleneck. Redis Enterprise scales by adding shards: each shard owns its slice of data, runs its own calc. Linear scale-out, hash-tag locality, no shared bottleneck."
- **Fallback:** If loadgen flakes, narrate the previously captured load-test report from the asset pack; the numbers are the same.

## Step 9 — Extensibility (schema swap) (2 min)

- **Business value:** When the regulator or a new desk demands a schema tweak, the risk team ships a YAML PR instead of a code-and-redeploy cycle through ETL + storage + calc layers — fewer change tickets, no parallel ETL+calc release train, faster turnaround on regulatory shape changes. *Capabilities used: JSON shape flexibility, Redis Functions generalising across schemas.*
- **Narration:** "Live-swap the schema YAML. Rerun search and Equity + FX calcs on the new shape. No code changes, no redeploy — the entire pipeline (generator, ingest, indexes, calc) is config-driven."
- **Objection:** "Schema changes always require code changes in our world."
- **Rebuttal:** "Because your current pipeline has the schema *embedded* in the ETL code and the calc code. Here, the schema YAML drives `FT.CREATE`, the Functions' field bindings, and the UI. JSON-native storage means the document shape is data, not code. Day-2 schema changes are a YAML PR."
- **Fallback:** If the swap fails mid-demo, switch to a pre-recorded clip and narrate the architecture — the message is "config-driven", not "live YAML edit drama".

## Step 10 — Scale pivot: Auto Tiering on RS (2 min)

- **Business value:** The 450M-row production set fits in one Redis Enterprise cluster on the bank's own NVMe VMs — RAM for the hot working set, SSD for the long tail — so capex drops 60–80% versus an all-RAM fleet, the bank avoids a per-region SaaS bill and avoids running a separate cold-store tier. *Capabilities used: Auto Tiering (Enterprise exclusive), linear scale-out, Deploy in your perimeter.*
- **Narration:** "The 'but 450M rows won't fit in RAM' answer. Switch active target to `scale-cluster` — Redis Enterprise with Auto Tiering on NVMe. Same UI, same code, same hot-key latency; cold keys served from SSD. And this runs on the bank's own NVMe VMs — no SaaS dependency."
- **Objection:** "We'd just buy more RAM."
- **Rebuttal:** "RAM at 450M-row scale is six-figure capex per cluster, repeated per region. Auto Tiering is a Redis Enterprise *exclusive* — OSS doesn't have it, no other KV store has it. RAM for the hot working set, NVMe for the long tail, one logical database. Cost falls by 60–80% with no application change."
- **Fallback:** If `scale-cluster` isn't reachable, show the architecture diagram and narrate the scale-out math — same numbers, different medium.

## Step 11 — Kill a node (1 min, optional)

- **Business value:** A primary shard dies mid-trading and the desk sees a sub-five-second blip with no analyst restart — replacing Oracle-RAC-style failover (tens of seconds plus shared-storage licensing) with a shared-nothing setup the platform team already runs on K8s. *Capabilities used: HA + rapid failover.*
- **Narration:** "Mid-load, fail a primary via the RS admin UI. Replica promotes in under five seconds; the app sees a brief reconnect blip in observability and keeps running. This is the Enterprise SLA story — built-in, not bolted on."
- **Objection:** "Our incumbent is already HA — Oracle RAC etc."
- **Rebuttal:** "Oracle RAC failover is measured in tens of seconds and requires shared storage. Redis Enterprise failover is sub-five-second, shared-nothing, and the application doesn't need failover logic — the smart client and the proxy hide it. Same story across nodes, racks, and AZs."
- **Fallback:** If you skip the live kill, narrate the failover story over the observability tab — the audience usually accepts the architectural claim without a live demonstration.

## Step 12 — Close + Q&A (2 min)

- **Business value:** A four-week POC replaces the multi-quarter Spark + Oracle + ES integration project — the bank hits the FRTB January deadline on one operated stack, one vendor invoice and the K8s + Ansible automation the platform team already owns. *Capabilities used: recap — JSON, RQE, Redis Functions, scale-out, Auto Tiering, HA, in your perimeter.*
- **Narration:** "Today you saw JSON-native storage, sub-second RQE searches, in-database SBM compute via Redis Functions, multi-threaded shard scale-out, Auto Tiering for the 450M scale story, and HA failover — all inside the bank's perimeter. Next step is a scoped POC against one of your own desks; the asset pack covers procurement and Professional Services."
- **Objection:** "What's the realistic timeline to production?"
- **Rebuttal:** "Two-week POC on one risk class with your own data, four-week pilot across GIRR + Equity + FX, eight-week production rollout via the K8s Operator. Professional Services scopes the Auto Tiering sizing and the Active-Active geo topology in parallel."
- **Fallback:** If Q&A goes sideways, return to the "Why Redis Enterprise" table in the deck — every answer ties back to one of the 13 business-value moments.

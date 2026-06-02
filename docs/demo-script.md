# FRTB SBM on Redis Enterprise — Tier-1 bank Demo Script

> **Audience:** The bank's FRTB / market-risk stakeholders.
> **Goal:** Land Redis Enterprise Software buying signals (not "explain FRTB").
> **Length:** 15–20 min walkthrough + 2 min Q&A.
> **Presenter:** Redis Solutions Architect (SA).
> **Stack assumed live at start:** `.env.local` populated at repo root (Compose loads it automatically via `env_file` — no `--env-file` flag needed), `docker compose up -d --wait` returned healthy, `demo-cluster` profile pre-seeded and Active, sample CSV pre-uploaded so the wizard is warm, `scale-cluster` profile pre-seeded (not Active), 450M-row file mounted at known path. See [presenter-checklist.md](./presenter-checklist.md).

Each step lists: **Purpose · What to click · What to narrate · Acceptance criterion proved · Fallback**.

> **Pre-flight — remote cluster reset (Wave 5.8.3):** If you (or a prior smoke run) left data in the remote Redis Enterprise cluster, drain it before the demo with `scripts/smoke-reset-cluster.sh --yes`. `docker compose down -v` only clears local volumes — a populated `sensitivities:in` will OOM the generator at Step 3. The script reads `REDIS_URL` from `.env.local`, FLUSHALLs every master shard, and never echoes credentials.

---

## Step 1 — The problem (1 min, slide deck)

- **Purpose:** Frame the pain — FRTB-SA, 450M sensitivities, 110 dimensions, tenor arrays, end-of-day batch pressure. Incumbent (Murex/Calypso + Oracle/KDB + Spark) struggles on shape + latency + cost.
- **Click:** Open `docs/deck/index.html` slide 1 ("The problem"). Advance one click to the data-shape diagram.
- **Narrate:** *"You have 450M sensitivities by end-of-day. Each row is shaped — tenor arrays, 110 dims. Today's stack is fighting the shape. Today I'm going to show you Redis Enterprise being the operational layer for this."*
- **Buying signal(s):** Sets up #1, #2, #3, #5 (problem-fit framing).
- **Acceptance criterion proved:** Sets context for *all* `## Acceptance Criteria` items in the spec.
- **Fallback:** Skip animation, hold static slide.

## Step 2 — Architecture + deployment topology (1 min, slide)

- **Purpose:** Establish "Redis Enterprise Software runs in *your* perimeter."
- **Click:** Advance to architecture slide. Hover the "K8s Operator / Ansible" callout.
- **Narrate:** *"RS runs anywhere — bare-metal, VMware, GCP, AWS, OpenShift. Your VPC, your controls, no SaaS dependency, no data egress. Same product Redis Cloud uses, operated by your platform team via the K8s Operator."*
- **Buying signals:** #8 (deploy in your perimeter), #11 (K8s Operator + Ansible), #12 (Active-Active option).
- **Acceptance criterion proved:** Spec §Architecture, Assumptions (RS in the bank perimeter).
- **Fallback:** Read the deployment-paths bullet aloud; reference `docs/presenter/deploy-paths.md`.

## Step 2a — Connections + Sources (1 min, live app)

- **Purpose:** "Bring your own Redis Enterprise, bring your own data." Sets value-prop tone before the heavy demo. Lands the security/perimeter signal.
- **Click:**
  1. Switch to the app at `http://localhost:5173`.
  2. Click **Connections** in the left rail.
  3. Point at the two pre-seeded cards: `demo-cluster` (Active green pill) and `scale-cluster`.
  4. Click **Test** on `demo-cluster` → green ticks for ReJSON / RediSearch / RedisGears + TLS + ACL.
  5. Click **Sources** in the left rail.
  6. Drag the pre-staged `girr-sample-100k.csv` onto the drop zone.
  7. Click **Infer columns** → mapping wizard opens with auto-suggestions. Tenor columns auto-grouped into `risk_value[]`.
- **Narrate:** *"Two clusters, both Redis Enterprise Software, both inside your perimeter. TLS, ACL, module bundle — Search, JSON, Functions, all included in one license. And on the data side — drag in your CSV, the wizard infers your schema. No flattening of your tenor arrays."*
- **Buying signals:** #8, #9, #13.
- **Acceptance criteria proved:** Spec — *"Connections + Sources (the 'bring your own everything' layer)"*, *"Demo step 2a is now executable end-to-end"*.
- **Fallback:** If drag-drop misfires → use the pre-uploaded source row in the Sources list and click **Configure mapping** directly.

## Step 3 — Live ingest (3 min, live app)

- **Purpose:** Throughput on Redis Enterprise. Hash-tag sharding makes ingest slot-local.
- **Click:**
  1. From the mapping wizard's *Save & Ingest* CTA, kick off ingest for the 2M synthetic GIRR fixture.
  2. (Alt path) Click **Ingest** → **Start generator (2M)** if the source has already been mapped.
  3. Watch the rows/sec tile and the per-shard ops/sec chart climb.
  4. Point at the MetricTile *Total keys* counter passing 500k, 1M, 2M.
- **Narrate:** *"50k+ rows/sec sustained, three shards, each row routes by hash tag — `{risk_class:bucket}` — so the calc later is slot-local. Linear scale-out: add a shard, get more throughput. No app-side sharding. Architecture proves <2s; 10M-row production scales linearly per-shard."*
- **Buying signals:** #2, #4, #10.
- **Acceptance criteria proved:** `Ingest sustains ≥50k rows/sec`, `Keys use the sens:{risk_class:bucket}:{ulid} hash-tag pattern`, `UI surfaces: live ingest throughput`.
- **Fallback:** Pre-recorded clip `docs/recordings/ingest-burst.mp4` (post-recording). If live throughput stalls, narrate the chart's stored history.

## Step 4 — Native array shape (1 min, live app)

- **Purpose:** Prove JSON-as-native. No row explosion.
- **Click:**
  1. Click **Search** → set Risk Class = `GIRR`, Bucket = `USD-IRS`, Sensitivity = `Delta` → **Run query**.
  2. Click any returned row to expand → point at `risk_value: [...10 tenor sensitivities]`.
- **Narrate:** *"Your file shape, untouched. Ten tenor sensitivities live inside one document as a JSON array. No row explosion, no JOIN tax, no flattening into 10× the storage."*
- **Buying signal:** #1.
- **Acceptance criterion proved:** `Redis stores GIRR rows with risk_value as a native JSON array (10 tenor points)`.
- **Fallback:** Show pre-captured `docs/asset-pack/json-shape.png` in the asset pack.

## Step 5 — Search at speed (3 min, live app)

- **Purpose:** Redis Query Engine on JSON, sub-100ms over millions of rows.
- **Click:**
  1. Stay in **Search**. Run a GROUPBY query across all GIRR buckets, grouped by bucket + tenor.
  2. Run it three more times → watch the **p50 / p95 / p99** histogram tighten.
- **Narrate:** *"Same JSON documents from step 4. Redis Query Engine indexed them. p99 under 250ms over 2M rows. Try that on a KV store. Try that on a columnar warehouse without ETL. Architecture proves <2s; 10M-row production scales linearly per-shard."*
- **Buying signal:** #2.
- **Acceptance criterion proved:** `RQE indexes return pivot queries (GROUPBY + REDUCE) over 2M rows in p99 <250ms (architecture projects to 10M with 3-shard cluster)`.
- **Fallback:** Pre-captured `docs/asset-pack/pivot-p99.png`.

## Step 6 — SBM Delta calc (3 min, live app — **THE MVP**)

- **Purpose:** In-database compute via Redis Functions. THE moment that proves 5 of 13 signals in one click.
- **Click:**
  1. Click **Calc** in the left rail.
  2. Risk Class = `GIRR`, Sensitivity = `Delta`.
  3. Click **Calculate SBM risk charge**.
  4. Point at the **wall-clock badge** — should be green (<2s).
  5. Point at the **Per-shard timing** strip — each bucket's FCALL on its owning shard.
  6. Scroll the **Per-bucket K_b breakdown** table.
- **Narrate:** *"K_b = √(ΣWS² + ΣΣρWSWS), per bucket, computed inside Redis via FCALL. Each call lands on the owning shard — see the per-shard strip. The api just reduces across buckets. No data leaves the database for the math."*
- **Buying signals:** #1, #2, #3, #4, #9 (five in one click — the MVP).
- **Acceptance criteria proved:** **MVP gate** (`Calculate SBM risk charge... <2s wall-clock... per-shard timing visible`), `SBM Delta + Vega calcs use the map-reduce pattern`, `Results validate to within 0.01%` (oracle compare).
- **Fallback:** If wall-clock is amber/red, mention the load test still running concurrently and reference the green captured run in `docs/asset-pack/mvp-green.png`.

## Step 7 — SBM Vega calc (2 min, live app)

- **Purpose:** Reinforce Function-pattern generality.
- **Click:** Stay in **Calc**. Sensitivity = `Vega`. **Calculate**.
- **Narrate:** *"Same map-reduce. Different math, same pattern. This is how every risk class plugs in — one Lua function per measure, hash-tagged keys, slot-local FCALL."*
- **Buying signal:** #3 (reinforcement).
- **Acceptance criterion proved:** MVP gate (Vega variant).
- **Fallback:** Reference Delta result still on screen; explain Vega in narration only.

## Step 8 — Concurrent workforce scenario (3 min, live app)

- **Purpose:** "200 analysts hitting it at once" — multi-threaded shards, p99 holds.
- **Click:**
  1. Click **Loadgen** in the left rail.
  2. Concurrency = `200`, Mix = `pivot+calc`, Duration = `60s`. Click **Start**.
  3. Watch the p99 line in the live histogram, ops/sec/shard tiles, memory tile.
  4. Switch to **Observability** while load runs — show ShardMetricsStrip ops/sec per shard stays even.
- **Narrate:** *"200 concurrent analysts. p99 under 500ms. Memory flat. No thread contention because RS shards are multi-threaded — that's the Enterprise edition difference. Same workload on OSS needs 2–3× the nodes."*
- **Buying signals:** #2, #3, #10.
- **Acceptance criterion proved:** `Concurrent load test runs 200 simultaneous mixed pivot+calc queries with p99 <500ms`.
- **Fallback:** Stop loadgen, reference `docs/asset-pack/concurrent-p99.png`.

## Step 9 — Extensibility — schema swap + Equity/FX (2 min, live app)

- **Purpose:** Data-model agnostic. Calc generalises.
- **Click:**
  1. Show `config/schema/frtb-default.yaml` open in editor (split screen). Toggle the visible Equity bucket scheme.
  2. Hot-reload the schema (api auto-reloads).
  3. Back in **Calc** → Risk Class = `Equity`, Sensitivity = `Delta` → **Calculate**. Green wall-clock.
  4. Repeat with Risk Class = `FX`.
- **Narrate:** *"One YAML file defines schema + bindings. Swap it, the calc rebinds, no code change. And the calc generalises — Equity, FX, same map-reduce pattern."*
- **Buying signals:** #1, #3.
- **Acceptance criteria proved:** `Schema config YAML can be swapped and the entire pipeline... re-binds`, MVP gate variants (Equity Delta/Vega, FX Delta/Vega).
- **Fallback:** Skip schema swap, just run Equity + FX calcs against the seeded schema.

## Step 10 — Scale pivot — Auto Tiering on RS (2 min, live app — **CLIMAX**)

- **Purpose:** Answer "but 450M won't fit in RAM." **Auto Tiering is Redis Enterprise *exclusive*.**
- **Click:**
  1. Click **Connections** → click **scale-cluster** card → **Activate**. Active pill in shell header switches.
  2. Click **Sources** → select the pre-seeded mounted-path source `frtb-450M.parquet`.
  3. Click **Save & Ingest**. (Pre-warmed — ingest is partially done so the demo doesn't wait 8 minutes.)
  4. Click **Calc** → Risk Class = `GIRR`, Sensitivity = `Delta` → **Calculate**.
  5. Hot keys still serve from RAM; cold keys served from NVMe SSD. Wall-clock badge still green.
- **Narrate:** *"Same UI. Same code. Same FCALL pattern. Bigger cluster — six shards with Auto Tiering on NVMe. Hot keys in RAM, cold on SSD, transparent to the calc. This is how 450M rows fits in a budget that doesn't melt your hardware spend. **And this Auto Tiering capability is a Redis Enterprise exclusive — OSS doesn't have it.**"*
- **Buying signals:** #5 (**the headline**), #4, #8.
- **Acceptance criteria proved:** `450M scale story is supported`, MVP gate at scale, `step 10 (scale pivot to scale-cluster with Auto Tiering)`.
- **Fallback:** If `scale-cluster` is unreachable → flip back to `demo-cluster` and play `docs/recordings/scale-pivot.mp4`. The asset pack carries the headline numbers.

## Step 11 — (Optional) Kill a node (1 min, live app)

- **Purpose:** HA + rapid failover. Enterprise SLA story.
- **Click:**
  1. While loadgen is still running, open the RS admin UI in a second tab.
  2. Find a primary shard on `scale-cluster`, click **Fail over**.
  3. Switch back to the app — show the brief blip in ShardMetricsStrip, then steady-state resumes within seconds.
- **Narrate:** *"Primary down, replica promoted, app reconnects in a heartbeat. SLA story for tier-1 deployment."*
- **Buying signal:** #6.
- **Acceptance criterion proved:** `Killing one cluster node (primary failover to replica) shows graceful degradation`.
- **Fallback:** Skip live (high-risk moment). Narrate from `docs/asset-pack/failover.png`.

## Step 12 — Close + Q&A (2 min)

- **Purpose:** Land the recap. Hand over the asset pack. Move toward POC scoping.
- **Click:** Return to deck. Final slide: 13 buying signals recap with the 11 you just proved highlighted.
- **Narrate:** *"That was: JSON-native shape, Query Engine on JSON, in-database compute via Functions, map-reduce across shards, Auto Tiering for the 450M problem, all inside your perimeter, on one license bundle. Same product Redis Cloud uses — your platform team operates it via the K8s Operator or Ansible. Next step: 4-week POC against your actual data. The asset pack on the table has everything — script, deck, recording, talking points."*
- **Buying signals:** Recap of all 13.
- **Acceptance criteria proved:** Demo script + deck + asset pack handoff.
- **Fallback:** Skip recap if running long → straight to "questions?"

---

## Acceptance-criteria mapping (quick reference)

| Step | Spec acceptance criterion proved |
|---|---|
| 2 | Architecture / Assumptions (RS in the bank perimeter) |
| 2a | "Connections + Sources" section; "Demo step 2a is now executable end-to-end" |
| 3 | `Ingest sustains ≥50k rows/sec`, `Keys use the sens:{risk_class:bucket}:{ulid} hash-tag pattern`, `UI surfaces: live ingest throughput` |
| 4 | `Redis stores GIRR rows with risk_value as a native JSON array (10 tenor points)` |
| 5 | `RQE indexes return pivot queries (GROUPBY + REDUCE) over 2M rows in p99 <250ms (architecture projects to 10M with 3-shard cluster)` |
| 6 | **MVP gate** + `SBM Delta/Vega calcs use the map-reduce pattern` + oracle 0.01% match |
| 7 | MVP gate Vega variant |
| 8 | `Concurrent load test runs 200 simultaneous mixed pivot+calc queries with p99 <500ms` |
| 9 | `Schema config YAML can be swapped and the entire pipeline re-binds`, MVP gate Equity/FX variants |
| 10 | `450M scale story is supported`, Auto Tiering signal |
| 11 | `Killing one cluster node shows graceful degradation` |
| 12 | `Demo script document + Reveal.js deck + Playwright E2E suite + 15-min recorded dry-run exist` |

---

## Timings cheat sheet

| Block | Time | Cumulative |
|---|---|---|
| 1 Problem | 1:00 | 1:00 |
| 2 Architecture | 1:00 | 2:00 |
| 2a Connections + Sources | 1:00 | 3:00 |
| 3 Ingest | 3:00 | 6:00 |
| 4 Array shape | 1:00 | 7:00 |
| 5 Search | 3:00 | 10:00 |
| 6 Delta calc (MVP) | 3:00 | 13:00 |
| 7 Vega calc | 2:00 | 15:00 |
| 8 Concurrent load | 3:00 | 18:00 |
| 9 Schema swap + Equity/FX | 2:00 | 20:00 |
| 10 Scale pivot (climax) | 2:00 | 22:00 |
| 11 Kill a node (optional) | 1:00 | 23:00 |
| 12 Close | 2:00 | 25:00 |

**Target 15-min cut:** drop steps 7, 9, 11 → 18 min. **Hard 10-min cut:** drop 7, 9, 11, and shorten 3 + 8 → 13 min. **Never cut step 6 (MVP) or step 10 (climax).**

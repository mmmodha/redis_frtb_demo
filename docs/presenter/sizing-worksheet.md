# Redis Enterprise Sizing Worksheet — FRTB-SA

Fill out one column per HSBC desk or business line. Drives a Redis Enterprise Software (RS) sizing recommendation: shard count, shard memory, tier mix (RAM-only vs Auto Tiering), and a Redis Cloud SKU equivalent for cost benchmarking.

## Inputs (ask the desk)

| Input | Symbol | Notes |
|---|---|---|
| Number of sensitivities | N | Distinct rows; aggregate across risk classes |
| Average dimensions per row | D | ~110 for FRTB-SA full schema; ~30 for slimmed |
| Risk classes in scope | RC | GIRR / CSR / Equity / Commodity / FX (1–7) |
| Average tenor-array length | T | 10 for GIRR Delta/Vega; 1 for Equity/FX scalars |
| Concurrent users at peak | U | Analysts + downstream services |
| Regions needing local writes | R | Drives Active-Active topology |
| Index fields per doc | I | Recommend 10–15 of D in RQE for FRTB |

## Sizing formulas

**Per-row JSON payload** ≈ `(D × 40 bytes) + (T × 16 bytes) + 200 bytes overhead`

**Per-row index footprint** ≈ `I × 32 bytes` (RediSearch TAG fields, ~1.5× including postings)

**Total dataset memory (RAM-only)** ≈ `N × (payload + index) × 1.4 replication overhead`

**Recommended shard count** ≈ `ceil(total / 12 GB)` — keeps each shard in the sweet spot for failover.

**RAM working set with Auto Tiering** ≈ `total × 0.15` (assume 15% hot keys) plus index in RAM always.

## Worked example — 10M sensitivities (`demo-cluster`)

- N = 10,000,000; D = 110; T = 10; I = 15; R = 1; U = 50.
- Per-row payload ≈ `(110 × 40) + (10 × 16) + 200` = **4,760 bytes** (~4.6 KB).
- Per-row index ≈ `15 × 32 × 1.5` = **720 bytes**.
- Total dataset ≈ `10M × (4,760 + 720) × 1.4` = **~76 GB**.
- Shards: `ceil(76 / 12)` = **7 shards** RAM-only OR 3 shards + Auto Tiering.
- **Recommendation:** 3 primaries × 12 GB + 3 replicas (36 GB usable, fits the 10M-row demo with headroom for failover + concurrent load). Matches the spec's `demo-cluster` topology.
- **Redis Cloud SKU comparable:** `Pro 100GB` (3 shards). RS-equivalent install is two small VMs (16 GB each).

## Worked example — 45M sensitivities (single-region pilot)

- N = 45,000,000; D = 110; T = 10; I = 15; R = 1; U = 200.
- Total dataset ≈ `45M × (4,760 + 720) × 1.4` = **~345 GB**.
- Shards (RAM-only): `ceil(345 / 12)` = **29 shards** — too many for a 6-node cluster.
- **Recommendation:** 12 shards × 12 GB RAM + **Auto Tiering with 1:4 RAM:NVMe ratio**. Working set ≈ 52 GB hot, ~293 GB on NVMe. Cluster = 6 nodes × (24 GB RAM + 80 GB NVMe).
- **Redis Cloud SKU comparable:** `Pro 500GB Flex` with Auto Tiering. Sized to 0.5 TB usable.
- **Talking point:** "We just moved off RAM-only without changing a line of application code. Auto Tiering is an Enterprise exclusive — try this on OSS."

## Worked example — 450M sensitivities (full FRTB-SA production)

- N = 450,000,000; D = 110; T = 10; I = 15; R = 3 (London + HK + NYC); U = 1,000.
- Total dataset *per region* ≈ `450M × (4,760 + 720) × 1.4` = **~3.45 TB**.
- Working set (Auto Tiering, 10% hot) ≈ **345 GB RAM + index** per region.
- **Recommendation per region:** 24 shards × 16 GB RAM + Auto Tiering with NVMe at 1:8 RAM:NVMe. Cluster = 12 nodes × (32 GB RAM + 256 GB NVMe).
- **Active-Active across 3 regions:** sized identically per region; CRDTs converge. Adds ~10% memory overhead for CRDT metadata.
- **Redis Cloud SKU comparable:** `Pro 5TB Active-Active`. RS install is 3 × (12-node clusters with Operator).
- **Talking point:** "450M rows × 110 dims × 3 regions with local-write latency in each — this is the scale story. Auto Tiering keeps RAM cost sane; Active-Active is Enterprise-exclusive; the K8s Operator deploys the topology identically into your GCP + AWS + on-prem footprint."

## Worksheet template (copy-paste per desk)

```
Desk / business line: ______________________
N (rows):              ______________________
D (dimensions):        ______________________
T (tenor array len):   ______________________
RC (risk classes):     ______________________
U (concurrent users):  ______________________
R (regions):           ______________________
I (indexed fields):    ______________________

Per-row payload:       ____ bytes
Per-row index:         ____ bytes
Total dataset:         ____ GB / TB
Working set (15%):     ____ GB
Recommended shards:    ____
Recommended nodes:     ____
Auto Tiering ratio:    ____
Active-Active:         yes / no
Redis Cloud SKU:       ______________________
Notes / risks:         ______________________
```

## Output for the customer

1. One-page sizing memo with the filled worksheet.
2. Redis Cloud SKU for cost-benchmarking against the incumbent.
3. RS BOM (nodes, RAM, NVMe) for the on-prem / own-cloud install.
4. Operator install timeline (typically 2 weeks from approval to first cluster).

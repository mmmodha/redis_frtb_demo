# Cleanup audit — 2026-06-18 (Wave 6.33 P0.5)

READ-ONLY inventory of deletion candidates. No files are modified by this report.
The user approves entries marked `delete-safe`; per-phase implementors apply
`delete-after-Pn` entries when their phase lands.

## Summary

**14 delete-safe, 19 delete-after-Pn, 9 needs-review, 8 keep-with-comment.**
Bulk of cleanup is concentrated in (a) the legacy Lua FCALL path + its env flag
(P3), (b) the un-versioned `idx:sens` literal which is mostly legitimate
fallback code (keep), and (c) recordings older than two waves (delete-safe).

Tag legend:
- `delete-safe` — no production reader, remove now
- `delete-after-Pn` — superseded once Phase n ships
- `needs-review` — manual call (semantics ambiguous or historical value)
- `keep-with-comment` — intentional, document and retain

## 1. Unused dependencies (`npx depcheck --skip-missing` per workspace)

| Workspace            | Pkg          | Declared-in         | Usage status        | Recommendation        |
|----------------------|--------------|---------------------|---------------------|-----------------------|
| `shared/calc`        | `@types/node`| devDependencies     | depcheck: unused    | `needs-review` — verify `npm run -w @frtb/calc-shared typecheck` still passes without it before removing |
| all 14 other workspaces | —         | —                   | clean               | none                  |
| `tools/reference-sbm`| (Python)     | `requirements.txt`  | not a Node workspace| skip — depcheck N/A   |

Wave 5.97C removed 5 deps; no accumulation since (1 candidate, contested).

## 2. Stale literals

| Pattern | Hits | Representative file:line | Context | Tag |
|---|---|---|---|---|
| `bigcluster` (dead-cluster name) | 6 | `scripts/backfill-rollups-bigcluster.sh:1` | dedicated script for decommissioned cluster | `delete-after-P0` (whole script + sibling `scripts/README.md:34`, `scripts/shard-balance-report.mjs:31` comments) |
| `bigcluster` (historical evidence) | 2 | `services/api/src/active-target.ts:588`, `services/api/tests/pool-fail-fast.test.ts:3` | incident postmortem comments inside otherwise-live code | `keep-with-comment` (historical incident reference) |
| `idx:sens` literal — `BASE_INDEX_NAME` constant | 1 | `services/api/src/lib/sens-index.ts:16` | exported base for `versionedIndexName()` builder; legacy-target fallback path | `keep-with-comment` (Wave 6.18i fallback by design) |
| `idx:sens` literal — `bootstrap.ts` log fields & step names | ~17 | `services/api/src/bootstrap.ts` | bootstrap is the code that *constructs* the versioned name; literal here is the log channel id | `keep-with-comment` |
| `idx:sens` literal — `admin.ts:168` (`probeIndex = "idx:sens"`) | 1 | `services/api/src/routes/admin.ts:168` | initial value before reassignment to versioned name from `getSensIndexName` | `needs-review` — confirm reassignment is unconditional, else the literal is a real fallback used in pre-flight |
| `idx:sens` literal — test fixtures | 92 | `services/api/tests/*`, `services/ui/tests/*` | test mocks of FT.INFO/FT.AGGREGATE replies | `keep-with-comment` (acceptable in unit fixtures; consider per-target rebuild in P6) |
| `JSON.SET sens:` | 0 | — | already removed | `delete-safe` (no-op — confirms prior removal) |
| `frtb.sens` global stream | 0 | — | replaced by `sensitivities:in` + per-bucket routing | `delete-safe` (no-op) |
| `CALC_FCALL_FALLBACK` (env + code + tests) | 8 | `services/api/src/routes/calc.ts:163,471,484`; `services/api/vitest.setup.ts:22-23`; `.env.example`; Lua header comments | legacy Lua FCALL fallback path | `delete-after-P3` (P3 calculator scale removes the FCALL kernels entirely) |
| Lua kernel files | 9 | `services/calc/lib/{girr,fx,equity}_{delta,vega,curvature}.lua` | only `girr_delta` and `girr_curvature` headers note `LEGACY (Wave 6.31)`; other 7 kernels not referenced from current TS at all | `delete-after-P3` (all 9); ⚠ confirm no live `FUNCTION LOAD` of `equity_*` / `fx_*` before P3 lands — likely never loaded post-Wave-6.31 |
| `services/api/src/sbm/fcall-*.ts` | 0 files | directory contains `aggregate-via-index.ts`, `calc-cache.ts`, `correlations.ts`, `reduce.ts` only | already removed | `delete-safe` (no-op) |
| `{rc:bkt}` on **sens** keys (LEGACY shape) | 2 | `services/calc/lib/girr_curvature.lua:1`, `services/calc/lib/girr_delta.lua:1` | SCAN target string inside Lua | `delete-after-P3` (rides with the Lua kernels) |
| `{rc:bkt}` on **sens** keys (comments only) | 5 | `services/ingest/src/consumer.ts:273`, `services/generator/src/producer.ts:236`, `shared/stream-router/src/index.ts:11`, `services/ingest/src/backfill-rollups.ts:46,111,156` | descriptive comments about pre-Wave-6.31 shape | `keep-with-comment` (rewording — not deletion — is the right move; do it lazily) |
| `{rc:bkt}` on **rollup** keys | 8 | `services/api/src/routes/facets.ts`, `services/ingest/src/backfill-rollups.ts`, `services/api/src/bootstrap.ts:598`, `scripts/backfill-rollups-fast.ts:129` | rollup keys keep the hash-tag (slot affinity for shard-local SCAN) | `keep-with-comment` (intentional — DO NOT flag) |
| `getSensIndexName` 30s module-level cache | 1 | `services/api/src/lib/sens-index.ts:33-40,68` (`const cache = new Map<...>()`, `CACHE_TTL_MS = 30_000`) | per-process cache, 11 callers across `calc.ts`/`pivot.ts`/`admin.ts`/`bootstrap.ts` | `needs-review` — cache is functional but the spec calls it a "hack"; replace with proper Redis-backed lookup or remove entirely in P3/P6 |

## 3. Dead env vars (declared in `.env.example`, no reader in `services/*/src/`)

| Var | Declared-in (`.env.example` line) | Readers found | Recommendation |
|---|---|---|---|
| `CALC_BASE` | cross-service-URL block | 0 anywhere | `delete-safe` |
| `INGEST_BASE` | cross-service-URL block | 0 anywhere | `delete-safe` |
| `GENERATOR_PORT` | service-binding block | only `scripts/run-local.sh:153` (port-name helper) | `needs-review` — launcher uses the name, but no service reads `process.env.GENERATOR_PORT`. Either wire it in or drop both halves. |
| (`VITE_API_BASE`) | UI block | `services/ui/src/lib/api.ts:41` (via `import.meta.env`) | KEEP — `import.meta.env` reader; not dead |
| (`*_HOST`, `*_PORT`, `*_BASE` for api/source/calc/ingest/loadgen/ui) | binding blocks | 1+ each (config readers / docker-compose) | KEEP — multi-VM override surface (Wave 5.79) |
| All other entries (`ALLOWED_ORIGINS`, `CONN_STORE_KEY`, `INTERNAL_API_TOKEN`, `LOG_LEVEL`, `REDIS_*`, `CALC_FAST_PATH`, `CALC_ROLLUP_PATH`, `UI_API_PROXY_*`) | various | 1+ readers each | KEEP |

Note: `CALC_FCALL_FALLBACK` is *declared* and *read* but the feature it gates is the legacy Lua path — covered in §2 (`delete-after-P3`).

## 4. Spec archive candidates (move to `spec-archive` note in P6)

Approximate line ranges in the live spec (3,463 lines / ~288 KB; target < 50 KB).

| Range | Heading | Status | Tag |
|---|---|---|---|
| 59-79 | `## Wave 6.30 — Recovery from flushed bigcluster + fundamental fixes` | superseded by 6.33 | archive |
| 80-131 | `## Wave 6.31 — Option B: drop hash-tag from sens keys` | ✅ COMPLETE (verifier-approved 2026-06-18, marker in heading) | archive |
| 132-144 | `## Wave 6.32 — Self-heal stuck rebuild mutex` | verify, likely complete | `needs-review` |
| 482-534 | `### Phase A / B / C` (recovery sub-plan under 6.30) | superseded | archive (with 6.30) |
| 536-583 | `## 🚨 VM TRIAGE 2026-06-17 — Calc page broken on bigcluster` | triage log, resolved | archive |
| 585-672 | `## Wave 6.26 + 6.27 — Follow-ups from 6.25 verification (QUEUED, NOT DISPATCHED)` | QUEUED; likely supplanted by 6.33 | `needs-review` (kill vs archive) |
| 594-672 | Two adjacent `## Operational guardrails (all agents)` blocks (lines 594 and 616) | duplicate per Phase 6 spec | `needs-review` — Phase 6 task #2 (merge into one) |
| 635-672 | `## Deployment Protocol (MANDATORY — applies to every push)` | VM-specific deploy protocol | `delete-after-P0` (Phase 6 task #3 removes VM deploy protocol) |
| 673-691 | `## Wave 6.25 — Replace /facets FT.AGGREGATE GROUPBY` | DEMO BLOCKER, shipped | archive |
| 692-811 | `## Wave 6.18a` through `## Wave 6.18l` (12 sub-waves at lines 692, 708, 727, 744, 752, 766, 784, 804, plus 871, 884, 896, 907) | URGENT hotfixes long landed | archive (entire 6.18 series) |
| 813-857 | `## Wave 6.21 / 6.22 / 6.23 / 6.24` (pool / circuit-breaker / backpressure / materialized-discovery) | shipped per code (pool/pool-fail-fast tests exist) | archive |
| 859-869 | `## Wave 6.19 — Shard balance diagnostic` | shipped | archive |
| 925-933 | `## Wave 6.17 — Simplify IngestPanel: presets-only UI` | shipped | archive |
| 935-954 | `## Wave 6.16 — Strict bootstrap (fail loud)` | shipped | archive |
| 956-977 | `## Wave 6.15b — Per-runner dedicated ioredis (PROPOSED)` | PROPOSED, never started | `needs-review` (kill or archive) |
| 979-985 | `## Wave 6.12d — Proxy default fix` | shipped | archive |
| 987-1003 | `## Wave 6.15 — Consumer throughput lift (QUEUED, NOT DISPATCHED)` | QUEUED, supplanted by 6.33 P2 | `needs-review` (kill) |
| 1005-1069 | `## Waves 6.13 + 6.14 — Throughput follow-ons (QUEUED)`, `## Wave 6.13`, `## Wave 6.14` | QUEUED, supplanted by 6.33 P2/P3 | `needs-review` (kill) |
| 1071-1112 | `## Wave 6.12 — Ingest UI parity for runtime shard control` | shipped | archive |
| 1114-1141 | `## Wave 6.10 — Sensible defaults for high-volume runs` | shipped | archive |
| 1143-1185 | `## Wave 6.11 — Balanced multi-shard writes` | shipped | archive |
| 1187-1194 | `## Wave 6.12 — Bucket-weight rebalancing` (duplicate `## Wave 6.12` heading — placeholder) | never spec'd out, superseded | archive (and dedupe with line 1071) |
| 1196-3153 | `## Live target evidence (snapshot)` | ~1,950 lines of historical log dumps — single largest archive candidate | archive (biggest single win toward < 50 KB) |
| 3154-3376 | `### Wave 5.97D.1 — verification (2026-06-10)` | completed | archive |
| 3377-3391 | `## 6.18g — Replace WITHCURSOR in /facets` | shipped | archive |
| 3392-3407 | `## Wave 6.18p deploy — what happened` | postmortem, completed | archive |
| 3408-3463 | `## Demo contingency plan (added 2026-06-17)` | still in-force for current demo | KEEP |
| 1-43 | `## 🚨 VM IS THE SOURCE OF TRUTH …` | VM is being decommissioned in P6 | `needs-review` (rewrite for cloud cluster vs delete) |

## 5. Recordings archive candidates (`docs/recordings/`)

Two most recent waves to keep at top level: **`wave-6.33-phase-0`** (current, untracked) and **`wave-5.96`** (previous most recent wave-named dir, dated 2026-06-09). Reference dirs (`screenshots/`, `playwright-artifacts/`, `README.md`) also kept.

`delete-safe` (move to `docs/recordings/_archive/2026-06-18/`):
- `smoke-run-6/`, `smoke-run-10/`, `smoke-run-11/`, `smoke-run-12/`, `smoke-run-13/`
- `smoke-run-15/`, `smoke-run-16/`, `smoke-run-17/` (explicitly named in Phase 6 spec block)
- `wave-5.83K/`, `wave-5.84/`, `wave-5.84-corpus/`, `wave-5.92/`

Total: 12 directories.

## 6. TODO / FIXME / XXX / DEPRECATED backlog (informational)

Grand total across `services/`, `shared/`, `tools/`, `scripts/`: **2 TODOs, 0 FIXME, 0 XXX, 0 DEPRECATED**.

- `services/api/src/routes/sources-proxy.ts:26` — TODO: replace 60000ms poll with tighter signal once source-service exposes one
- `services/api/src/routes/sources-proxy.ts:183` — TODO: same as above (sibling reference)

Not action items for this audit; both are low-priority enhancements.

---

## Pre-existing working-tree state (not introduced by this audit)

For transparency — `git status --short` at audit time already showed these (from in-flight Phase 0 work, untouched by this task):

- ` M package-lock.json`
- ` M scripts/backfill-rollups-bigcluster.sh`
- `?? docs/recordings/wave-6.33-phase-0/`
- `?? scripts/backfill-rollups-fast.ts`

After this task lands, the **new** entry should be exactly `?? docs/cleanup-audit-2026-06-18.md`.

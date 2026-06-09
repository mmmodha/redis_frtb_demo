# Presenter Preflight Checklist — Tier-1 bank Demo

> Run this top-to-bottom **the morning of** the demo, and again **30 minutes before** going on. Anything not ticked is a risk to the live moment.

## T-24h — environment provisioning

- [ ] **`demo-cluster`** Redis Enterprise Software cluster provisioned in the Redis-internal lab (or SA's GCP/AWS account). Minimum 3 primaries × 12 GB shards + 3 replicas. ReJSON, RediSearch, RedisGears modules installed. TLS + ACL user created.
- [ ] **`scale-cluster`** Redis Enterprise Software cluster provisioned. 6+ shards with Auto Tiering enabled on NVMe-backed hosts. Same module bundle.
- [ ] **450M-row source file** copied/mounted into the `source` service container at the known path (default `/data/sources/frtb-450M.parquet`). Verify size and row count match expectations.
- [ ] Both cluster connection profiles exported into a JSON file, env var `SEED_CONNECTIONS_FILE` pointing at it so they appear on app boot.

## T-1h — boot the demo stack

- [ ] `cd` to the repo root.
- [ ] **Pull latest:** `git pull --rebase` on the demo branch.
- [ ] **Env vars sanity check** — confirm in `.env` (or shell):
  - `SEED_CONNECTIONS_FILE=/abs/path/to/seed-connections.json`
  - `CONN_STORE_KEY=<32-byte hex>` (do NOT commit)
  - `SOURCE_DATA_DIR=/abs/path/to/data/sources`
  - `API_BASE=http://localhost:8080` (UI default)
- [ ] **Bring up the app stack:** `docker compose up -d --build`. Wait for all 7 services healthy.
- [ ] **Smoke check the api process is up:** `curl -fsS http://localhost:8080/healthz` returns `{"service":"api","status":"alive"}`.
- [ ] **Smoke check the api is Redis-ready:** `curl -fsS http://localhost:8080/readyz` returns `{"service":"api","status":"ok","bootstrap":"ready"}` (503 with `bootstrap-failed` until an active Redis connection is wired via the Connections panel).
- [ ] **Smoke check `GET /redis/active-target`** — returns `demo-cluster` host/port/tls (no password leak).
- [ ] **Open the UI:** `http://localhost:5173`. Confirm:
  - Active-target pill in header shows green `demo-cluster`.
  - Left rail renders all 6 sections (Connections, Sources, Ingest, Search, Calc, Observability) + Loadgen (Wave 4.2 once live).
- [ ] **Pre-warm a sample upload** so the Sources wizard appears instantly during the demo:
  - Go to `/sources` → drag-drop the small `girr-sample-100k.csv` (lives under `data/samples/`).
  - Click **Infer**. Confirm columns auto-detect. Leave the wizard idle but warmed.
- [ ] **Pre-warm a small ingest** so step 3's chart history isn't flat-line:
  - `/ingest` → **Start generator** → 100k rows. Let it complete.
  - Wipe the generated keys after the smoke run if you don't want them in step 3's view: `redis-cli -h ... FLUSHALL` against `demo-cluster`. (**Skip if you want a non-zero starting point — usually you do.**)
- [ ] **Pre-stage the 450M source** in the Sources panel as `frtb-450M.parquet` row, status = `mapped`. (Map it once now so step 10 is one click.) If full ingest hasn't started, kick a partial ingest so the first 50M rows are loaded — step 10 then continues the run live.
- [ ] **`scale-cluster` reachable:** `/connections` → click **Test** on the `scale-cluster` card → green ticks on all modules + TLS + ACL.

## T-30min — preflight rehearsal

- [ ] Run the 11-step flow once **end-to-end**, **fast** (target ≤8 min). Note any panel that hesitates or any tile that shows "stale" — those are the fallback triggers.
- [ ] Click **Calculate** on Calc panel → confirm wall-clock badge is **green** (<2s) for GIRR Delta and GIRR Vega.
- [ ] If Equity/FX (Wave 4.1) is live, click those too. Green expected.
- [ ] **Loadgen** (Wave 4.2): run a 30s `concurrency=50` burst. Confirm Shard ops/sec stays even and memory holds flat.
- [ ] **Recordings:** confirm `docs/recordings/dry-run-15min.mp4` plays (the final dry-run lives here once 4.1/4.2/4.6 are GREEN).
- [ ] **Asset pack** is on a USB drive AND in cloud storage. SA confirms link works.

## T-5min — final go/no-go

- [ ] Browser zoom = 100%, all tabs closed except: app (`/connections`), deck (`docs/deck/index.html`), RS admin UI (for the optional kill-a-node step).
- [ ] Notifications silenced (Slack, mail, calendar). Screen-share preview confirmed.
- [ ] Mic + screen-share check with the bank's counterpart.
- [ ] Pre-rendered fallback assets open in background tab and **muted**:
  - `docs/asset-pack/json-shape.png`
  - `docs/asset-pack/pivot-p99.png`
  - `docs/asset-pack/mvp-green.png`
  - `docs/asset-pack/concurrent-p99.png`
  - `docs/asset-pack/failover.png`
  - `docs/recordings/scale-pivot.mp4` (post-4.1/4.2/4.6)

## Browser bookmarks (set up once, keep on the demo machine)

- `local-app` → `http://localhost:5173/observability` (lands user on a low-stakes screen)
- `local-app-connections` → `http://localhost:5173/connections`
- `local-app-calc` → `http://localhost:5173/calc`
- `local-app-loadgen` → `http://localhost:5173/loadgen` (Wave 4.2)
- `rs-admin-demo` → RS admin UI for the `demo-cluster`
- `rs-admin-scale` → RS admin UI for the `scale-cluster`
- `deck` → `file:///.../docs/deck/index.html`

## Fallback decision tree

| Symptom | Trigger | Action |
|---|---|---|
| Active-target pill is amber/red | Active cluster unreachable | Switch to spare cluster in **Connections** before continuing. If both are out → screen-share `docs/recordings/dry-run-15min.mp4` and narrate live. |
| Ingest chart flat-lines | Generator or ingest worker died | Open Observability tab, narrate the historical numbers. Cut to `docs/asset-pack/concurrent-p99.png`. |
| Calc wall-clock badge is red | Concurrent load saturated the cluster, or schema mismatch | Hit **Calculate** once more (transient) → if still red, narrate captured `docs/asset-pack/mvp-green.png` and explain you're sharing infra with the loadgen run. |
| Loadgen panel returns 0 ops/sec | loadgen service crashed | Use `docker compose restart loadgen`; if still failing, narrate from the dry-run video. Loadgen failure is **not demo-blocking** for steps 6/10. |
| `scale-cluster` Activate fails | Network / TLS / cluster gone | DO NOT improvise. Switch immediately to the recorded `docs/recordings/scale-pivot.mp4`, keep the narration as planned. |
| RS admin UI failover doesn't show in the app | RS lag / app reconnect window | Skip Step 11 entirely — narrate from the deck's HA slide. Step 11 is optional. |
| Any browser tab freezes | Chrome OOM / extension issue | Close tab, re-open from bookmark. The app's state is server-side; reload is safe. |

## "Loadgen flaked" recovery script (verbatim)

> *"Quick housekeeping — the loadgen worker just lost its connection, that's a synthetic concurrency simulator I run on a separate container. The Redis Enterprise cluster behind it is still serving every analyst request you'd actually have in production — let me show you the captured p99 from this morning's dry-run instead."*

Then: switch to `docs/asset-pack/concurrent-p99.png` for 30 seconds, narrate the numbers (p99 < 500ms, ops/sec/shard, memory flat), then move to Step 9.

## Post-demo

- [ ] Hand the bank the USB drive + cloud-storage link. The drive contains:
  - `docs/deck/` exported as PDF
  - `docs/asset-pack/*.png`
  - `docs/recordings/dry-run-15min.mp4`
  - `docs/demo-script.md`
  - `docs/presenter/talking-points.md`
- [ ] Log notes from the meeting (objections raised, decision-makers in room, follow-up actions) in `docs/post-demo-notes.md` within 24h.
- [ ] Schedule POC scoping call within 5 business days.

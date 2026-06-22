#!/usr/bin/env bash
# scripts/dev-up-and-diagnose.sh — Wave 7.0.6.9
#
# One-shot operator entrypoint: stop → rebuild → start → ensure active
# target → wait for the api's sens-index → run diagnose-ingest --probe.
# Thin wrapper over scripts/run-local.sh; does NOT reimplement service
# orchestration.
#
# Assumes Redis Enterprise is already listening on localhost:12000 (docker
# compose up). Never starts docker.
#
# Usage: scripts/dev-up-and-diagnose.sh

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_LOCAL="${REPO_ROOT}/.env.local"
LOGS_DIR="${REPO_ROOT}/logs"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DIAG_LOG="${LOGS_DIR}/diagnose-ingest-${TS}.log"
RUN_LOCAL="${SCRIPT_DIR}/run-local.sh"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  C_RESET="$(tput sgr0)"; C_RED="$(tput setaf 1)"; C_GREEN="$(tput setaf 2)"
  C_YELLOW="$(tput setaf 3)"; C_CYAN="$(tput setaf 6)"; C_BOLD="$(tput bold)"
else
  C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_BOLD=""
fi
hdr()  { printf '\n%s\n' "${C_BOLD}${C_CYAN}$*${C_RESET}"; }
info() { printf '%s\n' "$*"; }
ok()   { printf '%s\n' "${C_GREEN}$*${C_RESET}"; }
warn() { printf '%s\n' "${C_YELLOW}$*${C_RESET}"; }
fail() { printf '%s\n' "${C_RED}$*${C_RESET}" >&2; }

on_interrupt() {
  fail "interrupted; services may be in mixed state; run \`./scripts/run-local.sh stop\` to clean up"
  exit 130
}
trap on_interrupt INT TERM

# Best-effort TCP reachability check (works on macOS + Linux). Returns 0 if
# something is listening on host:port within 2s, 1 otherwise. Uses nc when
# available (more reliable than bash /dev/tcp under set -o pipefail), falls
# back to curl --connect-timeout, then to a /dev/tcp subshell.
tcp_open() {
  local host="$1" port="$2"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "${host}" "${port}" >/dev/null 2>&1 && return 0 || return 1
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -sS --connect-timeout 2 "telnet://${host}:${port}" >/dev/null 2>&1 && return 0 || return 1
  fi
  ( exec 3<>"/dev/tcp/${host}/${port}" ) >/dev/null 2>&1 && return 0 || return 1
}

# ---------- preflight ----------
if [[ ! -f "${ENV_LOCAL}" ]]; then
  fail "${ENV_LOCAL} not found — create .env.local first (see .env.example)."
  exit 2
fi

set -a
# shellcheck disable=SC1090
. "${ENV_LOCAL}"
set +a

if [[ -z "${REDIS_USERNAME:-}" ]] || [[ -z "${REDIS_PASSWORD:-}" ]]; then
  fail "REDIS_USERNAME / REDIS_PASSWORD missing from ${ENV_LOCAL} — add them and re-run."
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node not on PATH"; exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  fail "curl not on PATH"; exit 2
fi

if ! tcp_open localhost 12000; then
  fail "nothing listening on localhost:12000 — start Redis Enterprise (docker compose up) first."
  exit 2
fi

mkdir -p "${LOGS_DIR}"

# Export REDIS_URL into the child env. Never echo. seedConnections in the api
# (services/api/src/seed.ts) reads this, auto-creates 'live-standalone', and
# the auto-activate path in services/api/src/index.ts then commits it as the
# active target before bootstrap runs.
export REDIS_URL="redis://${REDIS_USERNAME}:${REDIS_PASSWORD}@localhost:12000"

# ---------- 1. stop ----------
# --force allows SIGKILL escalation if a service ignores SIGTERM after the 5s
# grace window. Required for a true one-shot: without it, wedged api / ui
# processes (state 'hung:<pid>') survive into the start phase and run-local
# reports "already running" against an unresponsive PID. reconcile --force
# afterwards clears any hung/orphan/foreign port owners so the start phase
# binds cleanly.
hdr "[1/6] Stopping local stack (--force) + reconcile"
"${RUN_LOCAL}" stop --force || warn "  stop returned non-zero; continuing"
"${RUN_LOCAL}" reconcile --force >/dev/null 2>&1 || true

# ---------- 2. rebuild + 3. start ----------
# run-local.sh canonicalises 'build' via `start --force-build` (forces UI
# bundle rebuild; tsx-runtime services pick up the latest sources on the
# next exec, so no separate compile step is required for them).
hdr "[2/6] Rebuilding UI bundle and starting full stack (--force-build)"
"${RUN_LOCAL}" start --force-build || warn "  start reported one or more services unhealthy; will surface in next steps"

# Catalogue includes bulk-loader (see SERVICES in run-local.sh), but verify
# explicitly because Wave 7.0.6.9 ties the probe to it.
hdr "[3/6] Verifying bulk-loader on :8086"
i=0
while (( i < 20 )); do
  if curl -fsS --max-time 1 "http://localhost:8086/healthz" >/dev/null 2>&1; then
    ok "  bulk-loader healthy on :8086"
    break
  fi
  sleep 1
  i=$(( i + 1 ))
done
if (( i >= 20 )); then
  fail "  bulk-loader not healthy after 20s — check .run/logs/bulk-loader.log"
  exit 1
fi

# ---------- 4. ensure active target points at localhost:12000 ----------
hdr "[4/6] Ensuring active target = redis://localhost:12000"
ensure_active_target() {
  node - <<'NODE'
const api = process.env.API_BASE || "http://localhost:8080";
const targetHost = "localhost";
const targetPort = 12000;
const username = process.env.REDIS_USERNAME;
const password = process.env.REDIS_PASSWORD;

async function getJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  // Wait for api /healthz first (up to 30s).
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const h = await fetch(`${api}/healthz`);
      if (h.ok) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }

  // Check current active.
  let active = await getJson(`${api}/connections/active`);
  if (active.status === 200 && active.body
      && active.body.host === targetHost && Number(active.body.port) === targetPort) {
    console.log(`already-active id=${active.body.id} name=${active.body.name}`);
    return;
  }

  // Find an existing profile matching the target endpoint.
  const list = await getJson(`${api}/connections`);
  if (list.status !== 200 || !Array.isArray(list.body)) {
    throw new Error(`GET /connections failed: status=${list.status}`);
  }
  let match = list.body.find(p => p.host === targetHost && Number(p.port) === targetPort);

  if (!match) {
    // Create live-standalone (or a unique fallback name) pointing at the target.
    const baseName = "live-standalone";
    let name = baseName;
    const existingNames = new Set(list.body.map(p => p.name));
    let n = 2;
    while (existingNames.has(name)) { name = `${baseName}-${n++}`; }
    const create = await getJson(`${api}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name, host: targetHost, port: targetPort,
        username, password, db: 0, clusterMode: false,
      }),
    });
    if (create.status !== 201) {
      throw new Error(`POST /connections failed: status=${create.status} body=${JSON.stringify(create.body)}`);
    }
    match = create.body;
    console.log(`created profile id=${match.id} name=${match.name}`);
  }

  const act = await getJson(`${api}/connections/${match.id}/activate`, { method: "POST" });
  if (act.status !== 200) {
    throw new Error(`POST /connections/${match.id}/activate failed: status=${act.status} body=${JSON.stringify(act.body)}`);
  }
  console.log(`activated id=${match.id} name=${match.name}`);
})().catch(e => { console.error(String(e.message || e)); process.exit(1); });
NODE
}

if ! ensure_active_target; then
  fail "  could not ensure active target on localhost:12000 — see output above"
  exit 1
fi

# ---------- 5. wait for /admin/index-count to return a non-null index_name ----------
hdr "[5/6] Waiting for /admin/index-count to expose a live index_name (≤ 30s)"
got_index=""
i=0
while (( i < 30 )); do
  resp="$(curl -fsS --max-time 2 "http://localhost:8080/admin/index-count" 2>/dev/null || true)"
  if [[ -n "${resp}" ]]; then
    name="$(printf '%s' "${resp}" | node -e '
      let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
        try { const j=JSON.parse(d); if (j && j.index_name) process.stdout.write(String(j.index_name)); } catch {}
      });' 2>/dev/null || true)"
    if [[ -n "${name}" ]]; then
      got_index="${name}"
      ok "  index_name=${name}"
      break
    fi
  fi
  sleep 1
  i=$(( i + 1 ))
done
if [[ -z "${got_index}" ]]; then
  fail "  /admin/index-count never returned a non-null index_name within 30s."
  fail "  Tail api logs: ./scripts/run-local.sh logs api"
  exit 1
fi

# ---------- 6. run diagnose-ingest ----------
hdr "[6/6] Running diagnose-ingest.mjs --probe --yes (tee → ${DIAG_LOG})"
# REDIS_URL already exported above; diagnose-ingest reads it for its Redis
# client. tee to both stdout and the log file so the operator sees the
# DIAGNOSTIC SUMMARY live and has a persisted artefact for the wave report.
set +o pipefail
node "${SCRIPT_DIR}/diagnose-ingest.mjs" --probe --yes 2>&1 | tee "${DIAG_LOG}"
rc="${PIPESTATUS[0]}"
set -o pipefail

if [[ "${rc}" == "0" ]]; then
  ok "diagnose-ingest exited 0; full log: ${DIAG_LOG}"
else
  warn "diagnose-ingest exited ${rc}; full log: ${DIAG_LOG}"
fi
exit "${rc}"

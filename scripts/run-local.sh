#!/usr/bin/env bash
# scripts/run-local.sh
#
# Local-developer launcher for the FRTB SBM stack. Starts 6 long-running
# services as background processes owned by the invoking user; all PIDs, logs,
# and runtime state live under ./.run/. No sudo, no systemd, no /var/lib/frtb.
#
# The synthetic-data `generator` is a one-shot CLI, NOT a long-running service;
# `start` (no args) does not launch it. Invoke explicitly with
# `start generator [-- --rows N]` when you want to populate `sensitivities:in`.
#
# Modelled on scripts/deploy-bare-metal.sh's process-mode helpers (entry-point
# catalogue, pid_alive, health polling, status table) but rootless and rooted
# in the repository.
#
# Usage: scripts/run-local.sh <start|stop|restart|status|logs|doctor> [opts]
#
# Pure bash 3.2-compatible (macOS dev box). shellcheck-clean.

set -u
set -o pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_DIR="${REPO_ROOT}/.run"
PIDS_DIR="${RUN_DIR}/pids"
LOGS_DIR="${RUN_DIR}/logs"
ENV_SNAPSHOT="${RUN_DIR}/env"
ENV_LOCAL="${REPO_ROOT}/.env.local"
ENV_EXAMPLE_REL=".env.example"

# Service catalogue (parallel arrays — bash 3.2). Iteration order = start order.
# api must come first (others depend on it), ui must come last (depends on api healthy).
SERVICES=( api source ingest calc loadgen ui )
PORTS=(    8080 8082    8083    8084 8085    3000 )

# One-shot tools (CLI utilities, no /healthz, not started by bulk `start`).
# Invoked explicitly via `scripts/run-local.sh start <tool> [-- ...extra]`.
ONE_SHOT_TOOLS=( generator )

# Health probe path is uniform across services per docker-compose.
HEALTH_PATH="/healthz"

# Per-service /healthz poll budget (seconds).
HEALTH_TIMEOUT_S=10
# Per-service stop SIGTERM grace (seconds) before SIGKILL.
STOP_GRACE_S=5

# CLI flags
OPT_FORCE_INSTALL=0
OPT_FORCE_BUILD=0
LOGS_FOLLOW=0
LOGS_SERVICE=""
COMMAND=""
# Wave 5.80 — optional single-target for `start` and `--`-separated extra args
# forwarded to one-shot tools (e.g. `start generator -- --rows 50`).
START_TARGET=""
EXTRA_ARGS=()
# Wave 6.18d — optional single-target for `reconcile` (empty = all services).
RECONCILE_TARGET=""
# Wave 6.18e — optional single-target for `stop` (empty = all services).
STOP_TARGET=""

# ---------------------------------------------------------------------------
# Colour primitives (mirrors deploy-bare-metal.sh init_colours).
# ---------------------------------------------------------------------------
init_colours() {
  if [[ "${NO_COLOR:-}" == "1" ]] || [[ ! -t 1 ]]; then
    USE_COLOUR=0
  elif command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
    USE_COLOUR=1
  else
    USE_COLOUR=0
  fi
  if [[ "${USE_COLOUR}" == "1" ]]; then
    C_RESET="$(tput sgr0)"; C_BOLD="$(tput bold)"
    C_RED="$(tput setaf 1)"; C_GREEN="$(tput setaf 2)"
    C_YELLOW="$(tput setaf 3)"; C_CYAN="$(tput setaf 6)"
    C_DIM="$(tput dim 2>/dev/null || true)"
  else
    C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""
    C_YELLOW=""; C_CYAN=""; C_DIM=""
  fi
}

info() { printf '%s\n' "${C_DIM}$*${C_RESET}"; }
ok()   { printf '%s\n' "${C_GREEN}$*${C_RESET}"; }
warn() { printf '%s\n' "${C_YELLOW}$*${C_RESET}"; }
fail() { printf '%s\n' "${C_RED}$*${C_RESET}" >&2; }
hdr()  { printf '\n%s\n' "${C_BOLD}${C_CYAN}$*${C_RESET}"; }

# ---------------------------------------------------------------------------
# Service entry-point catalogue. One npm command per workspace. UI start
# script serves the prior `vite build` output via node src/index.mjs.
# ---------------------------------------------------------------------------
service_entry_cmd() {
  case "$1" in
    api)       echo 'npm run -w @frtb/api start' ;;
    source)    echo 'npm run -w @frtb/source start' ;;
    ingest)    echo 'npm run -w @frtb/ingest start' ;;
    calc)      echo 'npm run -w @frtb/calc start' ;;
    loadgen)   echo 'npm run -w @frtb/loadgen start' ;;
    generator) echo 'npm run -w @frtb/generator start' ;;
    ui)        echo 'npm run -w @frtb/ui start' ;;
    *)         echo '' ;;
  esac
}

# Map a service name to its index in the SERVICES array. Echoes index, exit 0
# on hit, 1 on miss. Used to look up PORTS in parallel.
svc_index() {
  local target="$1" i=0
  while [[ $i -lt ${#SERVICES[@]} ]]; do
    if [[ "${SERVICES[$i]}" == "${target}" ]]; then
      echo "${i}"
      return 0
    fi
    i=$(( i + 1 ))
  done
  return 1
}

svc_port_for() {
  local idx
  if ! idx="$(svc_index "$1")"; then
    echo ""
    return 1
  fi
  echo "${PORTS[$idx]}"
}

# Wave 5.79 — map a service name to the env var name that overrides its port.
# Used by resolve_ports_from_env so operators can remap any service's listen
# port in .env.local without touching the catalogue here.
svc_port_env_var() {
  case "$1" in
    api)       echo API_PORT ;;
    source)    echo SOURCE_PORT ;;
    ingest)    echo INGEST_PORT ;;
    calc)      echo CALC_PORT ;;
    loadgen)   echo LOADGEN_PORT ;;
    generator) echo GENERATOR_PORT ;;
    ui)        echo UI_PORT ;;
    *)         echo "" ;;
  esac
}

# Wave 5.79 — overlay <SVC>_PORT (from .env.local or the caller's env) onto
# the catalogue PORTS array. Call after load_env_quiet so doctor/status/start
# poll the operator-chosen port. Idempotent.
resolve_ports_from_env() {
  local i=0 var val
  while [[ $i -lt ${#SERVICES[@]} ]]; do
    var="$(svc_port_env_var "${SERVICES[$i]}")"
    if [[ -n "${var}" ]]; then
      val="${!var:-}"
      if [[ -n "${val}" ]]; then
        PORTS[$i]="${val}"
      fi
    fi
    i=$(( i + 1 ))
  done
}

# Wave 5.80 — name predicates that span both SERVICES and ONE_SHOT_TOOLS.
# Used by parse_args, cmd_logs, and cmd_start_one so explicit-invocation forms
# (`start generator`, `logs generator`) accept one-shot tool names too.
is_one_shot_tool() {
  local name="$1" i=0
  while [[ $i -lt ${#ONE_SHOT_TOOLS[@]} ]]; do
    [[ "${ONE_SHOT_TOOLS[$i]}" == "${name}" ]] && return 0
    i=$(( i + 1 ))
  done
  return 1
}

is_known_name() {
  local name="$1"
  svc_index "${name}" >/dev/null 2>&1 && return 0
  is_one_shot_tool "${name}" && return 0
  return 1
}

pid_file() { echo "${PIDS_DIR}/$1.pid"; }
log_file() { echo "${LOGS_DIR}/$1.log"; }

pid_alive() {
  local pid="${1:-}"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

# Process age string (mm:ss / hh:mm:ss / d-hh:mm:ss) for the status table.
# `ps -o etime= -p <pid>` is portable across macOS + Linux.
pid_age() {
  local pid="$1"
  command -v ps >/dev/null 2>&1 || { echo '-'; return 0; }
  local out
  out="$(ps -o etime= -p "${pid}" 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [[ -z "${out}" ]] && out='-'
  echo "${out}"
}

# Wave 6.18d — classify the operational state of one service by reconciling
# pidfile ↔ live PID ↔ port owner. Echoes exactly one token:
#   running:<pid>   pidfile PID alive and the port is bound (by it or a child).
#   hung:<pid>      pidfile PID alive but the port is NOT bound (wedged before listen()).
#   orphan:<lpid>   pidfile PID dead, port held by a different live PID.
#   foreign:<lpid>  no pidfile at all, port held by a foreign live PID.
#   dead:<pid>      pidfile PID dead AND port free (truly stale pidfile).
#   stopped         no pidfile and port free.
# Callers parse with ${state%%:*} / ${state##*:}. Centralising this here keeps
# pid_cell / age_cell / spawn_service / stop_service / reconcile in lockstep.
svc_state() {
  local svc="$1" port="${2:-}"
  local pidf pid lpid=''
  pidf="$(pid_file "${svc}")"
  pid=''
  if [[ -f "${pidf}" ]]; then
    pid="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
  fi
  if [[ -n "${port}" ]]; then
    lpid="$(listening_pid_on "${port}")"
  fi
  if [[ -n "${pid}" ]] && pid_alive "${pid}"; then
    if [[ -n "${lpid}" ]]; then
      echo "running:${pid}"
    else
      echo "hung:${pid}"
    fi
    return 0
  fi
  if [[ -n "${lpid}" ]]; then
    if [[ -n "${pid}" ]]; then
      echo "orphan:${lpid}"
    else
      echo "foreign:${lpid}"
    fi
    return 0
  fi
  if [[ -n "${pid}" ]]; then
    echo "dead:${pid}"
  else
    echo "stopped"
  fi
}


# ---------------------------------------------------------------------------
# Preflight (run by start/restart/status, skipped by stop/logs/doctor —
# each of those does its own minimal checks).
# ---------------------------------------------------------------------------
preflight_no_root() {
  if [[ "$(id -u)" == "0" ]]; then
    fail "${SCRIPT_NAME}: refusing to run as root. This is a local-user dev launcher."
    fail "  Re-run as your normal user; no sudo is needed."
    exit 2
  fi
}

# Wave 5.97B — `.env.local` is no longer mandatory. The primary Redis-config
# path is the UI Connections panel at http://localhost:3000/connections; the
# stack boots happily without REDIS_URL on disk. We auto-generate a minimal
# `.env.local` on first run so CONN_STORE_KEY / INTERNAL_API_TOKEN stop being
# the literal dev defaults (which `doctor` then warns about explicitly).
generate_env_local() {
  local key tok
  if command -v openssl >/dev/null 2>&1; then
    key="$(openssl rand -hex 32 2>/dev/null || echo '')"
    tok="$(openssl rand -hex 16 2>/dev/null || echo '')"
  fi
  [[ -z "${key:-}" ]] && key="dev-only-change-in-prod"
  [[ -z "${tok:-}" ]] && tok="dev-internal-token"
  local tmp="${ENV_LOCAL}.tmp.$$"
  {
    printf '# Auto-generated by %s on %s.\n' \
      "${SCRIPT_NAME}" "$(date -u +%FT%TZ 2>/dev/null || date)"
    printf '# Edit freely — gitignored. See %s for the full list of overrides.\n' "${ENV_EXAMPLE_REL}"
    printf '#\n'
    printf '# Redis is configured via the UI Connections panel at\n'
    printf '#   http://localhost:3000/connections\n'
    printf '# Pre-seed a profile here only if you want it auto-added on boot:\n'
    printf '# REDIS_URL=redis://:CHANGE_ME@your-cluster-host:6379\n'
    printf '\n'
    printf 'CONN_STORE_KEY=%s\n' "${key}"
    printf 'INTERNAL_API_TOKEN=%s\n' "${tok}"
  } > "${tmp}" 2>/dev/null
  if [[ -s "${tmp}" ]] && mv -f "${tmp}" "${ENV_LOCAL}" 2>/dev/null; then
    ok "Created ${ENV_LOCAL} with auto-generated secrets (CONN_STORE_KEY, INTERNAL_API_TOKEN)."
    info "  Configure Redis via the UI Connections panel at http://localhost:3000/connections,"
    info "  or pre-seed REDIS_URL in .env.local (see .env.example)."
  else
    rm -f "${tmp}" 2>/dev/null || true
    warn "Could not write ${ENV_LOCAL}; continuing without it. Defaults will apply."
  fi
}

preflight_env_local() {
  if [[ ! -f "${ENV_LOCAL}" ]]; then
    warn ".env.local not present — auto-creating a minimal one with generated secrets."
    generate_env_local
  fi
}

# Verify node ≥ 20 and npm are on PATH. Exits 2 on failure.
preflight_node_npm() {
  if ! command -v node >/dev/null 2>&1; then
    fail "${SCRIPT_NAME}: node not found on PATH. Install Node ≥ 20."
    exit 2
  fi
  local nv major
  nv="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${nv%%.*}"
  if [[ -z "${major}" ]] || ! [[ "${major}" =~ ^[0-9]+$ ]] || (( major < 20 )); then
    fail "${SCRIPT_NAME}: node ${nv:-?} is too old; need ≥ 20."
    exit 2
  fi
  if ! command -v npm >/dev/null 2>&1; then
    fail "${SCRIPT_NAME}: npm not found on PATH."
    exit 2
  fi
}

preflight() {
  preflight_no_root
  preflight_env_local
  preflight_node_npm
  cd "${REPO_ROOT}" || { fail "cd ${REPO_ROOT} failed"; exit 2; }
}

ensure_run_dirs() {
  mkdir -p "${PIDS_DIR}" "${LOGS_DIR}" || {
    fail "Cannot create ${RUN_DIR}. Check write permissions on ${REPO_ROOT}."
    exit 1
  }
}

# ---------------------------------------------------------------------------
# .env.local loader.
#   1. set -a; source; set +a — exports every assignment so children inherit.
#   2. Writes a redacted snapshot to ./.run/env for debugging.
# Secrets whose key matches PASSWORD|KEY|TOKEN|SECRET are replaced with
# <redacted> in the snapshot file. Original env stays in process memory.
# ---------------------------------------------------------------------------
# Wave 5.79 — quiet env loader for commands (doctor/status) that need to read
# <SVC>_PORT overrides but should not write a snapshot. No-op if .env.local
# is absent so doctor still runs with sensible defaults on a fresh checkout.
load_env_quiet() {
  if [[ -f "${ENV_LOCAL}" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "${ENV_LOCAL}" 2>/dev/null || true
    set +a
  fi
}

load_env() {
  # Wave 5.97B — `.env.local` is auto-created by preflight on the start path,
  # but stay defensive: a missing file should not crash this loader, and the
  # snapshot writer below already no-ops when ENV_LOCAL is absent.
  if [[ -f "${ENV_LOCAL}" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "${ENV_LOCAL}" 2>/dev/null || true
    set +a
  fi
  ensure_run_dirs
  local tmp="${ENV_SNAPSHOT}.tmp.$$"
  {
    printf '# Sanitised env snapshot — generated %s by %s\n' \
      "$(date -u +%FT%TZ 2>/dev/null || date)" "${SCRIPT_NAME}"
    printf '# Keys matching PASSWORD|KEY|TOKEN|SECRET are <redacted>.\n'
    grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "${ENV_LOCAL}" 2>/dev/null \
      | awk -F= '{
          key=$1; gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
          rest=substr($0, index($0,"=")+1)
          if (key ~ /PASSWORD|KEY|TOKEN|SECRET/) {
            printf "%s=<redacted>\n", key
          } else {
            printf "%s=%s\n", key, rest
          }
        }'
  } > "${tmp}" 2>/dev/null
  if [[ -s "${tmp}" ]]; then
    mv -f "${tmp}" "${ENV_SNAPSHOT}" 2>/dev/null || rm -f "${tmp}"
  else
    rm -f "${tmp}"
  fi
}

# Apply per-stack defaults. These are layered ON TOP of .env.local so the
# user can override anything by setting it locally.
apply_defaults() {
  : "${NODE_ENV:=development}"
  : "${LOG_LEVEL:=info}"
  : "${API_URL:=http://localhost:8080}"
  : "${ALLOWED_ORIGINS:=http://localhost:3000}"
  : "${INTERNAL_API_TOKEN:=dev-internal-token}"
  : "${SOURCE_BASE:=http://localhost:8082}"
  if [[ -z "${CONN_STORE_KEY:-}" ]]; then
    warn "CONN_STORE_KEY not set — using insecure default 'dev-only-change-in-prod'."
    CONN_STORE_KEY="dev-only-change-in-prod"
  fi
  : "${SCHEMA_FILE:=${REPO_ROOT}/config/schema/frtb-default.yaml}"
  export NODE_ENV LOG_LEVEL API_URL ALLOWED_ORIGINS INTERNAL_API_TOKEN
  export SOURCE_BASE CONN_STORE_KEY SCHEMA_FILE
}


# ---------------------------------------------------------------------------
# Build gates: only run `npm install` if node_modules missing (or --force-install).
# Only run UI build if services/ui/dist missing (or --force-build).
# ---------------------------------------------------------------------------
ensure_deps() {
  if [[ "${OPT_FORCE_INSTALL}" == "1" ]] || [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
    info "Installing npm dependencies (this can take a few minutes)…"
    if ! ( cd "${REPO_ROOT}" && npm install ); then
      fail "npm install failed."
      return 1
    fi
  fi
  return 0
}

ensure_ui_build() {
  if [[ "${OPT_FORCE_BUILD}" == "1" ]] || [[ ! -d "${REPO_ROOT}/services/ui/dist" ]]; then
    info "Building UI…"
    if ! ( cd "${REPO_ROOT}" && npm run -w @frtb/ui build ); then
      fail "UI build failed."
      return 1
    fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Spawn one service. Pattern:
#   nohup bash -c "cd repo; HEALTH_PORT=…; exec npm run …" >>log 2>&1 &
# `exec` makes npm the direct child of the nohup'd bash, so the captured PID
# is npm and SIGTERM propagates cleanly to its node child. Disown to detach.
# ---------------------------------------------------------------------------
spawn_service() {
  local svc="$1" port="$2"
  local cmd; cmd="$(service_entry_cmd "${svc}")"
  local logf; logf="$(log_file "${svc}")"
  local pidf; pidf="$(pid_file "${svc}")"
  if [[ -z "${cmd}" ]]; then
    fail "no entry command for service '${svc}'"
    return 1
  fi
  # Already running? Short-circuit.
  if [[ -f "${pidf}" ]]; then
    local existing
    existing="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
    if [[ -n "${existing}" ]] && pid_alive "${existing}"; then
      info "  ${svc}: already running (pid ${existing})"
      return 0
    fi
    rm -f "${pidf}"
  fi
  # Wave 6.18d — refuse to spawn into a port already held by a foreign PID.
  # Without this we'd spawn a child that fails to bind and silently exits,
  # leaving the operator staring at dead:PID while the orphan keeps the port.
  local fpid; fpid="$(listening_pid_on "${port}")"
  if [[ -n "${fpid}" ]]; then
    fail "${svc}: port ${port} held by foreign pid ${fpid}; run \`${SCRIPT_NAME} reconcile ${svc}\` first"
    return 1
  fi
  # Boot marker (append, never truncate).
  printf '\n[boot] %s svc=%s port=%s ppid=%s\n' \
    "$(date -u +%FT%TZ 2>/dev/null || date)" "${svc}" "${port}" "$$" >> "${logf}"
  # The inner shell exports HEALTH_PORT (per-service override) and execs the
  # npm command. shellcheck: SC2086 — we want word-splitting on $cmd.
  # shellcheck disable=SC2086
  (
    cd "${REPO_ROOT}" || exit 1
    HEALTH_PORT="${port}" nohup bash -c "export HEALTH_PORT='${port}'; exec ${cmd}" \
      >> "${logf}" 2>&1 &
    echo $! > "${pidf}"
    disown 2>/dev/null || true
  )
  return 0
}

# Wave 5.80 — spawn a one-shot CLI tool (e.g. generator). Like spawn_service
# but: no HEALTH_PORT (no /healthz), and forwards any extra args after `--`
# straight to the npm script (`npm run … start -- --rows 50`). Backgrounded so
# the caller returns immediately; tail `.run/logs/<tool>.log` for progress.
spawn_one_shot() {
  local svc="$1"; shift
  local cmd; cmd="$(service_entry_cmd "${svc}")"
  local logf; logf="$(log_file "${svc}")"
  local pidf; pidf="$(pid_file "${svc}")"
  if [[ -z "${cmd}" ]]; then
    fail "no entry command for one-shot tool '${svc}'"
    return 1
  fi
  if [[ -f "${pidf}" ]]; then
    local existing
    existing="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
    if [[ -n "${existing}" ]] && pid_alive "${existing}"; then
      info "  ${svc}: already running (pid ${existing})"
      return 0
    fi
    rm -f "${pidf}"
  fi
  local extra_args=("$@")
  local full_cmd="${cmd}"
  if [[ ${#extra_args[@]} -gt 0 ]]; then
    full_cmd="${cmd} -- ${extra_args[*]}"
  fi
  printf '\n[boot] %s tool=%s args=%s ppid=%s\n' \
    "$(date -u +%FT%TZ 2>/dev/null || date)" "${svc}" "${extra_args[*]:-(none)}" "$$" >> "${logf}"
  # shellcheck disable=SC2086
  (
    cd "${REPO_ROOT}" || exit 1
    nohup bash -c "exec ${full_cmd}" >> "${logf}" 2>&1 &
    echo $! > "${pidf}"
    disown 2>/dev/null || true
  )
  return 0
}

# Single curl health probe. Returns 0 if 2xx, 1 otherwise.
health_probe() {
  local port="$1"
  curl -fsS --max-time 1 "http://localhost:${port}${HEALTH_PATH}" >/dev/null 2>&1
}

# Poll /healthz for up to HEALTH_TIMEOUT_S. Echoes final status: ok|timeout|dead.
wait_for_health() {
  local svc="$1" port="$2" pidf
  pidf="$(pid_file "${svc}")"
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while (( $(date +%s) < deadline )); do
    local pid
    pid="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
    if [[ -z "${pid}" ]] || ! pid_alive "${pid}"; then
      echo "dead"
      return 1
    fi
    if health_probe "${port}"; then
      echo "ok"
      return 0
    fi
    sleep 0.5
  done
  echo "timeout"
  return 1
}

# Stop one service. SIGTERM, wait STOP_GRACE_S, SIGKILL if needed. Idempotent.
# Wave 6.18d — also kills the foreign listener when the pidfile is dead but
# the port is still bound (so `stop` truly stops the service).
stop_service() {
  local svc="$1"
  local pidf; pidf="$(pid_file "${svc}")"
  local port=''
  port="$(svc_port_for "${svc}" 2>/dev/null || echo '')"
  local pid=''
  if [[ -f "${pidf}" ]]; then
    pid="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
  fi
  # Wave 6.18d — orphan path: pidfile is missing/dead AND something else is
  # listening on this service's port. Tear down the orphan with TERM→KILL.
  local fpid=''
  if [[ -n "${port}" ]] && { [[ -z "${pid}" ]] || ! pid_alive "${pid}"; }; then
    fpid="$(listening_pid_on "${port}")"
  fi
  if [[ -n "${fpid}" ]]; then
    warn "  ${svc}: orphan listener pid ${fpid} on port ${port}; sending SIGTERM"
    kill -TERM "${fpid}" 2>/dev/null || true
    local k=0
    while (( k < STOP_GRACE_S * 2 )) && pid_alive "${fpid}"; do
      sleep 0.5
      k=$(( k + 1 ))
    done
    if pid_alive "${fpid}"; then
      warn "  ${svc}: orphan pid ${fpid} ignored SIGTERM, sending SIGKILL"
      kill -KILL "${fpid}" 2>/dev/null || true
      sleep 0.5
    fi
    if pid_alive "${fpid}"; then
      fail "  ${svc}: orphan pid ${fpid} did not exit"
      rm -f "${pidf}" 2>/dev/null || true
      return 1
    fi
    ok "  ${svc}: killed orphan pid ${fpid}"
    rm -f "${pidf}" 2>/dev/null || true
    return 0
  fi
  if [[ ! -f "${pidf}" ]]; then
    info "  ${svc}: no pidfile (already stopped)"
    return 0
  fi
  if [[ -z "${pid}" ]] || ! pid_alive "${pid}"; then
    info "  ${svc}: stale pidfile (pid ${pid:-?} not alive), cleaning up"
    rm -f "${pidf}"
    return 0
  fi
  kill -TERM "${pid}" 2>/dev/null || true
  local i=0
  while (( i < STOP_GRACE_S * 2 )) && pid_alive "${pid}"; do
    sleep 0.5
    i=$(( i + 1 ))
  done
  if pid_alive "${pid}"; then
    warn "  ${svc}: SIGTERM ignored after ${STOP_GRACE_S}s, sending SIGKILL"
    kill -KILL "${pid}" 2>/dev/null || true
    sleep 0.5
  fi
  if pid_alive "${pid}"; then
    fail "  ${svc}: pid ${pid} did not exit"
    return 1
  fi
  rm -f "${pidf}"
  ok "  ${svc}: stopped (pid ${pid})"
  return 0
}


# ---------------------------------------------------------------------------
# Status table renderer.
# Columns: Service | PID | Age | Port | /healthz
# ---------------------------------------------------------------------------
health_cell() {
  local port="$1" code
  if ! command -v curl >/dev/null 2>&1; then
    printf '%s? no curl%s' "${C_DIM}" "${C_RESET}"
    return 0
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 1 \
    "http://localhost:${port}${HEALTH_PATH}" 2>/dev/null)" || code="000"
  case "${code}" in
    200) printf '%s✓ 200 ok%s' "${C_GREEN}" "${C_RESET}" ;;
    000) printf '%s✗ refused%s' "${C_RED}" "${C_RESET}" ;;
    *)   printf '%s✗ HTTP %s%s' "${C_RED}" "${code}" "${C_RESET}" ;;
  esac
}

# Wave 6.18d — pid_cell now reflects the reconciled svc_state so it can show
# orphan:PID (red) and hung:PID (yellow) in addition to the existing
# running:PID (green) and dead:PID (red, kept ONLY when port is also free).
pid_cell() {
  local svc="$1" port="${2:-}"
  local state; state="$(svc_state "${svc}" "${port}")"
  case "${state}" in
    running:*) printf '%s%-11s%s' "${C_GREEN}"  "${state#running:}" "${C_RESET}" ;;
    hung:*)    printf '%s%-11s%s' "${C_YELLOW}" "${state}"          "${C_RESET}" ;;
    orphan:*)  printf '%s%-11s%s' "${C_RED}"    "${state}"          "${C_RESET}" ;;
    dead:*)    printf '%s%-11s%s' "${C_RED}"    "${state}"          "${C_RESET}" ;;
    foreign:*) printf '%s%-11s%s' "${C_RED}"    "${state}"          "${C_RESET}" ;;
    *)         printf '%s%-11s%s' "${C_DIM}"    "-"                 "${C_RESET}" ;;
  esac
}

age_cell() {
  local svc="$1" port="${2:-}"
  local state; state="$(svc_state "${svc}" "${port}")"
  case "${state}" in
    running:*|hung:*|orphan:*|foreign:*)
      printf '%-11s' "$(pid_age "${state##*:}")" ;;
    *)
      printf '%s%-11s%s' "${C_DIM}" "-" "${C_RESET}" ;;
  esac
}

print_status_table() {
  local header sep
  header="${C_BOLD}Service     | PID         | Age         | Port  | /healthz${C_RESET}"
  sep='------------+-------------+-------------+-------+------------------'
  printf '%s\n%s\n' "${header}" "${sep}"
  local i=0 all_healthy=1 need_reconcile=0
  while [[ $i -lt ${#SERVICES[@]} ]]; do
    local svc="${SERVICES[$i]}" port="${PORTS[$i]}"
    local pid_s age_s health_s state
    state="$(svc_state "${svc}" "${port}")"
    case "${state}" in hung:*|orphan:*) need_reconcile=1 ;; esac
    pid_s="$(pid_cell "${svc}" "${port}")"
    age_s="$(age_cell "${svc}" "${port}")"
    health_s="$(health_cell "${port}")"
    if ! health_probe "${port}"; then
      all_healthy=0
    fi
    printf '%-11s | %s | %s | %-5s | %s\n' "${svc}" "${pid_s}" "${age_s}" "${port}" "${health_s}"
    i=$(( i + 1 ))
  done
  # Wave 6.18d — footer hint when at least one service is wedged or orphaned.
  if [[ "${need_reconcile}" == "1" ]]; then
    printf '\n%shung/orphan states detected — run: %s reconcile%s\n' \
      "${C_YELLOW}" "${SCRIPT_NAME}" "${C_RESET}"
  fi
  return $(( 1 - all_healthy ))
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
# Wave 6.18e — single-target spawn for `start <svc>` and `start <tool>`. Runs
# the same preflight/build gates as the bulk-start loop and reuses
# spawn_service (which carries the foreign-pid boot guard from 6.18d) so the
# single-target path stays in lockstep with the bulk path.
cmd_start_one() {
  local target="$1"; shift || true
  if ! is_known_name "${target}"; then
    fail "start: unknown service '${target}'. Known: ${SERVICES[*]} ${ONE_SHOT_TOOLS[*]}"
    exit 2
  fi
  preflight
  load_env
  apply_defaults
  resolve_ports_from_env
  ensure_run_dirs
  ensure_deps || exit 1
  if [[ "${target}" == "ui" ]]; then
    ensure_ui_build || exit 1
  fi
  if is_one_shot_tool "${target}"; then
    hdr "Starting one-shot tool: ${target}"
    if ! spawn_one_shot "${target}" "$@"; then
      fail "  ${target}: spawn failed"
      exit 1
    fi
    local tpidf; tpidf="$(pid_file "${target}")"
    local tpid; tpid="$(tr -d '[:space:]' < "${tpidf}" 2>/dev/null || echo '?')"
    ok "  ${target}: launched (pid ${tpid}); tail $(log_file "${target}") for progress"
    exit 0
  fi
  local port; port="$(svc_port_for "${target}")"
  hdr "Starting ${target} (port ${port})"
  if ! spawn_service "${target}" "${port}"; then
    fail "  ${target}: spawn failed"
    exit 1
  fi
  local result; result="$(wait_for_health "${target}" "${port}")"
  case "${result}" in
    ok)
      local pid; pid="$(tr -d '[:space:]' < "$(pid_file "${target}")" 2>/dev/null || echo '?')"
      ok "  ${target}: healthy (pid ${pid})"
      exit 0
      ;;
    timeout)
      warn "  ${target}: /healthz not 200 after ${HEALTH_TIMEOUT_S}s — continuing; see $(log_file "${target}")"
      exit 1
      ;;
    dead)
      fail "  ${target}: process died before /healthz responded — see $(log_file "${target}")"
      exit 1
      ;;
  esac
}

cmd_start() {
  # Wave 5.80 — single-target invocation (`start <svc>` or `start <tool>`)
  # dispatches to cmd_start_one and never touches the bulk-start loop.
  if [[ -n "${START_TARGET}" ]]; then
    cmd_start_one "${START_TARGET}" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
    return $?
  fi
  preflight
  load_env
  apply_defaults
  # Wave 5.79 — honour <SVC>_PORT overrides from .env.local for the spawn
  # loop, the healthz probes, and the final status table.
  resolve_ports_from_env
  ensure_run_dirs
  ensure_deps || exit 1
  ensure_ui_build || exit 1
  hdr "Starting FRTB SBM stack (process mode)"
  info "  repo:    ${REPO_ROOT}"
  info "  run dir: ${RUN_DIR}"
  local i=0 any_unhealthy=0
  while [[ $i -lt ${#SERVICES[@]} ]]; do
    local svc="${SERVICES[$i]}" port="${PORTS[$i]}"
    printf '%s[%d/%d] %s%s (port %s)…\n' \
      "${C_BOLD}${C_CYAN}" "$(( i + 1 ))" "${#SERVICES[@]}" "${svc}" "${C_RESET}" "${port}"
    if ! spawn_service "${svc}" "${port}"; then
      fail "  ${svc}: spawn failed"
      any_unhealthy=1
      i=$(( i + 1 ))
      continue
    fi
    local result
    result="$(wait_for_health "${svc}" "${port}")"
    case "${result}" in
      ok)
        local pid; pid="$(tr -d '[:space:]' < "$(pid_file "${svc}")" 2>/dev/null || echo '?')"
        ok "  ${svc}: healthy (pid ${pid})"
        ;;
      timeout)
        warn "  ${svc}: /healthz not 200 after ${HEALTH_TIMEOUT_S}s — continuing; see $(log_file "${svc}")"
        any_unhealthy=1
        ;;
      dead)
        fail "  ${svc}: process died before /healthz responded — see $(log_file "${svc}")"
        any_unhealthy=1
        ;;
    esac
    i=$(( i + 1 ))
  done
  hdr "Final status"
  print_status_table || any_unhealthy=1
  if [[ "${any_unhealthy}" == "0" ]]; then
    ok "All services healthy. UI: http://localhost:3000  API: http://localhost:8080/healthz"
    exit 0
  else
    fail "One or more services unhealthy. Tail logs with: ${SCRIPT_NAME} logs <svc> -f"
    exit 1
  fi
}

cmd_stop() {
  # Wave 6.18e — single-target invocation (`stop <svc>`) dispatches to
  # cmd_stop_one and never touches the bulk-stop loop.
  if [[ -n "${STOP_TARGET}" ]]; then
    cmd_stop_one "${STOP_TARGET}"
    return $?
  fi
  preflight_no_root
  cd "${REPO_ROOT}" 2>/dev/null || true
  hdr "Stopping FRTB SBM stack"
  if [[ ! -d "${PIDS_DIR}" ]]; then
    info "  no ${PIDS_DIR} — nothing to stop"
    return 0
  fi
  # Stop in reverse start order — UI first, then dependents, api last.
  local i=$(( ${#SERVICES[@]} - 1 ))
  local any_fail=0
  while [[ $i -ge 0 ]]; do
    stop_service "${SERVICES[$i]}" || any_fail=1
    i=$(( i - 1 ))
  done
  # Wave 5.80 — also tear down any explicitly-launched one-shot tools so a
  # bare `stop` always returns the workspace to a clean state.
  local j=0
  while [[ $j -lt ${#ONE_SHOT_TOOLS[@]} ]]; do
    stop_service "${ONE_SHOT_TOOLS[$j]}" || any_fail=1
    j=$(( j + 1 ))
  done
  if [[ "${any_fail}" == "0" ]]; then
    ok "Stack stopped."
    return 0
  fi
  return 1
}

# Wave 6.18e — single-target stop. Delegates to stop_service which already
# carries the orphan/foreign-listener TERM→KILL pattern (same path the bulk
# stop loop uses), so `stop <svc>` reclaims a port held by a foreign PID just
# like `stop` with no args does for the catalogue as a whole.
cmd_stop_one() {
  local target="$1"
  if ! is_known_name "${target}"; then
    fail "stop: unknown service '${target}'. Known: ${SERVICES[*]} ${ONE_SHOT_TOOLS[*]}"
    exit 2
  fi
  preflight_no_root
  cd "${REPO_ROOT}" 2>/dev/null || true
  load_env_quiet
  resolve_ports_from_env
  hdr "Stopping ${target}"
  if stop_service "${target}"; then
    ok "${target}: stop complete."
    return 0
  fi
  return 1
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_status() {
  preflight_no_root
  cd "${REPO_ROOT}" 2>/dev/null || true
  # Wave 5.79 — pick up <SVC>_PORT overrides so the table + probes match the
  # operator's actual binding.
  load_env_quiet
  resolve_ports_from_env
  hdr "FRTB SBM stack status"
  info "  repo:    ${REPO_ROOT}"
  info "  run dir: ${RUN_DIR}"
  local rc=0
  print_status_table || rc=1
  # Wave 5.80 — list one-shot tools with their running/idle state. These are
  # informational only and never fail the status command.
  if (( ${#ONE_SHOT_TOOLS[@]} > 0 )); then
    printf '\n%sOne-shot tools (manual invocation only):%s\n' "${C_DIM}" "${C_RESET}"
    local k=0
    while [[ $k -lt ${#ONE_SHOT_TOOLS[@]} ]]; do
      local tool="${ONE_SHOT_TOOLS[$k]}"
      local tpidf; tpidf="$(pid_file "${tool}")"
      local state="idle"
      if [[ -f "${tpidf}" ]]; then
        local tpid
        tpid="$(tr -d '[:space:]' < "${tpidf}" 2>/dev/null || echo '')"
        if [[ -n "${tpid}" ]] && pid_alive "${tpid}"; then
          state="running (pid ${tpid})"
        fi
      fi
      printf '  %-11s %s\n' "${tool}" "${state}"
      k=$(( k + 1 ))
    done
  fi
  exit "${rc}"
}

cmd_logs() {
  preflight_no_root
  if [[ -z "${LOGS_SERVICE}" ]]; then
    info "Available services:"
    local i=0
    while [[ $i -lt ${#SERVICES[@]} ]]; do
      printf '  %s (log: %s)\n' "${SERVICES[$i]}" "$(log_file "${SERVICES[$i]}")"
      i=$(( i + 1 ))
    done
    # Wave 5.80 — also surface one-shot tool log paths.
    if (( ${#ONE_SHOT_TOOLS[@]} > 0 )); then
      info "Available one-shot tools:"
      local j=0
      while [[ $j -lt ${#ONE_SHOT_TOOLS[@]} ]]; do
        printf '  %s (log: %s)\n' "${ONE_SHOT_TOOLS[$j]}" "$(log_file "${ONE_SHOT_TOOLS[$j]}")"
        j=$(( j + 1 ))
      done
    fi
    info ""
    info "Usage: ${SCRIPT_NAME} logs <svc> [-f|--follow]"
    return 0
  fi
  if ! is_known_name "${LOGS_SERVICE}"; then
    fail "Unknown service '${LOGS_SERVICE}'. Known: ${SERVICES[*]} ${ONE_SHOT_TOOLS[*]}"
    exit 2
  fi
  local logf; logf="$(log_file "${LOGS_SERVICE}")"
  if [[ ! -f "${logf}" ]]; then
    warn "No log file yet at ${logf} (service not started?)"
    exit 1
  fi
  if [[ "${LOGS_FOLLOW}" == "1" ]]; then
    tail -F "${logf}"
  else
    tail -n 200 "${logf}"
  fi
}

# ---------------------------------------------------------------------------
# doctor: numbered diagnostic with a colour summary. Never exits early on
# a failed check; runs all and exits 1 if any failed.
# ---------------------------------------------------------------------------
DOCTOR_FAILED=0
doctor_check() {
  local name="$1" verdict="$2" note="${3:-}"
  case "${verdict}" in
    ok)   printf '  %s✓%s  %-44s %s\n' "${C_GREEN}" "${C_RESET}" "${name}" "${C_DIM}${note}${C_RESET}" ;;
    warn) printf '  %s⚠%s  %-44s %s\n' "${C_YELLOW}" "${C_RESET}" "${name}" "${C_DIM}${note}${C_RESET}" ;;
    fail) printf '  %s✗%s  %-44s %s\n' "${C_RED}" "${C_RESET}" "${name}" "${C_DIM}${note}${C_RESET}"; DOCTOR_FAILED=1 ;;
  esac
}

# Return the PID currently listening on the given TCP port, or empty if free.
# Wave 6.18d — prefer `lsof` (portable: macOS + Linux); fall back to `ss` only
# when lsof is missing so the script keeps working on stripped-down Linux VMs.
listening_pid_on() {
  local port="$1" out=''
  if command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -n1)"
  elif command -v ss >/dev/null 2>&1; then
    out="$(ss -tlnpH "( sport = :${port} )" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n1)"
  fi
  echo "${out}"
}

cmd_doctor() {
  # Wave 5.79 — pick up <SVC>_PORT overrides so the port-availability checks
  # below probe the operator's actual binding instead of the catalogue defaults.
  load_env_quiet
  resolve_ports_from_env
  hdr "FRTB SBM run-local doctor"
  # Not-root.
  if [[ "$(id -u)" == "0" ]]; then
    doctor_check "running as non-root" fail "uid=0; refuse to run anything"
  else
    doctor_check "running as non-root" ok "uid=$(id -u) ($(id -un))"
  fi
  # Node ≥ 20.
  if command -v node >/dev/null 2>&1; then
    local nv major; nv="$(node -v 2>/dev/null | sed 's/^v//')"; major="${nv%%.*}"
    if [[ "${major}" =~ ^[0-9]+$ ]] && (( major >= 20 )); then
      doctor_check "node ≥ 20"               ok "v${nv}"
    else
      doctor_check "node ≥ 20"               fail "found v${nv:-?}"
    fi
  else
    doctor_check "node ≥ 20"                 fail "node not on PATH"
  fi
  # npm + curl presence.
  if command -v npm  >/dev/null 2>&1; then
    doctor_check "npm present"  ok   "$(npm -v 2>/dev/null)"
  else
    doctor_check "npm present"  fail "npm not on PATH"
  fi
  if command -v curl >/dev/null 2>&1; then
    doctor_check "curl present" ok   "$(curl --version 2>/dev/null | head -n1 | awk '{print $1, $2}')"
  else
    doctor_check "curl present" fail "curl not on PATH"
  fi
  # Wave 5.97B — `.env.local` is optional. The UI Connections panel is the
  # primary Redis-config path; `start` auto-creates the file with generated
  # secrets on first run. Doctor downgrades absence to an info notice and
  # warns (does not fail) when CONN_STORE_KEY still equals the dev default.
  if [[ -f "${ENV_LOCAL}" ]]; then
    doctor_check ".env.local present"        ok "${ENV_LOCAL}"
    # Parse in a subshell so a syntax error doesn't poison our env.
    if ( set -a; # shellcheck disable=SC1090
         . "${ENV_LOCAL}" 2>/dev/null; set +a ); then
      doctor_check ".env.local parseable"    ok "sourced cleanly"
      local rurl="" csk=""
      # shellcheck source=/dev/null
      rurl="$( set -a; . "${ENV_LOCAL}" 2>/dev/null; printf '%s' "${REDIS_URL:-}" )"
      csk="$( set -a; . "${ENV_LOCAL}" 2>/dev/null; printf '%s' "${CONN_STORE_KEY:-}" )"
      if [[ -z "${rurl}" ]]; then
        doctor_check "REDIS_URL"             ok "unset — UI Connections panel will configure Redis"
      elif [[ "${rurl}" == *CHANGE_ME* ]]; then
        doctor_check "REDIS_URL"             warn "contains CHANGE_ME placeholder (will be ignored)"
      else
        doctor_check "REDIS_URL"             ok "pre-seeded (redacted)"
      fi
      if [[ -z "${csk}" ]]; then
        doctor_check "CONN_STORE_KEY"        warn "unset — apply_defaults will use insecure 'dev-only-change-in-prod'"
      elif [[ "${csk}" == "dev-only-change-in-prod" ]]; then
        doctor_check "CONN_STORE_KEY"        warn "still set to insecure dev default — regenerate with: openssl rand -hex 32"
      else
        doctor_check "CONN_STORE_KEY"        ok "set (redacted)"
      fi
    else
      doctor_check ".env.local parseable"    fail "shell syntax error"
    fi
  else
    doctor_check ".env.local present"        ok "not present; will be auto-created on first start"
  fi
  # ./.run writable.
  if mkdir -p "${RUN_DIR}" 2>/dev/null && [[ -w "${RUN_DIR}" ]]; then
    doctor_check ".run/ writable"            ok "${RUN_DIR}"
  else
    doctor_check ".run/ writable"            fail "cannot create or write ${RUN_DIR}"
  fi
  # Ports: 3000, 8080-8085 must be free OR owned by a PID we manage.
  local i=0
  while [[ $i -lt ${#SERVICES[@]} ]]; do
    local svc="${SERVICES[$i]}" port="${PORTS[$i]}"
    local lpid; lpid="$(listening_pid_on "${port}")"
    if [[ -z "${lpid}" ]]; then
      doctor_check "port ${port} (${svc})"   ok "free"
    else
      local pidf; pidf="$(pid_file "${svc}")"
      local our_pid=''
      [[ -f "${pidf}" ]] && our_pid="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
      if [[ -n "${our_pid}" ]] && [[ "${our_pid}" == "${lpid}" ]]; then
        doctor_check "port ${port} (${svc})" ok  "owned by our pid ${lpid}"
      else
        doctor_check "port ${port} (${svc})" fail "in use by foreign pid ${lpid}"
      fi
    fi
    i=$(( i + 1 ))
  done
  # Wave 6.18d — flag hung/orphan states the per-port check above doesn't catch
  # (hung = pidfile alive but port not bound; orphan check below complements the
  # "foreign pid" message above with a clearer pointer to `reconcile`).
  local h=0
  while [[ $h -lt ${#SERVICES[@]} ]]; do
    local hsvc="${SERVICES[$h]}" hport="${PORTS[$h]}"
    local hstate; hstate="$(svc_state "${hsvc}" "${hport}")"
    case "${hstate}" in
      hung:*)
        doctor_check "service ${hsvc} liveness"  fail "${hstate} — process alive but port ${hport} not bound; run \`${SCRIPT_NAME} reconcile ${hsvc}\`" ;;
      orphan:*)
        doctor_check "service ${hsvc} liveness"  fail "${hstate} — pidfile dead, port ${hport} held; run \`${SCRIPT_NAME} reconcile ${hsvc}\`" ;;
    esac
    h=$(( h + 1 ))
  done
  # Wave 6.05 — informational: does the built UI bundle bypass the same-origin
  # /api proxy by hard-coding http://localhost:8080? Never fails; skipped when
  # the dist hasn't been built.
  if [[ -d "${REPO_ROOT}/services/ui/dist" ]]; then
    if grep -lq 'http://localhost:8080' "${REPO_ROOT}/services/ui/dist/assets/"index-*.js 2>/dev/null; then
      doctor_check "UI bundle API mode"        ok "UI bundle pinned to absolute URL; single-VM proxy bypassed"
    else
      doctor_check "UI bundle API mode"        ok "UI bundle uses same-origin /api proxy"
    fi
  fi
  printf '\n'
  if [[ "${DOCTOR_FAILED}" == "0" ]]; then
    ok "doctor: all checks passed"
    exit 0
  fi
  fail "doctor: one or more checks failed"
  exit 1
}

# ---------------------------------------------------------------------------
# Wave 6.18d — reconcile pidfile ↔ live PID ↔ port owner for one service.
# Wave 6.18e — also act on foreign:<lpid> (no pidfile, port held by a foreign
# live PID) so `reconcile <svc>` can clear a stray listener the operator never
# pointed at, not just orphan/hung states left behind by our own boot.
# Idempotent: safe to re-run. Returns 0 on success (incl. "nothing to do").
# Side-effects per state:
#   hung:<pid>      SIGTERM → wait STOP_GRACE_S → SIGKILL <pid>; clear pidfile.
#   orphan:<lpid>   Same TERM→KILL pattern on the listening PID; clear pidfile.
#   foreign:<lpid>  Same TERM→KILL pattern on the listening PID; no pidfile to clear.
#   dead:<pid>      Clear stale pidfile (no PID to kill).
#   running:*|stopped  Print "nothing to do".
# ---------------------------------------------------------------------------
reconcile_one() {
  local svc="$1" port="${2:-}"
  local state; state="$(svc_state "${svc}" "${port}")"
  local pidf; pidf="$(pid_file "${svc}")"
  local kind="${state%%:*}" target_pid="${state##*:}"
  case "${state}" in
    stopped|running:*)
      info "  ${svc}: nothing to do (${state})"
      return 0
      ;;
    dead:*)
      info "  ${svc}: cleared dead pidfile (was pid ${target_pid})"
      rm -f "${pidf}" 2>/dev/null || true
      return 0
      ;;
    hung:*|orphan:*|foreign:*)
      : ;;
    *)
      info "  ${svc}: nothing to do (${state})"
      return 0
      ;;
  esac
  warn "  ${svc}: ${state} — sending SIGTERM to pid ${target_pid}"
  kill -TERM "${target_pid}" 2>/dev/null || true
  local i=0
  while (( i < STOP_GRACE_S * 2 )) && pid_alive "${target_pid}"; do
    sleep 0.5
    i=$(( i + 1 ))
  done
  if pid_alive "${target_pid}"; then
    warn "  ${svc}: pid ${target_pid} ignored SIGTERM, sending SIGKILL"
    kill -KILL "${target_pid}" 2>/dev/null || true
    sleep 0.5
  fi
  if pid_alive "${target_pid}"; then
    fail "  ${svc}: pid ${target_pid} did not exit"
    return 1
  fi
  ok "  ${svc}: killed ${kind} pid ${target_pid}"
  rm -f "${pidf}" 2>/dev/null || true
  return 0
}

cmd_reconcile() {
  preflight_no_root
  cd "${REPO_ROOT}" 2>/dev/null || true
  load_env_quiet
  resolve_ports_from_env
  local target="${1:-all}"
  hdr "Reconciling FRTB SBM stack (target: ${target})"
  local any_fail=0
  if [[ "${target}" == "all" ]]; then
    local i=0
    while [[ $i -lt ${#SERVICES[@]} ]]; do
      reconcile_one "${SERVICES[$i]}" "${PORTS[$i]}" || any_fail=1
      i=$(( i + 1 ))
    done
    local j=0
    while [[ $j -lt ${#ONE_SHOT_TOOLS[@]} ]]; do
      reconcile_one "${ONE_SHOT_TOOLS[$j]}" '' || any_fail=1
      j=$(( j + 1 ))
    done
  else
    if ! is_known_name "${target}"; then
      fail "reconcile: unknown service '${target}'. Known: ${SERVICES[*]} ${ONE_SHOT_TOOLS[*]} all"
      exit 2
    fi
    local port=''
    if svc_index "${target}" >/dev/null 2>&1; then
      port="$(svc_port_for "${target}")"
    fi
    reconcile_one "${target}" "${port}" || any_fail=1
  fi
  if [[ "${any_fail}" == "0" ]]; then
    ok "reconcile: done"
    return 0
  fi
  fail "reconcile: one or more services could not be reconciled"
  return 1
}

# ---------------------------------------------------------------------------
# Usage / arg parser / main
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} <command> [options]

Commands:
  start              Start the 6 long-running services (api, source, ingest,
                     calc, loadgen, ui) in dependency order, poll /healthz,
                     print a status table. Exits 0 only if every service is healthy.
  start <svc>        Start one named service or one-shot tool. For the
                     one-shot 'generator', append '-- --rows N' to forward
                     CLI args (e.g. 'start generator -- --rows 50').
  stop               SIGTERM each service + one-shot tool (5s grace, then
                     SIGKILL). Idempotent.
  stop <svc>         Stop one named service or one-shot tool. Same TERM→KILL
                     grace as bulk stop; also clears a port held by a foreign
                     listener (orphan/foreign:PID) the same way.
  restart            stop, then start.
  status             Print the live status table for long-running services;
                     also lists one-shot tools with running/idle state.
  logs <svc> [-f]    Tail .run/logs/<svc>.log. --follow / -f streams new lines.
                     Argless prints the list of known services + one-shot tools.
  doctor             Run diagnostics (Node version, env file, ports, .run/ writable).
  reconcile [svc]    Wave 6.18d — reconcile pidfile ↔ live PID ↔ port owner.
                     For each service in 'hung' (pidfile alive, port not bound),
                     'orphan' (pidfile dead, port held by foreign PID), or
                     'foreign' (no pidfile, port held by foreign PID) state:
                     SIGTERM → SIGKILL the bad PID and clear the pidfile.
                     'reconcile' with no arg (or 'reconcile all') reconciles all.
                     Idempotent; safe to re-run.

Status table state strings:
  <pid>              green   — running normally (pidfile alive, port bound).
  hung:<pid>         yellow  — pidfile alive but port NOT bound (wedged boot).
  orphan:<pid>       red     — pidfile dead, port held by another live PID.
  dead:<pid>         red     — pidfile dead AND port free (stale pidfile only).

Options for start/restart:
  --force-install    Re-run 'npm install' even if node_modules/ exists.
  --force-build      Re-run the UI build even if services/ui/dist/ exists.

One-shot tools (NOT started by bare 'start'; invoke explicitly):
  generator          Synthetic FRTB sensitivity producer; pushes rows into
                     the 'sensitivities:in' Redis stream and exits. Default
                     run produces 2,000,000 rows — use '-- --rows N' to limit.

Environment:
  NO_COLOR=1         Force monochrome output.

Layout under ${REPO_ROOT}/.run/ (created on first run):
  logs/<svc>.log     per-service stdout+stderr (append-only)
  pids/<svc>.pid     PID files
  env                redacted env snapshot
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      start)
        if [[ -n "${COMMAND}" ]]; then
          fail "error: multiple commands ('${COMMAND}' and 'start')"; exit 2
        fi
        COMMAND="start"; shift
        # Wave 5.80 — `start` accepts an optional positional <svc> followed
        # by `--` and extra args forwarded to one-shot tools.
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --force-install) OPT_FORCE_INSTALL=1; shift ;;
            --force-build)   OPT_FORCE_BUILD=1;   shift ;;
            -h|--help)       usage; exit 0 ;;
            --)
              shift
              while [[ $# -gt 0 ]]; do
                EXTRA_ARGS+=("$1"); shift
              done
              ;;
            -*) fail "error: unknown option for start: $1"; exit 2 ;;
            *)
              if [[ -z "${START_TARGET}" ]]; then
                START_TARGET="$1"; shift
              else
                fail "error: unexpected arg for start: $1"; exit 2
              fi
              ;;
          esac
        done
        ;;
      stop)
        if [[ -n "${COMMAND}" ]]; then
          fail "error: multiple commands ('${COMMAND}' and 'stop')"; exit 2
        fi
        COMMAND="stop"; shift
        # Wave 6.18e — `stop` accepts an optional positional <svc>.
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -h|--help) usage; exit 0 ;;
            --)        shift; break ;;
            -*)        fail "error: unknown option for stop: $1"; exit 2 ;;
            *)
              if [[ -z "${STOP_TARGET}" ]]; then
                STOP_TARGET="$1"; shift
              else
                fail "error: unexpected arg for stop: $1"; exit 2
              fi
              ;;
          esac
        done
        ;;
      restart|status|doctor)
        if [[ -n "${COMMAND}" ]]; then
          fail "error: multiple commands ('${COMMAND}' and '$1')"; exit 2
        fi
        COMMAND="$1"; shift
        ;;
      reconcile)
        if [[ -n "${COMMAND}" ]]; then
          fail "error: multiple commands ('${COMMAND}' and 'reconcile')"; exit 2
        fi
        COMMAND="reconcile"; shift
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -h|--help) usage; exit 0 ;;
            --)        shift; break ;;
            -*)        fail "error: unknown option for reconcile: $1"; exit 2 ;;
            *)
              if [[ -z "${RECONCILE_TARGET}" ]]; then
                RECONCILE_TARGET="$1"; shift
              else
                fail "error: unexpected arg for reconcile: $1"; exit 2
              fi
              ;;
          esac
        done
        ;;
      logs)
        if [[ -n "${COMMAND}" ]]; then
          fail "error: multiple commands ('${COMMAND}' and 'logs')"; exit 2
        fi
        COMMAND="logs"; shift
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --follow|-f) LOGS_FOLLOW=1; shift ;;
            -h|--help)   usage; exit 0 ;;
            --)          shift; break ;;
            -*)          fail "error: unknown option for logs: $1"; exit 2 ;;
            *)
              if [[ -z "${LOGS_SERVICE}" ]]; then
                LOGS_SERVICE="$1"; shift
              else
                fail "error: unexpected arg for logs: $1"; exit 2
              fi
              ;;
          esac
        done
        ;;
      --force-install)   OPT_FORCE_INSTALL=1; shift ;;
      --force-build)     OPT_FORCE_BUILD=1;   shift ;;
      -h|--help)         usage; exit 0 ;;
      --)                shift; break ;;
      -*)                fail "error: unknown option: $1"; usage >&2; exit 2 ;;
      *)                 fail "error: unexpected argument: $1"; usage >&2; exit 2 ;;
    esac
  done
}

main() {
  init_colours
  parse_args "$@"
  if [[ -z "${COMMAND}" ]]; then
    usage
    exit 2
  fi
  case "${COMMAND}" in
    start)     cmd_start ;;
    stop)      cmd_stop ;;
    restart)   cmd_restart ;;
    status)    cmd_status ;;
    logs)      cmd_logs ;;
    doctor)    cmd_doctor ;;
    reconcile) cmd_reconcile "${RECONCILE_TARGET:-all}" ;;
  esac
}

main "$@"


#!/usr/bin/env bash
# scripts/run-local.sh
#
# Local-developer launcher for the FRTB SBM stack. Starts all 7 services as
# background processes owned by the invoking user; all PIDs, logs, and runtime
# state live under ./.run/. No sudo, no systemd, no /var/lib/frtb.
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
SERVICES=( api source ingest calc loadgen generator ui )
PORTS=(    8080 8082    8083    8084 8085    8081      3000 )

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

preflight_env_local() {
  if [[ ! -f "${ENV_LOCAL}" ]]; then
    fail "Missing .env.local. Run: cp ${ENV_EXAMPLE_REL} .env.local and fill in REDIS_URL."
    exit 1
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
load_env() {
  set -a
  # shellcheck disable=SC1090
  . "${ENV_LOCAL}"
  set +a
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
stop_service() {
  local svc="$1"
  local pidf; pidf="$(pid_file "${svc}")"
  if [[ ! -f "${pidf}" ]]; then
    info "  ${svc}: no pidfile (already stopped)"
    return 0
  fi
  local pid
  pid="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
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

pid_cell() {
  local svc="$1" pidf pid
  pidf="$(pid_file "${svc}")"
  if [[ ! -f "${pidf}" ]]; then
    printf '%s%-11s%s' "${C_DIM}" "-" "${C_RESET}"
    return 0
  fi
  pid="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
  if [[ -z "${pid}" ]]; then
    printf '%s%-11s%s' "${C_DIM}" "-" "${C_RESET}"
  elif pid_alive "${pid}"; then
    printf '%s%-11s%s' "${C_GREEN}" "${pid}" "${C_RESET}"
  else
    printf '%s%-11s%s' "${C_RED}" "dead:${pid}" "${C_RESET}"
  fi
}

age_cell() {
  local svc="$1" pidf pid
  pidf="$(pid_file "${svc}")"
  [[ -f "${pidf}" ]] || { printf '%s%-11s%s' "${C_DIM}" "-" "${C_RESET}"; return 0; }
  pid="$(tr -d '[:space:]' < "${pidf}" 2>/dev/null || echo '')"
  if [[ -z "${pid}" ]] || ! pid_alive "${pid}"; then
    printf '%s%-11s%s' "${C_DIM}" "-" "${C_RESET}"
    return 0
  fi
  printf '%-11s' "$(pid_age "${pid}")"
}

print_status_table() {
  local header sep
  header="${C_BOLD}Service     | PID         | Age         | Port  | /healthz${C_RESET}"
  sep='------------+-------------+-------------+-------+------------------'
  printf '%s\n%s\n' "${header}" "${sep}"
  local i=0 all_healthy=1
  while [[ $i -lt ${#SERVICES[@]} ]]; do
    local svc="${SERVICES[$i]}" port="${PORTS[$i]}"
    local pid_s age_s health_s
    pid_s="$(pid_cell "${svc}")"
    age_s="$(age_cell "${svc}")"
    health_s="$(health_cell "${port}")"
    if ! health_probe "${port}"; then
      all_healthy=0
    fi
    printf '%-11s | %s | %s | %-5s | %s\n' "${svc}" "${pid_s}" "${age_s}" "${port}" "${health_s}"
    i=$(( i + 1 ))
  done
  return $(( 1 - all_healthy ))
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
cmd_start() {
  preflight
  load_env
  apply_defaults
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
  if [[ "${any_fail}" == "0" ]]; then
    ok "Stack stopped."
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
  hdr "FRTB SBM stack status"
  info "  repo:    ${REPO_ROOT}"
  info "  run dir: ${RUN_DIR}"
  if print_status_table; then
    exit 0
  fi
  exit 1
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
    info ""
    info "Usage: ${SCRIPT_NAME} logs <svc> [-f|--follow]"
    return 0
  fi
  if ! svc_index "${LOGS_SERVICE}" >/dev/null; then
    fail "Unknown service '${LOGS_SERVICE}'. Known: ${SERVICES[*]}"
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
listening_pid_on() {
  local port="$1" out=''
  if command -v lsof >/dev/null 2>&1; then
    out="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null | head -n1)"
  fi
  echo "${out}"
}

cmd_doctor() {
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
  # .env.local presence + parseable + REDIS_URL non-empty.
  if [[ -f "${ENV_LOCAL}" ]]; then
    doctor_check ".env.local present"        ok "${ENV_LOCAL}"
    # Parse in a subshell so a syntax error doesn't poison our env.
    if ( set -a; # shellcheck disable=SC1090
         . "${ENV_LOCAL}" 2>/dev/null; set +a ); then
      doctor_check ".env.local parseable"    ok "sourced cleanly"
      local rurl=""
      # shellcheck source=/dev/null
      rurl="$( set -a; . "${ENV_LOCAL}" 2>/dev/null; printf '%s' "${REDIS_URL:-}" )"
      if [[ -n "${rurl}" ]] && [[ "${rurl}" != *CHANGE_ME* ]]; then
        doctor_check "REDIS_URL non-empty"   ok "(redacted)"
      elif [[ -n "${rurl}" ]]; then
        doctor_check "REDIS_URL non-empty"   warn "still contains CHANGE_ME placeholder"
      else
        doctor_check "REDIS_URL non-empty"   fail "REDIS_URL is empty"
      fi
    else
      doctor_check ".env.local parseable"    fail "shell syntax error"
    fi
  else
    doctor_check ".env.local present"        fail "missing — cp ${ENV_EXAMPLE_REL} .env.local"
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
  printf '\n'
  if [[ "${DOCTOR_FAILED}" == "0" ]]; then
    ok "doctor: all checks passed"
    exit 0
  fi
  fail "doctor: one or more checks failed"
  exit 1
}

# ---------------------------------------------------------------------------
# Usage / arg parser / main
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} <command> [options]

Commands:
  start              Start all 7 services in dependency order, poll /healthz,
                     print a status table. Exits 0 only if every service is healthy.
  stop               SIGTERM each service (5s grace, then SIGKILL). Idempotent.
  restart            stop, then start.
  status             Print the live status table. Exits 0 if all healthy.
  logs <svc> [-f]    Tail .run/logs/<svc>.log. --follow / -f streams new lines.
                     Argless prints the list of known services.
  doctor             Run diagnostics (Node version, env file, ports, .run/ writable).

Options for start/restart:
  --force-install    Re-run 'npm install' even if node_modules/ exists.
  --force-build      Re-run the UI build even if services/ui/dist/ exists.

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
      start|stop|restart|status|doctor)
        if [[ -n "${COMMAND}" ]]; then
          fail "error: multiple commands ('${COMMAND}' and '$1')"; exit 2
        fi
        COMMAND="$1"; shift
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
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    logs)    cmd_logs ;;
    doctor)  cmd_doctor ;;
  esac
}

main "$@"


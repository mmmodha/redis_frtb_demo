#!/usr/bin/env bash
# Ensure TLS material exists for the ui nginx container.
#
# Self-signed by default (browsers warn — replace with a real cert for demos).
# Includes localhost + 127.0.0.1, plus the VM public IP when known so
# https://<public-ip>/ does not fail hostname matching.
#
# Env:
#   TLS_CERT_DIR   — cert directory (default: <repo>/certs); also accepted as $1
#   PUBLIC_IP      — IPv4 to embed in SAN (skips auto-detect when set)
#   TLS_HOSTNAMES  — comma-separated extra DNS names (e.g. demo.example.com)
#   TLS_SAN        — full subjectAltName override (skips PUBLIC_IP / defaults)
#   TLS_FORCE=1    — always regenerate
#
# Exit 0 always on success. Prints TLS_CERTS_CHANGED=1 when files were written
# so callers (docker-up.sh) can recreate the ui container to pick up new certs.
#
# Usage:
#   scripts/ensure-tls-certs.sh
#   PUBLIC_IP=34.89.13.108 scripts/ensure-tls-certs.sh
#   TLS_CERT_DIR=/path/to/certs scripts/ensure-tls-certs.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${1:-${TLS_CERT_DIR:-${REPO_ROOT}/certs}}"

mkdir -p "${CERT_DIR}"
CRT="${CERT_DIR}/tls.crt"
KEY="${CERT_DIR}/tls.key"
CHANGED=0

is_ipv4() {
  [[ "${1:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

detect_public_ip() {
  local ip=""
  # GCP metadata (VMs in Google Cloud)
  ip="$(curl -fsS -m 2 -H "Metadata-Flavor: Google" \
    "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" \
    2>/dev/null || true)"
  if is_ipv4 "${ip}"; then
    echo "${ip}"
    return 0
  fi
  # AWS / generic IMDS is less consistent; fall back to public echo services.
  for url in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    ip="$(curl -4 -fsS -m 3 "${url}" 2>/dev/null | tr -d '[:space:]' || true)"
    if is_ipv4 "${ip}"; then
      echo "${ip}"
      return 0
    fi
  done
  return 1
}

build_san() {
  if [[ -n "${TLS_SAN:-}" ]]; then
    echo "${TLS_SAN}"
    return 0
  fi

  local parts=("DNS:localhost" "IP:127.0.0.1")
  local ip="${PUBLIC_IP:-}"
  if [[ -z "${ip}" ]]; then
    ip="$(detect_public_ip || true)"
  fi
  if is_ipv4 "${ip}" && [[ "${ip}" != "127.0.0.1" ]]; then
    parts+=("IP:${ip}")
    # Stash for docker-up messaging (subshell-safe via file).
    echo "${ip}" > "${CERT_DIR}/.public-ip"
  else
    rm -f "${CERT_DIR}/.public-ip"
  fi

  if [[ -n "${TLS_HOSTNAMES:-}" ]]; then
    local IFS=','
    local host
    for host in ${TLS_HOSTNAMES}; do
      host="$(echo "${host}" | tr -d '[:space:]')"
      [[ -n "${host}" ]] && parts+=("DNS:${host}")
    done
  fi

  local IFS=','
  echo "${parts[*]}"
}

cert_covers_san() {
  local want="$1"
  [[ -f "${CRT}" ]] || return 1
  local text
  text="$(openssl x509 -in "${CRT}" -noout -text 2>/dev/null || true)"
  [[ -n "${text}" ]] || return 1

  local IFS=','
  local entry kind value pattern
  for entry in ${want}; do
    entry="$(echo "${entry}" | tr -d '[:space:]')"
    kind="${entry%%:*}"
    value="${entry#*:}"
    case "${kind}" in
      DNS) pattern="DNS:${value}" ;;
      IP)  pattern="IP Address:${value}" ;;
      *)   continue ;;
    esac
    if ! grep -Fq "${pattern}" <<<"${text}"; then
      return 1
    fi
  done
  return 0
}

generate_cert() {
  local san="$1"
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate self-signed TLS certs" >&2
    exit 1
  fi

  echo "Generating self-signed TLS cert (SAN=${san}) → ${CERT_DIR}"
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "${KEY}" \
    -out "${CRT}" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=${san}" \
    2>/dev/null

  chmod 600 "${KEY}"
  chmod 644 "${CRT}"
  CHANGED=1
  echo "  → Self-signed: browsers will warn. Replace with a real cert for customer demos."
}

SAN="$(build_san)"

if [[ "${TLS_FORCE:-0}" == "1" ]] || ! cert_covers_san "${SAN}"; then
  if [[ -f "${CRT}" && -f "${KEY}" && "${TLS_FORCE:-0}" != "1" ]]; then
    echo "Existing cert missing required SAN (${SAN}) — regenerating…"
  fi
  generate_cert "${SAN}"
else
  echo "TLS certs present and cover SAN (${SAN}): ${CRT}"
fi

if [[ "${CHANGED}" == "1" ]]; then
  echo "TLS_CERTS_CHANGED=1"
fi

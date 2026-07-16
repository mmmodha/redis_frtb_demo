#!/usr/bin/env bash
# Ensure TLS material exists for the ui nginx container.
# Default: self-signed cert for localhost (browsers will warn — replace with
# a real cert for demos). Override directory via TLS_CERT_DIR or $1.
#
# Usage:
#   scripts/ensure-tls-certs.sh
#   TLS_CERT_DIR=/path/to/certs scripts/ensure-tls-certs.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${1:-${TLS_CERT_DIR:-${REPO_ROOT}/certs}}"

mkdir -p "${CERT_DIR}"
CRT="${CERT_DIR}/tls.crt"
KEY="${CERT_DIR}/tls.key"

if [[ -f "${CRT}" && -f "${KEY}" ]]; then
  echo "TLS certs present: ${CRT}"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate self-signed TLS certs" >&2
  exit 1
fi

echo "Generating self-signed TLS cert for localhost → ${CERT_DIR}"
openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "${KEY}" \
  -out "${CRT}" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  2>/dev/null

chmod 600 "${KEY}"
chmod 644 "${CRT}"
echo "  → Replace ${CRT} / ${KEY} with a real certificate for production demos."

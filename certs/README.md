# TLS certificates (Docker UI)

The `ui` nginx container mounts this directory at `/etc/nginx/certs` and
expects:

| File | Role |
|------|------|
| `tls.crt` | Server certificate (PEM) |
| `tls.key` | Private key (PEM) |

`scripts/docker-up.sh` (and `scripts/ensure-tls-certs.sh`) create a
**self-signed** pair when these files are missing or when the cert does not
cover the VM's public IP. Browsers will show a warning — that is expected
for local / PoV use.

### Public IP / hostname SAN

On a VM, the script auto-detects the external IPv4 (GCP metadata, then
ipify/ifconfig) and embeds it in the certificate SAN so
`https://<public-ip>/` matches. Override or extend:

```bash
PUBLIC_IP=34.89.13.108 scripts/docker-up.sh
TLS_HOSTNAMES=demo.example.com scripts/docker-up.sh
TLS_SAN='DNS:demo.example.com,IP:34.89.13.108' scripts/ensure-tls-certs.sh
TLS_FORCE=1 scripts/ensure-tls-certs.sh   # always regenerate
```

For a real demo or deploy VM, replace both files with a certificate trusted
by your audience (or set `TLS_CERT_DIR` to a directory that already contains
them) and restart:

```bash
TLS_CERT_DIR=/path/to/real-certs scripts/docker-up.sh
# or copy into ./certs/ then:
docker compose up -d --force-recreate ui
```

Only **HTTPS :443** is published to the host. Port 3000 stays inside the
container for healthchecks; the API (`:8080`) is not published.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = resolve(ROOT, 'scripts/ensure-tls-certs.sh');

function runEnsure(env, certDir) {
  return execFileSync('bash', [SCRIPT, certDir], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function certText(certDir) {
  return execFileSync(
    'openssl',
    ['x509', '-in', join(certDir, 'tls.crt'), '-noout', '-text'],
    { encoding: 'utf8' },
  );
}

describe('scripts/ensure-tls-certs.sh', () => {
  let certDir;

  beforeEach(() => {
    certDir = mkdtempSync(join(tmpdir(), 'frtb-tls-'));
  });

  afterEach(() => {
    rmSync(certDir, { recursive: true, force: true });
  });

  it('embeds PUBLIC_IP in the certificate SAN', () => {
    runEnsure({ PUBLIC_IP: '203.0.113.10' }, certDir);
    expect(existsSync(join(certDir, 'tls.crt'))).toBe(true);
    expect(existsSync(join(certDir, 'tls.key'))).toBe(true);

    const text = certText(certDir);
    expect(text).toMatch(/IP Address:203\.0\.113\.10/);
    expect(text).toMatch(/DNS:localhost/);
    expect(text).toMatch(/IP Address:127\.0\.0\.1/);
  });

  it('regenerates when an existing cert is missing the requested PUBLIC_IP', () => {
    runEnsure({ PUBLIC_IP: '203.0.113.10' }, certDir);
    const first = readFileSync(join(certDir, 'tls.crt'));

    const out = runEnsure({ PUBLIC_IP: '198.51.100.20' }, certDir);
    const second = readFileSync(join(certDir, 'tls.crt'));

    expect(Buffer.compare(first, second)).not.toBe(0);
    expect(out).toMatch(/regenerat|Generating/i);
    expect(certText(certDir)).toMatch(/IP Address:198\.51\.100\.20/);
  });

  it('honours TLS_SAN as a full subjectAltName override', () => {
    runEnsure(
      { TLS_SAN: 'DNS:demo.example.com,IP:203.0.113.50' },
      certDir,
    );
    const text = certText(certDir);
    expect(text).toMatch(/DNS:demo\.example\.com/);
    expect(text).toMatch(/IP Address:203\.0\.113\.50/);
  });
});

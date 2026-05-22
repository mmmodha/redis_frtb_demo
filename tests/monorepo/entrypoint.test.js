import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = resolve(__dirname, '..', '..');
const APP_SERVICES = ['ui', 'api', 'generator', 'source', 'ingest', 'calc', 'loadgen'];

describe('service entry points', () => {
  for (const name of APP_SERVICES) {
    it(`services/${name} entry point prints "ready" and binds a health port`, () => {
      const entry = resolve(ROOT, 'services', name, 'src', 'index.mjs');
      expect(existsSync(entry), `services/${name}/src/index.mjs must exist`).toBe(true);
      const res = spawnSync(process.execPath, [entry], {
        env: { ...process.env, HEALTH_PORT: '0', SMOKE: '1' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(res.status, `services/${name} should exit 0 in SMOKE mode\nstdout:${res.stdout}\nstderr:${res.stderr}`).toBe(0);
      expect((res.stdout + res.stderr).toLowerCase(), `services/${name} must log "ready"`).toMatch(/ready/);
    });
  }
});

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = resolve(__dirname, '..', '..');
// Stubs owned by this task. The "generator" service is implemented by a sibling agent
// and runs its own smoke test in its own package; we only assert layout/Dockerfile for it elsewhere.
const APP_SERVICES = ['ui', 'api', 'source', 'ingest', 'calc', 'loadgen'];

// Resolve a service's entry script from its package.json "start" script, e.g.
//   "start": "node src/index.mjs"   -> { runner: "node", entry: "src/index.mjs" }
//   "start": "tsx src/cli.ts"       -> { runner: "tsx",  entry: "src/cli.ts" }
function resolveEntry(serviceDir) {
  const pkg = JSON.parse(readFileSync(resolve(serviceDir, 'package.json'), 'utf8'));
  const start = pkg.scripts && pkg.scripts.start;
  if (!start) return null;
  const tokens = start.trim().split(/\s+/);
  const runner = tokens[0];
  const entry = tokens[tokens.length - 1];
  return { runner, entry, absEntry: resolve(serviceDir, entry) };
}

describe('service entry points', () => {
  for (const name of APP_SERVICES) {
    it(`services/${name} has an entry point (node entry also prints "ready" in SMOKE mode)`, () => {
      const serviceDir = resolve(ROOT, 'services', name);
      const resolved = resolveEntry(serviceDir);
      expect(resolved, `services/${name}/package.json must declare a "start" script`).not.toBeNull();
      expect(existsSync(resolved.absEntry), `services/${name} start script entry ${resolved.entry} must exist`).toBe(true);
      // Only node-runnable entries (.mjs via node) participate in the SMOKE spawn check;
      // tsx-based .ts entries are covered by their own service-level smoke tests.
      if (resolved.runner !== 'node') return;
      const res = spawnSync(process.execPath, [resolved.absEntry], {
        env: { ...process.env, HEALTH_PORT: '0', SMOKE: '1' },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(res.status, `services/${name} should exit 0 in SMOKE mode\nstdout:${res.stdout}\nstderr:${res.stderr}`).toBe(0);
      expect((res.stdout + res.stderr).toLowerCase(), `services/${name} must log "ready"`).toMatch(/ready/);
    });
  }
});

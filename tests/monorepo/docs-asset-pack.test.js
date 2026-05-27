import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, statSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(__dirname, '..', '..');
const PACK = resolve(ROOT, 'docs/asset-pack');
const SCRIPTS_OK = () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  return typeof pkg.scripts?.['asset-pack'] === 'string';
};

// Files the asset pack must contain after the build runs. Each is referenced
// in the task note's "post-demo handoff bundle" list or the supervisor's
// deliverables list.
const REQUIRED_FILES = [
  'deck.pdf',
  'talking-points.md',
  'competitive-positioning.md',
  'next-steps.md',
  'exec-summary.md',
  'technical-brief.md',
  'architecture.png',
  'extensibility.png',
];

// 13 demo steps (1, 2, 2a, 3..12)
const SCREENSHOT_STEPS = [
  '01-problem',
  '02-architecture',
  '02a-connections',
  '03-ingest',
  '04-native-array',
  '05-pivot',
  '06-delta',
  '07-vega',
  '08-concurrent',
  '09-extensibility',
  '10-scale',
  '11-failover',
  '12-close',
];

describe('npm run asset-pack', () => {
  it('is wired in root package.json', () => {
    expect(SCRIPTS_OK(), 'root package.json must define an "asset-pack" script').toBe(true);
  });

  it('produces docs/asset-pack/ with all required files', () => {
    // Clean before to make this a real round-trip; the script must be idempotent.
    if (existsSync(PACK)) rmSync(PACK, { recursive: true, force: true });
    const res = spawnSync('npm', ['run', '--silent', 'asset-pack'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(
      res.status,
      `asset-pack exit non-zero\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).toBe(0);
    expect(existsSync(PACK), 'docs/asset-pack/ must be created by the script').toBe(true);
    for (const f of REQUIRED_FILES) {
      const p = resolve(PACK, f);
      expect(existsSync(p), `${f} must be in asset-pack`).toBe(true);
      expect(statSync(p).size, `${f} must be non-empty`).toBeGreaterThan(0);
    }
  }, 90_000);

  it('produces a screenshot per demo step under docs/asset-pack/screenshots/', () => {
    const dir = resolve(PACK, 'screenshots');
    expect(existsSync(dir), 'screenshots dir must exist').toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.png'));
    for (const step of SCREENSHOT_STEPS) {
      const found = files.find((f) => f === `step-${step}.png`);
      expect(found, `screenshot for step ${step} required`).toBeDefined();
      expect(statSync(resolve(dir, found)).size, `step-${step}.png must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('zips the bundle as docs/asset-pack.zip ready to email to HSBC', () => {
    const zip = resolve(ROOT, 'docs/asset-pack.zip');
    expect(existsSync(zip), 'docs/asset-pack.zip must exist after asset-pack run').toBe(true);
    expect(statSync(zip).size, 'docs/asset-pack.zip must be non-empty').toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

// These two root scripts must work out-of-the-box from the repo root with
// no extra arguments, so the presenter can run them during demo prep.
describe('root scripts wired to @frtb/schema-cli', () => {
  it('npm run schema:validate exits 0 against the bundled default schema', () => {
    const res = spawnSync('npm', ['run', '--silent', 'schema:validate'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(
      res.status,
      `exit non-zero\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).toBe(0);
    expect((res.stdout + res.stderr).toLowerCase()).toMatch(/validated|ok/);
  }, 60_000);

  it('npm run schema:generate exits 0 against the bundled default schema', () => {
    const res = spawnSync('npm', ['run', '--silent', 'schema:generate'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(
      res.status,
      `exit non-zero\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).toBe(0);
  }, 60_000);
});

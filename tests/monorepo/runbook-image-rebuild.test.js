import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const RUNBOOK = resolve(ROOT, 'docs/recordings/README.md');

const read = (p) => readFileSync(p, 'utf8');

// Wave 5.15h regression gate. Smoke-run-10 (Wave 5.15g) failed because
// step 1 of the runbook ran `docker compose up -d --wait` without
// `--build`, so the stale generator image (built 34h before the 5.15f
// case-mismatch fix) was reused and the source fix never reached
// runtime. See docs/recordings/smoke-run-10/SUMMARY.md for forensics.
describe('docs/recordings/README.md — image-rebuild gate (Wave 5.15h)', () => {
  it('exists', () => {
    expect(existsSync(RUNBOOK), 'docs/recordings/README.md must exist').toBe(true);
  });

  it('step 1 invokes `docker compose up` with `--build`', () => {
    const content = read(RUNBOOK);
    // The step-1 row in the pre-flight table. Pattern is intentionally
    // anchored so a future edit cannot accidentally drop `--build` and
    // still pass this test.
    const stepOneLines = content
      .split('\n')
      .filter((l) => /^\|\s*1\s*\|.*docker\s+compose\s+up/.test(l));
    expect(
      stepOneLines.length,
      'expected exactly one step-1 row in the pre-flight table that runs `docker compose up`',
    ).toBe(1);
    const [stepOne] = stepOneLines;
    expect(
      stepOne,
      `step-1 row must pass \`--build\` to \`docker compose up\` (Wave 5.15h regression gate). Found: ${stepOne}`,
    ).toMatch(/docker\s+compose\s+up\b[^|]*--build\b/);
  });

  it('runbook prose explains why --build is mandatory after source-only changes', () => {
    const content = read(RUNBOOK);
    // The required note. We assert key phrases rather than an exact
    // string match so editorial tweaks (capitalisation, punctuation) do
    // not break the gate, while still requiring the substantive content.
    expect(content).toMatch(/rebuild service images before a smoke run/i);
    expect(content).toMatch(/cached layers/i);
    expect(content).toMatch(/\.ts[`\s]*\/[`\s]*\.py[`\s]*\/[`\s]*\.lua/);
    expect(content).toMatch(/Dockerfile/);
    expect(content).toMatch(/Wave 5\.15g/);
    expect(content).toMatch(/smoke-run-10/);
  });

  // Wave 5.15j regression gate. Smoke-run-11 (Wave 5.15i) STOP-ed at
  // the freshness gate because step 1's `compose up --build` only
  // rebuilds default-profile services and never touches the
  // `tools`-profile generator. The fix is to add `--build` to the
  // step-4 `compose run` invocation. This test anchors that fix.
  it('step 4 invokes `docker compose run` with `--build` on the generator', () => {
    const content = read(RUNBOOK);
    expect(
      content,
      'step-4 generator invocation must pass `--build` to `docker compose run` (Wave 5.15j regression gate)',
    ).toMatch(/docker\s+compose\s+run\b[^\n]*--build\b[^\n]*generator\b/);
  });

  it('runbook prose explains why step-4 needs its own --build (tools profile)', () => {
    const content = read(RUNBOOK);
    // Assert the substantive content of the Wave 5.15j note without
    // pinning exact wording. Must cite the 5.15i failure and reference
    // the smoke-run-11 forensics.
    expect(content).toMatch(/Wave 5\.15j/);
    expect(content).toMatch(/Wave 5\.15i/);
    expect(content).toMatch(/smoke-run-11/);
    expect(content).toMatch(/tools.*profile/i);
    expect(content).toMatch(/default.*profile/i);
  });
});

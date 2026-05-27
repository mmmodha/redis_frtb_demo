import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

// Walk a directory and return all .md files relative to ROOT.
function listMarkdown(dir) {
  const acc = [];
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) acc.push(...listMarkdown(p));
    else if (entry.endsWith('.md')) acc.push(p);
  }
  return acc;
}

// Lightweight structural markdown lint. We intentionally do not pull in
// markdownlint-cli as a dep — these checks catch the issues that matter for
// SA-facing handoff docs (heading hierarchy, trailing whitespace, broken
// fences, single H1).
function lintMarkdownText(label, text) {
  const issues = [];
  const lines = text.split('\n');
  let h1Count = 0;
  let inFence = false;
  let fenceLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line)) {
      inFence = !inFence;
      fenceLine = i + 1;
      continue;
    }
    if (inFence) continue;
    if (/^# (?!#)/.test(line)) h1Count += 1;
    if (/\s+$/.test(line) && line.length > 0) {
      issues.push(`${label}:${i + 1} trailing whitespace`);
    }
  }
  if (inFence) issues.push(`${label}:${fenceLine} unclosed code fence`);
  if (h1Count !== 1) issues.push(`${label} must have exactly one H1 (found ${h1Count})`);
  return issues;
}

const lintMarkdown = (path) => lintMarkdownText(path, readFileSync(path, 'utf8'));

describe('markdown lint — presenter + asset-pack docs', () => {
  it('docs/presenter/**.md pass structural lint', () => {
    const files = listMarkdown(resolve(ROOT, 'docs/presenter'));
    expect(files.length, 'expect at least 3 presenter docs').toBeGreaterThanOrEqual(3);
    const issues = files.flatMap(lintMarkdown);
    expect(issues, `lint issues:\n${issues.join('\n')}`).toEqual([]);
  });

  // Asset-pack-generated markdown is lint-checked from its in-memory source
  // (tools/asset-pack/src/content.mjs) so this test is independent of the
  // sibling asset-pack build test that rewrites docs/asset-pack/ on each run.
  it('generated asset-pack markdown (next-steps/exec-summary/technical-brief) passes structural lint', async () => {
    const mod = await import(new URL('../../tools/asset-pack/src/content.mjs', import.meta.url));
    const entries = Object.entries(mod).filter(([k]) => typeof mod[k] === 'string' && k.endsWith('_MD'));
    expect(entries.length, 'expect at least 3 generated mds').toBeGreaterThanOrEqual(3);
    const issues = entries.flatMap(([k, body]) => lintMarkdownText(`content.mjs:${k}`, body));
    expect(issues, `lint issues:\n${issues.join('\n')}`).toEqual([]);
  });
});

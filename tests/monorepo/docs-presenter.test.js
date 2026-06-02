import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const TP = resolve(ROOT, 'docs/presenter/talking-points.md');
const CP = resolve(ROOT, 'docs/presenter/competitive-positioning.md');
const SW = resolve(ROOT, 'docs/presenter/sizing-worksheet.md');

const read = (p) => readFileSync(p, 'utf8');

// 12-step demo flow from the spec (## Demo Flow). Each must have an entry
// in talking-points.md with all four required fields.
const DEMO_STEPS = [
  'Step 1', 'Step 2', 'Step 2a', 'Step 3', 'Step 4', 'Step 5',
  'Step 6', 'Step 7', 'Step 8', 'Step 9', 'Step 10', 'Step 11', 'Step 12',
];

const TP_REQUIRED_FIELDS = [
  '**Business value',
  '**Narration',
  '**Objection',
  '**Rebuttal',
  '**Fallback',
];

describe('docs/presenter/talking-points.md', () => {
  it('exists', () => {
    expect(existsSync(TP), 'docs/presenter/talking-points.md must exist').toBe(true);
  });

  it('has an H2 entry for every demo step (Step 1 .. Step 12 plus 2a)', () => {
    const content = read(TP);
    for (const step of DEMO_STEPS) {
      expect(content, `talking-points must have a heading for "${step}"`).toMatch(
        new RegExp(`^##\\s+${step.replace(/\s+/g, '\\s+')}\\b`, 'm'),
      );
    }
  });

  it('every demo step heading is followed by all five required fields before the next H2', () => {
    const content = read(TP);
    const sections = content.split(/^##\s+/m).slice(1);
    const stepSections = sections.filter((s) => /^Step\s/.test(s));
    expect(stepSections.length, 'must have at least 13 step sections').toBeGreaterThanOrEqual(13);
    for (const section of stepSections) {
      const head = section.split('\n')[0].trim();
      for (const field of TP_REQUIRED_FIELDS) {
        expect(section, `section "${head}" missing required field "${field}"`).toContain(field);
      }
    }
  });

  it('rebuttals mention at least one Enterprise-specific differentiator', () => {
    const content = read(TP).toLowerCase();
    const enterpriseTerms = [
      'auto tiering', 'active-active', 'rbac', 'tls', 'acl',
      'multi-threaded', 'operator', 'redis enterprise',
      'module bundle', 'rejson', 'redisearch', 'redisgears',
    ];
    const hits = enterpriseTerms.filter((t) => content.includes(t));
    expect(hits.length, `expected several Enterprise terms across talking-points, found: ${hits.join(', ')}`).toBeGreaterThanOrEqual(5);
  });
});

describe('docs/presenter/competitive-positioning.md', () => {
  it('exists', () => {
    expect(existsSync(CP), 'docs/presenter/competitive-positioning.md must exist').toBe(true);
  });

  it('covers at least 5 named competitors as H2 sections', () => {
    const content = read(CP);
    const required = [
      'OSS Redis',
      'ClickHouse',
      'Aerospike',
      'KDB',
      'Oracle',
    ];
    for (const name of required) {
      expect(content, `competitive-positioning must have a section mentioning "${name}"`).toMatch(
        new RegExp(`^##\\s+.*${name.replace(/\+/g, '\\+')}`, 'mi'),
      );
    }
  });

  it('every competitor section names a concrete Enterprise-only differentiator', () => {
    const content = read(CP);
    const sections = content.split(/^##\s+/m).slice(1);
    const competitorSections = sections.filter((s) => /redis|clickhouse|aerospike|kdb|oracle|snowflake|dynamodb|scylla|kx/i.test(s.split('\n')[0]));
    expect(competitorSections.length).toBeGreaterThanOrEqual(5);
    for (const section of competitorSections) {
      const head = section.split('\n')[0].trim();
      expect(section, `competitor section "${head}" must reference a concrete Redis Enterprise differentiator`).toMatch(
        /auto tiering|active-active|crdt|operator|rbac|multi-threaded|module bundle|fcall|redis functions|redisearch|rejson|rqe/i,
      );
    }
  });
});

describe('docs/presenter/sizing-worksheet.md', () => {
  it('exists', () => {
    expect(existsSync(SW), 'sizing-worksheet must exist').toBe(true);
  });

  it('has worked examples for 10M, 45M, and 450M row scales', () => {
    const content = read(SW);
    expect(content).toMatch(/10\s*M/i);
    expect(content).toMatch(/45\s*M/i);
    expect(content).toMatch(/450\s*M/i);
  });
});

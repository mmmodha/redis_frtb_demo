import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const DECK = resolve(ROOT, 'docs/deck/competitive-positioning.html');

describe('docs/deck/competitive-positioning.html — Reveal.js competitive slide', () => {
  it('exists', () => {
    expect(existsSync(DECK), 'docs/deck/competitive-positioning.html must exist').toBe(true);
  });

  it('is a Reveal.js page', () => {
    const html = readFileSync(DECK, 'utf8');
    expect(html, 'must include reveal.js asset').toMatch(/reveal\.js/i);
    expect(html, 'must declare reveal container').toMatch(/class=("|')reveal("|')/i);
    expect(html, 'must contain slides container').toMatch(/class=("|')slides("|')/i);
  });

  it('contains a competitive positioning slide naming the five core competitors', () => {
    const html = readFileSync(DECK, 'utf8');
    const slideStartIdx = html.search(/<section[^>]*data-id=("|')competitive("|')/i);
    expect(slideStartIdx, 'slide with data-id="competitive" must exist').toBeGreaterThanOrEqual(0);
    const slice = html.slice(slideStartIdx);
    const slideEndIdx = slice.search(/<\/section>/i);
    const slide = slice.slice(0, slideEndIdx);
    for (const name of ['OSS Redis', 'ClickHouse', 'Aerospike', 'KDB', 'Oracle']) {
      expect(slide, `competitive slide must mention "${name}"`).toMatch(
        new RegExp(name.replace(/\+/g, '\\+'), 'i'),
      );
    }
  });

  it('uses Redis brand red #FF4438 as an accent (not red-500 or pure red)', () => {
    const html = readFileSync(DECK, 'utf8').toLowerCase();
    expect(html, 'brand red #FF4438 expected').toContain('#ff4438');
    expect(html, 'must not use #FF0000').not.toContain('#ff0000');
  });
});

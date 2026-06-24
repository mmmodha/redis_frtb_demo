import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(__dirname, '..', '..');
const COMPOSE = resolve(ROOT, 'docker-compose.yml');

const APP_SERVICES = ['ui', 'api', 'generator', 'source', 'ingest', 'calc', 'loadgen', 'bulk-loader'];

/** Resolve `${VAR:-default}` literals from compose environment blocks. */
function composeDefault(value) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\$\{[^:]+:-(.+)\}$/);
  return m ? m[1] : value;
}

describe('docker-compose.yml', () => {
  let doc;

  beforeAll(() => {
    expect(existsSync(COMPOSE), 'docker-compose.yml must exist at repo root').toBe(true);
    // merge:true expands `<<: *anchor` keys the way docker compose itself does
    doc = parse(readFileSync(COMPOSE, 'utf8'), { merge: true });
  });

  it('defines all 8 application services', () => {
    for (const name of APP_SERVICES) {
      expect(doc.services, `service "${name}" should be defined`).toHaveProperty(name);
    }
  });

  it('does NOT include a redis container in the default profile (RS runs in the bank perimeter)', () => {
    const redis = doc.services?.redis;
    if (!redis) return;
    const profiles = redis.profiles || [];
    expect(profiles, 'any redis service must be gated behind a profile, not started by default').toContain('dev-redis');
  });

  it('declares a "data" volume for connections store, sources, uploads', () => {
    expect(doc.volumes, 'top-level volumes block must exist').toBeDefined();
    expect(doc.volumes).toHaveProperty('data');
  });

  it('every application service declares a healthcheck', () => {
    for (const name of APP_SERVICES) {
      expect(doc.services[name].healthcheck, `service "${name}" must define a healthcheck`).toBeDefined();
      expect(doc.services[name].healthcheck.test, `service "${name}" healthcheck.test required`).toBeDefined();
    }
  });

  it('every application service is on the shared internal network', () => {
    expect(doc.networks, 'top-level networks block must exist').toBeDefined();
    expect(doc.networks).toHaveProperty('frtb');
    for (const name of APP_SERVICES) {
      const nets = doc.services[name].networks || [];
      expect(nets, `service "${name}" must join the "frtb" network`).toContain('frtb');
    }
  });

  it('api, source, ingest persist data via the data volume mount', () => {
    for (const name of ['api', 'source', 'ingest']) {
      const vols = doc.services[name].volumes || [];
      const mountsData = vols.some(v => (typeof v === 'string' ? v : `${v.source}:${v.target}`).includes('data:/'));
      expect(mountsData, `service "${name}" must mount the data volume`).toBe(true);
    }
  });

  it('services that need Redis read REDIS_TARGET_URL from the api router, not hardcoded hosts', () => {
    for (const name of ['ingest', 'calc', 'generator', 'source', 'loadgen', 'bulk-loader']) {
      const env = doc.services[name].environment || {};
      const apiUrl = env.API_URL || env.api_url;
      expect(apiUrl, `service "${name}" must declare API_URL env so it can fetch the active Redis target from api`).toBeDefined();
    }
  });

  it('api enables Wave 7 lazy-math + slim index (Docker parity with run-local.sh)', () => {
    const env = doc.services.api.environment || {};
    expect(composeDefault(env.CALC_LAZY_MATH)).toBe('1');
    expect(composeDefault(env.ENABLE_SLIM_SENS_INDEX)).toBe('1');
    expect(env.BULK_LOADER_URL).toBe('http://bulk-loader:8086');
  });

  it('bulk-loader defaults to production-oriented pool sizing', () => {
    const env = doc.services['bulk-loader'].environment || {};
    expect(Number(composeDefault(env.BULK_LOADER_POOL_SIZE))).toBeGreaterThanOrEqual(16);
    expect(Number(composeDefault(env.BULK_LOADER_BATCH_SIZE))).toBeGreaterThanOrEqual(2000);
  });
});

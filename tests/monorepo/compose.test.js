import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const ROOT = resolve(__dirname, '..', '..');
const COMPOSE = resolve(ROOT, 'docker-compose.yml');

const APP_SERVICES = ['ui', 'api', 'generator', 'source', 'ingest', 'calc', 'loadgen'];

describe('docker-compose.yml', () => {
  let doc;

  beforeAll(() => {
    expect(existsSync(COMPOSE), 'docker-compose.yml must exist at repo root').toBe(true);
    // merge:true expands `<<: *anchor` keys the way docker compose itself does
    doc = parse(readFileSync(COMPOSE, 'utf8'), { merge: true });
  });

  it('defines all 7 application services', () => {
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
    for (const name of ['ingest', 'calc', 'generator', 'source', 'loadgen']) {
      const env = doc.services[name].environment || {};
      const apiUrl = env.API_URL || env.api_url;
      expect(apiUrl, `service "${name}" must declare API_URL env so it can fetch the active Redis target from api`).toBeDefined();
    }
  });
});

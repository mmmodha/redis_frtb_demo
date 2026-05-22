import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const APP_SERVICES = ['ui', 'api', 'generator', 'source', 'ingest', 'calc', 'loadgen'];
const SHARED_PACKAGES = ['schema'];

describe('monorepo layout', () => {
  it('root package.json declares npm workspaces for services/*, shared/*, tools/*', () => {
    const pkg = readJson(resolve(ROOT, 'package.json'));
    expect(pkg.workspaces).toEqual(expect.arrayContaining(['services/*', 'shared/*', 'tools/*']));
    expect(pkg.private, 'root must be private').toBe(true);
  });

  it('root package.json wires schema:generate and schema:validate to @frtb/schema-cli', () => {
    const pkg = readJson(resolve(ROOT, 'package.json'));
    expect(pkg.scripts?.['schema:generate'], 'schema:generate script required').toMatch(/@frtb\/schema-cli/);
    expect(pkg.scripts?.['schema:validate'], 'schema:validate script required').toMatch(/@frtb\/schema-cli/);
  });

  it('tsconfig.base.json exists at repo root for package tsconfigs to extend', () => {
    const tsBase = resolve(ROOT, 'tsconfig.base.json');
    expect(existsSync(tsBase), 'tsconfig.base.json must exist').toBe(true);
    const cfg = readJson(tsBase);
    expect(cfg.compilerOptions?.strict, 'tsconfig.base must enable strict').toBe(true);
  });

  it('every application service folder has a package.json with a private @frtb-scoped name', () => {
    for (const name of APP_SERVICES) {
      const pkgPath = resolve(ROOT, 'services', name, 'package.json');
      expect(existsSync(pkgPath), `services/${name}/package.json must exist`).toBe(true);
      const pkg = readJson(pkgPath);
      expect(pkg.name, `services/${name} package.name should start with @frtb/ and include "${name}"`).toMatch(new RegExp(`^@frtb[^/]*\\/.*${name}`));
      expect(pkg.private !== false, `services/${name} must be private`).toBe(true);
    }
  });

  it('every application service folder has a Dockerfile', () => {
    for (const name of APP_SERVICES) {
      expect(existsSync(resolve(ROOT, 'services', name, 'Dockerfile')), `services/${name}/Dockerfile must exist`).toBe(true);
    }
  });

  it('every application service has an entry point script', () => {
    for (const name of APP_SERVICES) {
      const pkg = readJson(resolve(ROOT, 'services', name, 'package.json'));
      expect(pkg.scripts?.start, `services/${name} must define a "start" script`).toBeDefined();
    }
  });

  it('shared packages exist with @frtb/<name> scope', () => {
    for (const name of SHARED_PACKAGES) {
      const pkgPath = resolve(ROOT, 'shared', name, 'package.json');
      expect(existsSync(pkgPath), `shared/${name}/package.json must exist`).toBe(true);
      const pkg = readJson(pkgPath);
      expect(pkg.name).toBe(`@frtb/${name}`);
    }
  });

  it('config/schema directory exists for hot-swappable schema YAMLs', () => {
    expect(existsSync(resolve(ROOT, 'config', 'schema')), 'config/schema/ directory must exist').toBe(true);
  });
});

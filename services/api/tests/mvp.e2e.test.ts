import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Redis } from "ioredis";
import { monotonicFactory } from "ulid";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { createServer } from "../src/server.ts";
import { reduceRiskClassCharge, type BucketResult, type CorrelationSpec } from "../src/sbm/reduce.ts";
import { buildGirrDeltaSnippet } from "../../calc/src/girrDeltaSnippet.ts";
import { buildGirrVegaSnippet } from "../../calc/src/girrVegaSnippet.ts";
import { buildEquityDeltaSnippet } from "../../calc/src/equityDeltaSnippet.ts";
import { buildEquityVegaSnippet } from "../../calc/src/equityVegaSnippet.ts";
import { buildFxDeltaSnippet } from "../../calc/src/fxDeltaSnippet.ts";
import { buildFxVegaSnippet } from "../../calc/src/fxVegaSnippet.ts";
import { loadFrtbLibrary, type FrtbLibrarySnippet } from "../../calc/src/loadFrtbLibrary.ts";
import { computeKbDelta } from "../../calc/src/girrDeltaReference.ts";
import { computeKbVega } from "../../calc/src/girrVegaReference.ts";
import { createStreamProducer, type SensitivityRow } from "../../generator/src/producer.ts";
import { ensureGroup, processBatch } from "../../ingest/src/consumer.ts";

// End-to-end MVP gate — the test that closes Wave 3. Exercises the real
// pipeline: ingest via `createStreamProducer` → `processBatch` consumer →
// FT.CREATE idx:sens → FUNCTION LOAD the real `frtb` library → POST /calc/sbm
// → assert response.charge ≈ TS oracle on the same fixture (<0.01%).
// Verifier-runnable: requires Docker + the redis/redis-stack-server image;
// otherwise it.skipIf cleanly skips.

const GIRR_W = [0.017, 0.017, 0.016, 0.013, 0.012, 0.011, 0.011, 0.011, 0.011, 0.011];
const GIRR_RHO_DELTA = 0.99;
const GIRR_VEGA_W = 1.0;
const GIRR_VEGA_RHO = 0.5;
const CROSS_BUCKET_GAMMA = 0.5;
const BUCKETS = ["USD", "EUR", "GBP"] as const;
const TENOR = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "15Y", "20Y", "30Y"];

// Equity / FX constants — values mirror config/schema/frtb-default.yaml so that
// the Lua snippets are configured with the same parameters the Python oracle
// used when it produced tools/reference-sbm/golden/expected.json.
const EQUITY_WEIGHTS: Record<string, number> = {
  "1": 0.55, "2": 0.60, "3": 0.45, "4": 0.55, "5": 0.30, "6": 0.35, "7": 0.40,
  "8": 0.50, "9": 0.70, "10": 0.50, "11": 0.70, "12": 0.15, "13": 0.25,
};
const EQUITY_RHO = 0.50;
const EQUITY_GAMMA = 0.15;
const FX_WEIGHT = 0.075;
const FX_GAMMA = 0.60;

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(HERE, "..", "..", "..", "tools", "reference-sbm", "golden");

let container: StartedTestContainer | undefined;
let redis: Redis | undefined;

// Synchronous Docker availability check — must run at module load because
// `it.skipIf()` evaluates its condition at test-definition time, not at run
// time. We accept any of: DOCKER_HOST env, the standard unix socket, or a
// successful `docker info` exit.
function detectDocker(): boolean {
  if (process.env.DOCKER_HOST) return true;
  if (existsSync("/var/run/docker.sock")) return true;
  try {
    execSync("docker info", { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
const HAS_DOCKER = detectDocker();

function buildFixture(): SensitivityRow[] {
  // 100 deterministic rows: ~17 Delta + ~17 Vega per bucket × 3 buckets.
  // Risk values are pseudo-random but seeded by index so the test is
  // bit-for-bit reproducible across runs and across machines.
  const ulid = monotonicFactory();
  const rows: SensitivityRow[] = [];
  let n = 0;
  for (const bucket of BUCKETS) {
    for (let leg = 0; leg < 2; leg++) {
      const sensitivity_type = leg === 0 ? "Delta" : "Vega";
      for (let r = 0; r < 17; r++) {
        const rv = TENOR.map((_, k) => {
          // Stable pseudo-random in [-1, 1] derived from (n, k).
          const seed = (n * 31 + k * 7 + 1) * 2654435761;
          return ((seed % 2_000_001) / 1_000_000) - 1;
        });
        rows.push({
          risk_class: "GIRR",
          bucket,
          _hash_tag: `GIRR:${bucket}`,
          _id: ulid(),
          sensitivity_type,
          tenor: TENOR as unknown as string[],
          risk_value: rv,
          weight_ref: "girr_delta_weights",
          correlation_ref: "girr_rho_kl",
        });
        n += 1;
      }
    }
  }
  return rows;
}

async function ingestFixture(client: Redis, rows: SensitivityRow[]): Promise<void> {
  const stream = "sensitivities:in";
  const group = "ingest";
  const consumerName = "e2e-test-consumer";
  await ensureGroup(client, stream, group);
  const producer = createStreamProducer(client, { stream, batchSize: 50 });
  for (const row of rows) await producer.add(row);
  await producer.flush();
  // Drain the stream — single consumer, blocking pop=0 (poll-once-per-batch).
  for (let i = 0; i < 50; i++) {
    const n = await processBatch(client, { stream, group, consumerName, batchSize: 200 }, ">", 100);
    if (n === 0) break;
  }
}

async function createIndex(client: Redis): Promise<void> {
  // Locked idx:sens contract — 5 mandatory TAG fields (Wave 2.C).
  await client.call(
    "FT.CREATE", "idx:sens", "ON", "JSON", "PREFIX", "1", "sens:", "SCHEMA",
    "$.risk_class", "AS", "risk_class", "TAG",
    "$.bucket", "AS", "bucket", "TAG",
    "$.sensitivity_type", "AS", "sensitivity_type", "TAG",
    "$.book", "AS", "book", "TAG",
    "$.trade_id", "AS", "trade_id", "TAG",
  );
  // Allow the index to catch up with the JSON.SETs (FT is async on JSON).
  for (let i = 0; i < 50; i++) {
    const info = (await client.call("FT.INFO", "idx:sens")) as unknown[];
    const flat: Record<string, unknown> = {};
    for (let j = 0; j < info.length; j += 2) flat[String(info[j])] = info[j + 1];
    if (Number(flat.num_docs ?? 0) > 0 && Number(flat.indexing ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  if (!HAS_DOCKER) return;
  container = await new GenericContainer("redis/redis-stack-server:latest")
    .withExposedPorts(6379)
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(6379);
  redis = new Redis({ host, port, maxRetriesPerRequest: 3 });
  await redis.ping();
}, 180_000);

afterAll(async () => {
  if (redis) await redis.quit().catch(() => undefined);
  if (container) await container.stop().catch(() => undefined);
});

async function setupAndIngest(rows: SensitivityRow[]): Promise<void> {
  await redis!.flushall();
  await redis!.call("FUNCTION", "FLUSH").catch(() => undefined);
  await ingestFixture(redis!, rows);
  await createIndex(redis!);
  await loadFrtbLibrary(redis!, [
    buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO_DELTA }),
    buildGirrVegaSnippet({ weight: GIRR_VEGA_W, rho: GIRR_VEGA_RHO }),
  ]);
}

function expectedDeltaCharge(rows: SensitivityRow[]): number {
  const per: BucketResult[] = BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => r.bucket === b);
    const ts = computeKbDelta(
      inBucket.map((r) => ({ sensitivity_type: String(r.sensitivity_type), risk_value: r.risk_value })),
      GIRR_W, GIRR_RHO_DELTA,
    );
    return { bucket: b, K_b: ts.K_b, S_b: ts.S_b, count: ts.count, ms: 0 };
  });
  return reduceRiskClassCharge(per, { kind: "constant", value: CROSS_BUCKET_GAMMA });
}

function expectedVegaCharge(rows: SensitivityRow[]): number {
  const per: BucketResult[] = BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => r.bucket === b && r.sensitivity_type === "Vega");
    const ts = computeKbVega(
      inBucket.map((r) => r.risk_value as number[]),
      GIRR_VEGA_W, GIRR_VEGA_RHO,
    );
    return { bucket: b, K_b: ts.K_b, S_b: ts.S_b, count: ts.count, ms: 0 };
  });
  return reduceRiskClassCharge(per, { kind: "constant", value: CROSS_BUCKET_GAMMA });
}

describe("MVP end-to-end: ingest → frtb library → POST /calc/sbm", () => {
  it.skipIf(!HAS_DOCKER)(
    "GIRR Delta: api charge matches TS oracle on the ingested fixture to <0.01%",
    async () => {
      const rows = buildFixture();
      await setupAndIngest(rows);
      const app = await createServer({
        redis: redis!,
        correlations: { GIRR: { kind: "constant", value: CROSS_BUCKET_GAMMA } },
      });
      try {
        const t0 = Date.now();
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: "Delta" },
        });
        const wallMs = Date.now() - t0;
        expect(res.statusCode).toBe(200);
        const body = res.json();
        const expected = expectedDeltaCharge(rows);
        const tol = Math.max(Math.abs(expected) * 1e-4, 1e-9);
        expect(Math.abs(body.charge - expected)).toBeLessThanOrEqual(tol);
        expect(body.per_bucket.map((p: BucketResult) => p.bucket).sort())
          .toEqual([...BUCKETS].sort());
        expect(wallMs).toBeLessThan(30_000);
      } finally {
        await app.close();
      }
    },
    180_000,
  );

  it.skipIf(!HAS_DOCKER)(
    "GIRR Vega: api charge matches TS oracle on the ingested fixture to <0.01%",
    async () => {
      const rows = buildFixture();
      await setupAndIngest(rows);
      const app = await createServer({
        redis: redis!,
        correlations: { GIRR: { kind: "constant", value: CROSS_BUCKET_GAMMA } },
      });
      try {
        const t0 = Date.now();
        const res = await app.inject({
          method: "POST",
          url: "/calc/sbm",
          payload: { risk_class: "GIRR", sensitivity_type: "Vega" },
        });
        const wallMs = Date.now() - t0;
        expect(res.statusCode).toBe(200);
        const body = res.json();
        const expected = expectedVegaCharge(rows);
        const tol = Math.max(Math.abs(expected) * 1e-4, 1e-9);
        expect(Math.abs(body.charge - expected)).toBeLessThanOrEqual(tol);
        expect(body.per_bucket.map((p: BucketResult) => p.bucket).sort())
          .toEqual([...BUCKETS].sort());
        expect(wallMs).toBeLessThan(30_000);
      } finally {
        await app.close();
      }
    },
    180_000,
  );
});


// ---------------------------------------------------------------------------
// Wave 4.3 — Equity + FX oracle compare cases
// ---------------------------------------------------------------------------
// Read each golden CSV in tools/reference-sbm/golden/, ingest into Redis,
// POST /calc/sbm, and assert response.charge ≈ the Python oracle's expected
// charge (from expected.json) to <= 1e-4. The CSV + expected.json are the
// canonical out-of-process oracle; they're authored by tools/reference-sbm
// and consumed here without re-deriving the math in TypeScript.

interface GoldenRow {
  risk_class: string;
  bucket: string;
  sensitivity_type: string;
  // Scalar for Equity / FX; array of per-tenor floats for GIRR.
  risk_value: number | number[];
}

// Minimal CSV parser tailored to the golden fixtures. The risk_value column
// is the only one that may be double-quoted (when it contains a JSON array),
// so a hand-rolled splitter is sufficient — no need for a CSV dep.
function parseGoldenCsv(text: string): GoldenRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const header = lines.shift();
  if (!header) throw new Error("golden csv: empty");
  const cols = header.split(",");
  const idx = {
    risk_class: cols.indexOf("risk_class"),
    bucket: cols.indexOf("bucket"),
    sensitivity_type: cols.indexOf("sensitivity_type"),
    risk_value: cols.indexOf("risk_value"),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new Error(`golden csv: missing column ${k}`);
  }
  return lines.map((line) => {
    // risk_value is the last column. If it starts with a double-quote, the
    // remainder of the line (minus the wrapping quotes) is its JSON payload.
    const firstComma = line.indexOf(",");
    const secondComma = line.indexOf(",", firstComma + 1);
    const thirdComma = line.indexOf(",", secondComma + 1);
    const risk_class = line.slice(0, firstComma);
    const bucket = line.slice(firstComma + 1, secondComma);
    const sensitivity_type = line.slice(secondComma + 1, thirdComma);
    let rvField = line.slice(thirdComma + 1);
    let risk_value: number | number[];
    if (rvField.startsWith('"')) {
      rvField = rvField.slice(1, rvField.lastIndexOf('"'));
      risk_value = JSON.parse(rvField) as number[];
    } else {
      risk_value = Number(rvField);
    }
    return { risk_class, bucket, sensitivity_type, risk_value };
  });
}

interface ExpectedManifest {
  [filename: string]: { risk_class: string; sensitivity_type: string; charge: number };
}

function readGolden(filename: string): { rows: GoldenRow[]; expectedCharge: number } {
  const csvText = readFileSync(resolve(GOLDEN_DIR, filename), "utf8");
  const manifest = JSON.parse(
    readFileSync(resolve(GOLDEN_DIR, "expected.json"), "utf8"),
  ) as ExpectedManifest;
  const entry = manifest[filename];
  if (!entry) throw new Error(`expected.json missing entry for ${filename}`);
  return { rows: parseGoldenCsv(csvText), expectedCharge: entry.charge };
}

// Convert golden rows into the SensitivityRow shape used by the producer.
// Stamps _hash_tag = "{risk_class}:{bucket}" so the consumer routes them to
// the slot-affine `sens:{risk_class:bucket}:{ulid}` key shape.
function toSensitivityRows(golden: GoldenRow[]): SensitivityRow[] {
  const ulid = monotonicFactory();
  return golden.map((g) => ({
    risk_class: g.risk_class,
    bucket: g.bucket,
    _hash_tag: `${g.risk_class}:${g.bucket}`,
    _id: ulid(),
    sensitivity_type: g.sensitivity_type,
    risk_value: g.risk_value,
  }));
}

// Build the full set of FRTB snippets (GIRR + Equity + FX) so the loaded
// `frtb` library can serve any (risk_class, sensitivity_type) the API may
// dispatch to. Mirrors how a production deployment would load the library.
function buildAllSnippets(): FrtbLibrarySnippet[] {
  return [
    buildGirrDeltaSnippet({ weights: GIRR_W, rho: GIRR_RHO_DELTA }),
    buildGirrVegaSnippet({ weight: GIRR_VEGA_W, rho: GIRR_VEGA_RHO }),
    buildEquityDeltaSnippet({ weights: EQUITY_WEIGHTS, rho: EQUITY_RHO }),
    buildEquityVegaSnippet({ weight: 1.0, rho: EQUITY_RHO }),
    buildFxDeltaSnippet({ weight: FX_WEIGHT }),
    buildFxVegaSnippet({ weight: FX_WEIGHT }),
  ];
}

async function setupAndIngestGolden(rows: SensitivityRow[]): Promise<void> {
  await redis!.flushall();
  await redis!.call("FUNCTION", "FLUSH").catch(() => undefined);
  await ingestFixture(redis!, rows);
  await createIndex(redis!);
  await loadFrtbLibrary(redis!, buildAllSnippets());
}

interface GoldenCase {
  filename: string;
  risk_class: "EQUITY" | "FX";
  sensitivity_type: "Delta" | "Vega";
  gamma: number;
}

const EQUITY_FX_CASES: GoldenCase[] = [
  { filename: "equity-delta.csv", risk_class: "EQUITY", sensitivity_type: "Delta", gamma: EQUITY_GAMMA },
  { filename: "equity-vega.csv",  risk_class: "EQUITY", sensitivity_type: "Vega",  gamma: EQUITY_GAMMA },
  { filename: "fx-delta.csv",     risk_class: "FX",     sensitivity_type: "Delta", gamma: FX_GAMMA },
  { filename: "fx-vega.csv",      risk_class: "FX",     sensitivity_type: "Vega",  gamma: FX_GAMMA },
];

describe("Equity + FX oracle compare (golden CSVs vs Python oracle)", () => {
  for (const c of EQUITY_FX_CASES) {
    it.skipIf(!HAS_DOCKER)(
      `${c.risk_class} ${c.sensitivity_type}: /calc/sbm matches oracle expected.json to <=1e-4 (${c.filename})`,
      async () => {
        const { rows: golden, expectedCharge } = readGolden(c.filename);
        const sensRows = toSensitivityRows(golden);
        await setupAndIngestGolden(sensRows);
        const correlations: Record<string, CorrelationSpec> = {
          [c.risk_class]: { kind: "constant", value: c.gamma },
        };
        const app = await createServer({ redis: redis!, correlations });
        try {
          const res = await app.inject({
            method: "POST",
            url: "/calc/sbm",
            payload: { risk_class: c.risk_class, sensitivity_type: c.sensitivity_type },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // 1e-4 absolute tolerance per the Wave 4.3 contract — the goldens
          // are small enough that relative + absolute tolerances coincide.
          expect(Math.abs(body.charge - expectedCharge)).toBeLessThanOrEqual(1e-4);
          const expectedBuckets = Array.from(new Set(golden.map((g) => g.bucket))).sort();
          expect(body.per_bucket.map((p: BucketResult) => p.bucket).sort())
            .toEqual(expectedBuckets);
        } finally {
          await app.close();
        }
      },
      180_000,
    );
  }
});

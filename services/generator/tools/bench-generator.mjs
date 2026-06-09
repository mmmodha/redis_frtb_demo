#!/usr/bin/env node
// Wave 5.84D — Generator throughput bench + pre/post-5.84 byte-equivalence
// anchor. Mirrors the 5.83I shape: a single canonical harness that produces
// either (a) a deterministic XADD-sequence diff for the workers=1 invariant
// or (b) median wall-clock + rows/sec + memory delta for a named target
// (small/medium/large).
//
// Modes
//   --verify-equiv [--seed 42] [--rows 1000] [--write-fixture]
//       Generates the XADD field-value sequence (with `_id` stripped) for a
//       fixed seed via the same row-generator + stub-pipeline path the
//       workers.test.ts canary exercises. Computes SHA256, compares to the
//       stored fixture under tools/fixtures/. Exit 0 ⇔ bit-equivalent.
//       `--write-fixture` re-anchors the fixture (operator-supervised only).
//
//   --target {small|medium|large} --rows N [--samples 10] [--rounds 1]
//                                          [--stream-prefix bench:5.84d]
//                                          [--keep-stream]
//       Probes REDIS_URL, runs the generator `samples × rounds` times against
//       a throwaway stream, captures elapsed + rows/sec + memory delta from
//       INFO memory, writes a JSON report to docs/recordings/wave-5.84/.
//       Default: 3 rounds × 10 samples (DoD #1) — operator may scale down via
//       --samples / --rounds for cloud budget (each deviation is recorded in
//       the report so the spec block is self-explanatory).
//
// Secrets-safety: never prints REDIS_URL or password. The host portion is
// extracted via URL parsing for log lines; everything else is opaque.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const SCHEMA_DEFAULT = resolve(REPO_ROOT, "config/schema/frtb-default.yaml");
const FIXTURES_DIR = resolve(HERE, "fixtures");
const RECORDINGS_DIR = resolve(REPO_ROOT, "docs/recordings/wave-5.84");
const CAPTURE_SCRIPT = resolve(HERE, "capture-xadd.ts");
const CLI_SCRIPT = resolve(HERE, "../src/cli.ts");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

// Best-effort .env.local loader — keeps `node services/generator/tools/
// bench-generator.mjs ...` usable without `set -a; . .env.local; set +a`.
// Never overwrites an already-set env var; never logs the loaded values.
function loadEnvLocal() {
  const path = resolve(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvLocal();

function redactedHost(url) {
  try { return new URL(url).host; } catch { return "redis"; }
}

async function main() {
  if (flag("--verify-equiv")) {
    return await runVerifyEquiv();
  }
  if (arg("--target")) {
    return await runThroughputTarget();
  }
  process.stderr.write(
    "Usage:\n" +
    "  node services/generator/tools/bench-generator.mjs --verify-equiv [--seed 42] [--rows 1000] [--write-fixture]\n" +
    "  node services/generator/tools/bench-generator.mjs --target {small|medium|large} --rows N [--samples 10] [--rounds 1]\n",
  );
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`bench-generator: ${err.stack || String(err)}\n`);
  process.exit(1);
});

// ─────────────────────────── verify-equiv ─────────────────────────────────

async function runVerifyEquiv() {
  const seed = arg("--seed", "42");
  const rows = Number(arg("--rows", "1000"));
  const schemaFile = arg("--schema-file", SCHEMA_DEFAULT);
  const batchSize = arg("--batch-size", "1000");
  const writeFixture = flag("--write-fixture");
  const fixtureBase = `xadd-seed${seed}-rows${rows}`;
  const shaFile = resolve(FIXTURES_DIR, `${fixtureBase}.sha256`);
  const metaFile = resolve(FIXTURES_DIR, `${fixtureBase}.meta.json`);
  const sampleFile = resolve(FIXTURES_DIR, `${fixtureBase}.sample.jsonl`);
  const { sha, sampleLines, bytes, lineCount } = await captureXaddSha({ seed, rows, schemaFile, batchSize });
  if (writeFixture) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(shaFile, sha + "\n");
    writeFileSync(metaFile, JSON.stringify({
      tool: "services/generator/tools/bench-generator.mjs --verify-equiv",
      capturedAt: new Date().toISOString(),
      seed, rows, schemaFile: schemaFile.replace(REPO_ROOT + "/", ""),
      schemaSha: sha256OfFile(schemaFile),
      batchSize: Number(batchSize),
      sha256: sha,
      bytes,
      lineCount,
      note: "stripped `_id` field-value pair to neutralise ulid monotonic timestamps",
    }, null, 2) + "\n");
    writeFileSync(sampleFile, sampleLines.join("\n") + "\n");
    process.stdout.write(`wrote fixture ${fixtureBase} (sha=${sha.slice(0, 16)}…, lines=${lineCount}, bytes=${bytes})\n`);
    return;
  }
  if (!existsSync(shaFile)) {
    process.stderr.write(`fixture missing: ${shaFile}\nRun with --write-fixture once to anchor it.\n`);
    process.exit(3);
  }
  const expected = readFileSync(shaFile, "utf8").trim();
  if (expected === sha) {
    process.stdout.write(`✅ bit-equivalent — sha256=${sha} (${lineCount} lines, ${bytes} bytes)\n`);
    process.exit(0);
  }
  process.stderr.write(
    `❌ XADD-sequence mismatch\n  expected sha256=${expected}\n  observed sha256=${sha}\n` +
    `  fixture: ${shaFile}\n  sample of observed:\n${sampleLines.slice(0, 3).map((l) => "    " + l).join("\n")}\n` +
    `Re-run with --write-fixture if and only if the change is expected.\n`,
  );
  process.exit(4);
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Drive capture-xadd.ts as a subprocess and stream stdout into a SHA256
// hasher (keeps memory bounded — the 1000-row JSONL is ~900 KB but we never
// build the full string). Returns the hash plus the first 3 lines so a
// mismatch dump can show a human-readable diff anchor.
function captureXaddSha({ seed, rows, schemaFile, batchSize }) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [
      "--import", "tsx",
      CAPTURE_SCRIPT,
      "--schema-file", schemaFile,
      "--seed", String(seed),
      "--rows", String(rows),
      "--classes", "all",
      "--batch-size", String(batchSize),
    ], { stdio: ["ignore", "pipe", "inherit"] });
    const hash = createHash("sha256");
    let bytes = 0;
    let lineCount = 0;
    let buf = "";
    const sampleLines = [];
    child.stdout.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lineCount++;
        if (sampleLines.length < 5) sampleLines.push(line);
      }
    });
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code !== 0) return rejectP(new Error(`capture-xadd exited ${code}`));
      resolveP({ sha: hash.digest("hex"), sampleLines, bytes, lineCount });
    });
  });
}

// ─────────────────────────── throughput target ────────────────────────────

async function runThroughputTarget() {
  const target = arg("--target");
  const rows = Number(arg("--rows", "200000"));
  const samples = Number(arg("--samples", "10"));
  const rounds = Number(arg("--rounds", "1"));
  const streamPrefix = arg("--stream-prefix", `bench:5.84d:${target}`);
  const schemaFile = arg("--schema-file", SCHEMA_DEFAULT);
  const profile = arg("--profile", "auto");
  const keepStream = flag("--keep-stream");
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) { process.stderr.write("REDIS_URL is required (set in shell or .env.local)\n"); process.exit(2); }
  if (!["small", "medium", "large"].includes(target)) {
    process.stderr.write(`--target must be one of small|medium|large (got: ${target})\n`); process.exit(2);
  }
  process.stdout.write(`bench-generator: target=${target} rows=${rows} samples=${samples} rounds=${rounds} host=${redactedHost(redisUrl)} profile=${profile}\n`);

  const memBefore = await infoMemoryBytes(redisUrl).catch(() => null);
  const allSamples = [];
  const roundMedians = [];
  for (let r = 0; r < rounds; r++) {
    const roundSamples = [];
    for (let s = 0; s < samples; s++) {
      const streamKey = `${streamPrefix}:r${r}:s${s}:${Date.now()}`;
      const sample = await runOneGeneratorInvocation({ rows, schemaFile, redisUrl, streamKey, profile });
      roundSamples.push(sample);
      allSamples.push(sample);
      process.stdout.write(
        `  round=${r + 1}/${rounds} sample=${s + 1}/${samples} ` +
        `elapsed=${sample.elapsedSec.toFixed(2)}s rps=${sample.rps} ` +
        `profile=${sample.plan?.profile} workers=${sample.plan?.dials?.workers} ` +
        `batch=${sample.plan?.dials?.batch_size} window=${sample.plan?.dials?.pipeline_window}\n`,
      );
      if (!keepStream) await delStream(redisUrl, streamKey).catch(() => undefined);
    }
    const median = medianBy(roundSamples, (s) => s.elapsedSec);
    roundMedians.push(median);
  }
  const memAfter = await infoMemoryBytes(redisUrl).catch(() => null);
  const summary = summarise(allSamples, roundMedians, { memBefore, memAfter, target, rows, samples, rounds });
  writeReport(summary, { target, rows, samples, rounds });
  process.stdout.write(`\n${renderSummary(summary)}\n`);
}

function medianBy(arr, sel) {
  const sorted = arr.slice().sort((a, b) => sel(a) - sel(b));
  const n = sorted.length;
  return n === 0 ? 0 : n % 2 ? sel(sorted[(n - 1) / 2]) : (sel(sorted[n / 2 - 1]) + sel(sorted[n / 2])) / 2;
}

function pct(arr, sel, p) {
  const sorted = arr.slice().sort((a, b) => sel(a) - sel(b));
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sel(sorted[idx]);
}

// Spawn the generator CLI as a child process and parse the structured pino
// JSON log to extract elapsed + the resolved plan dials. We intentionally
// do NOT use the in-process row-generator — measuring through the same
// entrypoint operators use is the only honest throughput number.
function runOneGeneratorInvocation({ rows, schemaFile, redisUrl, streamKey, profile }) {
  return new Promise((resolveP, rejectP) => {
    const env = { ...process.env, NODE_ENV: "production", LOG_LEVEL: "info" };
    const t0 = Date.now();
    const child = spawn(process.execPath, [
      "--import", "tsx",
      CLI_SCRIPT,
      "--rows", String(rows),
      "--schema-file", schemaFile,
      "--redis-url", redisUrl,
      "--stream", streamKey,
      "--profile", profile,
    ], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", rejectP);
    child.on("close", (code) => {
      const wallSec = (Date.now() - t0) / 1000;
      if (code !== 0) return rejectP(new Error(`generator exited ${code}\n${err}\n${out.slice(-500)}`));
      const lines = out.trim().split("\n");
      let plan = null, done = null;
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o.plan) plan = o.plan;
          if (typeof o.rowsSent === "number" && typeof o.elapsed === "number" && typeof o.rps === "number") done = o;
        } catch { /* non-json log line — ignore */ }
      }
      if (!done) return rejectP(new Error(`no done line in generator output:\n${out.slice(-2000)}`));
      resolveP({
        wallSec, elapsedSec: done.elapsed, rps: done.rps, rowsSent: done.rowsSent,
        byClass: done.byClass ?? {}, plan,
      });
    });
  });
}

// Read INFO memory once via a transient ioredis client — used for the
// per-target `memDelta` figure. Honours REDIS_CLUSTER / REDIS_TLS env so it
// matches whatever the generator itself used. Imports ioredis lazily so the
// bench tool stays importable even when ioredis is not installed at the
// repo root.
async function infoMemoryBytes(redisUrl) {
  const ioredis = await import("ioredis");
  const u = new URL(redisUrl);
  const tls = (process.env.REDIS_TLS ?? "").toLowerCase();
  const useTls = u.protocol === "rediss:" || ["1", "true", "yes", "on"].includes(tls);
  const cluster = (process.env.REDIS_CLUSTER ?? "true").toLowerCase();
  const isCluster = ["1", "true", "yes", "on"].includes(cluster);
  const opts = {
    password: u.password ? decodeURIComponent(u.password) : undefined,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    ...(useTls ? { tls: {} } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  };
  let client;
  if (isCluster) {
    client = new ioredis.Cluster([{ host: u.hostname, port: Number(u.port) || 6379 }], { redisOptions: opts, slotsRefreshTimeout: 5_000 });
  } else {
    client = new ioredis.Redis({ host: u.hostname, port: Number(u.port) || 6379, ...opts });
  }
  try {
    await client.connect().catch(() => undefined);
    const nodes = isCluster ? client.nodes("master") : [client];
    let total = 0;
    for (const n of nodes) {
      const txt = await n.info("memory");
      const m = /^used_memory:(\d+)/m.exec(txt);
      if (m) total += Number(m[1]);
    }
    return total;
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function delStream(redisUrl, streamKey) {
  const ioredis = await import("ioredis");
  const u = new URL(redisUrl);
  const tls = (process.env.REDIS_TLS ?? "").toLowerCase();
  const useTls = u.protocol === "rediss:" || ["1", "true", "yes", "on"].includes(tls);
  const cluster = (process.env.REDIS_CLUSTER ?? "true").toLowerCase();
  const isCluster = ["1", "true", "yes", "on"].includes(cluster);
  const opts = {
    password: u.password ? decodeURIComponent(u.password) : undefined,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    ...(useTls ? { tls: {} } : {}),
    lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5_000,
  };
  const client = isCluster
    ? new ioredis.Cluster([{ host: u.hostname, port: Number(u.port) || 6379 }], { redisOptions: opts, slotsRefreshTimeout: 5_000 })
    : new ioredis.Redis({ host: u.hostname, port: Number(u.port) || 6379, ...opts });
  try {
    await client.connect().catch(() => undefined);
    await client.del(streamKey);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

function summarise(allSamples, roundMedians, ctx) {
  const elapsed = (s) => s.elapsedSec;
  const rps = (s) => s.rps;
  const first = allSamples[0];
  return {
    target: ctx.target,
    rows: ctx.rows,
    samples: ctx.samples,
    rounds: ctx.rounds,
    plan: first?.plan ?? null,
    elapsedSec: { median: medianBy(allSamples, elapsed), p50: medianBy(allSamples, elapsed), p95: pct(allSamples, elapsed, 0.95), min: pct(allSamples, elapsed, 0), max: pct(allSamples, elapsed, 0.999) },
    rowsPerSec: { median: Math.round(medianBy(allSamples, rps)), p95: Math.round(pct(allSamples, rps, 0.95)), min: Math.round(pct(allSamples, rps, 0)), max: Math.round(pct(allSamples, rps, 0.999)) },
    roundMedians,
    memDeltaBytes: ctx.memBefore != null && ctx.memAfter != null ? ctx.memAfter - ctx.memBefore : null,
    memBeforeBytes: ctx.memBefore, memAfterBytes: ctx.memAfter,
    rawSamples: allSamples.map((s) => ({ elapsedSec: s.elapsedSec, rps: s.rps, rowsSent: s.rowsSent, plan: s.plan ? { profile: s.plan.profile, dials: s.plan.dials, shape: s.plan.shape } : null })),
    capturedAt: new Date().toISOString(),
  };
}

function writeReport(summary, { target, rows, samples, rounds }) {
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  const file = resolve(RECORDINGS_DIR, `bench-${target}-rows${rows}-s${samples}-r${rounds}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(`wrote report → ${file.replace(REPO_ROOT + "/", "")}\n`);
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const sign = n < 0 ? "-" : "";
  let v = Math.abs(n); const units = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${sign}${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function renderSummary(s) {
  const p = s.plan?.dials ?? {};
  const lines = [
    `target=${s.target} rows=${s.rows} samples=${s.samples}×rounds=${s.rounds}`,
    `profile=${s.plan?.profile ?? "?"} workers=${p.workers ?? "?"} batch=${p.batch_size ?? "?"} window=${p.pipeline_window ?? "?"}`,
    `elapsed: median=${s.elapsedSec.median.toFixed(2)}s p95=${s.elapsedSec.p95.toFixed(2)}s min=${s.elapsedSec.min.toFixed(2)}s max=${s.elapsedSec.max.toFixed(2)}s`,
    `rows/sec: median=${s.rowsPerSec.median} p95=${s.rowsPerSec.p95} min=${s.rowsPerSec.min} max=${s.rowsPerSec.max}`,
    `mem delta: ${formatBytes(s.memDeltaBytes)} (before=${formatBytes(s.memBeforeBytes)} after=${formatBytes(s.memAfterBytes)})`,
  ];
  return lines.join("\n");
}

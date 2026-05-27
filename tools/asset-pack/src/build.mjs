// Asset pack builder. Assembles the post-demo handoff bundle from the
// presenter docs + placeholder PDF/PNG assets, then zips the lot for email.
// Idempotent: deletes docs/asset-pack and docs/asset-pack.zip before rebuild.
import {
  existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync, createWriteStream,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { PNG_1x1, makePlaceholderPdf } from './placeholders.mjs';
import { NEXT_STEPS_MD, EXEC_SUMMARY_MD, TECHNICAL_BRIEF_MD } from './content.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

export const SCREENSHOT_STEPS = [
  '01-problem', '02-architecture', '02a-connections', '03-ingest',
  '04-native-array', '05-pivot', '06-delta', '07-vega', '08-concurrent',
  '09-extensibility', '10-scale', '11-failover', '12-close',
];

const SOURCES = {
  'talking-points.md': 'docs/presenter/talking-points.md',
  'competitive-positioning.md': 'docs/presenter/competitive-positioning.md',
  'sizing-worksheet.md': 'docs/presenter/sizing-worksheet.md',
};

const GENERATED_MD = {
  'next-steps.md': NEXT_STEPS_MD,
  'exec-summary.md': EXEC_SUMMARY_MD,
  'technical-brief.md': TECHNICAL_BRIEF_MD,
};

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

async function zipDir(srcDir, outZip) {
  await new Promise((res, rej) => {
    const out = createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', res);
    archive.on('error', rej);
    archive.pipe(out);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

export async function buildAssetPack({ root = ROOT, quiet = false } = {}) {
  const log = (m) => { if (!quiet) console.log(m); };
  const pack = resolve(root, 'docs/asset-pack');
  const zip = resolve(root, 'docs/asset-pack.zip');
  if (existsSync(pack)) rmSync(pack, { recursive: true, force: true });
  if (existsSync(zip)) rmSync(zip, { force: true });
  ensureDir(pack);
  ensureDir(resolve(pack, 'screenshots'));

  for (const [dest, src] of Object.entries(SOURCES)) {
    const srcPath = resolve(root, src);
    if (!existsSync(srcPath)) {
      throw new Error(`asset-pack: required source missing: ${src}`);
    }
    copyFileSync(srcPath, resolve(pack, dest));
    log(`  copied ${src} → asset-pack/${dest}`);
  }

  for (const [name, body] of Object.entries(GENERATED_MD)) {
    writeFileSync(resolve(pack, name), body, 'utf8');
    log(`  wrote asset-pack/${name}`);
  }

  writeFileSync(resolve(pack, 'deck.pdf'), makePlaceholderPdf());
  log('  wrote asset-pack/deck.pdf (placeholder — real Reveal.js export from task 4.4)');

  writeFileSync(resolve(pack, 'architecture.png'), PNG_1x1);
  writeFileSync(resolve(pack, 'extensibility.png'), PNG_1x1);
  log('  wrote placeholder Excalidraw PNGs (architecture, extensibility)');

  for (const step of SCREENSHOT_STEPS) {
    writeFileSync(resolve(pack, 'screenshots', `step-${step}.png`), PNG_1x1);
  }
  log(`  wrote ${SCREENSHOT_STEPS.length} placeholder demo-step screenshots`);

  await zipDir(pack, zip);
  log(`  zipped → docs/asset-pack.zip`);
  return { pack, zip };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAssetPack().catch((e) => { console.error(e); process.exit(1); });
}

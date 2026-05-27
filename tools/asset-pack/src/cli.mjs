#!/usr/bin/env node
import { buildAssetPack } from './build.mjs';

buildAssetPack().then(({ pack, zip }) => {
  console.log(`asset-pack built → ${pack}`);
  console.log(`zipped           → ${zip}`);
}).catch((err) => {
  console.error('asset-pack failed:', err.message);
  process.exit(1);
});

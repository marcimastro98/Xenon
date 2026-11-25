#!/usr/bin/env node
// Writes the site's copy of the Bit kit (docs/create/bit-kit.js), the file a widget copies in to draw
// the person's own Bit. It is server/bit/kit.js's text, made from the engine the app ships, so the two
// never drift: server/test/bit-surfaces.test.mjs fails when the site's copy is stale.
//
//   node tools/bit-kit.mjs          # rewrite docs/create/bit-kit.js
//   node tools/bit-kit.mjs --check  # exit 1 if it is stale
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'create', 'bit-kit.js');
const { bitKit } = require(join(ROOT, 'server', 'bit', 'kit.js'));

const kit = await bitKit();
const now = await readFile(OUT, 'utf8').catch(() => '');
if (process.argv.includes('--check')) {
  if (now !== kit) {
    console.error('docs/create/bit-kit.js is stale: run node tools/bit-kit.mjs');
    process.exit(1);
  }
  console.log('docs/create/bit-kit.js is up to date.');
} else if (now === kit) {
  console.log('docs/create/bit-kit.js is up to date.');
} else {
  await writeFile(OUT, kit);
  console.log(`Wrote docs/create/bit-kit.js (${Math.round(kit.length / 1024)} KB).`);
}

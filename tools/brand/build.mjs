#!/usr/bin/env node
// Writes Xenon's brand files (Bit mark, lockup, app icons, favicons) from
// mark.mjs. See .claude/docs/strumenti.md.
//
//   node tools/brand/build.mjs [--out <dir>]   (default: docs/images/brand)
//   node tools/brand/build.mjs --tauri apps/native/src-tauri/icons
//   node tools/brand/build.mjs --fixed          (the FIXED_PATHS files, in place)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { encodePng } from '../bit-export/png.mjs';
import { encodeIco } from './ico.mjs';
import { loaderFiles } from './loader.mjs';
import { PALETTE, iconRgba, iconSvg, lockupSvg, markRgba, markSvg } from './mark.mjs';
import { createRequire } from 'node:module';

const sparkEngine = createRequire(import.meta.url)('../../packages/core/src/bit-spark.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'images', 'brand');

export const APP_ICON_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
export const BARE_SIZES = [16, 24, 32, 48]; // Bit without plate: taskbar, tray, small UI
export const ICO_SIZES = [16, 32, 48, 256];

/** Every brand file as { name, bytes }; nothing is written. */
export function brandFiles() {
  const files = [];
  const add = (name, content) => files.push({ name, bytes: typeof content === 'string' ? Buffer.from(content, 'utf8') : content });
  add('bit.svg', markSvg());
  add('bit-light.svg', markSvg({ body: PALETTE.bitDeep }));
  add('bit-mono.svg', markSvg({ mono: PALETTE.wordOnLight }));
  add('bit-blink.svg', markSvg({ eyes: 'blink' }));
  add('xenon-logo-dark.svg', lockupSvg({ theme: 'dark' }));
  add('xenon-logo-light.svg', lockupSvg({ theme: 'light' }));
  add('favicon.svg', iconSvg());
  // The Scintilla, still, for pages that name Scintille (the site's plans).
  add('spark.svg', sparkEngine.svg({ still: true }).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
  for (const size of APP_ICON_SIZES) add(`icon-${size}.png`, encodePng(iconRgba(size)));
  for (const size of BARE_SIZES) {
    add(`bit-${size}.png`, encodePng(iconRgba(size, { plate: null })));
    add(`bit-${size}-light.png`, encodePng(iconRgba(size, { plate: null, body: PALETTE.bitDeep })));
  }
  // Email cannot show SVG: Bit at 4px a pixel, shown at 16x22 for a sharp 2x.
  add('bit-4x.png', encodePng(markRgba(4)));
  add('apple-touch-icon.png', encodePng(iconRgba(180, { plate: 'full' })));
  add('favicon.ico', encodeIco(ICO_SIZES.map((size) => ({ size, png: encodePng(iconRgba(size)) }))));
  files.push(...loaderFiles());
  return files;
}

// The flat icons of the native app (apps/native/src-tauri/icons), by file name.
// `tauri icon` scales one picture down and blurs Bit at small sizes, so CI runs
// it for icon.icns, android/ and ios/ only and then writes these on top.
export const TAURI_ICONS = Object.freeze({
  '32x32.png': 32,
  '64x64.png': 64,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'icon.png': 512,
  'StoreLogo.png': 50,
  ...Object.fromEntries([30, 44, 71, 89, 107, 142, 150, 284, 310].map((s) => [`Square${s}x${s}Logo.png`, s])),
});
export const TAURI_ICO_SIZES = [16, 24, 32, 48, 64, 256];

/** The native app's icons as { name, bytes }; nothing is written. */
export function tauriIconFiles() {
  const files = Object.entries(TAURI_ICONS).map(([name, size]) => ({ name, bytes: encodePng(iconRgba(size)) }));
  files.push({ name: 'icon.ico', bytes: encodeIco(TAURI_ICO_SIZES.map((size) => ({ size, png: encodePng(iconRgba(size)) }))) });
  return files;
}

// Files the app, the site, the README and sent emails load by a fixed path,
// relative to the repo root. Rewriting them in place moves every one of those
// to the new logo without touching the pages that point at them.
export const FIXED_PATHS = Object.freeze({
  'docs/images/favicon.png': () => iconRgba(64),
  'docs/images/logo-mark.png': () => iconRgba(256),
  'server/assets/favicon.png': () => iconRgba(150),
  'server/public/images/logo/logo-mark.png': () => iconRgba(256),
  // Android draws a notification badge from its alpha only: Bit white, face cut out.
  'server/public/images/logo/badge.png': () => iconRgba(96, { plate: null, body: '#ffffff', face: null }),
});

// Where the app and the native splash load the loader from (tools/brand/loader.mjs).
// The native splash is its own small page and cannot reach the dashboard's files.
export const LOADER_DIRS = Object.freeze({
  'server/public/images/loader': null, // every loader file
  'apps/native/splash': ['bit-recharge.svg', 'bit-recharge-still.svg'],
});

/** The fixed-path files as { name, bytes }, name relative to the repo root. */
export function fixedPathFiles() {
  const files = Object.entries(FIXED_PATHS).map(([name, draw]) => ({ name, bytes: encodePng(draw()) }));
  const loaders = loaderFiles();
  for (const [dir, only] of Object.entries(LOADER_DIRS)) {
    for (const f of loaders) if (!only || only.includes(f.name)) files.push({ name: `${dir}/${f.name}`, bytes: f.bytes });
  }
  return files;
}

async function writeFiles(outDir, files) {
  const written = [];
  for (const f of files) {
    const target = path.join(outDir, f.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.bytes);
    written.push(target);
  }
  return written;
}

export const writeBrand = (outDir = DEFAULT_OUT) => writeFiles(outDir, brandFiles());
export const writeTauriIcons = (outDir) => writeFiles(outDir, tauriIconFiles());
export const writeFixedPaths = (root = ROOT) => writeFiles(root, fixedPathFiles());

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, tauri: { type: 'string' }, fixed: { type: 'boolean' } } });
  let written;
  if (values.fixed) written = await writeFixedPaths();
  else if (values.tauri) written = await writeTauriIcons(path.resolve(values.tauri));
  else written = await writeBrand(values.out ? path.resolve(values.out) : DEFAULT_OUT);
  console.log(`Wrote ${written.length} files:\n${written.map((f) => '  ' + path.relative(ROOT, f)).join('\n')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

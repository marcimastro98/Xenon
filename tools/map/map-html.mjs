// The map as a page to explore: the areas drawn as a map, every feature, its
// folders and files, what each function does and on which line, and the HTTP
// routes, with one search box over all of it, in Italian and English.
// It reads the same features.json as MAP.md and the files git tracks, so it is
// as true as the tree it runs on.
//
//   npm run map:html                     write the page to the system temp folder
//   npm run map:html -- --out map.html   write it where you say
//   npm run map:html -- --artifact       no document head, for a host that adds its own
//   npm run map:html -- --open           and open it in the default browser

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, trackedFiles } from '../quality/repo-files.mjs';
import { assign, readMap, repoFiles } from './map.mjs';
import { describeFile } from './map-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'page');
const SCRIPTS = ['strings.js', 'model.js', 'draw.js', 'treemap.js', 'views.js', 'folders.js', 'search.js', 'start.js'];
const STANDALONE_HEAD = '<!doctype html>\n<html lang="it">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<style>body { margin: 0; } [hidden] { display: none !important; }</style>\n';

/**
 * Everything the page shows, as one object.
 * @param {string[]} files
 * @param {ReturnType<typeof readMap>} map
 * @param {{ areas: object, features: object, pieces: object }} italian names and lines in Italian, by id
 * @param {(file: string) => string | null} read
 */
export function buildData(files, map, italian, read) {
  const { owned } = assign(files, map.features);
  const owner = new Map();
  for (const [id, list] of owned) for (const file of list) owner.set(file, id);
  const it = (table, id, at) => (table[id] ? table[id][at] : '');
  return {
    pieces: italian.pieces,
    areas: map.areas.map((area) => ({ id: area.id, name: { en: area.name, it: it(italian.areas, area.id, 0) || area.name }, what: { en: area.what, it: it(italian.areas, area.id, 1) || area.what } })),
    features: map.features.map((feature) => ({
      id: feature.id, area: feature.area, globs: feature.files,
      name: { en: feature.name, it: it(italian.features, feature.id, 0) || feature.name },
      what: { en: feature.what.replace(/`/g, ''), it: it(italian.features, feature.id, 1) || feature.what },
    })),
    files: files.map((file) => ({ ...describeFile(file, read), o: owner.get(file) || '' })),
  };
}

/**
 * @param {{ html: string, css: string, js: string }} parts
 * @param {object} data
 * @param {string} stamp shown on the page: which tree it was built from
 */
export function renderPage(parts, data, stamp) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return parts.html
    .replace('/*@CSS@*/', () => parts.css)
    .replace('/*@JS@*/', () => parts.js.replace('/*@MAP_DATA@*/null', () => json))
    .replace('@MAP_STAMP@', () => stamp.replace(/[<>&]/g, ''));
}

function readRepoFile(file) {
  try { return readFileSync(path.join(REPO_ROOT, file), 'utf8'); }
  catch { return null; }
}

function readParts() {
  const read = (name) => readFileSync(path.join(PAGE, name), 'utf8');
  const js = SCRIPTS.map((name) => `// ${name}\n${read(name)}`).join('\n');
  return { html: read('page.html'), css: read('page.css'), js: `(function () {\n'use strict';\n${js}\n})();` };
}

function main(args) {
  const listed = trackedFiles();
  if (!listed) {
    console.error('No git here: the map needs the list of tracked files.');
    return 1;
  }
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 && args[outAt + 1] ? path.resolve(args[outAt + 1]) : path.join(os.tmpdir(), 'xenon-map.html');
  const italian = JSON.parse(readFileSync(path.join(HERE, 'features-it.json'), 'utf8'));
  const data = buildData(repoFiles(listed), readMap(), italian, readRepoFile);
  const page = renderPage(readParts(), data, new Date().toISOString().slice(0, 10));
  writeFileSync(out, args.includes('--artifact') ? page : `${STANDALONE_HEAD}${page}`);
  console.log(`Map page written: ${out} (${data.features.length} features, ${data.files.length} files).`);
  if (args.includes('--open')) openInBrowser(out);
  return 0;
}

/** Hands the page to the system, which opens it in the default browser. */
function openInBrowser(file) {
  const opener = { win32: 'explorer.exe', darwin: 'open' }[process.platform] || 'xdg-open';
  try {
    const child = spawn(opener, [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => console.error(`Could not open the page: open ${file} by hand.`));
    child.unref();
  } catch {
    console.error(`Could not open the page: open ${file} by hand.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

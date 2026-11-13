#!/usr/bin/env node
// Points the tests that read server/js/i18n.js as text at the words where they
// now live. Each such read (`read('../js/i18n.js')`, `readFileSync(new URL(...))`,
// `readFileSync(join(..., 'js', 'i18n.js'), 'utf8')`) becomes appStringsSource()
// from server/test/i18n-source.mjs, which gives the same script the old file was.
// Nothing else in a test changes. Running it again changes nothing.
//
//   node tools/restructure/i18n-test-readers.mjs            list what would change
//   node tools/restructure/i18n-test-readers.mjs --write

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR = path.join(ROOT, 'server', 'test');
// The line each test gains. The helper sits beside the tests, not beside this
// tool, so its name is kept apart from the word "from": the check that every
// load points at a real file would otherwise look for it here.
const HELPER = './i18n-source.mjs';
const IMPORT_LINE = `import { appStringsSource } from '${HELPER}';`;

// Tests about the files themselves or about the tools that edit them: by hand.
export const BY_HAND = new Set([
  'i18n-set-tool.test.mjs', 'repo-sweep-tool.test.mjs', 'layer-i18n.test.mjs', 'i18n-load.test.mjs',
  'i18n-en-spread.test.mjs', 'demo-build.test.mjs', 'no-owner-name.test.mjs',
  'restructure-i18n-split.test.mjs', 'restructure-i18n-equal.test.mjs',
]);

const UTF8 = String.raw`(?:,\s*'utf-?8')?`;
const READS = [
  // readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8')
  new RegExp(String.raw`(?:fs\.)?readFileSync\(\s*new URL\('\.\./js/i18n\.js',\s*import\.meta\.url\)${UTF8}\s*\)`, 'g'),
  // readFileSync(join(HERE, '..', 'js', 'i18n.js'), 'utf8')
  new RegExp(String.raw`(?:fs\.)?readFileSync\(\s*(?:path\.)?join\([^()]*'i18n\.js'\)${UTF8}\s*\)`, 'g'),
  // read('../js/i18n.js'), read('js', 'i18n.js'), src('js/i18n.js')
  /\b(?:read|src|readLf)\((?:'[^']*',\s*)*'(?:[^']*\/)?i18n\.js'\)/g,
];
// The iCUE widget has its own i18n.js: not this one.
const OTHER_FILE = /widget|modules/;

/** @param {string} source a test file @returns {string} the same test reading the words where they are */
export function retarget(source) {
  let hits = 0;
  let next = source;
  for (const re of READS) {
    next = next.replace(re, (match) => {
      if (OTHER_FILE.test(match)) return match;
      hits += 1;
      return 'appStringsSource()';
    });
  }
  if (!hits || next.includes(IMPORT_LINE)) return next;
  // After the last import statement, which may span lines.
  const imports = [...next.matchAll(/^import\s[^;]*?;[ \t]*$/gm)];
  if (!imports.length) return `${IMPORT_LINE}\n${next}`;
  const last = imports[imports.length - 1];
  const end = last.index + last[0].length;
  return `${next.slice(0, end)}\n${IMPORT_LINE}${next.slice(end)}`;
}

function main(args) {
  const write = args.includes('--write');
  const changed = [];
  for (const name of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs') && !BY_HAND.has(f)).sort()) {
    const file = path.join(TEST_DIR, name);
    const source = fs.readFileSync(file, 'utf8');
    const next = retarget(source);
    if (next === source) continue;
    changed.push(name);
    if (write) fs.writeFileSync(file, next);
  }
  console.log(`${changed.length} test files ${write ? 'changed' : 'would change'}.`);
  if (!write) for (const name of changed) console.log(`  ${name}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

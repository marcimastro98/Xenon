#!/usr/bin/env node
// Points the tests that read server/server.js as text at the engine's code wherever
// it lives now. Each such read (`read('../server.js')`, `readFileSync(new URL(...),
// 'utf8')`, `readFileSync(join(..., 'server.js'), 'utf8')`) becomes engineSource()
// from server/test/engine-source.mjs: server.js followed by every module taken out
// of it. Nothing else in a test changes. Running it again changes nothing.
//
//   node tools/restructure/engine-test-readers.mjs            list what would change
//   node tools/restructure/engine-test-readers.mjs --write

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR = path.join(ROOT, 'server', 'test');
// The helper sits beside the tests, not beside this tool, so its name is kept apart
// from the word "from": the check that every load points at a real file would
// otherwise look for it here.
const HELPER = './engine-source.mjs';
const IMPORT_LINE = `import { engineSource } from '${HELPER}';`;

// Tests about the file itself (its size, its place, its first lines, the order of
// its statements) or about the tools that take it apart: they keep reading the file.
export const BY_HAND = new Set([
  'engine-source.mjs', 'engine-source.test.mjs', 'restructure-analyze.test.mjs', 'restructure-extract.test.mjs',
  'restructure-verify.test.mjs', 'restructure-remainder.test.mjs', 'restructure-engine-test-readers.test.mjs',
  'quality-ratchet.test.mjs', 'structure-frozen-paths.test.mjs', 'structure-map.test.mjs', 'structure-requires-resolve.test.mjs',
]);

const UTF8 = String.raw`,\s*'utf-?8'`;
const READS = [
  // readFileSync(new URL('../server.js', import.meta.url), 'utf8'), with or without fileURLToPath(...)
  new RegExp(String.raw`(?:fs\.)?readFileSync\(\s*(?:fileURLToPath\(\s*)?new URL\('\.\./server\.js',\s*import\.meta\.url\)\)?${UTF8}\s*\)`, 'g'),
  // readFileSync(join(HERE, '..', 'server.js'), 'utf8'), readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8')
  new RegExp(String.raw`(?:fs\.)?readFileSync\(\s*(?:path\.)?join\(\s*\w+,\s*(?:'\.\.',\s*|'server',\s*)?'server\.js'\)${UTF8}\s*\)`, 'g'),
  // read('../server.js'), read('server.js'), read('server/server.js'), read('server', 'server.js'), src('server.js')
  /\b(?:read|src|source|readLf)\((?:'\.\.\/server\.js'|'server\.js'|'server\/server\.js'|'server',\s*'server\.js')\)/g,
];

/** @param {string} source a test file @returns {string} the same test reading the engine wherever it is */
export function retarget(source) {
  let hits = 0;
  let next = source;
  for (const re of READS) next = next.replace(re, () => { hits += 1; return 'engineSource()'; });
  if (!hits || next.includes(IMPORT_LINE)) return next;
  // A test that already takes another reader from the helper gains the name there.
  const own = new RegExp(String.raw`^import \{([^}]*)\} from '${HELPER.replace(/[.]/g, '\\.')}';$`, 'm').exec(next);
  if (own) {
    if (own[1].split(',').some((name) => name.trim() === 'engineSource')) return next;
    return next.replace(own[0], `import { ${[...own[1].split(',').map((name) => name.trim()), 'engineSource'].join(', ')} } from '${HELPER}';`);
  }
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
  const untouched = [];
  for (const name of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.mjs') && !BY_HAND.has(f)).sort()) {
    const file = path.join(TEST_DIR, name);
    const source = fs.readFileSync(file, 'utf8');
    const next = retarget(source);
    // A test that still spells the file's name in a string may read it another way.
    if (/'[^']*server\.js'/.test(next.replace(/^\s*(?:\/\/|\*).*$/gm, '')) && !/ai-local-server|engineSource\(\)/.test(next)) untouched.push(name);
    if (next === source) continue;
    changed.push(name);
    if (write) fs.writeFileSync(file, next);
  }
  console.log(`${changed.length} test files ${write ? 'changed' : 'would change'}.`);
  if (!write) for (const name of changed) console.log(`  ${name}`);
  if (untouched.length) console.log(`${untouched.length} files name server.js in a string and read it no way this tool knows: look at them by hand.\n  ${untouched.join('\n  ')}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

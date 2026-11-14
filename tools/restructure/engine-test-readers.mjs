#!/usr/bin/env node
// Points the tests that read an engine file as text at its code wherever it lives
// now. Each such read (`read('../server.js')`, `readFileSync(new URL(...), 'utf8')`,
// `readFileSync(join(..., 'server.js'), 'utf8')`) becomes engineSource() from
// server/test/engine-source.mjs: the file followed by every module taken out of
// it. Nothing else in a test changes. Running it again changes nothing.
//
//   node tools/restructure/engine-test-readers.mjs            list what would change (server/server.js)
//   node tools/restructure/engine-test-readers.mjs --write
//   node tools/restructure/engine-test-readers.mjs --source server/remote-access.js [--write]
//                                the same for another engine file a module was taken out of:
//                                its reads become engineSource('server/remote-access.js')

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR = path.join(ROOT, 'server', 'test');
const ENGINE = 'server/server.js';
// The helper sits beside the tests, not beside this tool, so its name is kept apart
// from the word "from": the check that every load points at a real file would
// otherwise look for it here.
const HELPER = './engine-source.mjs';
const IMPORT_LINE = `import { engineSource } from '${HELPER}';`;

// Tests about the file itself (its size, its place, its first lines, the order of
// its statements) or about the tools that take it apart: they keep reading the file.
export const BY_HAND = new Set([
  'engine-source.mjs', 'engine-source.test.mjs', 'restructure-analyze.test.mjs', 'restructure-extract.test.mjs',
  'restructure-verify.test.mjs', 'restructure-remainder.test.mjs', 'restructure-branches-move.test.mjs', 'restructure-engine-test-readers.test.mjs',
  'quality-ratchet.test.mjs', 'structure-frozen-paths.test.mjs', 'structure-map.test.mjs', 'structure-requires-resolve.test.mjs',
]);

const UTF8 = String.raw`,\s*'utf-?8'`;
const SPACED = String.raw`,\s*`;
const quoted = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Folders of server/ that hold no script a test would read by name.
const NOT_READ = new Set(['node_modules', 'data', 'test', 'shared', 'whisper']);

/**
 * @param {string} source repo-relative engine file @param {string} [root] the repo
 * @returns {boolean} true when no other script under server/ has the same file name, so a read that
 *   gives only the name (`read('x.js')`) can mean no other file
 */
export function nameIsItsOwn(source, root = ROOT) {
  const name = path.posix.basename(source);
  let found = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!NOT_READ.has(entry.name)) walk(path.join(dir, entry.name)); }
      else if (entry.name === name) found += 1;
    }
  };
  walk(path.join(root, 'server'));
  return found <= 1;
}

/**
 * The spellings of "read this engine file as text" a test may use.
 * @param {string} [source] repo-relative, under server/
 * @param {{ bare?: boolean }} [how] bare: false leaves a read that gives only the file's name
 * @returns {RegExp[]}
 */
export function readsOf(source = ENGINE, { bare = true } = {}) {
  if (!/^server\/(?:[\w.-]+\/)*[\w.-]+\.js$/.test(source)) throw new Error(`${source} is not a script under server/`);
  const parts = source.slice('server/'.length).split('/');
  const whole = quoted(parts.join('/'));
  // A file in a folder is given in one piece or folder by folder: 'actions/registry.js' or 'actions', 'registry.js'.
  const pieces = parts.length > 1 ? `(?:'${whole}'|${parts.map((part) => `'${quoted(part)}'`).join(SPACED)})` : `'${whole}'`;
  return [
    // readFileSync(new URL('../server.js', import.meta.url), 'utf8'), with or without fileURLToPath(...)
    new RegExp(String.raw`(?:fs\.)?readFileSync\(\s*(?:fileURLToPath\(\s*)?new URL\('\.\.\/${whole}',\s*import\.meta\.url\)\)?${UTF8}\s*\)`, 'g'),
    // readFileSync(join(HERE, '..', 'server.js'), 'utf8'), readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8')
    new RegExp(String.raw`(?:fs\.)?readFileSync\(\s*(?:path\.)?join\(\s*\w+,\s*(?:'\.\.',\s*|'server',\s*)?${pieces}\)${UTF8}\s*\)`, 'g'),
    // read('../server.js'), read('server.js'), read('server/server.js'), read('server', 'server.js'), src('server.js')
    new RegExp(String.raw`\b(?:read|src|source|readLf)\((?:'\.\.\/${whole}'|${bare ? `'${whole}'|` : ''}'server\/${whole}'|'server',\s*${pieces})\)`, 'g'),
  ];
}

/**
 * @param {string} text a test file
 * @param {string} [source] repo-relative engine file whose reads change (server/server.js when left out)
 * @param {{ bare?: boolean }} [how] see readsOf
 * @returns {string} the same test reading that file's code wherever it is
 */
export function retarget(text, source = ENGINE, how = {}) {
  const call = source === ENGINE ? 'engineSource()' : `engineSource('${source}')`;
  let hits = 0;
  let next = text;
  for (const re of readsOf(source, how)) next = next.replace(re, () => { hits += 1; return call; });
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

/**
 * @param {string} text a test file, after retarget @param {string} [source] repo-relative engine file
 * @returns {boolean} true when a line still spells the file's name in a string without loading it as code
 *   or reading it through the helper: the test may read it another way, a person looks
 */
export function stillNames(text, source = ENGINE) {
  if (source === ENGINE) {
    return /'[^']*server\.js'/.test(text.replace(/^\s*(?:\/\/|\*).*$/gm, '')) && !/ai-local-server|engineSource\(\)/.test(text);
  }
  // The name alone or after a folder: 'lighting.js' and '../lighting.js', not 'js/driver-lighting.js'.
  const named = new RegExp(`'(?:[^'\\n]*\\/)?${quoted(path.posix.basename(source))}'`);
  const call = `engineSource('${source}')`;
  return text.split('\n').some((line) => !/^\s*(?:\/\/|\*)/.test(line) && !/\b(?:require|import)\b/.test(line)
    && named.test(line.split(call).join('')));
}

function valueAfter(args, option) {
  const at = args.indexOf(option);
  if (at === -1) return undefined;
  if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`${option} needs a path, for example ${option} server/remote-access.js`);
  return args[at + 1];
}

function main(args) {
  const write = args.includes('--write');
  const source = (valueAfter(args, '--source') ?? ENGINE).split('\\').join('/');
  readsOf(source);
  if (!fs.existsSync(path.join(ROOT, source))) throw new Error(`${source} is not a file of this repo`);
  const bare = nameIsItsOwn(source);
  const name = path.posix.basename(source);
  const changed = [];
  const untouched = [];
  for (const test of fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.mjs') && !BY_HAND.has(f)).sort()) {
    const file = path.join(TEST_DIR, test);
    const text = fs.readFileSync(file, 'utf8');
    const next = retarget(text, source, { bare });
    if (stillNames(next, source)) untouched.push(test);
    if (next === text) continue;
    changed.push(test);
    if (write) fs.writeFileSync(file, next);
  }
  console.log(`${source === ENGINE ? '' : `${source}: `}${changed.length} test files ${write ? 'changed' : 'would change'}.`);
  if (!write) for (const test of changed) console.log(`  ${test}`);
  if (!bare) console.log(`Another script under server/ is also called ${name}: a read that gives only that name was left alone.`);
  if (untouched.length) console.log(`${untouched.length} files name ${name} in a string and read it no way this tool knows: look at them by hand.\n  ${untouched.join('\n  ')}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

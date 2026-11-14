// Points the tests that read a split browser file as text at the reader that
// follows the split (server/test/browser-source.mjs). The reader has a
// `readFileSync` that is the one of node:fs for every other file, so a test only
// changes where that one function comes from: no call and no assertion is touched.
// Running it again changes nothing.
//
// Two kinds of test follow a split by more than where they read, and are only
// listed for a person: one that holds the exact list of a page's scripts (a part
// gets a tag of its own right before the file), and one that cuts a piece out of
// the file's text between two of its lines (the second may no longer follow the
// first once code has left).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { mentionsOf } from './browser-consumers.mjs';
import { readBrowserLedger } from './browser-ledger.mjs';

// The reader sits beside the tests, not beside this tool, so its name is kept
// apart from the word "from": the check that every load points at a real file
// would otherwise look for it here.
const READER = 'browser-source.mjs';
const FS_IMPORT = /^import\s+\{([^}]*)\}\s+from\s+'(?:node:)?fs';[ \t]*$/gm;
const FS_OBJECT = /^import\s+(?:\*\s+as\s+)?fs\s+from\s+'(?:node:)?fs';[ \t]*$/m;
const FS_LATER = /const \{ readFileSync \} = await import\('(?:node:)?fs'\);/g;
const IS_READ = /^readFileSync(?:\s+as\s+\w+)?$/;

/**
 * @param {string} source a test file
 * @param {string} readerPath how the test names the reader (`./browser-source.mjs`)
 * @returns {string | null} the same test taking `readFileSync` from the reader; the text unchanged when it
 *   already does; null when it has to be done by hand
 */
export function retarget(source, readerPath) {
  const origin = `'${readerPath}'`;
  if (source.includes(`} from ${origin};`) || source.includes(`await import(${origin})`)) return source;
  for (const named of source.matchAll(FS_IMPORT)) {
    const names = named[1].split(',').map((name) => name.trim()).filter(Boolean);
    const mine = names.find((name) => IS_READ.test(name));
    if (!mine) continue;
    const rest = names.filter((name) => name !== mine);
    const kept = rest.length ? `import { ${rest.join(', ')} } from ${named[0].slice(named[0].lastIndexOf(' ') + 1)}\n` : '';
    return source.replace(named[0], () => `${kept}import { ${mine} } from ${origin};`);
  }
  if (source.search(FS_LATER) !== -1) return source.replace(FS_LATER, () => `const { readFileSync } = await import(${origin});`);
  const whole = FS_OBJECT.exec(source);
  // `fs.readFileSync(...)` becomes `readFileSync(...)`, unless the test has a `readFileSync` of its own.
  if (!whole || !source.includes('fs.readFileSync(') || /\b(?:const|let|function)\s+readFileSync\b/.test(source)) return null;
  return source.replace(whole[0], () => `${whole[0]}\nimport { readFileSync } from ${origin};`).replaceAll('fs.readFileSync(', 'readFileSync(');
}

const QUOTED = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`/g;
const SCRIPT_NAME = /^(?:js|shared|components)\/[\w./-]+\.js$/;
const MARK_MIN = 12;
// Lines every wrapped script has: naming one says nothing about this file.
const ANY_SCRIPT = new Set(["'use strict';", '(function () {', '(() => {', '})();']);
const escaped = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a test holds of a browser file beyond its name.
 * @param {string} source the test's text
 * @param {string} file repo-relative browser file (`server/js/deck.js`)
 * @param {string} scriptText the file's text, with the scripts taken out of it
 * @returns {{ lists: number[], cuts: { line: number, from: string, to: string }[] }} `lists`: lines where the file stands in a list of
 *   scripts and is not written as its parts (`partsOf`); `cuts`: lines that name two whole lines of the file, the ends of a cut
 */
export function heldByText(source, file, scriptText) {
  const address = file.replace(/^server\//, '');
  const starts = [...new Set(scriptText.split('\n').map((line) => line.trim()).filter((line) => line.length >= MARK_MIN && !ANY_SCRIPT.has(line)))];
  // In a list the name stands between brackets and commas; `indexOf('js/a.js') < indexOf('js/b.js')` only asks for an order.
  const listed = new RegExp(`[\\[,]\\s*['"]${escaped(address)}['"]\\s*[,\\]]`);
  const lists = [];
  const cuts = [];
  for (const [at, line] of source.split('\n').entries()) {
    const quoted = [...line.matchAll(QUOTED)].map((match) => (match[1] ?? match[2] ?? match[3]).replace(/\\(['"\\])/g, '$1'));
    // A list may be asked for as a regular expression, where the names are written `js\/a\.js` and the bracket `\]`.
    const plain = line.replace(/\\([/.[\]()])/g, '$1');
    const names = [...plain.matchAll(QUOTED)].map((match) => match[1] ?? match[2] ?? match[3]).filter((name) => SCRIPT_NAME.test(name));
    if (listed.test(plain) && names.length > 1 && !line.includes(`partsOf('${file}')`)) lists.push(at + 1);
    // `'\n  }\n'` is the end of any function, not a line of this file: only marks long enough to be one count.
    // A mark is a whole line of the file or how one begins (`function fmtSize(`).
    const marks = [...new Set(quoted.flatMap((piece) => piece.split('\\n')).map((piece) => piece.trim()).filter((piece) => piece.length >= MARK_MIN && starts.some((begin) => begin.startsWith(piece))))];
    if (marks.length > 1) cuts.push({ line: at + 1, from: marks[0], to: marks[1] });
  }
  return { lists, cuts };
}

/**
 * @param {string} root @param {string} file repo-relative browser file
 * @returns {string[]} one line per test that holds a list of scripts with the file in it, or cuts its text between two of its lines
 */
export function testsHeldByText(root, file) {
  const parts = readBrowserLedger(root).moves.filter((move) => move.from === file && (move.kind === 'script' || move.kind === 'inner')).map((move) => move.file);
  const scriptText = [...parts, file].map((part) => readFileSync(path.join(root, part), 'utf8')).join('\n');
  const found = [];
  for (const mention of mentionsOf(root, file)) {
    if (mention.kind !== 'test') continue;
    const { lists, cuts } = heldByText(readFileSync(path.join(root, mention.file), 'utf8'), file, scriptText);
    if (lists.length) found.push(`${mention.file}:${lists.join(',')} holds a list of scripts with ${path.posix.basename(file)} in it: write it as ...partsOf('${file}')`);
    for (const cut of cuts) found.push(`${mention.file}:${cut.line} cuts the text from \`${cut.from}\` to \`${cut.to}\`: the second must still follow the first after a move`);
  }
  return found;
}

/**
 * @param {string} root
 * @param {string} file repo-relative browser file that is split, or about to be
 * @param {boolean} write false to only list
 * @returns {{ changed: string[], byHand: string[] }} tests moved to the reader, and tests that name the file but could not be
 */
export function retargetTests(root, file, write) {
  const changed = [];
  const byHand = [];
  for (const mention of mentionsOf(root, file)) {
    if (mention.kind !== 'test' || mention.reader) continue;
    const place = path.join(root, mention.file);
    const source = readFileSync(place, 'utf8');
    const toReader = path.posix.relative(path.posix.dirname(mention.file), `server/test/${READER}`);
    const next = /\.mjs$/.test(mention.file) ? retarget(source, toReader.startsWith('.') ? toReader : `./${toReader}`) : null;
    if (next === null || next === source) { byHand.push(mention.file); continue; }
    changed.push(mention.file);
    if (write) writeFileSync(place, next);
  }
  return { changed, byHand };
}

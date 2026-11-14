// Finds everything in the repo that names a browser file in code: a page that
// loads it, a build step that copies or patches it, a test that reads it as text.
// A file about to be split must have every one of them accounted for, because
// each of them would go on reading one file where there are now several.
//
// Pages are followed by their tags, the list the pages for desktop widgets are
// built from by its rows (browser-lists.mjs), tests by server/test/browser-source.mjs.
// A page that loads the file must be one the page check opens (browser-check-pages.mjs).
// Anything else has to be written down in browser-consumers.json with a sentence
// saying how it keeps working, or the tool refuses the split.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { uncheckedPages } from './browser-check-pages.mjs';
import { BROWSER_LEDGER } from './browser-ledger.mjs';
import { LIST_FILES, listsHold } from './browser-lists.mjs';
import { tagsOf } from './browser-pages.mjs';

export const CONSUMERS = 'tools/restructure/browser-consumers.json';
const READER = 'browser-source.mjs';
// These follow a split without help: the saved numbers are moved by `browser carry` and
// `npm run sizes -- --update`, and a new file with no owner in the map is refused before the move.
const FOLLOW_ALONE = /^tools\/quality\/baseline\/|^tools\/map\/features\.json$/;
/** @param {string} file repo-relative @returns {boolean} true for a file a tool keeps in step with the browser files by itself */
export const followsAlone = (file) => FOLLOW_ALONE.test(file) || file === CONSUMERS || file === BROWSER_LEDGER;
const PROSE = /\.(md|txt)$|(^|\/)(LICENSE|CHANGELOG)[^/]*$/;
const TEST = /(^|\/)test\//;
// What stands right before a file's name when Node is told to load it: require('...'), import ... from '...', import('...').
const LOADS = /(?:\brequire\s*\(\s*|\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`]$/;
const blank = (text) => text.replace(/[^\n]/g, ' ');
/**
 * @param {string} root @param {string} file repo-relative
 * @returns {string[]} the lists built in code that hold the file (browser-lists.mjs): a name can be put together there
 *   from its parts ('components/' + name + '/' + name + '.css'), where no search for the file's name finds it
 */
export function builtListsWith(root, file) {
  return LIST_FILES.filter((list) => list !== file && existsSync(path.join(root, list)) && listsHold(readFileSync(path.join(root, list), 'utf8'), file));
}

/** Comments blanked out, every line kept, so a file named in a comment is not read as a use of it. */
export function withoutComments(text, file) {
  if (file.endsWith('.json')) return text;
  if (file.endsWith('.html')) return text.replace(/<!--[\s\S]*?-->/g, blank);
  const blocks = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (file.endsWith('.css')) return blocks;
  // `//` to the end of the line, but not the `//` of a URL.
  return blocks.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (whole, lead) => lead + blank(whole.slice(lead.length)));
}

/** @param {string} file repo-relative @returns {RegExp} the file's name as it can stand in code, with any folders in front */
function mentionOf(file) {
  const base = path.posix.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])((?:[\\w.-]+/)*)${base}(?![\\w-])`, 'g');
}

const grepFor = (root, names) => {
  const run = spawnSync('git', ['grep', '-l', '-I', '-z', '-F', ...names.flatMap((name) => ['-e', name])], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git grep failed: ${run.stderr}`);
  return run.stdout.split('\0').filter(Boolean);
};

// Set while one caller asks about many files (withOneSearch): which tracked files hold each file name, and each of them read once.
let once = null;
const SIMPLE_NAME = /^[\w.-]+\.js$/;
const SEARCH_AT_ONCE = 100;

/**
 * Asking who names a file is one search of the whole repo. Asked for hundreds of files, that is hundreds of
 * searches: here one search (a few, a hundred names each) finds every file that holds any of the names, each
 * is read once, and `mentionsOf` answers from that for as long as `work` runs. The answers are the same.
 * @template T @param {string} root @param {string[]} files repo-relative scripts that will be asked about @param {() => T} work
 * @returns {T}
 */
export function withOneSearch(root, files, work) {
  const names = [...new Set(files.map((file) => path.posix.basename(file)).filter((name) => SIMPLE_NAME.test(name)))];
  const holding = new Set();
  for (let at = 0; at < names.length; at += SEARCH_AT_ONCE) for (const file of grepFor(root, names.slice(at, at + SEARCH_AT_ONCE))) holding.add(file);
  const wanted = new Set(names);
  const holders = new Map(names.map((name) => [name, []]));
  const texts = new Map();
  for (const other of [...holding].sort()) {
    const raw = readFileSync(path.join(root, other), 'utf8');
    texts.set(other, raw);
    // A name is in the text where the text has it as letters in a row: every ".js" is the end of each name that stands right before it.
    const here = new Set();
    for (const match of raw.matchAll(/[\w.-]*\.js/g)) {
      for (let from = 0; from < match[0].length - 3; from += 1) { const name = match[0].slice(from); if (wanted.has(name)) here.add(name); }
    }
    for (const name of here) holders.get(name).push(other);
  }
  const before = once;
  once = { root, holders, texts, read: new Map() };
  try { return work(); } finally { once = before; }
}

// A file that names another one: its text, the text without comments and its tags, worked out once per search.
function holder(root, other) {
  const kept = once && once.root === root ? once.read : null;
  if (kept?.has(other)) return kept.get(other);
  const raw = once?.root === root && once.texts.has(other) ? once.texts.get(other) : readFileSync(path.join(root, other), 'utf8');
  const made = { raw, text: withoutComments(raw, other), tags: /^server\/.*\.html$/.test(other) ? tagsOf(raw).map((tag) => ({ file: tag.file, line: raw.slice(0, tag.start).split('\n').length })) : [] };
  kept?.set(other, made);
  return made;
}

/**
 * @param {string} root
 * @param {string} file repo-relative browser file
 * @returns {{ file: string, lines: number[], kind: 'page' | 'list' | 'test' | 'code', reader: boolean, loads: number[] }[]}
 *   every tracked file that names it outside a comment: `page` when only its tags do, `list` for a list of
 *   files a page is built from, `reader` true when a test already goes through browser-source.mjs,
 *   `loads` the lines where Node is told to load the file (`require`, `import`)
 */
export function mentionsOf(root, file) {
  const base = path.posix.basename(file);
  const holding = once?.root === root && once.holders.has(base) ? once.holders.get(base) : grepFor(root, [base]);
  const found = [];
  for (const other of [...holding].sort()) {
    if (other === file || PROSE.test(other)) continue;
    const { raw, text, tags } = holder(root, other);
    // Only a page of the app gets its tags from the tool; a page elsewhere (a tool's own page) is code that names the file.
    const tagLines = new Set(tags.filter((tag) => tag.file === file).map((tag) => tag.line));
    const lines = [];
    const loads = [];
    for (const match of text.matchAll(mentionOf(file))) {
      // `js/settings.js` and `../js/settings.js` are this file; `remote-control/settings.js` is another one.
      const folders = match[1].split('/').filter((part) => part && part !== '.' && part !== '..').join('/');
      if (folders && !`/${path.posix.dirname(file)}`.endsWith(`/${folders}`)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      if (!tagLines.has(line)) lines.push(line);
      if (LOADS.test(text.slice(Math.max(0, match.index - 40), match.index))) loads.push(line);
    }
    if (lines.length) found.push({ file: other, lines: [...new Set(lines)], kind: TEST.test(other) ? 'test' : 'code', reader: raw.includes(READER), loads });
    else if (tagLines.size) found.push({ file: other, lines: [...tagLines], kind: 'page', reader: false, loads });
  }
  // A list that holds the file is followed by the tool like a page; one that only names it in a sentence is code.
  for (const list of builtListsWith(root, file)) {
    const named = found.find((mention) => mention.file === list);
    if (named) named.kind = 'list';
    else found.push({ file: list, lines: [1], kind: 'list', reader: false, loads: [] });
  }
  return found;
}

/**
 * @param {string} root
 * @returns {Record<string, Record<string, string | { how: string, keeps: string[] }>>} per browser file, who names it and
 *   how it follows a split; `keeps` lists the declarations it reads out of the file, which therefore stay in it
 */
export function knownConsumers(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, CONSUMERS), 'utf8')).known ?? {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * @param {string} root
 * @param {string} file repo-relative browser file that is split, or about to be
 * @param {{ tests?: boolean }} [options] `tests: false` leaves the tests out (they are moved over after the first split)
 * @returns {string[]} one line per file that names it and is not accounted for
 */
export function consumerProblems(root, file, { tests = true } = {}) {
  const known = knownConsumers(root)[file] ?? {};
  const problems = [];
  for (const mention of mentionsOf(root, file)) {
    if (mention.kind === 'page' && uncheckedPages([mention.file]).length) {
      problems.push(`${mention.file} loads ${path.posix.basename(file)}, and the page check never opens that page: add it to tools/restructure/browser-check-pages.mjs first`);
    }
    if (mention.kind === 'page' || mention.kind === 'list' || known[mention.file] || FOLLOW_ALONE.test(mention.file)) continue;
    if (mention.file === CONSUMERS || mention.file === BROWSER_LEDGER) continue;
    const where = `${mention.file}:${mention.lines.slice(0, 3).join(',')}`;
    if (mention.kind === 'code') {
      problems.push(`${where} names ${path.posix.basename(file)} in code: make it follow the split, then say how in ${CONSUMERS}`);
    } else if (tests && !mention.reader) {
      problems.push(`${where} reads or names ${path.posix.basename(file)} without server/test/${READER}: read it through the reader, or say in ${CONSUMERS} why it need not`);
    }
  }
  return problems;
}

/**
 * @param {string} root @param {string} file repo-relative browser file
 * @returns {Map<string, string>} the declarations that must stay in the file, each with the consumer that reads it there
 */
export function keptNames(root, file) {
  const kept = new Map();
  for (const [consumer, entry] of Object.entries(knownConsumers(root)[file] ?? {})) {
    for (const name of entry.keeps ?? []) kept.set(name, consumer);
  }
  return kept;
}

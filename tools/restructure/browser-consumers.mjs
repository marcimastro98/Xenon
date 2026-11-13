// Finds everything in the repo that names a browser file in code: a page that
// loads it, a build step that copies or patches it, a test that reads it as text.
// A file about to be split must have every one of them accounted for, because
// each of them would go on reading one file where there are now several.
//
// Pages are followed by their tags and tests by server/test/browser-source.mjs.
// Anything else has to be written down in browser-consumers.json with a sentence
// saying how it keeps working, or the tool refuses the split.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { BROWSER_LEDGER } from './browser-ledger.mjs';
import { tagsOf } from './browser-pages.mjs';

export const CONSUMERS = 'tools/restructure/browser-consumers.json';
const READER = 'browser-source.mjs';
// These follow a split without help: the saved numbers are moved by `browser carry` and
// `npm run sizes -- --update`, and a new file with no owner in the map is refused before the move.
const FOLLOW_ALONE = /^tools\/quality\/baseline\/|^tools\/map\/features\.json$/;
const PROSE = /\.(md|txt)$|(^|\/)(LICENSE|CHANGELOG)[^/]*$/;
const TEST = /(^|\/)test\//;
const blank = (text) => text.replace(/[^\n]/g, ' ');
// Lists of browser files that code puts together while it runs. A name can be built there from its
// parts ('components/' + name + '/' + name + '.css'), where no search for the file's name finds it,
// so each list is asked for its files. The pages for widgets on the desktop are made from the first.
const BUILT_LISTS = [{
  file: 'server/js/layer-tiles.js',
  files: (api) => Object.values(api.TILES ?? {}).flatMap((row) => [...(row.css ?? []), ...(row.js ?? [])]).map((name) => `server/${name}`),
}];
const load = createRequire(import.meta.url);

/** @param {string} root @param {string} file repo-relative @returns {string[]} the lists built in code that hold the file */
export function builtListsWith(root, file) {
  return BUILT_LISTS.filter((list) => existsSync(path.join(root, list.file)) && list.files(load(path.join(root, list.file))).includes(file))
    .map((list) => list.file);
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

/**
 * @param {string} root
 * @param {string} file repo-relative browser file
 * @returns {{ file: string, lines: number[], kind: 'page' | 'test' | 'code', reader: boolean }[]}
 *   every tracked file that names it outside a comment: `page` when only its tags do,
 *   `reader` true when a test already goes through browser-source.mjs
 */
export function mentionsOf(root, file) {
  const base = path.posix.basename(file);
  const run = spawnSync('git', ['grep', '-l', '-I', '-z', '-F', '-e', base], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git grep failed: ${run.stderr}`);
  const found = [];
  for (const other of run.stdout.split('\0').filter(Boolean).sort()) {
    if (other === file || PROSE.test(other)) continue;
    const raw = readFileSync(path.join(root, other), 'utf8');
    const text = withoutComments(raw, other);
    // Only a page of the app gets its tags from the tool; a page elsewhere (a tool's own page) is code that names the file.
    const tagLines = /^server\/.*\.html$/.test(other) ? new Set(tagsOf(raw).filter((tag) => tag.file === file)
      .map((tag) => raw.slice(0, tag.start).split('\n').length)) : new Set();
    const lines = [];
    for (const match of text.matchAll(mentionOf(file))) {
      // `js/settings.js` and `../js/settings.js` are this file; `remote-control/settings.js` is another one.
      const folders = match[1].split('/').filter((part) => part && part !== '.' && part !== '..').join('/');
      if (folders && !`/${path.posix.dirname(file)}`.endsWith(`/${folders}`)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      if (!tagLines.has(line)) lines.push(line);
    }
    if (lines.length) found.push({ file: other, lines: [...new Set(lines)], kind: TEST.test(other) ? 'test' : 'code', reader: raw.includes(READER) });
    else if (tagLines.size) found.push({ file: other, lines: [...tagLines], kind: 'page', reader: false });
  }
  for (const list of builtListsWith(root, file)) {
    if (!found.some((mention) => mention.file === list && mention.kind === 'code')) found.push({ file: list, lines: [1], kind: 'code', reader: false });
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
    if (mention.kind === 'page' || known[mention.file] || FOLLOW_ALONE.test(mention.file)) continue;
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

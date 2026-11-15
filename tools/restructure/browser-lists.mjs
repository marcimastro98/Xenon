// The lists of browser files that code puts together while it runs. One the
// engine builds a page from: server/js/layers/layer-tiles.js, whose rows say which
// scripts and stylesheets the page of a widget on the desktop loads. The others
// are held by a script that loads them itself when it is asked to, under the
// names SCRIPTS and CSS (server/js/ai/screen-bit.js, the voice panel of the screen),
// or under a name it hands to nobody (server/js/layers/layer-host.js, the editor of a
// layer). Which scripts do, and how each list is read, is written down in
// browser-consumers.json under `loaders`.
// A file in such a list is loaded by a page no search for a tag finds, so a split
// must put the new files into every list that holds the old one, right next to it.
//
// The edit is made in the text; the proof is made by running the list before and
// after and comparing what it holds, so a wrong edit cannot pass.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const BUILT_LIST = 'server/js/layers/layer-tiles.js';
/** Scripts that load their own list when asked: each is opened by a page of the page check that asks it to (browser-check-pages.mjs). */
const LOADERS = JSON.parse(readFileSync(new URL('./browser-consumers.json', import.meta.url), 'utf8')).loaders;
export const ASKED_LISTS = Object.keys(LOADERS);
export const LIST_FILES = [BUILT_LIST, ...ASKED_LISTS];
/** The row a script's own SCRIPTS and CSS make. */
export const OWN_ROW = 'SCRIPTS';
/** @param {string} listFile @returns {string} the row a loader's own list makes: SCRIPTS, or the name of the list it writes for itself */
export const ownRowOf = (listFile) => LOADERS[listFile]?.written ?? OWN_ROW;
const PAGE_ROOT = 'server/';
const KEYS = ['css', 'js'];
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const urlOf = (file) => file.slice(PAGE_ROOT.length);

// A list a script writes for itself and hands to nobody: `const NAME = Object.freeze(['js/a.js', 'js/b.js']);`. The script
// cannot be run outside a page, so the list is read out of its text: written once, of addresses in single quotes and nothing else.
function writtenList(text, name, listFile) {
  const found = [...text.matchAll(new RegExp(`(?<![\\w$.])const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`, 'g'))];
  if (found.length !== 1) throw new Error(`${listFile} does not write the list ${name} once as \`const ${name} = Object.freeze([...])\``);
  const items = found[0][1].split(',').map((item) => item.trim()).filter(Boolean);
  const odd = items.find((item) => !/^'[\w./-]+'$/.test(item));
  if (odd !== undefined) throw new Error(`the list ${name} of ${listFile} holds ${odd}, which is not an address written out in single quotes`);
  return items.map((item) => PAGE_ROOT + item.slice(1, -1));
}

/**
 * Runs the list file and reads its rows; a list the file hands to nobody is read out of the text (`loaders` in browser-consumers.json).
 * @param {string} text the list file @param {string} [listFile] its name
 * @returns {Record<string, { css: string[], js: string[] }>} per row, the repo-relative files it loads, in order:
 *   the rows of TILES, and one row for the file's own SCRIPTS and CSS when it has them
 */
export function readLists(text, listFile = BUILT_LIST) {
  const written = LOADERS[listFile]?.written;
  if (written) return { [written]: { css: [], js: writtenList(text, written, listFile) } };
  const module = { exports: {} };
  vm.runInNewContext(text, { module }, { timeout: 5000 });
  const made = module.exports;
  const rows = {};
  // Array.from: the lists come out of another realm, and would never equal a list made here.
  const filesOf = (row) => Object.fromEntries(KEYS.map((key) => [key, Array.from(row[key] ?? [], (url) => PAGE_ROOT + url)]));
  for (const [name, row] of Object.entries(made.TILES ?? {})) rows[name] = filesOf(row);
  if (made.SCRIPTS || made.CSS) rows[OWN_ROW] = filesOf({ js: made.SCRIPTS, css: made.CSS });
  return rows;
}

/**
 * Where a copy of the engine serves the list file: where it stands today and, for a copy as at a commit
 * before it moved with its feature, where it stood then (browser-moved.json).
 * @param {{from: string, to: string}[]} moves @returns {string[]} addresses to ask, today's first
 */
export function listAddresses(moves) {
  const was = moves.find((move) => move.to === BUILT_LIST)?.from;
  return [BUILT_LIST, was].filter(Boolean).map((file) => `/${file.slice('server/'.length)}`);
}

/** @param {string} text the list file @returns {string[]} the built-in widgets the page of desktop widgets can carry */
export function liteWidgets(text) {
  const module = { exports: {} };
  vm.runInNewContext(text, { module }, { timeout: 5000 });
  return Array.from(module.exports.LITE ?? [], String);
}

/** @param {string | null} text the list file, null when the repo has none @param {string} file @param {string} [listFile] the list file's name @returns {boolean} */
export function listsHold(text, file, listFile = BUILT_LIST) {
  if (text === null) return false;
  return Object.values(readLists(text, listFile)).some((row) => KEYS.some((key) => row[key].includes(file)));
}

/**
 * @param {string} text the list file
 * @param {string[]} run the files of one split, in the order they must load
 * @param {string} [listFile] the list file's name, for the messages
 * @returns {string[]} problems, empty when every list holds none of them or all of them in a row
 */
export function listRunProblems(text, run, listFile = BUILT_LIST) {
  const problems = [];
  for (const [name, row] of Object.entries(readLists(text, listFile))) {
    for (const key of KEYS) {
      const first = row[key].findIndex((file) => run.includes(file));
      if (first === -1) continue;
      const held = row[key].filter((file) => run.includes(file));
      if (held.length !== run.length || row[key].slice(first, first + run.length).join('\n') !== run.join('\n')) {
        problems.push(`the row "${name}" of ${listFile} loads ${held.map(urlOf).join(', ')} where ${run.map(urlOf).join(', ')} must follow each other with nothing between`);
      }
    }
  }
  return problems;
}

// The arguments of the call that opens at `open` (the index of its bracket), each with where it starts and ends.
function argumentsAt(text, open) {
  const parts = [];
  let [depth, start, quote] = [0, open + 1, ''];
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth -= 1;
    else if (c === ',' && depth === 0) { parts.push({ start, end: i }); start = i + 1; } else if (c === ')') {
      if (text.slice(start, i).trim()) parts.push({ start, end: i });
      return { parts, close: i };
    }
  }
  return null;
}

// A stylesheet whose name a row builds from its parts (`tile(name, global, js, streams, cssName, moreCss)` gives
// components/<cssName or global>/<the same>.css first, then `moreCss`): the parts go to the front of `moreCss`.
function addAfterBuiltName(text, oldFile, urls) {
  const named = /^server\/components\/([A-Za-z0-9]+)\/\1\.css$/.exec(oldFile)?.[1];
  if (!named) return text;
  const literal = (part) => /^\s*'([A-Za-z0-9]+)'\s*$/.exec(text.slice(part.start, part.end))?.[1] ?? null;
  const added = urls.map((url) => `'${url}'`).join(', ');
  const edits = [];
  for (const call of text.matchAll(/(?<![\w.])tile\(/g)) {
    const read = argumentsAt(text, call.index + call[0].length - 1);
    if (!read || read.parts.length < 4) continue;
    const { parts, close } = read;
    if ((parts[4] ? literal(parts[4]) : null) !== named && !(literal(parts[1]) === named && (!parts[4] || text.slice(parts[4].start, parts[4].end).trim() === 'null'))) continue;
    if (parts[5]) {
      const open = text.indexOf('[', parts[5].start);
      if (open === -1 || open >= parts[5].end) continue;
      edits.push({ at: open + 1, insert: text.slice(open + 1, parts[5].end).trim().startsWith(']') ? added : `${added}, ` });
    } else {
      edits.push({ at: close, insert: `${parts[4] ? '' : ', null'}, [${added}]` });
    }
  }
  return edits.sort((a, b) => b.at - a.at).reduce((out, edit) => out.slice(0, edit.at) + edit.insert + out.slice(edit.at), text);
}

/**
 * Puts new files next to an old one in every list that holds it.
 * @param {string} text the list file
 * @param {string} oldFile repo-relative file the lists already hold
 * @param {string[]} newFiles repo-relative files, in the order they must load
 * @param {'before' | 'after'} where
 * @param {string} [listFile] the list file's name, for the messages
 * @returns {{ text: string, reasons: string[] }} `text` unchanged when no list holds the old file; `reasons` say why the
 *   edit is not proven: the lists, run before and after, must differ by the new files next to the old one and nothing else
 */
export function addToLists(text, oldFile, newFiles, where, listFile = BUILT_LIST) {
  const was = readLists(text, listFile);
  if (!Object.values(was).some((row) => KEYS.some((key) => row[key].includes(oldFile)))) return { text, reasons: [] };
  const urls = newFiles.map(urlOf);
  const quoted = new RegExp(`(['"])${escaped(urlOf(oldFile))}\\1`, 'g');
  let next = text.replace(quoted, (whole, quote) => {
    const added = urls.map((url) => `${quote}${url}${quote}`).join(', ');
    return where === 'before' ? `${added}, ${whole}` : `${whole}, ${added}`;
  });
  if (where === 'after') next = addAfterBuiltName(next, oldFile, urls);
  const wanted = (list) => list.flatMap((file) => (file !== oldFile ? [file] : where === 'before' ? [...newFiles, file] : [file, ...newFiles]));
  let now;
  try { now = readLists(next, listFile); } catch (error) { return { text, reasons: [`${listFile} does not run after the new files were written into it: ${error.message}`] }; }
  const reasons = [];
  for (const name of new Set([...Object.keys(was), ...Object.keys(now)])) {
    for (const key of KEYS) {
      if (wanted(was[name]?.[key] ?? []).join('\n') !== (now[name]?.[key] ?? []).join('\n')) {
        reasons.push(`the row "${name}" of ${listFile} builds its ${key} list in a way the tool cannot follow: write ${urlOf(oldFile)} out in that row first`);
      }
    }
  }
  return reasons.length ? { text, reasons } : { text: next, reasons };
}

// The lists of browser files that code puts together while it runs. One the
// engine builds a page from: server/js/layer-tiles.js, whose rows say which
// scripts and stylesheets the page of a widget on the desktop loads. The others
// are held by a script that loads them itself when it is asked to, under the
// names SCRIPTS and CSS (server/js/screen-bit.js, the voice panel of the screen).
// A file in such a list is loaded by a page no search for a tag finds, so a split
// must put the new files into every list that holds the old one, right next to it.
//
// The edit is made in the text; the proof is made by running the list before and
// after and comparing what it holds, so a wrong edit cannot pass.

import vm from 'node:vm';

export const BUILT_LIST = 'server/js/layer-tiles.js';
/** Scripts that load their own list when asked: each is opened by a page of the page check that asks it to (browser-check-pages.mjs). */
export const ASKED_LISTS = ['server/js/screen-bit.js'];
export const LIST_FILES = [BUILT_LIST, ...ASKED_LISTS];
/** The row a script's own SCRIPTS and CSS make. */
export const OWN_ROW = 'SCRIPTS';
const PAGE_ROOT = 'server/';
const KEYS = ['css', 'js'];
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const urlOf = (file) => file.slice(PAGE_ROOT.length);

/**
 * Runs the list file and reads its rows.
 * @param {string} text the list file
 * @returns {Record<string, { css: string[], js: string[] }>} per row, the repo-relative files it loads, in order:
 *   the rows of TILES, and one row for the file's own SCRIPTS and CSS when it has them
 */
export function readLists(text) {
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

/** @param {string} text the list file @returns {string[]} the built-in widgets the page of desktop widgets can carry */
export function liteWidgets(text) {
  const module = { exports: {} };
  vm.runInNewContext(text, { module }, { timeout: 5000 });
  return Array.from(module.exports.LITE ?? [], String);
}

/** @param {string | null} text the list file, null when the repo has none @param {string} file @returns {boolean} */
export function listsHold(text, file) {
  if (text === null) return false;
  return Object.values(readLists(text)).some((row) => KEYS.some((key) => row[key].includes(file)));
}

/**
 * @param {string} text the list file
 * @param {string[]} run the files of one split, in the order they must load
 * @param {string} [listFile] the list file's name, for the messages
 * @returns {string[]} problems, empty when every list holds none of them or all of them in a row
 */
export function listRunProblems(text, run, listFile = BUILT_LIST) {
  const problems = [];
  for (const [name, row] of Object.entries(readLists(text))) {
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
  const was = readLists(text);
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
  try { now = readLists(next); } catch (error) { return { text, reasons: [`${listFile} does not run after the new files were written into it: ${error.message}`] }; }
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

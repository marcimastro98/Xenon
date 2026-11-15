// A test or a tool may name a file in a way the move tool cannot follow: a bare `x.js` handed to a reader the tool
// cannot work out, a key of a table, a regular expression that pins how a file is required, a word in a message.
// A person read each of those places and wrote the answer in move-told.json: the spelling that is right once the
// file has moved (the same spelling, when the place is a word and not a path), with `near`, a piece of the line,
// when the same spelling stands for two things in one file. The tool writes that spelling in
// the step that moves the file, and the check afterwards takes a place that holds it as answered.
// Only tests and tools are answered this way: code that ships is never told.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isDevFile } from './move-refs.mjs';

export const TOLD = 'tools/restructure/move-told.json';

/** @param {string} root @returns {{file: string, was: string, text: string, near?: string}[]} */
export function readTold(root) {
  try { return JSON.parse(readFileSync(path.join(root, TOLD), 'utf8')).sites; } catch { return []; }
}

/**
 * @param {object[]} sites from findSites @param {{file: string, was: string, text: string, near?: string}[]} told
 * @param {(file: string) => string} read
 * @returns {object[]} the sites with every answered place rewritten (`kind: 'told'`), or gone when it stays as written
 */
export function answered(sites, told, read) {
  const seen = new Set();
  const out = [];
  for (const site of sites) {
    if (site.kind !== 'unknown' || !isDevFile(site.file)) { out.push(site); continue; }
    const line = (read(site.file) ?? '').split('\n')[site.line - 1] ?? '';
    const rows = told.filter((row) => row.file === site.file && (!row.near || line.includes(row.near)));
    // After the step the place holds the answer: nothing left to say about it.
    if (rows.some((row) => row.text === site.was)) continue;
    const row = rows.find((one) => one.was === site.was);
    if (!row) { out.push(site); continue; }
    const key = `${site.file}:${site.start}`;
    if (!seen.has(key)) out.push({ ...site, kind: 'told', text: row.text, why: undefined });
    seen.add(key);
  }
  return out;
}

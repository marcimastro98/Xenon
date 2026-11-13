// The list of what was taken out of which file, in order (extracted.json). The
// replay check redoes the moves from it, and the tests that read engine code as
// text use it to find a declaration wherever it lives now.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LEDGER = 'tools/restructure/extracted.json';
export const PROTECTED = 'tools/restructure/protected.json';
const NOTE = 'What tools/restructure took out of which file, in order. Written by `extract`, read by `verify` and by server/test/engine-source.mjs. Do not edit by hand.';

/** @param {string} root @returns {{ note: string, sources: Record<string, {file: string, about: string, names: string[]}[]> }} */
export function readLedger(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, LEDGER), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { note: NOTE, sources: {} };
    throw error;
  }
}

/**
 * @param {string} root
 * @param {string} source repo-relative file the code left
 * @param {{file: string, about: string, names: string[]}} entry
 */
export function appendLedger(root, source, entry) {
  const ledger = readLedger(root);
  ledger.sources[source] ??= [];
  ledger.sources[source].push(entry);
  const rows = Object.entries(ledger.sources).map(([file, entries]) => `    ${JSON.stringify(file)}: [\n${
    entries.map((e) => `      ${JSON.stringify(e)}`).join(',\n')}\n    ]`);
  writeFileSync(path.join(root, LEDGER), `{\n  "note": ${JSON.stringify(ledger.note)},\n  "sources": {\n${rows.join(',\n')}\n  }\n}\n`);
}

/**
 * The modules the tool made out of a file that run nothing when they load: a require of one may go when nobody
 * uses it. A lifted value's module (lift.mjs) does run code, on the line where the file requires it, and is left out.
 * @param {{ file: string, lift?: boolean }[]} entries a file's entries, or the ones before a step being redone
 * @returns {Set<string>}
 */
export function quietModules(entries) {
  return new Set(entries.filter((entry) => !entry.lift).map((entry) => entry.file));
}

/**
 * The protected values of a file that may get a module of their own, required on the line where they stood.
 * @param {string} root @param {string} source repo-relative
 * @returns {Set<string>}
 */
export function liftableNames(root, source) {
  return new Set(JSON.parse(readFileSync(path.join(root, PROTECTED), 'utf8')).files?.[source]?.liftable ?? []);
}

/**
 * The names that never leave a file: listed one by one, or as a stretch of the
 * file from one declaration to another (both included).
 * @param {string} root
 * @param {string} source repo-relative
 * @param {{names: string[], line: number[]}[]} records top-level statements of the file, in order
 * @returns {{ names: Set<string>, missing: string[], stretches: number[][] }} `missing` are anchors the file no longer
 *   declares; `stretches` are the protected runs as [first, last] positions in `records`, first = -1 when the run
 *   starts with the file
 */
export function protectedNames(root, source, records) {
  const rules = JSON.parse(readFileSync(path.join(root, PROTECTED), 'utf8')).files?.[source];
  const names = new Set();
  const missing = [];
  const stretches = [];
  if (!rules) return { names, missing, stretches };
  const indexOf = (name) => records.findIndex((record) => record.names.includes(name));
  for (const name of rules.names ?? []) {
    if (indexOf(name) === -1) missing.push(name); else names.add(name);
  }
  for (const [from, to] of rules.between ?? []) {
    const first = from === null ? 0 : indexOf(from);
    const last = indexOf(to);
    if (first === -1 || last === -1 || last < first) { missing.push(`${from}..${to}`); continue; }
    for (const record of records.slice(first, last + 1)) for (const name of record.names) names.add(name);
    stretches.push([from === null ? -1 : first, last]);
  }
  return { names, missing, stretches };
}

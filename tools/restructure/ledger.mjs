// The list of what was taken out of which file, in order (extracted.json). The
// replay check redoes the moves from it, and the tests that read engine code as
// text use it to find a declaration wherever it lives now.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LEDGER = 'tools/restructure/extracted.json';
export const PROTECTED = 'tools/restructure/protected.json';
const NOTE = 'What tools/restructure took out of which file, in order. Written by `extract`, read by `verify` and by server/test/engine-source.mjs. Do not edit by hand.';

/**
 * @param {string} root
 * @returns {{ note: string, sources: Record<string, {file: string, about: string, names: string[]}[]>,
 *   spreads?: Record<string, { name: string, parts: { name: string, first: string }[], after: number }[]>,
 *   branches?: Record<string, { file: string, about: string, keys: string[], after: number }[]> }}
 */
export function readLedger(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, LEDGER), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { note: NOTE, sources: {} };
    throw error;
  }
}

// One list per file, one entry per line: a step shows up as one added line.
function rowsOf(lists) {
  return Object.entries(lists).map(([file, entries]) => `    ${JSON.stringify(file)}: [\n${
    entries.map((e) => `      ${JSON.stringify(e)}`).join(',\n')}\n    ]`).join(',\n');
}

function writeLedger(root, ledger) {
  const more = ['spreads', 'branches'].filter((list) => ledger[list]).map((list) => `,\n  "${list}": {\n${rowsOf(ledger[list])}\n  }`).join('');
  writeFileSync(path.join(root, LEDGER), `{\n  "note": ${JSON.stringify(ledger.note)},\n  "sources": {\n${rowsOf(ledger.sources)}\n  }${more}\n}\n`);
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
  writeLedger(root, ledger);
}

/**
 * A frozen object that was cut into parts where it stood (spread.mjs). It is not a module, so it has a list of its
 * own: `after` says how many entries the file had when it was cut, which is where the replay redoes it.
 * @param {string} root
 * @param {string} source repo-relative file that declares the object
 * @param {{ name: string, parts: { name: string, first: string }[], after: number }} spread
 */
export function recordSpread(root, source, spread) {
  const ledger = readLedger(root);
  ledger.spreads ??= {};
  ledger.spreads[source] ??= [];
  ledger.spreads[source].push(spread);
  writeLedger(root, ledger);
}

/**
 * Bodies of a request handler's routes that went into a table in a module (branches.mjs). One record per run of the
 * command; a module may get several. `after` says how many entries the file had then, which is where the replay redoes it.
 * @param {string} root
 * @param {string} source repo-relative file with the handler
 * @param {{ file: string, about: string, keys: string[], after: number }} record
 */
export function recordBranches(root, source, record) {
  const ledger = readLedger(root);
  ledger.branches ??= {};
  ledger.branches[source] ??= [];
  ledger.branches[source].push(record);
  writeLedger(root, ledger);
}

/**
 * @param {ReturnType<typeof readLedger>} ledger
 * @returns {string[][]} per old file: itself, then every module made out of it, each once
 */
export function groupsOf(ledger) {
  const sources = new Set([...Object.keys(ledger.sources), ...Object.keys(ledger.spreads ?? {}), ...Object.keys(ledger.branches ?? {})]);
  return [...sources].map((source) => [...new Set([source, ...(ledger.sources[source] ?? []).map((entry) => entry.file),
    ...(ledger.branches?.[source] ?? []).map((record) => record.file)])]);
}

/**
 * The handlers of a file whose route bodies may move into tables: their tests and everything before the chain stay.
 * @param {string} root @param {string} source repo-relative
 * @returns {Set<string>}
 */
export function branchHandlers(root, source) {
  return new Set(JSON.parse(readFileSync(path.join(root, PROTECTED), 'utf8')).files?.[source]?.branches ?? []);
}

/** @param {string} root @param {string} source @returns {(string | null)[][]} the protected stretches as written: pairs of names */
export function protectedBetween(root, source) {
  return JSON.parse(readFileSync(path.join(root, PROTECTED), 'utf8')).files?.[source]?.between ?? [];
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

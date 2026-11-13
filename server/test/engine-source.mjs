// The engine's code as text, wherever it lives now.
// server.js is being taken apart into feature modules (tools/restructure). A test
// that reads server.js as text to find a function or a table would lose it the
// day it moves: these readers follow the list of what was moved
// (tools/restructure/extracted.json), so the same assertion keeps reading the
// same code.
//
// Some shared variables became properties of an object in a module of their own
// (`_serverHubSettings` is `hub.settings` now). The tests were written with the old
// names, so the text handed out here has them put back: the list says which
// property stands for which name.
//
// A big frozen object may have been cut into parts (`DEFAULT_HUB_SETTINGS` is
// several constants spread together now). The text handed out here has every key
// back inside the one literal, and the parts gone, as the tests found it before.
//
// The body of a route may live in a table in a module of its feature, with one
// call of the table left under the route's test (tools/restructure `branches`).
// The text handed out here has every body back under its test.
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { undoBranchesText } from '../../tools/restructure/branches-text.mjs';
import { oldPathsText } from '../../tools/restructure/paths-undo.mjs';
import { dropPart, undoSpreadText } from '../../tools/restructure/spread-undo.mjs';
import { undoStateText } from '../../tools/restructure/state-undo.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(REPO, 'tools', 'restructure', 'extracted.json');
const ENGINE = 'server/server.js';

const readAsIs = (file) => readFileSync(join(REPO, file), 'utf8');
// A module of places next to the engine says SERVER_DIR where the old file said __dirname: the old word is put back.
const PATH_MODULES = new Set(ledgerOf(ENGINE).filter((entry) => entry.paths).map((entry) => entry.file));
const SPREADS = readLedger().spreads?.[ENGINE] ?? [];
const PARTS = new Set(SPREADS.flatMap((spread) => spread.parts.map((part) => part.name)));
const oldPlaces = (file) => (PATH_MODULES.has(file) ? oldPathsText(readAsIs(file)) : readAsIs(file));
const read = (file) => wholeObjects(file, bodiesBack(file, oldPlaces(file)));

/**
 * @param {string} file repo-relative @param {string} text its text
 * @returns {string} the text with the cut objects it declares in one piece again, and without the parts it declares
 */
export function wholeObjects(file, text) {
  let out = text;
  for (const spread of SPREADS) {
    if (plainFileOf(spread.name) === file) out = undoSpreadText(out, spread, (part) => readAsIs(plainFileOf(part)));
    for (const part of spread.parts) if (plainFileOf(part.name) === file) out = dropPart(out, part.name);
  }
  return out;
}

/**
 * @param {string} file repo-relative @param {string} text its text
 * @returns {string} the text with the body of every route back under its test, when bodies of the file went into tables
 */
export function bodiesBack(file, text) {
  if (!readLedger().branches?.[file]) return text;
  return undoBranchesText(text, (spec) => readAsIs(posix.join(posix.dirname(file), spec)));
}

// Where a constant that was moved as it is lives today.
function plainFileOf(name) {
  return ledgerOf(ENGINE).find((entry) => !entry.state && entry.names.includes(name))?.file ?? ENGINE;
}

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function ledgerOf(source) {
  return readLedger().sources?.[source] ?? [];
}

/**
 * @param {string} [source]
 * @returns {{ name: string, parts: { name: string, first: string }[] }[]} the frozen objects of the file that were cut
 *   into parts: each part is a constant holding the keys from `first` on, spread into the object in order
 */
export function cutObjects(source = ENGINE) {
  return readLedger().spreads?.[source] ?? [];
}

/**
 * @param {string} [source] repo-relative file code was taken out of
 * @returns {{ file: string, about: string, names: string[] }[]} the modules moved out of it unchanged, oldest first
 */
export function extractedFrom(source = ENGINE) {
  return ledgerOf(source).filter((entry) => !entry.state);
}

/**
 * @param {string} [source]
 * @returns {{ file: string, about: string, names: string[],
 *   state: { object: string, props: Record<string, string>, kept: string[], bare: string[] } }[]}
 *   the modules that hold variables of the file as properties of one object: `props` is old name to property,
 *   `kept` the names whose first value is still given in the file, `bare` the ones declared without a value
 */
export function stateRewrites(source = ENGINE) {
  return ledgerOf(source).filter((entry) => entry.state);
}

/**
 * Code with the names it had before the state rewrites.
 * @param {string} text @param {{ state: any }[]} rewrites
 */
export function oldNames(text, rewrites) {
  return rewrites.reduce((out, entry) => undoStateText(out, entry.state), text);
}

/**
 * A state module as the declarations it replaced: `let name = value;` with the comments that stood above each.
 * @param {string} text the module @param {{ state: { object: string, props: Record<string, string>, kept: string[], bare: string[] } }} entry
 */
export function oldDeclarations(text, { state }) {
  const nameOf = new Map(Object.entries(state.props).map(([name, prop]) => [prop, name]));
  const lines = text.split('\n');
  const rows = lines.slice(lines.indexOf(`const ${state.object} = {`) + 1, lines.lastIndexOf('};'));
  return rows.flatMap((row) => {
    const value = /^ {2}([A-Za-z_$][\w$]*): (.*),(\s*(?:\/\/.*)?)$/.exec(row);
    if (!value || !nameOf.has(value[1])) return [undoStateText(row.replace(/^ {2}/, ''), { ...state, kept: [] })];
    const name = nameOf.get(value[1]);
    if (state.kept.includes(name)) return [];
    return [state.bare.includes(name) ? `let ${name};${value[3]}` : `let ${name} = ${value[2]};${value[3]}`];
  }).join('\n');
}

/**
 * The file followed by every module taken out of it: the text a test read when
 * all of it was one file, plus the few `require` lines that now join the parts.
 * @param {string} [source]
 * @returns {string}
 */
export function engineSource(source = ENGINE) {
  const rewrites = stateRewrites(source);
  return [oldNames(read(source), rewrites),
    ...ledgerOf(source).map((entry) => (entry.state ? oldDeclarations(read(entry.file), entry) : oldNames(read(entry.file), rewrites)))].join('\n');
}

/**
 * @param {string} name a top-level function, const, let or class
 * @param {string} [source]
 * @returns {string} repo-relative path of the file that declares it today
 */
export function fileDeclaring(name, source = ENGINE) {
  return (extractedFrom(source).find((entry) => entry.names.includes(name)) ?? valueHolder(name, source))?.file ?? source;
}

// The state module that holds the first value of a variable, when that value left the file.
function valueHolder(name, source) {
  return stateRewrites(source).find((entry) => entry.names.includes(name) && !entry.state.kept.includes(name));
}

/**
 * The text of one top-level declaration, from its first line to the line that
 * closes it, read from the file it lives in today.
 * @param {string} name
 * @param {string} [source]
 * @returns {string}
 */
export function declarationSource(name, source = ENGINE) {
  const file = fileDeclaring(name, source);
  const holder = valueHolder(name, source);
  // A part of a cut object is not in the text handed out as a whole; asked for by name, it is read as its module has it.
  const text = PARTS.has(name) ? oldPlaces(file) : read(file);
  const lines = (holder ? oldDeclarations(text, holder) : oldNames(text, stateRewrites(source))).split('\n');
  const escaped = name.replace(/[$]/g, '\\$&');
  const opening = new RegExp(`^(?:(?:async\\s+)?function\\*?\\s+${escaped}\\s*\\(|(?:const|let|var|class)\\s+${escaped}\\b)`);
  const first = lines.findIndex((line) => opening.test(line));
  if (first === -1) throw new Error(`${name} is not declared at the top level of ${file}`);
  const oneLine = /;\s*(?:\/\/.*)?$/.test(lines[first]) && !/[([{]\s*;?\s*$/.test(lines[first]);
  if (oneLine) return lines[first];
  // A value written on the lines after the `=`, or a call whose list goes on after a comma: the lines are
  // indented, and the last of them ends the statement.
  if (/[=,]\s*$/.test(lines[first])) {
    let end = first;
    while (end + 1 < lines.length && /^\s+\S/.test(lines[end + 1])) end += 1;
    if (end > first && /;\s*(?:\/\/.*)?$/.test(lines[end])) return lines.slice(first, end + 1).join('\n');
  }
  // The closing line starts at the margin: a bracket, or the backtick of a text written over several lines.
  const last = lines.findIndex((line, index) => index > first && /^[)\]}`]+;?\s*(?:\/\/.*)?$/.test(line));
  if (last === -1) throw new Error(`the end of ${name} was not found in ${file}`);
  return lines.slice(first, last + 1).join('\n');
}

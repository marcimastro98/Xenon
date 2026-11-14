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
// The same goes for the object a function returns, when it was cut into part
// functions (`normalizeHubSettings` returns its parts called one after the other).
//
// The body of a route may live in a table in a module of its feature, with one
// call of the table left under the route's test (tools/restructure `branches`).
// The text handed out here has every body back under its test.
//
// What a factory remembers may have been gathered into one object in its body
// (tools/restructure `gather`: `let held` is `memory.held` now). The text handed
// out here has the `let`s and their names back, in the factory's file and in the
// modules made out of it afterwards.
//
// A function that asks for a module inside its body (`require('./net-guard')`) has the path spelled for
// its new folder (tools/restructure extract-inline.mjs). The text handed out here has the old spelling back.
//
// The lines of a block of a long function may stand in a function of a module of their own, with one call left
// where they stood (tools/restructure `block`). The text handed out here has the lines back in their place, and
// the module without them; asked for by its name, the new function is read as its module has it.
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyModuleText, undoBlockText } from '../../tools/restructure/block-text.mjs';
import { undoBranchesText } from '../../tools/restructure/branches-text.mjs';
import { undoGatherText } from '../../tools/restructure/gather-undo.mjs';
import { oldPathsText } from '../../tools/restructure/paths-undo.mjs';
import { dropReturnedPart, undoReturnedText } from '../../tools/restructure/returned-undo.mjs';
import { dropPart, undoSpreadText } from '../../tools/restructure/spread-undo.mjs';
import { undoStateText } from '../../tools/restructure/state-undo.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(REPO, 'tools', 'restructure', 'extracted.json');
const ENGINE = 'server/server.js';
const REQUIRE_CALL = /require\((['"])([^'"]+)\1\)/g;

// A test file asks for the same text once per test, and putting the engine back together reads the list and
// every module again each time (7 seconds a call at 370 modules). Nothing here changes while a test runs, so
// each file, the list and each rebuilt text is worked out once per process.
const kept = new Map();
const once = (key, make) => {
  if (!kept.has(key)) kept.set(key, make());
  return kept.get(key);
};

const readAsIs = (file) => once(`as it is: ${file}`, () => readFileSync(join(REPO, file), 'utf8'));
// A module of places next to the engine says SERVER_DIR where the old file said __dirname: the old word is put back.
// So does a module with a moved function that said __dirname (`home` in the list): its one line for the folder goes too.
const PATH_MODULES = new Set(ledgerOf(ENGINE).filter((entry) => entry.paths || entry.home).map((entry) => entry.file));
const SPREADS = readLedger().spreads?.[ENGINE] ?? [];
const PARTS = new Set(SPREADS.flatMap((spread) => spread.parts.map((part) => part.name)));
// A module whose moved code asks for files by path: the list has each new spelling with the old one.
const SPELLED = new Map(Object.values(readLedger().sources ?? {}).flat().filter((entry) => entry.spelled).map((entry) => [entry.file, entry.spelled]));
const oldPlaces = (file) => {
  const text = PATH_MODULES.has(file) ? oldPathsText(readAsIs(file)) : readAsIs(file);
  return SPELLED.has(file) ? oldSpellings(text, SPELLED.get(file)) : text;
};
// A module that holds the lines of a block, with the name of its function.
const BLOCKS = new Map(Object.values(readLedger().sources ?? {}).flat().filter((entry) => entry.block).map((entry) => [entry.file, entry.names[0]]));
const read = (file) => once(`put back: ${file}`, () => wholeObjects(file, bodiesBack(file, blocksBack(file, oldPlaces(file)))));

/**
 * @param {string} file repo-relative @param {string} text its text
 * @returns {string} a file with the lines of every block taken out of it back in their place, the last one taken out
 *   first; a module that holds such lines without them
 */
export function blocksBack(file, text) {
  if (BLOCKS.has(file)) return emptyModuleText(text, BLOCKS.get(file));
  return ledgerOf(file).filter((entry) => entry.block).reduceRight((out, entry) => {
    const undone = undoBlockText(out, readAsIs(entry.file), entry.names[0]);
    if (undone.problems.length) throw new Error(`${entry.file}: ${undone.problems.join('; ')}`);
    return undone.text;
  }, text);
}

/**
 * @param {string} text a module @param {Record<string, string>} spelled new spelling of a path to the old one
 * @returns {string} the text with every `require('<new>')` asking for the old spelling again, the module's own first lines included
 */
export function oldSpellings(text, spelled) {
  return text.replace(REQUIRE_CALL, (all, quote, spec) => (Object.hasOwn(spelled, spec) ? `require(${quote}${spelled[spec]}${quote})` : all));
}

/**
 * @param {string} file repo-relative @param {string} text its text
 * @returns {string} the text with the cut objects it declares in one piece again, and without the parts it declares
 */
export function wholeObjects(file, text) {
  let out = text;
  for (const spread of SPREADS) {
    const [undo, drop] = spread.returns ? [undoReturnedText, dropReturnedPart] : [undoSpreadText, dropPart];
    if (plainFileOf(spread.name) === file) out = undo(out, spread, (part) => readAsIs(plainFileOf(part)));
    for (const part of spread.parts) if (plainFileOf(part.name) === file) out = drop(out, part.name);
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
  return once('the list', () => {
    try {
      return JSON.parse(readFileSync(LEDGER, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  });
}

function ledgerOf(source) {
  return readLedger().sources?.[source] ?? [];
}

/**
 * @param {string} [source]
 * @returns {{ name: string, parts: { name: string, first: string }[], returns?: true }[]} the frozen objects of the file that were cut
 *   into parts: each part is a constant holding the keys from `first` on, spread into the object in order. One marked
 *   `returns` is a function instead: each part is a function returning the keys from `first` on, called in order
 */
export function cutObjects(source = ENGINE) {
  return readLedger().spreads?.[source] ?? [];
}

/**
 * @param {string} [source] repo-relative file code was taken out of
 * @returns {{ file: string, about: string, names: string[], spelled?: Record<string, string> }[]} the modules moved out of it unchanged, oldest first
 *   (`spelled`: the paths its code asks for, new spelling to old, when they were spelled for the new folder)
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
 * @param {string} [source]
 * @returns {{ factory: string, object: string, names: string[], kept: string[], bare: string[] }[]} what the factories of
 *   the file remember, gathered into one object each: the old names are the properties
 */
export function gatheredIn(source = ENGINE) {
  return readLedger().gathers?.[source] ?? [];
}

/**
 * Code with the names it had before the state rewrites, and before the gathers of the same file when they are given.
 * @param {string} text @param {{ state: any }[]} rewrites @param {ReturnType<typeof gatheredIn>} [gathered]
 */
export function oldNames(text, rewrites, gathered = []) {
  return gathered.reduce((out, record) => undoGatherText(out, record), rewrites.reduce((out, entry) => undoStateText(out, entry.state), text));
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
  return once(`whole: ${source}`, () => {
    const rewrites = stateRewrites(source);
    const gathered = gatheredIn(source);
    return [oldNames(read(source), rewrites, gathered),
      ...ledgerOf(source).map((entry) => (entry.state ? oldDeclarations(read(entry.file), entry) : oldNames(read(entry.file), rewrites, gathered)))].join('\n');
  });
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
  const text = PARTS.has(name) || BLOCKS.get(file) === name ? oldPlaces(file) : read(file);
  const lines = (holder ? oldDeclarations(text, holder) : oldNames(text, stateRewrites(source), gatheredIn(source))).split('\n');
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

/**
 * What a save of the whole settings does, as text: the route POST /settings from its test to the
 * next route, followed by the checks it runs between its read and its write (keepStoredOnSave, cut out
 * of the route by hand: the list names its module with "hand": true, and no recorded step redoes it).
 * @param {string} [source]
 * @returns {string}
 */
export function settingsSaveSource(source = ENGINE) {
  const engine = engineSource(source);
  const start = engine.indexOf("reqPath === '/settings' && req.method === 'POST'");
  if (start === -1) throw new Error('POST /settings is not where this reader looks');
  return `${engine.slice(start, engine.indexOf('} else if (reqPath', start + 200))}\n${declarationSource('keepStoredOnSave', source)}`;
}

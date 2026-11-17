// The dashboard's browser code as text, wherever it lives now.
// A big browser file is being taken apart (tools/restructure, `browser` commands):
// a script into smaller scripts that load right before it, a stylesheet into parts
// linked right after it. A test that reads the old file as text to find a function
// or a rule would lose it the day it moves. These readers follow the list of what
// was moved (tools/restructure/extracted-browser.json) and hand back the parts in
// the order the page loads them, so the same assertion keeps reading the same code.
// Statements that must run after their script (main.js and its data stream) go to a
// script that loads right after it, and are handed back after it.
//
// `readFileSync` here takes the place of the one from node:fs in a test: for a
// file that was never split it is the same call.
import fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(REPO, 'tools', 'restructure', 'extracted-browser.json');

let moves = null;
function recordedMoves() {
  if (moves) return moves;
  try {
    moves = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).moves ?? [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    moves = [];
  }
  return moves;
}

/**
 * @param {string} file repo-relative browser file, with forward slashes
 * @returns {string[]} the files it is made of today, in the order a page loads them (itself alone when it was never split)
 */
export function partsOf(file) {
  const mine = recordedMoves().filter((move) => move.from === file);
  const before = mine.filter((move) => move.kind === 'script' || move.kind === 'inner').map((move) => move.file);
  // Statements moved to a script that runs right after the file (`after`), then a stylesheet's parts.
  const after = mine.filter((move) => move.kind === 'after').map((move) => move.file);
  const parts = mine.filter((move) => move.kind === 'style').flatMap((move) => move.parts.map((part) => part.file));
  return [...before, file, ...after, ...parts];
}

const read = (file) => fs.readFileSync(join(REPO, file), 'utf8');

const PLACED = join(REPO, 'tools', 'restructure', 'browser-moved.json');

/**
 * What a scan of the root of server/js/ listed before any script moved: the scripts still loose
 * there and the ones moved whole to the folder of their feature (tools/restructure/browser-moved.json).
 * A test that walks every dashboard script lists them here, so a move takes nothing out of its sight.
 * @returns {string[]} names under server/js/, with forward slashes, sorted
 */
export function looseScripts() {
  const loose = fs.readdirSync(join(REPO, 'server', 'js')).filter((name) => name.endsWith('.js'));
  const placed = JSON.parse(read('tools/restructure/browser-moved.json')).moves.map((move) => move.to.slice('server/js/'.length));
  return [...loose, ...placed].sort();
}

/**
 * The text a page gets for one browser file: every script taken out of it and then
 * the script itself, or a stylesheet followed by its parts. For a stylesheet that
 * is the old file byte for byte.
 * A script made of statements that run after the file comes after it.
 * @param {string} file repo-relative, with forward slashes
 * @returns {string}
 */
export function browserSource(file) {
  return partsOf(file).map(read).join('');
}

/**
 * @param {string} name a top-level function, const, let or class
 * @param {string} file repo-relative script it was declared in before any move
 * @returns {string} repo-relative path of the script that declares it today
 */
export function fileDeclaring(name, file) {
  return recordedMoves().find((move) => move.kind === 'script' && move.from === file && move.names.includes(name))?.file ?? file;
}

// The path a test gave, as a repo-relative path with forward slashes; null for anything outside the repo.
function repoRelative(target) {
  let place = target;
  if (target instanceof URL) place = target.protocol === 'file:' ? fileURLToPath(target) : null;
  if (typeof place !== 'string') return null;
  const inside = relative(REPO, isAbsolute(place) ? place : resolve(place));
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split('\\').join('/') : null;
}

/**
 * `fs.readFileSync` for a test that reads browser code as text.
 * @param {string | URL | Buffer | number} target
 * @param {string | { encoding?: string | null, flag?: string }} [options]
 * @returns {string | Buffer}
 */
export function readFileSync(target, options) {
  const file = repoRelative(target);
  if (file === null || partsOf(file).length === 1) return fs.readFileSync(target, options);
  const whole = Buffer.concat(partsOf(file).map((part) => fs.readFileSync(join(REPO, part))));
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? whole.toString(encoding) : whole;
}

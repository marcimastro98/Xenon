// A Rust, C# or Swift file as text, with every file that was cut out of it.
// The native code is being split into smaller files (tools/restructure/native-cli.mjs).
// A test that reads monitor.rs to find a function would lose it the day it moves to
// monitor/pick.rs: these readers follow the list of what came out of what
// (tools/restructure/native-splits.json), so the same assertion keeps reading the
// same code. The parent comes first, then its parts in the order of the list.
import fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFileSync as readBrowserOrPlain } from './browser-source.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(REPO, 'tools', 'restructure', 'native-splits.json');

/** @returns {Record<string, string[]>} every split file and the files that came out of it */
export function nativeSplits() {
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8')).splits;
}

/**
 * @param {string} file repo-relative path with forward slashes, e.g. apps/native/src-tauri/src/monitor.rs
 * @returns {string[]} the file and the files cut out of it
 */
export function nativeFiles(file) {
  return [file, ...(nativeSplits()[file] ?? [])];
}

/**
 * @param {string} file repo-relative path with forward slashes
 * @returns {string} its text and the text of every file cut out of it, \n line ends
 */
export function nativeSource(file) {
  return nativeFiles(file).map((part) => fs.readFileSync(join(REPO, part), 'utf8').replace(/\r\n/g, '\n')).join('');
}

/** The repo-relative path of what a test asked to read, or null when it is not a path inside the repo. */
function repoRelative(target) {
  if (typeof target !== 'string' && !(target instanceof URL)) return null;
  if (target instanceof URL && target.protocol !== 'file:') return null;
  const inside = relative(REPO, target instanceof URL ? fileURLToPath(target) : resolve(target));
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : null;
}

/**
 * `fs.readFileSync` for a test that reads native code as text: a split file comes
 * back whole. Everything else is read as the browser reader does (which follows the
 * browser splits and reads any other file plainly).
 * @param {string | URL | Buffer | number} target
 * @param {string | { encoding?: string | null, flag?: string }} [options]
 * @returns {string | Buffer}
 */
export function readFileSync(target, options) {
  const file = repoRelative(target);
  if (file === null || nativeFiles(file).length === 1) return readBrowserOrPlain(target, options);
  const whole = Buffer.concat(nativeFiles(file).map((part) => fs.readFileSync(join(REPO, part))));
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? whole.toString(encoding) : whole;
}

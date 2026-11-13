// The engine's code as text, wherever it lives now.
// server.js is being taken apart into feature modules (tools/restructure). A test
// that reads server.js as text to find a function or a table would lose it the
// day it moves: these readers follow the list of what was moved
// (tools/restructure/extracted.json), so the same assertion keeps reading the
// same code.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(REPO, 'tools', 'restructure', 'extracted.json');
const ENGINE = 'server/server.js';

const read = (file) => readFileSync(join(REPO, file), 'utf8');

/**
 * @param {string} [source] repo-relative file code was taken out of
 * @returns {{ file: string, names: string[] }[]} the modules made out of it, oldest first
 */
export function extractedFrom(source = ENGINE) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return ledger.sources?.[source] ?? [];
}

/**
 * The file followed by every module taken out of it: the text a test read when
 * all of it was one file, plus the few `require` lines that now join the parts.
 * @param {string} [source]
 * @returns {string}
 */
export function engineSource(source = ENGINE) {
  return [read(source), ...extractedFrom(source).map((entry) => read(entry.file))].join('\n');
}

/**
 * @param {string} name a top-level function, const, let or class
 * @param {string} [source]
 * @returns {string} repo-relative path of the file that declares it today
 */
export function fileDeclaring(name, source = ENGINE) {
  return extractedFrom(source).find((entry) => entry.names.includes(name))?.file ?? source;
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
  const lines = read(file).split('\n');
  const escaped = name.replace(/[$]/g, '\\$&');
  const opening = new RegExp(`^(?:(?:async\\s+)?function\\*?\\s+${escaped}\\s*\\(|(?:const|let|var|class)\\s+${escaped}\\b)`);
  const first = lines.findIndex((line) => opening.test(line));
  if (first === -1) throw new Error(`${name} is not declared at the top level of ${file}`);
  const oneLine = /;\s*(?:\/\/.*)?$/.test(lines[first]) && !/[([{]\s*;?\s*$/.test(lines[first]);
  if (oneLine) return lines[first];
  // The closing line starts at the margin: a bracket, or the backtick of a text written over several lines.
  const last = lines.findIndex((line, index) => index > first && /^[)\]}`]+;?\s*(?:\/\/.*)?$/.test(line));
  if (last === -1) throw new Error(`the end of ${name} was not found in ${file}`);
  return lines.slice(first, last + 1).join('\n');
}

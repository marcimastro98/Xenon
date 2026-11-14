// The list of what was taken out of which browser file, in order
// (extracted-browser.json). `browser verify` redoes the moves from it, and
// server/test/browser-source.mjs uses it to hand a test the code of a split file.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BROWSER_LEDGER = 'tools/restructure/extracted-browser.json';
const NOTE = 'What tools/restructure took out of which browser file, in order. Written by `browser extract`, `browser split-css`, '
  + '`browser inline`, `browser module` and `browser inner`, read by `browser verify` and by server/test/browser-source.mjs. Do not edit by hand.';

/**
 * @param {string} root
 * @returns {{ note: string, moves: any[] }}
 *   `moves`: `{ kind: 'script', from, file, about, names }` (declarations to a script that loads right before),
 *   `{ kind: 'style', from, parts: [{ file, at }] }` (a stylesheet cut at lines, the parts linked right after)
 *   `{ kind: 'inline', from, file, about, nth }` (a script written inside a page, to a file)
 *   `{ kind: 'module', file, names }` (a classic script turned into an ES module; `names` are the top-level names it stopped sharing)
 *   `{ kind: 'unwrap', file }` (a module that lost the wrapper around its code)
 *   or `{ kind: 'inner', from, file, about, names, gives, name, takes? }` (functions out of a script's wrapper to a script that loads
 *   right before and leaves them on `window.<name>`; `gives` are the ones the old script takes back, `takes` the names the new script
 *   takes from the ones made of the same wrapper before it, by their name on window).
 */
export function readBrowserLedger(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, BROWSER_LEDGER), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { note: NOTE, moves: [] };
    throw error;
  }
}

/** @param {string} root @param {ReturnType<typeof readBrowserLedger>} ledger */
export function writeBrowserLedger(root, ledger) {
  const moves = ledger.moves.map((move) => `    ${JSON.stringify(move)}`).join(',\n');
  writeFileSync(path.join(root, BROWSER_LEDGER), `{\n  "note": ${JSON.stringify(NOTE)},\n  "moves": [\n${moves}\n  ]\n}\n`);
}

/**
 * The files one split file is made of today, in the order a page loads them.
 * A script's new files load before it (the ones made of its top-level declarations, or of functions of its wrapper),
 * a stylesheet's parts after it.
 * @param {{ moves: any[] }} ledger @param {string} file repo-relative
 * @returns {string[]} always ends (script) or starts (stylesheet) with `file` itself
 */
export function runOf(ledger, file) {
  const scripts = ledger.moves.filter((move) => (move.kind === 'script' || move.kind === 'inner') && move.from === file).map((move) => move.file);
  const parts = ledger.moves.filter((move) => move.kind === 'style' && move.from === file).flatMap((move) => move.parts.map((part) => part.file));
  return [...scripts, file, ...parts];
}

/** @param {{ moves: any[] }} ledger @param {string} file @returns {string[]} the scripts made of functions taken out of its wrapper, in load order */
export const innerFilesOf = (ledger, file) => ledger.moves.filter((move) => move.kind === 'inner' && move.from === file).map((move) => move.file);

/** @param {{ moves: any[] }} ledger @returns {string[]} every script or stylesheet something was taken out of */
export function splitFiles(ledger) {
  return [...new Set(ledger.moves.filter((move) => ['script', 'style', 'inner'].includes(move.kind)).map((move) => move.from))];
}

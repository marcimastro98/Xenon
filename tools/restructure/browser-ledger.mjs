// The list of what was taken out of which browser file, in order
// (extracted-browser.json). `browser verify` redoes the moves from it, and
// server/test/browser-source.mjs uses it to hand a test the code of a split file.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BROWSER_LEDGER = 'tools/restructure/extracted-browser.json';
const NOTE = 'What tools/restructure took out of which browser file, in order. Written by `browser extract`, `browser split-css`, '
  + '`browser inline`, `browser module`, `browser inner` and `browser state`, read by `browser verify` and by server/test/browser-source.mjs. Do not edit by hand.';
// The one line a person writes: an `inner` move with `hand: true`, for a script cut out of a wrapper by hand (see readBrowserLedger).

/**
 * @param {string} root
 * @returns {{ note: string, moves: any[] }}
 *   `moves`: `{ kind: 'script', from, file, about, names }` (declarations to a script that loads right before),
 *   `{ kind: 'style', from, parts: [{ file, at }] }` (a stylesheet cut at lines, the parts linked right after)
 *   `{ kind: 'inline', from, file, about, nth }` (a script written inside a page, to a file)
 *   `{ kind: 'module', file, names }` (a classic script turned into an ES module; `names` are the top-level names it stopped sharing)
 *   `{ kind: 'unwrap', file }` (a module that lost the wrapper around its code)
 *   `{ kind: 'lets', file, object, names, kept }` (lets of a script's wrapper turned into properties of one object in it; `kept` are the
 *   ones whose first value is still given where the `let` stood)
 *   or `{ kind: 'inner', from, file, about, names, gives, name, takes?, retakes?, hands? }` (functions out of a script's wrapper to a script that loads
 *   right before and leaves them on `window.<name>`; `gives` are the ones the old script takes back, `takes` the names the new script
 *   takes from the ones made of the same wrapper before it, by their name on window; `retakes: true` when the move also rewrote a line of the
 *   old script that took names from an earlier one, to the names it still uses: browser-inner-retakes.mjs; `hands` the names of the wrapper the
 *   new script is handed, when it is made in that form: browser-inner-handed.mjs; `hand: true` when a person cut the script and wrote the line:
 *   `browser verify` cannot redo such a move and does not try, the standing check reads the script like any other in the handed form, and only
 *   the rule that keeps a decision in its script is not asked of it, because a person judged that; `inside: '<function>'` on a hand cut whose
 *   lines stood in that function of the script and not in its wrapper: browser-inside.mjs writes it, browser-inside-proof.mjs is its standing check;
 *   `waits: ['<call>']` beside it names calls a person read and found to keep the function they are given for later, as a listener does).
 */
export function readBrowserLedger(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, BROWSER_LEDGER), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { note: NOTE, moves: [] };
    throw error;
  }
}

/**
 * The list as a commit has it: what a recording of the tree at that commit is compared with, whatever the checkout holds today.
 * @param {string} root @param {string} rev
 * @returns {{ note?: string, moves: any[] }} no moves when the commit has no list yet
 */
export function ledgerAt(root, rev) {
  const run = spawnSync('git', ['show', `${rev}:${BROWSER_LEDGER}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return run.status === 0 ? JSON.parse(run.stdout) : { moves: [] };
}

const WHOLE_MOVES = 'tools/restructure/browser-moved.json';
/** @param {string} root @param {string} [rev] @returns {{from: string, to: string}[]} the scripts moved whole, as a commit or the checkout lists them */
export function wholeMoves(root, rev) {
  if (rev) {
    const run = spawnSync('git', ['show', `${rev}:${WHOLE_MOVES}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return run.status === 0 ? JSON.parse(run.stdout).moves : [];
  }
  try { return JSON.parse(readFileSync(path.join(root, WHOLE_MOVES), 'utf8')).moves; } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * Writes into a recording of the pages the moves of the tree it shows: the commit's when the copy was laid as at one, the checkout's otherwise.
 * @param {number} code how the recording ended @param {string} root @param {string | undefined} rev @param {string} outFile
 * @returns {number} `code`, the recording left alone when it is not 0
 */
export function keepMoves(code, root, rev, outFile) {
  if (code !== 0) return code;
  const { moves } = rev ? ledgerAt(root, rev) : readBrowserLedger(root);
  // `placed`: the scripts moved whole to another folder (browser-move.mjs), whose address changed with their place.
  const placed = wholeMoves(root, rev);
  writeFileSync(outFile, `${JSON.stringify({ ...JSON.parse(readFileSync(outFile, 'utf8')), moves, placed }, null, 1)}
`);
  return code;
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

/**
 * @param {{ moves: any[] }} ledger @param {string} file
 * @returns {{ file: string, hand: boolean, inside: string | null, name: string, waits: string[] }[]} the same scripts, each with whether a person cut it, the
 *   function it was cut out of when it is not the wrapper (browser-inside.mjs), and its name on window
 */
export const innerPartsOf = (ledger, file) => ledger.moves.filter((move) => move.kind === 'inner' && move.from === file)
  .map((move) => ({ file: move.file, hand: move.hand === true, inside: move.inside ?? null, name: move.name, waits: move.waits ?? [] }));

/** @param {{ moves: any[] }} ledger @returns {string[]} every script or stylesheet something was taken out of */
export function splitFiles(ledger) {
  return [...new Set(ledger.moves.filter((move) => ['script', 'style', 'inner'].includes(move.kind)).map((move) => move.from))];
}

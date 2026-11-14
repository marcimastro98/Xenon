// The two words of a body that mean the folder its file sits in, and how they are
// written when the body lands in a module of another folder (the text forms are in
// branches-text.mjs, which also writes them back for the tests that read the engine
// as text):
//
//   __dirname             ->  SERVER_DIR, which the table works out once on a line of
//                             its own (`const SERVER_DIR = path.join(__dirname, '..');`)
//   require('./js/x.js')  ->  require('../js/x.js'): the same file, asked from the new
//                             folder. A built-in or a package is asked the same way
//                             from anywhere and stays as written.
//
// Nothing else in a line changes. Only the plain forms are taken: `__dirname` read as
// a value (not `{ __dirname }`, which would name a property after the new word) and
// `require('<text>')` written exactly so. Every other use of either word, and every
// other word that means the file (`module`, `exports`, `__filename`), still keeps a
// body where it is. Reading only; the plan writes, the proof reads again.

import vm from 'node:vm';

import { HOME_LINE, movedSpec, oldSpec } from './branches-text.mjs';
import { HOME, OLD_HOME } from './paths-undo.mjs';
import { homeLine, INSTALLS } from './paths.mjs';

export const PLACE_WORDS = new Set([OLD_HOME, 'require']);
const isRelative = (spec) => spec.startsWith('./') || spec.startsWith('../');

/**
 * @param {any[]} nodes every identifier of a body that stands for `__dirname` or `require` of its file (scope-uses.mjs `seen`)
 * @param {{ K: any }} parser @param {(node: any) => string} textOf the text of a node @param {any} sourceFile
 * @returns {{ homes: { start: number, end: number }[], loads: { start: number, end: number, spec: string }[], reasons: string[] }}
 *   where `__dirname` stands, where the text of each required path stands (between its quotes), and what cannot be respelled
 */
export function placeUses(nodes, { K }, textOf, sourceFile) {
  const homes = [];
  const loads = [];
  const reasons = new Set();
  for (const node of nodes) {
    const parent = node.parent;
    if (node.text === OLD_HOME) {
      if (parent?.kind === K.ShorthandPropertyAssignment) reasons.add(`it writes \`{ ${OLD_HOME} }\`, which would name the property after another word`);
      else homes.push({ start: node.getStart(sourceFile), end: node.end });
      continue;
    }
    const asked = parent?.kind === K.CallExpression && parent.expression === node && parent.arguments.length === 1 ? parent.arguments[0] : null;
    if (asked?.kind !== K.StringLiteral || textOf(parent) !== `require('${asked.text}')`) {
      reasons.add("it uses `require` otherwise than as require('<one plain text>')");
      continue;
    }
    if (isRelative(asked.text)) loads.push({ start: asked.getStart(sourceFile) + 1, end: asked.end - 1, spec: asked.text });
    else if (asked.text.startsWith('.')) reasons.add(`it requires '${asked.text}', which is not a path written with ./ or ../`);
  }
  return { homes, loads, reasons: [...reasons] };
}

/**
 * The lines of a body as its table holds them.
 * @param {object} job
 * @param {string} job.text the file @param {number} job.from offset of the body's first line @param {number} job.to offset past its last
 * @param {{ homes: { start: number, end: number }[], loads: { start: number, end: number, spec: string }[] }} job.place from placeUses
 * @param {string} job.spec the path the file requires the table with
 * @returns {{ lines: string[], reasons: string[] }} `reasons`: a required path that cannot be written back exactly
 */
export function placedLines({ text, from, to, place, spec }) {
  const reasons = [];
  const edits = place.homes.map((home) => ({ ...home, text: HOME }));
  for (const load of place.loads) {
    const moved = movedSpec(load.spec, spec);
    if (oldSpec(moved, spec) !== load.spec) reasons.push(`require('${load.spec}') is not written the plain way: asked from the new folder it could not be written back the same`);
    edits.push({ start: load.start, end: load.end, text: moved });
  }
  let out = '';
  let at = from;
  for (const edit of edits.sort((a, b) => a.start - b.start)) { out += text.slice(at, edit.start) + edit.text; at = edit.end; }
  return { lines: (out + text.slice(at, to)).split('\n'), reasons };
}

/**
 * The line of a table that works out the folder its bodies came from, checked apart from the code that writes it.
 * @param {string} source repo-relative file the bodies left @param {string} target repo-relative table
 * @returns {string | null} what is wrong; null when the line gives the old folder on every kind of system
 */
export function homeProblem(source, target) {
  if (homeLine(source, target) !== HOME_LINE) return `${target} is not one folder below ${source}: its home line would not be the one a table carries`;
  const made = HOME_LINE.slice(`const ${HOME} = `.length, -1);
  for (const [impl, folder] of INSTALLS) {
    const value = String(vm.runInNewContext(`(${made})`, { path: impl, [OLD_HOME]: impl.join(folder, 'part') }, { timeout: 1000 }));
    if (value !== folder) return `${HOME} would be ${value} where ${OLD_HOME} was ${folder}`;
  }
  return null;
}

/**
 * Old body against new, word by word: the same number of each, and every required path leads to the same file.
 * @param {ReturnType<typeof placeUses>} was of the body in the old file @param {ReturnType<typeof placeUses>} is of its function in the table
 * @param {{ source: string, target: string, idOf: (spec: string, from: string) => string }} where
 * @returns {string[]} problems
 */
export function placeProblems(was, is, { source, target, idOf }) {
  const problems = [...was.reasons, ...is.reasons];
  if (is.homes.length) problems.push(`its function still says ${OLD_HOME}, which is another folder there`);
  if (was.loads.length !== is.loads.length) return [...problems, `it required ${was.loads.length} paths and now requires ${is.loads.length}`];
  for (const [index, old] of was.loads.entries()) {
    let ids;
    try { ids = [idOf(old.spec, source), idOf(is.loads[index].spec, target)]; } catch (error) { problems.push(error.message); continue; }
    if (ids[0] !== ids[1]) problems.push(`require('${old.spec}') was ${ids[0]} and require('${is.loads[index].spec}') in ${target} is ${ids[1]}`);
  }
  return problems;
}

// A function that says `__dirname` (`path.join(__dirname, 'ffmpeg.exe')`) is tied to its file by that one word: in
// a module one folder down it would mean the folder of that module. It can move like any other when the new module
// works out the old folder once (`const SERVER_DIR = path.join(__dirname, '..');`, the line paths.mjs writes) and
// the moved lines say SERVER_DIR where they said __dirname. That word is all that changes in a moved line.
//
// Read here: which declarations are of that kind (for analyze.mjs) and the changed lines (for extract-plan.mjs).
// The proof is in extract-home-proof.mjs, written apart.

import path from 'node:path';

import { HOME, OLD_HOME, homeWord } from './paths-undo.mjs';

const REQUIRES_PATH = /^const path = require\((['"])(?:node:)?path\1\);$/;

/** @typedef {{ line: number, column: number }} HomeUse the 0-based place in the file of one `__dirname` */

/** The same line paths.mjs gives a module of places (a test holds the two together). */
export function homeLine(source, target) {
  const ups = path.posix.relative(path.posix.dirname(target), path.posix.dirname(source)).split('/');
  return `const ${HOME} = path.join(${OLD_HOME}, ${ups.map((part) => `'${part}'`).join(', ')});`;
}

/**
 * @param {any} record a top-level statement from top-level.mjs, with `fileBound` set
 * @param {any} node its node
 * @param {{ sourceFile: any, K: any }} file
 * @returns {{ list: HomeUse[] | null, why: string }} every `__dirname` in it, when that word inside a function is all
 *   that ties it to its file; otherwise null and the reason ('' when it is tied by something else altogether)
 */
export function readHomeUses(record, node, { sourceFile, K }) {
  if (record.kind === 'require' || record.fileBound.length !== 1 || record.fileBound[0] !== OLD_HOME) return { list: null, why: '' };
  if (record.uses.get(OLD_HOME)?.eager) return { list: null, why: `it reads ${OLD_HOME} while the file loads, not inside a function` };
  if (homeWord().test(node.getText(sourceFile))) return { list: null, why: `it already says ${HOME}, the word ${OLD_HOME} would become` };
  const list = [];
  const visit = (at, parent) => {
    if (at.kind === K.Identifier && at.text === OLD_HOME) {
      // `x.__dirname` and `{ __dirname: 1 }` name a property, not the folder.
      const isProperty = parent && ((parent.kind === K.PropertyAccessExpression && parent.name === at)
        || (parent.kind === K.PropertyAssignment && parent.name === at));
      if (!isProperty) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(at.getStart(sourceFile));
        list.push({ line, column: character });
      }
    }
    at.forEachChild((child) => visit(child, at));
  };
  visit(node, null);
  return { list, why: '' };
}

/**
 * @param {any[]} moved the records that move, each with `homeUses` from the analysis
 * @param {{ source: string, target: string, requireLines: string[] }} job `requireLines`: the first lines of the new module
 * @returns {{ uses: (HomeUse & { record: any })[], line: string | null, reasons: string[] }} every `__dirname` that moves,
 *   the line that works out the old folder (null when none moves), and why the set cannot move
 */
export function homeFor(moved, { source, target, requireLines }) {
  const uses = moved.flatMap((record) => (record.homeUses ?? []).map((use) => ({ record, ...use })));
  if (uses.length === 0) return { uses, line: null, reasons: [] };
  const reasons = [];
  if (path.posix.dirname(target) === path.posix.dirname(source)) reasons.push(`${target} is in the folder of ${source}: ${OLD_HOME} means the same there, nothing is respelled`);
  if (!requireLines.some((line) => REQUIRES_PATH.test(line))) {
    reasons.push(`the moved code says ${OLD_HOME} and does not use \`path\`, which the line that works out the old folder needs: move it with code that does`);
  }
  return { uses, line: homeLine(source, target), reasons };
}

/**
 * Writes the new word into the lines of the new module.
 * @param {string[]} body the lines of the new module, changed in place
 * @param {ReturnType<typeof homeFor>['uses']} uses
 * @param {(record: any) => number} moduleLineOf 0-based line of the new module where the record's first line stands
 * @returns {{ at: number, first: number, column: number }[]} what changed, by line of the new module (`at`) and then
 *   by column: `first` and `column` are the place of the word in the old file
 */
export function writeHome(body, uses, moduleLineOf) {
  const rows = uses.map(({ record, line, column }) => ({ at: moduleLineOf(record) + line - (record.range[0] - 1), first: line, column }));
  // From the right, so the columns to the left of each stay the ones of the old line.
  for (const row of [...rows].sort((a, b) => b.at - a.at || b.column - a.column)) {
    const line = body[row.at];
    body[row.at] = `${line.slice(0, row.column)}${HOME}${line.slice(row.column + OLD_HOME.length)}`;
  }
  return rows.sort((a, b) => a.at - b.at || a.column - b.column);
}

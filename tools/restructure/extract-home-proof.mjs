// The proof for a moved function that said `__dirname`: the new module says SERVER_DIR there, and works that
// folder out in one line of its own. Written apart from the planner (extract-home.mjs): it reads the lines as
// text, and works the line out for a made-up install on each kind of system.

import path from 'node:path';

import { HOME, OLD_HOME, homeWord } from './paths-undo.mjs';

/** @typedef {{ at: number, first: number, column: number }} HomeRow */

const OLD_WORD = new RegExp(String.raw`(?<![\w$.])${OLD_HOME}(?![\w$])`, 'g');
const HOME_LINE = new RegExp(String.raw`^const ${HOME} = path\.join\(${OLD_HOME}((?:, '[^'\\]*')+)\);$`);
const REQUIRES_PATH = /^const path = require\((['"])(?:node:)?path\1\);$/;
// Nothing is read from disk: the folders are compared as text, with both kinds of path.
const INSTALLS = [[path.win32, 'C:\\app'], [path.posix, '/opt/app']];
const wordAt = (line, column, word) => line.slice(column, column + word.length) === word
  && !/[\w$.]/.test(line[column - 1] ?? '') && !/[\w$]/.test(line[column + word.length] ?? '');

/**
 * @param {string} written the new module as the tool writes it (or with the paths of its requires already put back)
 * @param {HomeRow[]} rows
 * @returns {{ text: string, problems: string[] }} the module with `__dirname` back in every moved line, to be checked
 *   as a move of unchanged text; a problem for each word that is not where the plan says
 */
export function plainHome(written, rows) {
  if (rows.length === 0) return { text: written, problems: [] };
  const made = written.split('\n');
  const problems = [];
  // From the left: once one is back, the columns to its right are those of the old line again.
  for (const row of [...rows].sort((a, b) => a.at - b.at || a.column - b.column)) {
    const line = made[row.at];
    if (line === undefined || !wordAt(line, row.column, HOME)) {
      problems.push(`line ${row.at + 1} of the new module does not say ${HOME} where the plan says it stands for ${OLD_HOME}`);
      continue;
    }
    made[row.at] = `${line.slice(0, row.column)}${OLD_HOME}${line.slice(row.column + HOME.length)}`;
  }
  return { text: made.join('\n'), problems };
}

/**
 * @param {object} move
 * @param {string} move.before the old file before
 * @param {string} move.written the new module as the tool writes it
 * @param {{ ranges: number[][], glue: { moduleLines: number[], home?: HomeRow[] } }} move.plan
 * @param {{ source: string, target: string }} [move.paths] the two repo-relative files
 * @returns {string[]} problems: a `__dirname` in a moved line the plan does not respell, a respelled word that was not
 *   `__dirname` in a moved line, a moved line that said SERVER_DIR already, or a new module whose one line for the old
 *   folder is missing, written twice, without `path`, or does not lead to the folder of the old file
 */
export function homeProblems({ before, written, plan, paths }) {
  const rows = plan.glue.home ?? [];
  if (rows.length === 0) return [];
  if (!paths) return [`the plan respells ${OLD_HOME}, and the proof was not told where the two files are`];
  const { source, target } = paths;
  const problems = [];
  const old = before.split('\n');
  const told = new Map(rows.map((row) => [`${row.first}:${row.column}`, row]));
  if (told.size !== rows.length) problems.push(`the plan respells the same ${OLD_HOME} twice`);
  const seen = new Set();
  for (const [start, end] of plan.ranges) {
    for (let index = start - 1; index < end; index += 1) {
      const line = old[index] ?? '';
      if (homeWord().test(line)) problems.push(`line ${index + 1} says ${HOME} already: it could not be told from a respelled ${OLD_HOME} afterwards`);
      // A comment that shows the word is text, not the folder.
      if (/^\s*(?:\/\/|\*)/.test(line)) continue;
      for (const match of line.matchAll(OLD_WORD)) {
        const key = `${index}:${match.index}`;
        if (told.has(key)) seen.add(key);
        else problems.push(`line ${index + 1}: ${OLD_HOME} moves as it is, and means another folder in ${target}`);
      }
    }
  }
  for (const [key, row] of told) if (!seen.has(key)) problems.push(`line ${row.first + 1}: the plan respells a ${OLD_HOME} that is not in a moved line there`);

  const made = written.split('\n');
  const glue = plan.glue.moduleLines.map((index) => made[index] ?? '');
  const lines = made.filter((line) => line.startsWith(`const ${HOME} `));
  const parts = HOME_LINE.exec(lines[0] ?? '');
  if (lines.length !== 1 || !parts || !glue.includes(lines[0])) {
    problems.push(`${target} does not work out the old folder in one line of its own (const ${HOME} = path.join(${OLD_HOME}, '..');)`);
    return problems;
  }
  if (!glue.some((line) => REQUIRES_PATH.test(line))) problems.push(`${target} works out the old folder with \`path\` and does not require it`);
  const ups = [...parts[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  for (const [kind, install] of INSTALLS) {
    const folderOf = (file) => kind.join(install, ...path.posix.dirname(file).split('/'));
    if (kind.join(folderOf(target), ...ups) !== folderOf(source)) {
      problems.push(`${lines[0]} in ${target} is not the folder of ${source}`);
      break;
    }
  }
  return problems;
}

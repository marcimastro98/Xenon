// When moved code was the last user of a required name, the old file stops asking
// for that name: left there it would be an unused variable. The module itself is
// still required at the same place, so the load order stays what it was. Only a
// module this tool made, or one built into Node, loses its whole line: nothing
// of the app runs when those load. A comment after the require, on the same
// line, says what the module is for and is never lost: such a line always
// stays, with its comment as it was.

import { wrapNames } from './module-requires.mjs';

/**
 * @param {object} job
 * @param {string} job.text the old file
 * @param {number[]} job.starts offset of every line (top-level.mjs lineStarts)
 * @param {any} job.record a `require` statement of the file
 * @param {Set<string>} job.orphaned required names nothing in the file uses after the move
 * @param {boolean} job.ownModule the statement requires a module made by an earlier extraction
 * @param {boolean} job.builtin the statement requires a module built into Node
 * @returns {{ first: number, count: number, newLines: string[] } | null} which lines of the old
 *   file (0-based `first`) become `newLines`; null when the statement stays as it is
 */
export function requireEdit({ text, starts, record, orphaned, ownModule, builtin }) {
  const { bindings, head } = record.require;
  const dead = bindings.map((binding) => orphaned.has(binding.local));
  if (!dead.includes(true)) return null;
  const whole = dead.every(Boolean);
  const first = record.line[0] - 1;
  const last = record.line[1] - 1;
  const end = last + 1 < starts.length ? starts[last + 1] - 1 : text.length;
  const commented = TRAILING_COMMENT.test(text.slice(starts[last], end));
  if (whole && (ownModule || builtin) && !commented) return { first: record.range[0] - 1, count: record.range[1] - record.range[0] + 1, newLines: [] };

  if (ownModule && !whole) {
    // The tool wrote this line itself: write it again with the names that are left.
    const left = bindings.filter((_binding, i) => !dead[i]).map((binding) => binding.text);
    return { first, count: last - first + 1, newLines: wrapNames(left, 'const {', `} = ${text.slice(head[1], end)}`) };
  }
  const cuts = [];
  if (whole) cuts.push(head); // `const { a } = require('x');` becomes `require('x');`
  else {
    // A run of dead names goes with the comma that follows it, or, at the end of the list, the one before.
    for (let i = 0; i < dead.length; i += 1) {
      if (!dead[i]) continue;
      let j = i;
      while (j + 1 < dead.length && dead[j + 1]) j += 1;
      cuts.push(j + 1 < dead.length ? [bindings[i].span[0], bindings[j + 1].span[0]] : [bindings[i - 1].span[1], bindings[j].span[1]]);
      i = j;
    }
  }
  let out = '';
  let at = starts[first];
  for (const [from, to] of cuts) { out += text.slice(at, from); at = to; }
  out += text.slice(at, end);
  return { first, count: last - first + 1, newLines: out.split('\n') };
}

// The comment, when there is one, can only start after the whole require: nothing before it is free text.
const REQUIRE_SHAPE = /^const\s+(\{[^}]*\}|[\w$]+)\s*=\s*(require\(\s*(['"])([^'"]+)\3\s*\)(?:\.[\w$]+)?;?)(\s*\/\/.*)?$/;
const BARE_SHAPE = /^(require\(\s*(['"])([^'"]+)\2\s*\)(?:\.[\w$]+)?;?)(\s*\/\/.*)?$/;
const TRAILING_COMMENT = /\)(?:\.[\w$]+)?;?\s*\/\/.*$/;
const isCode = (line) => line.trim() !== '' && !/^\s*\/\//.test(line);
const codeOf = (lines) => lines.filter(isCode).join('\n').trim();
const namesOf = (pattern) => pattern.replace(/^\{|\}$/g, '').split(',').map((name) => name.trim()).filter(Boolean);

/**
 * The check of such an edit, written apart from the code that makes it: the lines
 * were one plain require, and what is left is the same require with fewer names.
 * A comment after the old require stands after the new one, byte for byte.
 * @param {string[]} oldLines @param {string[]} newLines
 * @param {string} moduleText the new module, which must require a dropped module itself
 * @returns {string | null} what is wrong, or null
 */
export function requireEditProblem(oldLines, newLines, moduleText) {
  const was = REQUIRE_SHAPE.exec(codeOf(oldLines));
  if (!was) return `a changed line outside the moved code is not a plain require: ${JSON.stringify(codeOf(oldLines).slice(0, 80))}`;
  const now = codeOf(newLines);
  if (was[5] !== undefined) {
    // From `require(` to the end of its line, the old text and the new are the same bytes.
    const oldLast = oldLines.findLast(isCode);
    const tail = oldLast.slice(oldLast.indexOf('require('));
    const newLast = newLines.findLast(isCode);
    if (newLast === undefined) return `the comment after require('${was[4]}') was lost with its line`;
    if (!newLast.endsWith(tail)) return `the comment after require('${was[4]}') changed: ${JSON.stringify(newLast.slice(0, 80))}`;
  }
  if (now === '') {
    const name = was[4].slice(was[4].lastIndexOf('/') + 1).replace(/^node:|\.js$/g, '');
    const asked = moduleText.split('\n').some((line) => new RegExp(`require\\('(?:[^']*[/:])?${name}(?:\\.js)?'\\)`).test(line));
    return asked ? null : `require('${was[4]}') was dropped but the new module does not require it`;
  }
  const bare = BARE_SHAPE.exec(now);
  if (bare && bare[1] === was[2] && bare[4] === was[5]) return null;
  const left = REQUIRE_SHAPE.exec(now);
  if (!left || left[2] !== was[2] || left[5] !== was[5]) return `require('${was[4]}') was changed into something else: ${JSON.stringify(now.slice(0, 80))}`;
  const had = new Set(namesOf(was[1]));
  const added = namesOf(left[1]).filter((name) => !had.has(name));
  return added.length ? `require('${was[4]}') gained ${added.join(', ')}` : null;
}

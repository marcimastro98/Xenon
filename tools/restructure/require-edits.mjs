// When moved code was the last user of a required name, the old file stops asking
// for that name: left there it would be an unused variable. The module itself is
// still required at the same place, so the load order stays what it was. Only a
// module this tool made, or one built into Node, loses its whole line: nothing
// of the app runs when those load. A comment after the require, on the same
// line, says what the module is for and is never lost: such a line always
// stays, with its comment as it was. Requires written on one line are edited
// together and keep their line: each loses its names where it stands, and one
// that loses all of them stays as a bare `require('x');`.

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
  return { first, count: last - first + 1, newLines: without(text, starts[first], end, cutsOf(record, orphaned)).split('\n') };
}

// The stretches of the text a require loses with its dead names, in order.
function cutsOf(record, orphaned) {
  const { bindings, head } = record.require;
  const dead = bindings.map((binding) => orphaned.has(binding.local));
  if (!dead.includes(true)) return [];
  if (dead.every(Boolean)) return [head]; // `const { a } = require('x');` becomes `require('x');`
  const cuts = [];
  // A run of dead names goes with the comma that follows it, or, at the end of the list, the one before.
  for (let i = 0; i < dead.length; i += 1) {
    if (!dead[i]) continue;
    let j = i;
    while (j + 1 < dead.length && dead[j + 1]) j += 1;
    cuts.push(j + 1 < dead.length ? [bindings[i].span[0], bindings[j + 1].span[0]] : [bindings[i - 1].span[1], bindings[j].span[1]]);
    i = j;
  }
  return cuts;
}

function without(text, from, end, cuts) {
  let out = '';
  let at = from;
  for (const [start, stop] of cuts) { out += text.slice(at, start); at = stop; }
  return out + text.slice(at, end);
}

/**
 * The same for every require of a file that may lose a name. Statements that share a line are edited together.
 * @param {object} job
 * @param {string} job.text the old file @param {number[]} job.starts offset of every line
 * @param {{ record: any, ownModule: boolean, builtin: boolean }[]} job.requires the statements, each with what it requires
 * @param {Set<string>} job.orphaned required names nothing in the file uses after the move
 * @returns {{ first: number, count: number, newLines: string[] }[]} the edits, top to bottom; no two touch the same line
 */
export function requireEdits({ text, starts, requires, orphaned }) {
  const lines = new Map();
  for (const entry of requires) lines.set(entry.record.line[0], [...(lines.get(entry.record.line[0]) ?? []), entry]);
  const edits = [];
  for (const group of lines.values()) {
    if (group.length === 1 && !group[0].record.sharesLine) {
      const edit = requireEdit({ text, starts, orphaned, ...group[0] });
      if (edit) edits.push(edit);
      continue;
    }
    const cuts = group.flatMap((entry) => cutsOf(entry.record, orphaned)).sort((a, b) => a[0] - b[0]);
    if (cuts.length === 0) continue;
    const first = group[0].record.line[0] - 1;
    const last = Math.max(...group.map((entry) => entry.record.line[1])) - 1;
    const end = last + 1 < starts.length ? starts[last + 1] - 1 : text.length;
    edits.push({ first, count: last - first + 1, newLines: without(text, starts[first], end, cuts).split('\n') });
  }
  return edits.sort((a, b) => a.first - b.first);
}

// The comment, when there is one, can only start after the whole require: nothing before it is free text.
const REQUIRE_SHAPE = /^const\s+(\{[^}]*\}|[\w$]+)\s*=\s*(require\(\s*(['"])([^'"]+)\3\s*\)(?:\.[\w$]+)?;?)(\s*\/\/.*)?$/;
const BARE_SHAPE = /^(require\(\s*(['"])([^'"]+)\2\s*\)(?:\.[\w$]+)?;?)(\s*\/\/.*)?$/;
const TRAILING_COMMENT = /\)(?:\.[\w$]+)?;?\s*\/\/.*$/;
// One require as a statement of a line that holds several: it ends with its `;`.
const ONE_OF_SEVERAL = /(?:const\s+(?:\{[^}]*\}|[\w$]+)\s*=\s*)?require\(\s*(['"])[^'"]+\1\s*\)(?:\.[\w$]+)?;/y;
const isCode = (line) => line.trim() !== '' && !/^\s*\/\//.test(line);

// The requires of a line that is two or more of them and nothing else, in order; a comment after the last goes with it.
function severalOf(code) {
  const parts = [];
  let at = 0;
  for (;;) {
    ONE_OF_SEVERAL.lastIndex = at;
    const found = ONE_OF_SEVERAL.exec(code);
    if (!found) break;
    parts.push(found[0]);
    at = ONE_OF_SEVERAL.lastIndex;
    const gap = /^[ \t]+(?=\S)/.exec(code.slice(at));
    if (gap && !code.startsWith('//', at + gap[0].length)) at += gap[0].length;
  }
  const rest = code.slice(at);
  if (parts.length < 2 || (rest !== '' && !/^\s*\/\/.*$/.test(rest))) return null;
  return [...parts.slice(0, -1), parts.at(-1) + rest];
}
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
  // A line with several requires: each statement on it is checked as if it stood alone, and none comes or goes.
  const [parts, kept] = [severalOf(codeOf(oldLines)), severalOf(codeOf(newLines))];
  if (parts) {
    if (kept?.length !== parts.length) return `a line with ${parts.length} requires did not keep one statement for each: ${JSON.stringify(codeOf(newLines).slice(0, 80))}`;
    return parts.map((part, index) => (part === kept[index] ? null : requireEditProblem([part], [kept[index]], moduleText))).find(Boolean) ?? null;
  }
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

// Puts back the names a factory's variables had before `gather` made them
// properties of one object declared in the factory's body. The proof of a
// gather uses the first half (names), the tests that read engine code as text
// use both: they keep asking for the `let`s the code had when they were written.
//
// Nothing here knows where the rewrite happened: it looks for `object.name` as
// text. That is exact because `gather` refuses a file that already has the
// object's name as a word, and a statement of the factory's body that starts a
// line by assigning a variable it leaves in place. One thing does not come back
// as it was written: `name: name` comes back the short way, `{ name }`, which
// means the same. The proof (gather-proof.mjs) has the plan and puts it back exactly.

import { statePattern } from './state-undo.mjs';

const escaped = (text) => text.replace(/[$]/g, '\\$&');

// What follows a `{ name }` that was written out: a comma, the closing brace, or the first value of a pattern.
// `name: object.name ? a : b` is followed by something else: there the property was always written out, and
// only `object.name` is the rewrite.
export const AFTER_SHORT = '(?=\\s*(?:[,}]|=(?![=>])))';

/** @param {string} object @param {string} name @returns {RegExp} every `name: object.name`, written for a `{ name }` */
export function shorthandPattern(object, name) {
  return new RegExp(`(?<![\\w$.])${escaped(name)}: ${escaped(object)}\\.${escaped(name)}(?![\\w$])${AFTER_SHORT}`, 'g');
}

/** @param {string} object @param {string} name @returns {RegExp} a line of the factory's body that starts by assigning `object.name` */
export function keptLine(object, name) {
  return new RegExp(`^( {2})${escaped(object)}\\.${escaped(name)}(?=\\s*=(?![=>]))`, 'gm');
}

/** @param {string} name @returns {RegExp} a line of a factory's body that starts by assigning `name` */
export function bodyAssignment(name) {
  return new RegExp(`^ {2}${escaped(name)}(?=\\s*=(?![=>]))`, 'm');
}

/**
 * @param {string} text code after a gather: the factory's file, or a module made out of it later
 * @param {{ object: string, names: string[], kept: string[] }} gathered the variables, and the ones whose first value is
 *   still given on the line where the `let` stood
 * @returns {string} the same code with the old names, and `let` back in front of the kept first values
 */
export function undoGatherNames(text, { object, names, kept }) {
  let out = text;
  for (const name of kept) out = out.replace(keptLine(object, name), (_all, indent) => `${indent}let ${name}`);
  for (const name of names) out = out.replace(shorthandPattern(object, name), () => name).replace(statePattern(object, name), () => name);
  return out;
}

/**
 * The same, and the object itself read back as the `let`s it replaced, where it stands. A `let` that stood further
 * down is not put back on its old line: for that, the proof has the plan (gather-proof.mjs).
 * @param {string} text @param {{ object: string, names: string[], kept: string[], bare: string[] }} gathered
 * @returns {string}
 */
export function undoGatherText(text, gathered) {
  const lines = text.split('\n');
  const open = lines.indexOf(`  const ${gathered.object} = {`);
  const close = open === -1 ? -1 : lines.indexOf('  };', open + 1);
  if (close !== -1) {
    const rows = lines.slice(open + 1, close).flatMap((row) => {
      const value = /^ {4}([A-Za-z_$][\w$]*): (.*),(\s*(?:\/\/.*)?)$/.exec(row);
      if (!value || !gathered.names.includes(value[1])) return [row.replace(/^ {2}/, '')];
      if (gathered.kept.includes(value[1])) return [];
      return [gathered.bare.includes(value[1]) ? `  let ${value[1]};${value[3]}` : `  let ${value[1]} = ${value[2]};${value[3]}`];
    });
    lines.splice(open, close - open + 1, ...rows);
  }
  return undoGatherNames(lines.join('\n'), gathered);
}

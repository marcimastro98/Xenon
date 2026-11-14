// A script made of code taken out of a wrapper may use what an earlier script of the
// same wrapper holds. It begins by taking those names, on the line the old script
// takes them back with:
//
//   js/leaf/sizes.js, made before            js/leaf/labels.js, made now
//     (() => {                                 (() => {
//       const LIMIT = 3;                         const { LIMIT } = window.LeafSizes;
//       window.LeafSizes = { LIMIT };
//     })();                                      function label(n) { return n > LIMIT ? '' : String(n); }
//                                                window.LeafLabels = { label };
//                                              })();
//
// The earlier script loads first: the scripts of one wrapper stand in the pages in the
// order they were made (browser-state.mjs holds them to it). A name taken that way is
// the same value on every side, because one object is handed over and a `const` cannot
// be assigned again. So a function may use it whenever it runs.
//
// A constant of the new script reads it while that script loads, which is earlier than
// its line in the old script ran. Taking the name as it is gives the same value at any
// moment. Computing with it does only when it is a number or a string written out in
// the earlier script. Copying what it holds (`[...NAME]`) is refused: code that runs
// between the two scripts could have changed it.

import { kindOfName } from './browser-inner-fixed.mjs';
import { wrapNames } from './module-requires.mjs';

const TAKE = /^const \{([^{}]*)\} = window\.([A-Za-z_$][\w$]*);$/;
const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;

/** @param {string[]} names @param {string} from the name on window @param {string} indent @returns {string[]} the line as the tool writes it */
export const takeText = (names, from, indent) => wrapNames(names, 'const {', `} = window.${from};`).map((line) => indent + line);

/**
 * Every statement of a wrapper that is `const { a, b } = window.<Name>;` written as the tool writes it.
 * @param {any} shell from readWrapper @param {string} text of the same script
 * @returns {{ record: any, names: string[], from: string }[]} in the order they stand
 */
export function takeLines(shell, text) {
  const lines = text.split('\n');
  const found = [];
  for (const record of shell.records) {
    if (record.kind !== 'const') continue;
    const code = lines.slice(shell.open + record.line[0], shell.open + record.line[1] + 1);
    const taken = TAKE.exec(code.map((line) => line.trim()).join(' '));
    if (!taken) continue;
    const names = taken[1].split(',').map((name) => name.trim()).filter(Boolean);
    if (names.length && names.every((name) => PLAIN_NAME.test(name)) && code.join('\n') === takeText(names, taken[2], shell.indent).join('\n')) found.push({ record, names, from: taken[2] });
  }
  return found;
}

/** @param {any} shell of a script made of moved code @returns {Map<string, 'primitive' | 'reference' | null>} what each name it declares holds */
export const kindsIn = (shell) => new Map([...shell.bindings.keys()].map((name) => [name, kindOfName(shell.bindings, name)]));

/**
 * Says which names of a wrapper are taken from a script that loads before it.
 * @param {any} shell from readWrapper @param {string} text of the same script
 * @param {Map<string, Map<string, any>>} known the name on window of every script it may take from, with what each of its names holds
 * @param {(line: { record: any, from: string }) => boolean} [counts] which take lines count: all that name a known script when not given
 * @returns {any} the shell, `taken` filled: name to `{ from, record, kind }`
 */
export function markTaken(shell, text, known, counts = (line) => known.has(line.from)) {
  for (const line of takeLines(shell, text).filter(counts)) {
    for (const name of line.names) shell.taken.set(name, { from: line.from, record: line.record, kind: known.get(line.from)?.get(name) ?? null });
  }
  return shell;
}

/**
 * Why a constant may not read a taken name the way it does while its line runs.
 * @param {any} shell @param {any} record the constant @param {{ name: string, how: string }} read @param {string} label @param {(record: any) => number} lineOf
 * @returns {string[]}
 */
export function takenReadReasons(shell, record, { name, how }, label, lineOf) {
  const taken = shell.taken.get(name);
  const there = `taken from window.${taken.from} (line ${lineOf(taken.record)})`;
  const reasons = [];
  if (taken.record.index > record.index) reasons.push(`${label} reads ${name} above the line that takes it back, ${there}`);
  if (how === 'through') reasons.push(`${label} copies what ${name} holds at that moment, ${there}: code that runs between the two scripts could change it first`);
  if (how === 'number' && taken.kind !== 'primitive') reasons.push(`${label} computes with ${name}, ${there}, which is not a number or a string written out there`);
  return reasons;
}

/**
 * The lines a new script begins with, for the taken names its code uses.
 * @param {any} shell with `taken` @param {any[]} moved the records that leave @param {string[]} order the names on window of the earlier scripts, as they load
 * @returns {{ from: string, names: string[] }[]} one per earlier script, in the order they load; the names in the order that script hands them over
 */
export function takesOf(shell, moved, order) {
  const used = new Set(moved.flatMap((record) => [...record.uses.keys()]));
  const takes = order.map((from) => ({ from, names: [...shell.taken].filter(([name, taken]) => taken.from === from && used.has(name)).map(([name]) => name) }));
  return takes.filter((take) => take.names.length);
}

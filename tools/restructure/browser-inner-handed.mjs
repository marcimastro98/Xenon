// The second form of a script made of functions taken out of a wrapper
// (browser-inner-plan.mjs): one that is handed what its functions use of the wrapper.
// The plain form cannot hold a function that calls one that stays, or that reads the
// wrapper's state. This one can: the new script leaves a function on `window`, the old
// script calls it once, hands over the names, and takes the moved names back.
//
//   js/leaf.js, the old script                js/leaf/rows.js, the new script
//     (function () {                            window.LeafRows = (wrapper) => {
//       const state = { open: null };             const { state, paint } = wrapper;
//       const { row, rows } = window.LeafRows({ state, paint });
//       function paint() { rows().forEach(row); }   function row(item) { ... state.open ... paint() ... }
//     })();                                       function rows() { ... }
//                                                 return { row, rows };
//                                               };
//
// What may be handed is what holds one value from the line that hands it to the end of
// the page:
//   - a function declaration of the wrapper, declared once and never assigned again
//     (it is there from the wrapper's first line);
//   - a `const` of the wrapper declared above the line that hands it. The wrapper's
//     state is handed that way: `browser state` first makes the lets properties of one
//     `const` object, and both sides then read and write the same object.
// Never a `let` or a `var`: the new script would keep the value of that moment.
//
// What is refused, besides everything the plain form refuses (a moved function that
// names innerHTML, sets an address or a style, and the rest of browser-inner-decides.mjs):
//   - a handed `let`, `var`, class, or a name a statement leaves in the wrapper;
//   - a handed function that is assigned again or declared twice;
//   - a handed constant declared below the line that makes the new script's functions,
//     also when that line cannot stand lower because a statement above the constant
//     could reach a moved function while the script loads;
//   - a moved constant that reads a handed name while its own line runs;
//   - more than MAX_HANDS handed names: a script handed that much mostly forwards;
//   - moved code that says `wrapper`, the one name the new form adds.
// `this` and `arguments` need no rule of their own: the function on `window` is an arrow
// and has neither, the moved functions are called by their bare names as before, in the
// same mode (strict or not), and a constant whose arrow says `this` or `arguments` does
// not move in either form (browser-inner-fixed.mjs).
//
// Nothing here reads code. A handed script is read by turning its text into the plain
// form, line for line, and the reading of the plain form (browser-inner-proof.mjs) does
// the rest with the handed names set apart. The text must be the one `toHanded` writes.

import { createReach } from './browser-inner-fixed.mjs';
import { anchorOf } from './browser-inner-judge.mjs';
import { wrapNames } from './module-requires.mjs';

/** How many names a script may be handed. */
export const MAX_HANDS = 8;
const STATE = new Set(['let', 'var']);
const PLAIN_NAME = /^[A-Za-z_$][\w$]*$/;
const OPEN = /^window\.([A-Za-z_$][\w$]*) = \(wrapper\) => \{$/;
const namesIn = (list) => list.split(',').map((name) => name.trim()).filter(Boolean);
const indentOf = (line) => /^[ \t]*/.exec(line ?? '')[0];
const joined = (lines) => lines.map((line) => line.trim()).join(' ');
// The lines right under the opening line that make the script strict: none, or the directive and an empty line.
const strictLines = (lines, open) => (/^[ \t]+'use strict';$/.test(lines[open + 1] ?? '') ? (lines[open + 2] === '' ? 2 : 1) : 0);

/** @param {string[]} gives @param {string} name @param {string[]} hands @returns {string[]} the line of the old script that makes the functions and takes them back, without indent */
export const handedGlue = (gives, name, hands) => wrapNames(gives, 'const {', `} = window.${name}({ ${hands.join(', ')} });`);
const GLUE = /^const \{[^{}]*\} = window\.([A-Za-z_$][\w$]*)\(\{([^{}]*)\}\);$/;

/**
 * Says which statements of a wrapper hand names to a script made of it. Such a statement names what it hands and calls none of it: the
 * function it calls only takes the names and makes its own (the reading of that script holds it to that). So a handed name is not a
 * way to reach anything while the script loads, and `reach` is worked out again without those.
 * @param {any} shell from readWrapper @param {string} text of the same script @param {(string | null)[]} names what the scripts made of the wrapper leave on window
 * @returns {any} the shell, with `hands` (a Set of names) on every such statement
 */
export function markHands(shell, text, names) {
  const lines = text.split('\n');
  for (const record of shell.records.filter((entry) => entry.kind === 'const')) {
    const made = GLUE.exec(joined(lines.slice(shell.open + record.line[0], shell.open + record.line[1] + 1)));
    if (made && names.includes(made[1]) && namesIn(made[2]).every((hand) => PLAIN_NAME.test(hand))) record.hands = new Set(namesIn(made[2]));
  }
  shell.reach = createReach(shell.records, shell.bindings);
  return shell;
}

/**
 * @param {string} plain a script in the plain form, as browser-inner-plan.mjs writes it @param {string} name the name it leaves on window
 * @param {string[]} hands the names it is handed
 * @returns {string | null} the same script in the handed form, null when the text is not the plain form
 */
export function toHanded(plain, name, hands) {
  const lines = plain.split('\n');
  const open = lines.indexOf('(() => {');
  const close = lines.length - 2;
  const object = lines.findLastIndex((line) => line.trimStart().startsWith(`window.${name} = {`));
  const given = object > open ? new RegExp(`^window\\.${name} = \\{([^{}]*)\\};$`).exec(joined(lines.slice(object, close))) : null;
  if (open < 0 || !given || lines[close] !== '})();' || lines.at(-1) !== '') return null;
  const indent = indentOf(lines[object]);
  const top = open + 1 + strictLines(lines, open);
  return [...lines.slice(0, open), `window.${name} = (wrapper) => {`, ...lines.slice(open + 1, top),
    ...wrapNames(hands, 'const {', '} = wrapper;').map((line) => indent + line), '', ...lines.slice(top, object),
    ...wrapNames(namesIn(given[1]), 'return {', '};').map((line) => indent + line), '};', ''].join('\n');
}

/**
 * Reads a script for the handed form.
 * @param {string} raw
 * @returns {{ text: string, handed: string[] | null, problems: string[] }} `text`: the script in the plain form, every line above its last
 *   statement on the line it had (the line that takes the handed names is empty there); `handed`: the names it is handed, null for a
 *   script that is in the plain form already, which comes back as it is
 */
export function fromHanded(raw) {
  const lines = raw.split('\n');
  const open = lines.findIndex((line) => OPEN.test(line));
  if (open < 0) return { text: raw, handed: null, problems: [] };
  const name = OPEN.exec(lines[open])[1];
  const bad = { text: raw, handed: [], problems: [`a script that is handed names is written as the tool writes it: \`window.${name} = (wrapper) => {\`, the line that takes the handed names, its code, and \`return { ... };\``] };
  const top = open + 1 + strictLines(lines, open);
  const end = lines.findIndex((line, at) => at >= top && at < top + MAX_HANDS + 2 && line.endsWith('} = wrapper;'));
  const close = lines.length - 2;
  const indent = indentOf(lines[top]);
  const back = lines.findLastIndex((line) => line.startsWith(`${indent}return {`));
  if (end < 0 || back <= end || lines[end + 1] !== '') return bad;
  const hand = /^const \{([^{}]*)\} = wrapper;$/.exec(joined(lines.slice(top, end + 1)));
  const gave = /^return \{([^{}]*)\};$/.exec(joined(lines.slice(back, close)));
  if (!hand || !gave || !namesIn(hand[1]).every((taken) => PLAIN_NAME.test(taken))) return bad;
  const head = [...lines.slice(0, open), '(() => {', ...lines.slice(open + 1, top)];
  const tail = [...lines.slice(end + 2, back), ...wrapNames(namesIn(gave[1]), `window.${name} = {`, '};').map((line) => indent + line), '})();', ''];
  if (toHanded([...head, ...tail].join('\n'), name, namesIn(hand[1])) !== raw) return bad;
  return { text: [...head, ...Array.from({ length: end + 2 - top }, () => ''), ...tail].join('\n'), handed: namesIn(hand[1]), problems: [] };
}

/**
 * Why a name of the wrapper cannot be handed to the code that uses it. Asked while planning.
 * @param {any} shell from readWrapper @param {{ name: string, kind: string, record: any }} own the name as the wrapper declares it @param {any} user the moved statement that uses it
 * @returns {string} empty when it can
 */
export function handReason(shell, own, user) {
  if (STATE.has(own.kind)) return `a ${own.kind} of the wrapper: handed, the new script would keep the value of that moment. Make it a property of one object first (\`browser state\`): the object can be handed`;
  if (own.kind !== 'function' && own.kind !== 'const') return `${own.kind === 'statement' ? 'a name a statement of the wrapper leaves there' : `a ${own.kind} of the wrapper`}: only a function or a constant can be handed`;
  if (shell.twice.has(own.name)) return 'declared twice in the wrapper: which one would be handed cannot be said';
  if (own.kind === 'function' && shell.records.some((record) => (record.uses.get(own.name)?.write ?? 0) > 0)) return 'a function the script assigns again: handed, the new script would keep the first one';
  if (user.kind === 'const' && user.fixed?.reads.some((read) => read.name === own.name)) return 'read while the constant\'s own line runs: handed, it would be read when the new script\'s functions are made, at another moment';
  return '';
}

/**
 * Where the line that makes the functions can stand: as the plain form has it, and below every handed constant.
 * @param {any} shell @param {any[]} moved records in order @param {string[]} hands
 * @returns {{ index: number, reasons: string[] }} `index`: the record the line stands above
 */
export function handedAnchor(shell, moved, hands) {
  const movedSet = new Set(moved);
  const reacher = shell.records.find((record) => !movedSet.has(record) && record.kind !== 'function' && moved.some((target) => shell.reach(target).has(record)));
  const consts = hands.map((hand) => shell.bindings.get(hand)).filter((own) => own.kind === 'const');
  const index = Math.max(anchorOf(shell, moved), ...consts.map((own) => own.record.index + 1));
  if (!reacher || index <= reacher.index) return { index, reasons: [] };
  const line = (record) => shell.open + record.line[0] + 1;
  return { index, reasons: consts.filter((own) => own.record.index >= reacher.index).map((own) => `${own.name} (line ${line(own.record)}) would be handed, and line ${line(reacher)} above it could use ${moved.flatMap((record) => record.names).join(', ')} while the script loads: `
    + 'the line that makes them would have to stand above the one and below the other') };
}

/** @param {any} shell @param {string[]} hands @returns {string[]} the handed names in the order the wrapper declares them */
export function inOrder(shell, hands) {
  const place = (hand) => { const { record } = shell.bindings.get(hand); return record.index * 1000 + record.names.indexOf(hand); };
  return [...hands].sort((a, b) => place(a) - place(b));
}

/**
 * What must hold between a wrapper and a script it hands names to, on any day.
 * @param {object} pair @param {any} pair.now the wrapper as read @param {any} pair.taker the statement that makes the functions and takes them back
 * @param {string[] | null} pair.hands the names that statement hands over, null when it hands none
 * @param {{ handed: string[] | null, shell: any, functions: Map<string, any> }} pair.made the new script as readInnerScript read it
 * @param {string} pair.source @param {string} pair.target
 * @returns {string[]}
 */
export function handProblems({ now, taker, hands, made, source, target }) {
  const { handed } = made;
  if (!hands && !handed) return [];
  if (!hands || !handed || hands.join() !== handed.join()) return [`${source} ${hands ? `hands ${target} ${hands.join(', ') || 'nothing'}` : `takes ${target} as an object`}, and ${target} ${handed ? `is handed ${handed.join(', ')}` : 'is not a script that is handed names'}`];
  const problems = [];
  if (hands.length === 0 || hands.length > MAX_HANDS) problems.push(`${target} is handed ${hands.length} names: one to ${MAX_HANDS}`);
  if (new Set(hands).size !== hands.length) problems.push(`${target} is handed a name twice`);
  if (made.shell.bindings.has('wrapper') || made.shell.records.some((record) => record.uses.has('wrapper'))) problems.push(`${target} says \`wrapper\` in its code: that is the name of what it is handed`);
  const users = [...new Set(made.functions.values())];
  for (const hand of hands) {
    const own = now.bindings.get(hand);
    if (made.shell.bindings.has(hand)) problems.push(`${target} is handed ${hand} and declares it too`);
    if (!users.some((record) => record.uses.has(hand))) problems.push(`${target} is handed ${hand} and does not use it`);
    if (!own || now.twice.has(hand)) { problems.push(`${hand}, handed to ${target}, is not declared once in the wrapper of ${source}`); continue; }
    const at = `${source}:${now.open + own.record.line[0] + 1}`;
    if (own.kind === 'function') {
      if (now.records.some((record) => (record.uses.get(hand)?.write ?? 0) > 0)) problems.push(`${source} assigns ${hand} again: ${target} would keep the function it was handed`);
    } else if (own.kind === 'const') {
      if (own.record.index >= taker.index) problems.push(`${hand} (${at}) is a constant declared below the line that hands it to ${target}: it has no value there yet`);
    } else problems.push(`${hand} (${at}) is a ${own.kind === 'statement' ? 'name a statement leaves in the wrapper' : `${own.kind} of the wrapper`}: ${target} would keep the value it was handed, only a function or a constant stays that value`);
  }
  return problems;
}

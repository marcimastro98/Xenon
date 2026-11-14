// What `browser inner` can take out of the wrapped scripts, and what holds the rest:
// per script, the functions of its wrapper that may leave today, and the ones that stay,
// sorted by the first thing that keeps them there. Also asks, without doing it, how many
// more would be free if the wrapper's state or its constants could go with them.
// Reads texts, changes nothing.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { heldFunctions, readWrapper } from './browser-inner-plan.mjs';

const OURS = /^server\/(?:js|components)\/.+\.js$/;
const VENDOR = /(^|\/)vendor\//;
const BIG = 300;
// The first reason of a function decides where it is counted; a function that only waits for another one comes last.
const ORDER = ['reassigned', 'state', 'const', 'other', 'needs'];
export const HOLDS = { reassigned: 'assigned again', state: 'use a let or var of the wrapper', const: 'use a const of the wrapper',
  other: 'use a class or another name of the wrapper, or cannot be read alone', needs: 'only use a function that stays' };

const sizeOf = (records) => records.reduce((sum, record) => sum + record.range[1] - record.range[0] + 1, 0);
const tally = (records) => ({ functions: records.length, lines: sizeOf(records) });

/**
 * The functions that may leave, in groups that do not use each other: each group can be a script of its own.
 * @param {any[]} free function records @returns {any[][]} groups in the order of their first function
 */
export function groupsOf(free) {
  const byName = new Map(free.map((record) => [record.names[0], record]));
  const group = new Map(free.map((record) => [record, record]));
  const top = (record) => { let at = record; while (group.get(at) !== at) at = group.get(at); return at; };
  for (const record of free) {
    for (const used of record.uses.keys()) {
      const other = byName.get(used);
      if (other && top(other) !== top(record)) group.set(top(other), top(record));
    }
  }
  const groups = new Map();
  for (const record of free) groups.set(top(record), [...(groups.get(top(record)) ?? []), record]);
  return [...groups.values()].sort((a, b) => a[0].index - b[0].index);
}

/**
 * @param {string} text @param {string} file @param {any} parser
 * @returns {any} `{ file, lines, wrapped: false, why }` or `{ file, lines, wrapped: true, all, free, held: { kind: tally }, ifState, ifConst, ifBoth,
 *   rows }` where a tally is `{ functions, lines }` and `rows` has one entry per function: `{ name, lines: [from, to], stays: string[], kind }`
 */
export function surveyScript(text, file, parser) {
  const lines = text.split('\n').length - 1;
  const shell = readWrapper(text, file, parser);
  if (shell.problems.length) return { file, lines, wrapped: false, why: shell.problems[0] };
  const whole = [...shell.words].filter((word) => word === 'eval' || word === 'with');
  const why = heldFunctions(shell);
  const functions = [...why.keys()];
  const withFixed = heldFunctions(shell, { along: true });
  const kindOf = (record) => ORDER.find((kind) => why.get(record).some((reason) => reason.kind === kind)) ?? null;
  const free = whole.length ? [] : functions.filter((record) => why.get(record).length === 0);
  const freeIf = (kinds) => { const asked = heldFunctions(shell, { free: new Set(kinds) }); return tally(functions.filter((record) => asked.get(record).length === 0)); };
  const held = Object.fromEntries(ORDER.map((kind) => [kind, tally(functions.filter((record) => kindOf(record) === kind))]));
  const rows = functions.map((record) => ({ name: record.names[0], lines: [shell.open + record.range[0] + 1, shell.open + record.range[1] + 1],
    stays: whole.length ? [`the script says \`${whole[0]}\``] : why.get(record).map((reason) => reason.text), kind: whole.length ? 'other' : kindOf(record) }));
  return { file, lines, wrapped: true, whole, all: tally(functions), free: tally(free), held, ifState: freeIf(['let', 'var']), ifConst: freeIf(['const']),
    ifBoth: freeIf(['let', 'var', 'const']), ifFixed: tally(functions.filter((record) => withFixed.get(record).length === 0)), rows, groups: groupsOf(free).map((group) => ({ lines: sizeOf(group), names: group.map((record) => record.names[0]) })) };
}

/** @param {string} root @returns {string[]} every script of ours a page could load, tracked, without the vendored ones */
export function ourScripts(root) {
  const run = spawnSync('git', ['ls-files', '-z', '--', 'server/js', 'server/components'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return run.stdout.split('\0').filter((file) => OURS.test(file) && !VENDOR.test(file)).sort();
}

/**
 * @param {string} root @param {any} parser @param {{ moves: any[] }} ledger
 * @returns {{ scripts: any[], made: number }} one survey per script that is not itself made of moved code, biggest first
 */
export function surveyAll(root, parser, ledger) {
  const made = new Set(ledger.moves.filter((move) => ['script', 'inner', 'inline'].includes(move.kind)).map((move) => move.file));
  const scripts = ourScripts(root).filter((file) => !made.has(file)).map((file) => surveyScript(readFileSync(path.join(root, file), 'utf8'), file, parser));
  return { scripts: scripts.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file)), made: made.size };
}

const add = (a, b) => ({ functions: a.functions + b.functions, lines: a.lines + b.lines });
const say = (count) => `${count.functions} functions (${count.lines} lines)`;

/** @param {{ scripts: any[] }} survey @param {boolean} all every wrapped script, not only the ones over the limit @returns {string[]} the survey as lines of text */
export function renderSurvey({ scripts }, all = false) {
  const wrapped = scripts.filter((script) => script.wrapped && (all || script.lines > BIG));
  const out = [];
  const zero = { functions: 0, lines: 0 };
  const total = { all: zero, free: zero, ifState: zero, ifConst: zero, ifBoth: zero, ifFixed: zero, held: Object.fromEntries(ORDER.map((kind) => [kind, zero])) };
  for (const script of wrapped) {
    for (const key of ['all', 'free', 'ifState', 'ifConst', 'ifBoth', 'ifFixed']) total[key] = add(total[key], script[key]);
    for (const kind of ORDER) total.held[kind] = add(total.held[kind], script.held[kind]);
    out.push(`${script.file.padEnd(46)} ${String(script.lines).padStart(5)} lines  ${String(script.all.functions).padStart(4)} functions  can leave ${String(script.free.functions).padStart(3)} (${String(script.free.lines).padStart(4)} l)`
      + `  held: ${ORDER.map((kind) => `${kind} ${script.held[kind].functions}`).join(', ')}  if state could go ${script.ifState.lines} l, constants ${script.ifConst.lines} l (written-out values and functions only: ${script.ifFixed.lines} l), both ${script.ifBoth.lines} l`
      + `${script.whole.length ? `  (says \`${script.whole[0]}\`: stays whole)` : ''}`);
  }
  const others = scripts.filter((script) => !script.wrapped && (all || script.lines > BIG));
  const handed = others.filter((script) => /handed values/.test(script.why));
  out.push('', `${wrapped.length} scripts${all ? '' : ` over ${BIG} lines`} are one plain wrapper: ${say(total.all)} declared in their wrappers, ${wrapped.reduce((sum, script) => sum + script.lines, 0)} lines in all.`,
    `Can leave today: ${say(total.free)}.`,
    `Held, by the first thing that keeps each: ${ORDER.map((kind) => `${say(total.held[kind])} ${HOLDS[kind]}`).join('; ')}.`,
    'Held by code that runs while the script loads: none. The line that takes the functions back is placed above the first statement that could reach one.',
    `If the wrapper's lets and vars could be shared: ${say(total.ifState)} could leave. If its constants could go along: ${say(total.ifConst)}; only the constants that are a value written out or a function: ${say(total.ifFixed)}. State and constants both: ${say(total.ifBoth)}.`,
    `Not a plain wrapper${all ? '' : ` and over ${BIG} lines`}: ${handed.length} are handed values when called (they stay whole), ${others.length - handed.length} have no wrapper or are a module.`);
  return out;
}

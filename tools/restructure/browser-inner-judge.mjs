// Judges what may leave the wrapper of a browser script (browser-inner-plan.mjs): a
// function declaration, or a constant whose value is written out
// (browser-inner-fixed.mjs). The same judgement plans a move, proves it afterwards on
// the old text and on the new script, and counts for the survey.
//
// A constant is not hoisted like a function: a statement above its line that reaches it
// while the script loads is an error today. After a move the line that takes the names
// back stands higher, and the error would be gone. So such a constant stays.

import { kindOfName } from './browser-inner-fixed.mjs';

const STATE = new Set(['let', 'var']);

export const isFunction = (record) => record.kind === 'function' && record.names.length === 1;
/** A constant that only builds a value when its line runs: it may go along when everything it names goes too. */
export const isWrittenOut = (record) => record.kind === 'const' && Boolean(record.fixed) && record.fixed.reasons.length === 0;
export const mayTravel = (record) => isFunction(record) || isWrittenOut(record);
/** 1-based line of the file a record's code starts on. */
export const lineOf = (shell, record) => shell.open + record.line[0] + 1;

// What a constant reads while its own line runs.
function readReasons(shell, record, label) {
  const reasons = [];
  for (const { name, how } of record.fixed.reads) {
    const own = shell.bindings.get(name);
    if (!own) { reasons.push({ kind: 'const', text: `${label} reads ${name} while the script loads, a name of the page: it could be another value when read earlier` }); continue; }
    if (own.record === record) { reasons.push({ kind: 'const', text: `${label} reads ${name}, which it declares itself` }); continue; }
    // A name that cannot travel is found by whoever asks what the constant uses.
    if (!mayTravel(own.record)) continue;
    const there = `(line ${lineOf(shell, own.record)})`;
    if (isFunction(own.record)) {
      if (how !== 'value') reasons.push({ kind: 'const', text: `${label} computes with the function ${name} ${there}, or copies from it` });
      continue;
    }
    if (own.record.index > record.index) reasons.push({ kind: 'const', text: `${label} reads ${name} above the line that declares it ${there}` });
    if (how === 'number' && kindOfName(shell.bindings, name) !== 'primitive') reasons.push({ kind: 'const', text: `${label} computes with ${name} ${there}, which is not a number or a string written out` });
    if (how !== 'through') continue;
    const between = shell.records.find((other) => other.index > own.record.index && other.index < record.index && !mayTravel(other) && shell.reach(own.record).has(other));
    if (between) reasons.push({ kind: 'const', text: `${label} copies what ${name} ${there} holds at that moment, and line ${lineOf(shell, between)} could change it first: copied earlier, it could hold something else` });
  }
  return reasons;
}

/**
 * Why a function or a constant cannot leave on its own account, whatever moves with it.
 * @param {any} shell from readWrapper @param {any} record @param {string} label how the reasons name it
 * @param {{ early?: boolean }} [ask] `early: false` leaves out the statements above a constant that could reach it (the survey asks what that rule costs)
 * @returns {{ kind: string, text: string }[]} `kind` sorts the reasons for the survey
 */
export function ownReasons(shell, record, label, { early = true } = {}) {
  const reasons = [];
  if (record.sharesLine) reasons.push({ kind: 'other', text: `${label} shares a line with another statement` });
  if (record.names.some((name) => shell.twice.has(name))) reasons.push({ kind: 'other', text: `${label} is declared twice in the wrapper` });
  if (record.names.some((name) => shell.records.some((other) => (other.uses.get(name)?.write ?? 0) > 0))) {
    reasons.push({ kind: 'reassigned', text: isFunction(record) ? `${label} is assigned again in the script: the old script would keep a copy that never changes`
      : `${label} is assigned to in the script: a constant cannot be, and the error would move with it` });
  }
  if (record.words.has('arguments.callee')) reasons.push({ kind: 'other', text: `${label} says arguments.callee` });
  if (record.kind !== 'const') return reasons;
  if (!record.fixed) return reasons;
  reasons.push(...record.fixed.reasons.map((reason) => ({ kind: 'const', text: `${label} is not a value that is the same whenever it is worked out: ${reason}` })));
  if (record.uses.has('arguments')) reasons.push({ kind: 'const', text: `${label} says \`arguments\` in an arrow, which is the wrapper's` });
  reasons.push(...readReasons(shell, record, label));
  if (!early) return reasons;
  const reachers = shell.reach(record);
  const above = shell.records.find((other) => other.index < record.index && (mayTravel(other)
    ? isWrittenOut(other) && other.fixed.reads.some((read) => record.names.includes(read.name)) : reachers.has(other)));
  if (above) reasons.push({ kind: 'early', text: `${label}: line ${lineOf(shell, above)} could use it while the script loads, above the line that declares it: today that is an error, after the move it would not be` });
  return reasons;
}

/**
 * Every function and written-out constant of the wrapper, with what keeps it there.
 * @param {any} shell from readWrapper
 * @param {{ free?: Set<string> }} [options] questions asked for the survey, never for a move. `free`: kinds of wrapper names
 *   ('let', 'var', 'const', 'class', 'statement') counted as if a function could take them along; 'early' leaves out the rule about
 *   statements above a constant
 * @returns {Map<any, { kind: string, text: string, needs?: string }[]>} per record its reasons, empty when it may move
 *   together with everything it uses that may move too
 */
export function heldFunctions(shell, { free = new Set() } = {}) {
  // Asked what would leave if every constant could go: then none of them is judged, and none holds a function.
  const travels = (record) => isFunction(record) || (!free.has('const') && isWrittenOut(record));
  const judged = shell.records.filter(travels);
  const why = new Map();
  for (const record of judged) {
    const label = `${record.names.join(', ')} (line ${lineOf(shell, record)})`;
    const reasons = ownReasons(shell, record, label, { early: !free.has('early') });
    for (const name of record.uses.keys()) {
      const own = shell.bindings.get(name);
      if (!own || own.record === record || travels(own.record) || free.has(own.kind)) continue;
      const what = STATE.has(own.kind) ? `a ${own.kind} of the wrapper that changes while the page runs` : `a ${own.kind === 'statement' ? 'name a statement' : own.kind} of the wrapper${own.kind === 'statement' ? ' leaves there' : ''}`;
      reasons.push({ kind: STATE.has(own.kind) ? 'state' : own.kind === 'const' ? 'const' : 'other', text: `${label} uses ${name}, ${what} (line ${lineOf(shell, own.record)}), which stays` });
    }
    why.set(record, reasons);
  }
  // What uses a function or a constant that stays, stays too.
  for (let again = true; again;) {
    again = false;
    for (const record of judged) {
      if (why.get(record).length) continue;
      const held = [...record.uses.keys()].map((name) => shell.bindings.get(name)).find((own) => own && travels(own.record) && own.record !== record && why.get(own.record).length > 0);
      if (!held) continue;
      why.get(record).push({ kind: held.kind === 'const' ? 'const' : 'needs', needs: held.name, text: `${record.names.join(', ')} (line ${lineOf(shell, record)}) uses ${held.kind === 'function' ? 'the function ' : 'the constant '}${held.name}, which stays` });
      again = true;
    }
  }
  return why;
}

/**
 * The constants that go along with the named functions: every written-out constant they use, and the ones those use.
 * A constant that cannot leave is not added; the plan then says why the function that uses it stays.
 * @param {any} shell @param {string[]} names of the wrapper @returns {string[]} the names with the constants added, in the order given
 */
export function withConstants(shell, names) {
  const why = heldFunctions(shell);
  const picked = new Set(names.map((name) => shell.bindings.get(name)?.record).filter(Boolean));
  const added = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const record of [...picked]) {
      for (const used of record.uses.keys()) {
        const own = shell.bindings.get(used)?.record;
        if (!own || picked.has(own) || !isWrittenOut(own) || why.get(own).length) continue;
        picked.add(own);
        added.push(own);
        grew = true;
      }
    }
  }
  return [...names, ...added.sort((a, b) => a.index - b.index).map((record) => record.names[0])];
}

/**
 * Where the line that takes the names back can stand: where the first moved declaration stood, or above the
 * first statement that could reach a moved one while the script loads.
 * @param {any} shell @param {any[]} moved records in order @returns {number} index of the record the line stands above
 */
export function anchorOf(shell, moved) {
  const movedSet = new Set(moved);
  const user = shell.records.find((record) => !movedSet.has(record) && record.kind !== 'function' && moved.some((target) => shell.reach(target).has(record)));
  return Math.min(moved[0].index, user ? user.index : shell.records.length);
}

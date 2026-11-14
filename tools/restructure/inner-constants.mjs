// Says which constants of a factory's body may leave it together with the functions that use
// them (inner-plan.mjs), and why another stays. The planner and the proof ask the same questions.
//
// A constant is worked out when its line runs. Moved, it is worked out when the factory calls
// the new module, which can be earlier or later than its line. So it leaves only when its value
// is written out (browser-inner-fixed.mjs: a literal, a function or an arrow, a list or an object
// of such values, `new Set([...])`, `new Map([...])`, `Object.freeze` of one written in place,
// arithmetic on numbers and strings, the name of something that moves with it), and when what it
// reads while its line runs is the same at both moments:
//   - a name that moves with it, declared above it;
//   - a function, a constant or an argument of the factory that stays, taken as it is (it is
//     handed over like anything a moved function uses), never computed with or copied from;
//   - a name the file requires, taken as it is.
// What a function inside the value uses runs later and obeys the rule of moved functions.
//
// One object is made, in the new module. A constant the factory still uses comes back by the
// line that takes the functions back, so a list, an object, a Set or a function is the same one
// on both sides: changing what it holds is seen by both.

import { createReach, kindOfName, readFixed } from './browser-inner-fixed.mjs';

/** A constant that only builds a value when its line runs. */
export const isWrittenOut = (record) => record.kind === 'const' && Boolean(record.fixed) && record.fixed.reasons.length === 0;

/**
 * Adds to every `const` of a factory's body what browser-inner-fixed.mjs reads of its value (`fixed`).
 * @param {{ records: any[], bindings: Map<string, any> }} inner the body, from analyze.mjs
 * @param {string} bodyText the text that was analyzed @param {any} parser from parser.mjs @param {string} source
 * @returns {(record: any) => Set<any>} who uses a record, or uses something that does
 */
export function markConstants(inner, bodyText, parser, source) {
  const nodes = parser.parse(bodyText, source).statements.filter((node) => (node.flags & parser.NodeFlags.Reparsed) === 0);
  inner.records.forEach((record, index) => { record.fixed = record.kind === 'const' && nodes[index] ? readFixed(parser.K, nodes[index]) : null; });
  return createReach(inner.records, inner.bindings);
}

/**
 * Why a constant cannot leave the factory on its own account. What the functions inside its value use is judged by
 * the rule of moved functions (inner-plan.mjs), not here.
 * @param {object} ask
 * @param {{ records: any[], bindings: Map<string, any> }} ask.inner the factory's body, marked by markConstants
 * @param {string[]} ask.params the factory's arguments @param {{ bindings: Map<string, any> }} ask.file the whole file, from analyze.mjs
 * @param {(record: any) => Set<any>} ask.reach from markConstants @param {any} ask.record the constant
 * @param {string} ask.label how the reasons name it @param {Set<any>} ask.movedSet every record that leaves
 * @param {string} ask.factory @param {(line: number) => number} ask.real a line of the body as a line of the file
 * @returns {string[]} empty when it may leave
 */
export function constantReasons({ inner, params, file, reach, record, label, movedSet, factory, real }) {
  if (!record.fixed) return [`${label} is not a constant whose value can be read`];
  const reasons = record.fixed.reasons.map((reason) => `${label} is not a value written out: ${reason.replace("the wrapper's", `${factory}'s`)}`);
  if (record.uses.has('arguments')) reasons.push(`${label} says \`arguments\` in an arrow, which is ${factory}'s`);
  if (record.names.some((name) => inner.bindings.get(name)?.reassigned)) reasons.push(`${label} is assigned to in ${factory}: a constant cannot be, and the error would move with it`);
  const at = (other) => `(line ${real(other.line[0])})`;
  const runs = (other) => !movedSet.has(other) && other.kind !== 'function';
  for (const { name, how } of record.fixed.reads) {
    const own = inner.bindings.get(name);
    if (own?.record === record) { reasons.push(`${label} reads ${name}, which it declares itself`); continue; }
    if (!own) {
      const top = file.bindings.get(name);
      const what = params.includes(name) ? `an argument of ${factory}` : top?.kind === 'require' ? 'a required name' : '';
      if (what && how !== 'value') reasons.push(`${label} computes with ${name} or copies from it, ${what}: only a value written out is known to come out the same at another moment`);
      // A declaration of the file itself is refused by the rule of moved functions.
      if (!what && !top) reasons.push(`${label} reads ${name} while ${factory} runs, a name no file declares: it could be another value at another moment`);
      continue;
    }
    if (own.kind === 'function') {
      if (how !== 'value') reasons.push(`${label} computes with the function ${name} ${at(own.record)}, or copies from it`);
      continue;
    }
    if (own.record.index > record.index) reasons.push(`${label} reads ${name} above the line that declares it ${at(own.record)}`);
    if (!movedSet.has(own.record)) {
      if (how !== 'value') reasons.push(`${label} computes with ${name} ${at(own.record)} or copies from it, and ${name} stays in ${factory}: move it along, or leave ${record.names[0]} where it is`);
      continue;
    }
    if (how === 'number' && kindOfName(inner.bindings, name) !== 'primitive') reasons.push(`${label} computes with ${name} ${at(own.record)}, which is not a number or a string written out`);
    if (how !== 'through') continue;
    const between = inner.records.find((other) => other.index > own.record.index && other.index < record.index && runs(other) && !isWrittenOut(other) && reach(own.record).has(other));
    if (between) reasons.push(`${label} copies what ${name} ${at(own.record)} holds at that moment, and line ${real(between.line[0])} could change it first: copied at another moment, it could hold something else`);
  }
  // A constant is not hoisted like a function: a statement above its line that reaches it is an error today.
  const reachers = reach(record);
  const above = inner.records.find((other) => other.index < record.index && runs(other)
    && (isWrittenOut(other) ? other.fixed.reads.some((read) => record.names.includes(read.name)) : reachers.has(other)));
  if (above) reasons.push(`${label}: line ${real(above.line[0])} could use it while ${factory} runs, above the line that declares it: today that is an error, after the move it would not be`);
  return reasons;
}

/**
 * The constants that go along with the named functions and constants without being named: every written-out
 * constant they use, and the ones those use, that nothing left in the factory uses and that nothing keeps there.
 * A constant the factory uses too is not added: named, it moves and is handed back; left alone, it is handed over.
 * @param {object} ask
 * @param {{ records: any[], bindings: Map<string, any> }} ask.inner the factory's body, marked by markConstants
 * @param {string[]} ask.names what was named @param {string} ask.factory @param {(line: number) => number} ask.real
 * @param {(record: any, movedSet: Set<any>) => string[]} ask.reasonsOf why a record cannot leave with that set (inner-plan.mjs)
 * @returns {{ added: string[], left: { name: string, why: string }[] }} `left`: written-out constants the moved code uses that stay, each with why
 */
export function constantsAlong({ inner, names, factory, real, reasonsOf }) {
  const named = new Set(names.map((name) => inner.bindings.get(name)?.record).filter(Boolean));
  const added = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const record of [...named, ...added]) {
      for (const used of record.uses.keys()) {
        const own = inner.bindings.get(used)?.record;
        if (!own || named.has(own) || added.has(own) || !isWrittenOut(own)) continue;
        added.add(own);
        grew = true;
      }
    }
  }
  // Taking one out can keep another that read it: asked again until nothing changes.
  const left = [];
  for (let again = true; again;) {
    again = false;
    const movedSet = new Set([...named, ...added]);
    for (const record of added) {
      const user = inner.records.find((other) => !movedSet.has(other) && record.names.some((name) => other.uses.has(name)));
      const why = user ? `line ${real(user.line[0])} of ${factory} uses it too: it is handed over; name it to move it and have it handed back` : reasonsOf(record, movedSet)[0];
      if (!why) continue;
      added.delete(record);
      left.push({ record, name: record.names.join(', '), why });
      again = true;
      break;
    }
  }
  const order = (a, b) => a.index - b.index;
  // Only the ones what moves in the end still uses are told: one that only a constant left behind read is nobody's business here.
  const moved = [...named, ...added];
  const told = left.filter((row) => moved.some((record) => row.record.names.some((name) => record.uses.has(name)))).map(({ name, why }) => ({ name, why }));
  return { added: [...added].sort(order).flatMap((record) => record.names), left: told };
}

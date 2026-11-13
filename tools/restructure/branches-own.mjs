// Which names of the file itself a moved body may be handed, in the one extra
// argument of its call (branches-text.mjs). Reading only; the scope reader looks
// for these, the plan refuses on them and the proof reads them again.
//
// A body in a table cannot see the file it came from. A name the file declares
// can still reach it when the call passes it along: `{ readNotes, saveNotes }`.
// That is the same thing as the body naming it in place only when the name means
// one value for good, and has that value whenever the body can run:
//
//   - a `const` at the top of the file (one that comes from a `require` too), or a
//     function declared there that nothing assigns again. Never a `let`, a `var`,
//     a class, a name declared twice or one anything assigns: the body would keep
//     the value of the moment it was called;
//   - a `const` gets its value when its line runs. The call reads every name it
//     hands over at once, where the body in place read one only when it reached
//     it, so the const must stand above the first line that, while the file loads,
//     may reach the function the chain is in. A declared function has its value
//     from the start. When nothing can run that function while the file loads
//     (after-load.json), no such line exists and every const has its value by then.
//
// A module the file requires above the function, or one that is part of Node, is
// not handed: the table requires it itself, which loads nothing earlier.

import { isBuiltin } from 'node:module';

/**
 * @param {{ records: any[], bindings: Map<string, any> }} analysis from analyze.mjs
 * @param {string} handler
 * @returns {any | null} the first statement that runs while the file loads and may reach the function (through
 *   anything it names, callbacks included); null when none does, or when nothing runs the function before the file
 *   has loaded (after-load.json)
 */
export function firstReach(analysis, handler) {
  const target = analysis.bindings.get(handler)?.record;
  if (!target || analysis.afterLoad?.has(handler)) return null;
  for (const start of analysis.records) {
    if (!start.loadTime || start === target) continue;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const name of queue.pop().uses.keys()) {
        const next = analysis.bindings.get(name)?.record;
        if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    if (seen.has(target)) return start;
  }
  return null;
}

/**
 * @param {{ records: any[], bindings: Map<string, any> }} analysis from analyze.mjs
 * @param {string} handler the function the chain is in
 * @returns {{ required: (name: string) => boolean, whyNot: (name: string) => string | null }}
 *   `required`: the table requires the name itself; `whyNot`: why a call cannot hand the name over, null when it can
 */
export function ownRule(analysis, handler) {
  const home = analysis.bindings.get(handler)?.record.index ?? -1;
  const reach = firstReach(analysis, handler);
  const declared = new Map();
  for (const record of analysis.records) for (const name of record.names) declared.set(name, (declared.get(name) ?? 0) + 1);
  const required = (name) => {
    const binding = analysis.bindings.get(name);
    return binding?.kind === 'require' && (binding.record.index < home || isBuiltin(binding.record.require.spec));
  };
  const whyNot = (name) => {
    const binding = analysis.bindings.get(name);
    if (!binding) return 'the file does not declare it at its top';
    const line = binding.record.line[0];
    if (declared.get(name) !== 1) return 'the file declares it more than once';
    if (binding.reassigned) return `the file assigns it again after declaring it (line ${line})`;
    if (binding.kind === 'function') return null;
    if (binding.kind !== 'const' && binding.kind !== 'require') return `it is declared with \`${binding.kind}\` (line ${line}), so it can change while a body runs`;
    if (reach && binding.record.index >= reach.index) {
      return `it gets its value on line ${line}, and line ${reach.line[0]} may already run ${handler} while the file loads`;
    }
    return null;
  };
  return { required, whyNot };
}

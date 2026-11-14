// A browser script that Node loads too (a test or the engine `require`s it) is one
// file there, with a scope of its own: a declaration taken out into another script
// is simply missing, and the file fails the day Node reaches it. A page never
// shows that, so the move has to be refused before it is made.
//
// What Node reaches: every top-level statement that runs when the file loads,
// every value worked out at load, and whatever those use, however deep. Only a
// statement kept for pages, `if (typeof window !== 'undefined') ...`, is left
// out. What is left over may move: functions that only pages ever call.

import { mentionsOf } from './browser-consumers.mjs';

/**
 * @param {string} root @param {string} file repo-relative browser script
 * @returns {string[]} every tracked file that loads it with `require` or `import`, as `file:line`
 */
export function nodeLoadersOf(root, file) {
  return mentionsOf(root, file).filter((mention) => mention.loads.length).map((mention) => `${mention.file}:${mention.loads[0]}`);
}

/**
 * @param {{ records: any[], bindings: Map<string, any> }} run from analyzeRun
 * @param {number} fileIndex the script Node loads
 * @returns {{ inside: Set<string>, outside: Set<string> }} the names Node reaches when it loads that script alone:
 *   `inside` the ones the script declares, `outside` the ones another script of the run declares
 */
export function reachedInNode(run, fileIndex) {
  const own = run.records.filter((record) => record.fileIndex === fileIndex);
  const queue = own.filter((record) => record.kind !== 'function' && !record.directive && !record.browserOnly);
  const seen = new Set(queue);
  const inside = new Set(queue.flatMap((record) => record.names));
  const outside = new Set();
  while (queue.length) {
    for (const name of queue.pop().uses.keys()) {
      const holder = run.bindings.get(name)?.record;
      if (!holder) continue;
      if (holder.fileIndex !== fileIndex) { outside.add(name); continue; }
      inside.add(name);
      if (!seen.has(holder)) { seen.add(holder); queue.push(holder); }
    }
  }
  return { inside, outside };
}

/**
 * @param {string} root @param {string} file repo-relative browser script
 * @param {{ records: any[], bindings: Map<string, any> }} run the script with the scripts already taken out of it, analyzed
 * @param {number} fileIndex where the script is in the run
 * @returns {Map<string, string>} the declarations that stay because Node loads the script, each with who loads it
 */
export function nodeKeeps(root, file, run, fileIndex) {
  const loaders = nodeLoadersOf(root, file);
  if (loaders.length === 0) return new Map();
  return new Map([...reachedInNode(run, fileIndex).inside].map((name) => [name, loaders[0]]));
}

/**
 * For a script that is split already: nothing Node reaches in it may live in one of its other scripts.
 * @param {string} root @param {string} file @param {{ records: any[], bindings: Map<string, any> }} run @param {number} fileIndex
 * @returns {string[]} problems
 */
export function nodeLoadProblems(root, file, run, fileIndex) {
  const loaders = nodeLoadersOf(root, file);
  if (loaders.length === 0) return [];
  return [...reachedInNode(run, fileIndex).outside].sort().map((name) => `${loaders[0]} loads ${file} in Node, alone, and what runs there uses `
    + `${name}, which is in ${run.bindings.get(name).record.file}: it must be in ${file}`);
}

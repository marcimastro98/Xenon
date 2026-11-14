// A browser script that Node loads too (a test or the engine `require`s it) is one
// file there, with a scope of its own: a declaration taken out into another script
// is simply missing, and the file fails the day Node reaches it. A page never
// shows that, so the move has to be refused before it is made.
//
// What Node reaches: every top-level statement that runs when the file loads,
// every value worked out at load, and whatever those use, however deep. Only a
// statement kept for pages, `if (typeof window !== 'undefined') ...`, is left
// out.
//
// That statement keeps names in the script all the same when a file of the engine
// loads it: the type check (tools/quality/tsconfig.server.json) then reads the
// script too, alone, as the module it is there. A name in `window.Grid = { fit }`
// whose function went to another script is error TS18004 in it, and the count of
// type errors may only go down. So a new move out of such a script leaves in it
// what the statement for pages reaches as well. A script only tests load is not
// in the type check, and keeps what Node reaches and no more.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { mentionsOf } from './browser-consumers.mjs';

const TYPE_CHECK = 'tools/quality/tsconfig.server.json';
const literal = (text) => text.replace(/[.+?^${}()|[\]\\]/g, (sign) => `\\${sign}`);
// `*` is any name in one folder, `**/` any number of folders.
const asPattern = (glob) => new RegExp(`^${glob.split('**/').map((piece) => piece.split('*').map(literal).join('[^/]*')).join('(?:.*/)?')}$`);

/**
 * @param {string} root
 * @returns {(file: string) => boolean} whether the type check lists a repo-relative file among the ones it reads (never, where it is not set up)
 */
export function typeChecked(root) {
  let project;
  try {
    project = JSON.parse(readFileSync(path.join(root, TYPE_CHECK), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return () => false;
  }
  const fromRoot = (entry) => path.posix.join(path.posix.dirname(TYPE_CHECK), entry);
  const include = (project.include ?? []).map((entry) => asPattern(fromRoot(entry)));
  const exclude = (project.exclude ?? []).map(fromRoot);
  return (file) => include.some((pattern) => pattern.test(file)) && !exclude.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

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
  return reachedFrom(run, fileIndex, (record) => record.kind !== 'function' && !record.directive && !record.browserOnly);
}

/**
 * @param {{ records: any[], bindings: Map<string, any> }} run from analyzeRun
 * @param {number} fileIndex the script Node loads
 * @returns {{ inside: Set<string>, outside: Set<string> }} the names its statements kept for pages reach, split the same way
 */
export function reachedForPages(run, fileIndex) {
  return reachedFrom(run, fileIndex, (record) => record.browserOnly);
}

function reachedFrom(run, fileIndex, starts) {
  const queue = run.records.filter((record) => record.fileIndex === fileIndex && starts(record));
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
 * @returns {Map<string, string>} the declarations that stay because Node loads the script, each with who loads it and what reaches it
 */
export function nodeKeeps(root, file, run, fileIndex) {
  const loaders = nodeLoadersOf(root, file);
  if (loaders.length === 0) return new Map();
  const keeps = new Map([...reachedInNode(run, fileIndex).inside].map((name) => [name, `${loaders[0]} loads the file in Node, alone, and what runs there reaches ${name}`]));
  const checked = typeChecked(root);
  const engine = loaders.find((loader) => checked(loader.slice(0, loader.lastIndexOf(':'))));
  if (!engine) return keeps;
  for (const name of reachedForPages(run, fileIndex).inside) {
    if (!keeps.has(name)) keeps.set(name, `${engine} loads the file in Node, so the type check reads it alone too, and its statement for pages reaches ${name}`);
  }
  return keeps;
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

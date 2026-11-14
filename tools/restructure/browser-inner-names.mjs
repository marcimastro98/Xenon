// A script made of functions taken out of a wrapper (browser-inner-plan.mjs) leaves one
// name on `window`, and every page that loads it gets that name. It must be nobody
// else's: not a word of any other file a page could run, not a name the browser itself
// has, not a name another page's script already leaves there. The first is read from
// the repo here; the other two come from a recording of the page check, which holds the
// names every page had on `window` and the ones an empty page has in that engine.

import { spawnSync } from 'node:child_process';

// Where code a page runs lives. Tests name things without running them in a page.
const SERVED = ['server', 'packages', ':!server/test', ':!packages/*/test'];
const wordOf = (name) => new RegExp(`(?<![\\w$])${name}(?![\\w$])`);

/**
 * @param {string} root
 * @param {{ name: string, from: string, file: string, takers?: string[] }[]} moves the names to look for, each with the two files that may hold it
 *   and the scripts made of the same wrapper later, which may take from it on the one line that does that
 * @returns {string[]} one line per other place that has a name as a word
 */
export function nameClashes(root, moves) {
  if (moves.length === 0) return [];
  const twice = moves.filter((move, at) => moves.findIndex((other) => other.name === move.name) !== at);
  const problems = twice.map((move) => `${move.file} would leave ${move.name} on window, the name another script made of moved functions leaves there`);
  const run = spawnSync('git', ['grep', '-n', '-w', '-F', '--untracked', ...moves.flatMap((move) => ['-e', move.name]), '--', ...SERVED],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git grep failed: ${run.stderr}`);
  for (const line of run.stdout.split('\n').filter(Boolean)) {
    const [file, at, ...rest] = line.split(':');
    const text = rest.join(':');
    for (const move of moves) {
      if (file === move.file || file === move.from || !wordOf(move.name).test(text)) continue;
      if (move.takers?.includes(file) && text.trimEnd().endsWith(`} = window.${move.name};`)) continue;
      problems.push(`${file}:${at} has ${move.name} as a word, the name ${move.file} leaves on window: a page would have two things under one name`);
    }
  }
  return problems;
}

/**
 * @param {any[]} moves the list of moves @returns {{ name: string, from: string, file: string, takers: string[] }[]} the name each script made of moved
 *   functions leaves on window, with the later scripts of the same wrapper that are recorded as taking from it
 */
export function namesMade(moves) {
  const inner = moves.filter((move) => move.kind === 'inner');
  return inner.map(({ name, from, file }) => ({ name, from, file, takers: inner.filter((other) => other.from === from && Object.hasOwn(other.takes ?? {}, name)).map((other) => other.file) }));
}

/**
 * @param {any} recording what browser-page-check.mjs wrote for the tree before the move
 * @param {string} name
 * @returns {string[]} why the name is taken in that recording, empty when it is free
 */
export function recordedClashes(recording, name) {
  const problems = [];
  if ((recording.engine?.blank ?? []).includes(name)) problems.push(`${name} is a name the browser itself has on window (${recording.engine.name})`);
  const pages = (recording.views ?? []).filter((view) => view.globals.includes(name) || name in (view.declared ?? {})).map((view) => view.name);
  if (pages.length) problems.push(`${name} is on window already on ${pages.join(', ')}`);
  return problems;
}

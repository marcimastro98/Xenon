// The tree on disk for dead-requires.mjs: which files the server has now, what each holds, and the
// one name of a file that can be reached under two. `extract` and `inner` ask it before they write,
// `verify` when it redoes a step that recorded a line as taken out.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { OUTSIDE } from './bare.mjs';
import { dropDeadRequires, leavesBare } from './dead-requires.mjs';

const posix = (file) => String(file).split(path.sep).join('/');

/**
 * The JavaScript of the server as it is on disk: what git tracks and what it does not know yet (a module an
 * earlier step of the same commit made). Where there is no git, every .js file under server/.
 * @param {string} root @returns {string[]} repo-relative
 */
export function serverFilesOnDisk(root) {
  const run = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'server'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let names;
  if (run.status === 0) names = run.stdout.split('\0');
  else {
    try { names = readdirSync(path.join(root, 'server'), { recursive: true }).map((name) => `server/${posix(name)}`); } catch { names = []; }
  }
  return names.filter((file) => file.endsWith('.js') && !OUTSIDE.test(file));
}

/**
 * @param {string} root
 * @returns {{ files: string[], read: (file: string) => string | null, real: (file: string) => string, known: Map<string, any> }}
 */
export function diskTree(root) {
  const texts = new Map();
  const read = (file) => {
    if (!texts.has(file)) {
      try { texts.set(file, readFileSync(path.join(root, file), 'utf8')); } catch { texts.set(file, null); }
    }
    return texts.get(file);
  };
  // server/shared is a link to packages/core: one file, one name.
  const real = (file) => {
    try { return posix(path.relative(root, realpathSync(path.join(root, file)))); } catch { return file; }
  };
  return { files: serverFilesOnDisk(root), read, real, known: new Map() };
}

/**
 * dropDeadRequires against the tree on disk. The tree is read only when the step leaves a line to ask about.
 * @param {{ root: string, parser: any, plan: any, source: string, target: string, only?: string[], tree?: ReturnType<typeof diskTree> }} job
 * @returns {ReturnType<typeof dropDeadRequires>}
 */
export function dropOnDisk({ root, parser, plan, source, target, only, tree }) {
  if (!leavesBare(plan) && !only?.length) return { plan, dropped: [], kept: [], problems: [] };
  return dropDeadRequires({ plan, source, target, parser, only, ...(tree ?? diskTree(root)) });
}

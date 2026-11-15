// After the moves: is the repo what the list of moves (moved.json) says, and nothing else?
//   - what an install gets (`git archive`, the only reading that follows export-ignore into folders) differs from the
//     base by the moved files alone: each one new at its new path, and gone from the old one until its line is there;
//   - no file still names an old path, except the line left at that path, the history and the map;
//   - every line left at an old path is the one line the tool writes.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { trackedFiles } from '../quality/repo-files.mjs';
import { readMoved, shimText } from './move-apply.mjs';
import { findSites } from './move-refs.mjs';

/**
 * @param {string} root @param {string} rev
 * @returns {Set<string>} the files of the archive git makes for a commit
 */
export function archiveList(root, rev) {
  const archive = spawnSync('git', ['archive', '--format=tar', rev], { cwd: root, maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error(`git archive ${rev} failed: ${archive.stderr}`);
  const listed = spawnSync('tar', ['-t'], { input: archive.stdout, maxBuffer: 1 << 28, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`tar could not list the archive: ${listed.stderr}`);
  return new Set(listed.stdout.split(/\r?\n/).filter((name) => name && !name.endsWith('/')));
}

/**
 * @param {Set<string>} before @param {Set<string>} after @param {{from: string, to: string, shim?: true}[]} moves
 * @returns {string[]} what differs beyond the moves, one sentence each
 */
export function archiveProblems(before, after, moves) {
  const problems = [];
  const news = new Set(moves.map((move) => move.to));
  const olds = new Map(moves.map((move) => [move.from, move]));
  for (const file of after) if (!before.has(file) && !news.has(file)) problems.push(`new in an install, and no move made it: ${file}`);
  for (const file of before) {
    if (after.has(file)) continue;
    if (!olds.has(file)) problems.push(`gone from an install, and no move took it: ${file}`);
    else if (olds.get(file).shim) problems.push(`the list says ${file} kept its line, and an install has no such file`);
  }
  for (const move of moves) {
    if (!after.has(move.to)) problems.push(`${move.to} is missing from an install (export-ignore, or never committed)`);
    if (!before.has(move.from)) problems.push(`${move.from} was not in an install at the base: not a move of this list`);
  }
  return problems;
}

/** @param {string} root @param {any} parser @returns {Set<string>} the old paths a file of the repo still names */
export function namedOldPaths(root, parser) {
  const { moves } = readMoved(root);
  const read = (file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };
  const olds = new Set(moves.map((move) => move.from));
  const sites = moves.length ? findSites({ files: trackedFiles(root), read, parser, moves }) : [];
  return new Set(sites.filter((site) => !olds.has(site.file)).map((site) => site.move.from));
}

/**
 * @param {string} root @param {any} parser
 * @returns {string[]} places that still name an old path, and lines at old paths that are not the tool's
 */
export function leftovers(root, parser) {
  const { moves } = readMoved(root);
  if (!moves.length) return [];
  const read = (file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };
  const shims = new Map(moves.filter((move) => move.shim).map((move) => [move.from, move]));
  const out = [];
  for (const [file, move] of shims) if (read(file) !== shimText(move)) out.push(`${file}: not the line the tool writes for ${move.to}`);
  const sites = findSites({ files: trackedFiles(root), read, parser, moves });
  for (const site of sites) if (!shims.has(site.file)) out.push(`${site.file}:${site.line} still says ${site.was}`);
  return out;
}

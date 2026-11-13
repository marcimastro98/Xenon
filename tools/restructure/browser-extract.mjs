// Does one browser move on disk: checks who reads the old file and where the new
// one may live, works the move out (browser-moves.mjs), writes the files, checks
// them and puts everything back if a check fails. Also redoes the recorded moves
// from a git revision, to show the files on disk are exactly what the tool writes.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { consumerProblems, keptNames } from './browser-consumers.mjs';
import { readBrowserLedger, writeBrowserLedger } from './browser-ledger.mjs';
import { applyMove } from './browser-moves.mjs';
import { listPages } from './browser-pages.mjs';
import { Refusal } from './extract-plan.mjs';
import { frozenTest, ownersOf } from './target-rules.mjs';
import { syntaxProblems } from './verify.mjs';

const KEBAB = '[a-z0-9]+(?:-[a-z0-9]+)*';
// The folders the engine serves to a page and whose tags get a version stamp (server/asset-version.js).
const SERVED = /^server\/(?:js|styles|components|shared)\//;

const git = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** @param {string} root @param {string} file @returns {boolean} true when the update archive leaves the file out */
export function leftOutOfUpdates(root, file) {
  return /: export-ignore: set$/m.test(git(root, ['check-attr', 'export-ignore', '--', file]).stdout);
}

/**
 * @param {string} root @param {any} move
 * @returns {string[]} why a new file of the move cannot live where it was put
 */
export function targetReasons(root, move) {
  const home = path.posix.dirname(move.from);
  const targets = move.kind === 'style' ? move.parts.map((part) => part.file) : [move.file];
  const shape = move.kind === 'style' ? new RegExp(`^${home}/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\\.css$`)
    : move.kind === 'inline' ? new RegExp(`^server/js/${KEBAB}\\.js$`)
      : new RegExp(`^${home}/(?:${KEBAB}/)?${KEBAB}\\.js$`);
  const where = move.kind === 'style' ? `next to ${move.from}, named like it`
    : move.kind === 'inline' ? 'server/js/<name>.js in lowercase kebab-case' : `${home}/<folder>/<name>.js in lowercase kebab-case`;
  const frozen = frozenTest(root);
  const owners = ownersOf(targets);
  const reasons = [];
  for (const target of targets) {
    if (!shape.test(target)) { reasons.push(`${target} is not ${where}`); continue; }
    if (!SERVED.test(target)) reasons.push(`${target} is not in a folder the engine serves to a page`);
    if (frozen(target)) reasons.push(`${target} is a frozen path (tools/map/frozen-paths.json)`);
    if (git(root, ['check-ignore', '-q', '--', target]).status === 0) reasons.push(`${target} is ignored by git: it would be missing from every install`);
    if (leftOutOfUpdates(root, target)) reasons.push(`${target} is left out of the update archive (.gitattributes export-ignore): an updated install would not get it`);
    if (!owners.get(target)) reasons.push(`no feature owns ${target}: add a pattern for it to tools/map/features.json first (then npm run map)`);
  }
  return reasons;
}

const diskTree = (root) => ({
  get: (file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
});

function undo(root, files, made, before) {
  for (const file of files.keys()) {
    if (!made.includes(file)) { writeFileSync(path.join(root, file), before.get(file)); continue; }
    rmSync(path.join(root, file), { force: true });
    const folder = path.dirname(path.join(root, file));
    if (readdirSync(folder).length === 0) rmdirSync(folder);
  }
}

/**
 * @param {{ root: string, parser: any, move: any, dryRun?: boolean }} job
 * @returns {{ record: any, made: string[], lines: Record<string, number> }} the line added to the list of moves, the new
 *   files and the length of every file written. Throws a Refusal before anything is written, an Error after a failed check (files put back).
 */
export function perform({ root, parser, move, dryRun = false }) {
  const ledger = readBrowserLedger(root);
  // The tests are held to the reader by server/test/restructure-browser-state.test.mjs, once the first move is done.
  const reasons = move.kind === 'inline' ? [] : consumerProblems(root, move.from, { tests: false });
  reasons.push(...targetReasons(root, move));
  const kept = keptNames(root, move.from);
  for (const name of move.names ?? []) if (kept.has(name)) reasons.push(`${name} stays in ${move.from}: ${kept.get(name)} reads it there`);
  if (reasons.length) throw new Refusal(reasons);
  const tree = diskTree(root);
  const { files, made, record } = applyMove(tree, move, { parser, pages: listPages(root), earlier: ledger.moves });
  const lines = Object.fromEntries([...files].map(([file, text]) => [file, text.split('\n').length - 1]));
  if (dryRun) return { record, made, lines };

  const before = new Map([...files.keys()].map((file) => [file, tree.get(file)]));
  for (const [file, text] of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  const problems = syntaxProblems(root, [...files.keys()].filter((file) => file.endsWith('.js')));
  if (problems.length) {
    undo(root, files, made, before);
    throw new Error(`the move failed its checks and was undone:\n${problems.join('\n')}`);
  }
  ledger.moves.push(record);
  writeBrowserLedger(root, ledger);
  return { record, made, lines };
}

/** @param {string} root @param {string} rev @param {string} file @returns {string | null} the file at that revision, null when it has none */
export function showAt(root, rev, file) {
  const run = git(root, ['show', `${rev}:${file}`]);
  return run.status === 0 ? run.stdout : null;
}

const newFilesOf = (move) => (move.kind === 'style' ? move.parts.map((part) => part.file) : [move.file]);

/**
 * Redoes every recorded move the revision does not have yet, starting from the
 * revision's files, and compares every file a move wrote with the one on disk.
 * @param {{ root: string, parser: any, base: string, show?: (root: string, rev: string, file: string) => string | null }} job
 * @returns {{ problems: string[], replayed: number, compared: string[] }}
 */
export function replay({ root, parser, base, show = showAt }) {
  const ledger = readBrowserLedger(root);
  const texts = new Map();
  const tree = {
    get: (file) => { if (!texts.has(file)) texts.set(file, show(root, base, file)); return texts.get(file); },
  };
  const pages = listPages(root);
  const problems = [];
  const written = new Set();
  let replayed = 0;
  ledger.moves.forEach((move, index) => {
    const made = newFilesOf(move);
    const there = made.filter((file) => show(root, base, file) !== null);
    if (there.length === made.length) return;
    if (there.length) { problems.push(`${base} has ${there.join(', ')} but not the rest of that move`); return; }
    let done;
    try {
      done = applyMove(tree, move, { parser, pages, earlier: ledger.moves.slice(0, index) });
    } catch (error) {
      problems.push(`${made[0]}: the recorded move cannot be redone from ${base}: ${error instanceof Refusal ? error.reasons.join('; ') : error.message}`);
      return;
    }
    if (JSON.stringify(done.record) !== JSON.stringify(move)) problems.push(`${made[0]}: redone from ${base}, the move is not the one recorded`);
    for (const [file, text] of done.files) { texts.set(file, text); written.add(file); }
    replayed += 1;
  });
  for (const file of written) {
    const onDisk = existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null;
    if (onDisk === texts.get(file)) continue;
    problems.push(onDisk === null ? `${file} is missing` : ledger.moves.some((move) => newFilesOf(move).includes(file))
      ? `${file} is not what the tool writes: it was edited by hand after the move`
      : `${file} differs from ${base} by more than the recorded moves: commit other edits apart from a move`);
  }
  return { problems, replayed, compared: [...written] };
}

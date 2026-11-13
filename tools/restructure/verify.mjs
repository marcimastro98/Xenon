// Proves an extraction moved text and changed nothing else: the moved bytes are
// the same, every line of the old file is accounted for, both files still parse,
// and the type check finds no name that lost its declaration (numbers from ratchets.mjs).

import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { requireEditProblem } from './require-edits.mjs';

const UNKNOWN_NAME = ['TS2304', 'TS2552'];

const tally = (counts, lines, by) => { for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + by); };

/**
 * The checks that need only the texts. Written without the planner's own helpers,
 * so a mistake there shows up here.
 * @param {object} move
 * @param {string} move.before the old file before
 * @param {string} move.after the old file after
 * @param {string} move.moduleText the new module
 * @param {{ ranges: number[][], glue: { sourceAt: number, sourceLines: string[], moduleLines: number[],
 *   edits?: { at: number, oldLines: string[], newLines: string[] }[] } }} move.plan
 * @returns {string[]} problems, empty when the move is proven
 */
export function proveMove({ before, after, moduleText, plan }) {
  const problems = [];
  const old = before.split('\n');
  const now = after.split('\n');
  const made = moduleText.split('\n').slice(0, -1);
  const { sourceAt, sourceLines, moduleLines, edits = [] } = plan.glue;

  // 1. The moved text is byte for byte the old ranges, in the old order.
  let from = 0;
  for (const [start, end] of plan.ranges) {
    const piece = old.slice(start - 1, end).join('\n') + '\n';
    const at = moduleText.indexOf(piece, from);
    if (at === -1) problems.push(`lines ${start}-${end} of the old file are not in the new module unchanged`);
    else from = at + piece.length;
  }

  // 2. Every line of the old file is in the old file or the new module, and nothing else is, but the glue.
  const counts = new Map();
  tally(counts, old, 1);
  tally(counts, now, -1);
  tally(counts, made, -1);
  tally(counts, sourceLines, 1);
  tally(counts, moduleLines.map((index) => made[index]), 1);
  for (const edit of edits) { tally(counts, edit.oldLines, -1); tally(counts, edit.newLines, 1); }
  const off = [...counts].filter(([, n]) => n !== 0);
  if (off.length) {
    const shown = off.slice(0, 5).map(([line, n]) => `${n > 0 ? 'lost' : 'extra'} x${Math.abs(n)}: ${JSON.stringify(line.slice(0, 80))}`);
    problems.push(`${off.length} lines are not accounted for (${shown.join('; ')})`);
  }

  // 3. Outside the moved ranges the old file is untouched: without the glue it is the old text without the ranges.
  const gone = new Set();
  for (const [start, end] of plan.ranges) for (let line = start; line <= end; line += 1) gone.add(line - 1);
  const expected = old.filter((_, index) => !gone.has(index)).join('\n');
  if (now.slice(sourceAt, sourceAt + sourceLines.length).join('\n') !== sourceLines.join('\n')) {
    problems.push('the new require is not where the plan put it');
  }
  // Undo the glue and the shrunk requires from the bottom up, so earlier line numbers stay true. Lines that
  // went altogether leave nothing behind, so two of them next to each other come back at the same place:
  // the one that was lower in the old file first.
  const undone = [...now];
  const patches = [{ at: sourceAt, drop: sourceLines.length, put: [] }, ...edits.map((edit, order) => ({ at: edit.at, drop: edit.newLines.length, put: edit.oldLines, order }))];
  for (const { at, drop, put } of patches.sort((a, b) => b.at - a.at || b.drop - a.drop || b.order - a.order)) undone.splice(at, drop, ...put);
  if (undone.join('\n') !== expected) problems.push('text outside the moved ranges changed');
  for (const edit of edits) {
    const wrong = requireEditProblem(edit.oldLines, edit.newLines, moduleText);
    if (wrong) problems.push(wrong);
  }
  return problems;
}

/** @param {string} root @param {string[]} files repo-relative @returns {string[]} problems */
export function syntaxProblems(root, files) {
  return files.flatMap((file) => {
    const run = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    return run.status === 0 ? [] : [`node --check ${file}: ${String(run.stderr).trim().split('\n').slice(0, 4).join(' | ')}`];
  });
}

/**
 * @param {Record<string, number>} counts type errors per "file code", as typecheck.mjs counts them
 * @param {Record<string, number>} baseline the saved numbers
 * @param {string[]} files the old file and the modules taken out of it
 * @returns {string[]} problems: "cannot find name" errors the group did not have before
 */
export function unknownNameProblems(counts, baseline, files) {
  return UNKNOWN_NAME.flatMap((code) => {
    const sum = (table) => files.reduce((total, file) => total + (table[`${file} ${code}`] ?? 0), 0);
    const [was, now] = [sum(baseline), sum(counts)];
    if (now <= was) return [];
    const where = files.filter((file) => (counts[`${file} ${code}`] ?? 0) > 0).join(', ');
    return [`${now - was} new ${code} (cannot find name) in ${where}: a moved name lost its declaration`];
  });
}

// Runs the type check and the lint of tools/quality and moves their saved numbers
// along with moved code. Both checks count per file, so code that goes from one
// file to another would read as "new findings" there: here the old file and its
// modules are one group, and the group's total per rule may only go down.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCounts, saveCounts } from '../quality/baseline-file.mjs';
import { countLintFindings } from '../quality/lint.mjs';
import { countTypeErrors } from '../quality/typecheck.mjs';

const QUALITY = ['tools', 'quality'];
const CHECKS = {
  types: { baseline: 'types-server.json', run: typeCounts },
  lint: { baseline: 'lint.json', run: lintCounts },
};

/** @param {string} root @returns {boolean} false until `npm run quality:install` has run */
export function checksAvailable(root) {
  return existsSync(path.join(root, ...QUALITY, 'node_modules', 'typescript', 'bin', 'tsc'));
}

/** @param {string} root @returns {Record<string, number>} type errors per "file code", today */
export function typeCounts(root) {
  const cwd = path.join(root, ...QUALITY);
  const run = spawnSync(process.execPath, [path.join(cwd, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', path.join(cwd, 'tsconfig.server.json'), '--pretty', 'false'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.error) throw run.error;
  return countTypeErrors(`${run.stdout}\n${run.stderr}`, cwd, root);
}

/** @param {string} root @returns {Record<string, number>} lint findings per "file rule", today */
export function lintCounts(root) {
  const quality = path.join(root, ...QUALITY);
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-lint-'));
  const out = path.join(folder, 'report.json');
  try {
    const run = spawnSync(process.execPath, [path.join(quality, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'), 'lint',
      `--config-path=${path.join(quality, 'lint.config.json')}`, '--reporter=json', `--reporter-file=${out}`,
      '--max-diagnostics=none', '--diagnostic-level=warn', 'server', 'packages', 'tools'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (!existsSync(out)) throw new Error(`The linter wrote no report.\n${run.stdout}\n${run.stderr}`);
    return countLintFindings(JSON.parse(readFileSync(out, 'utf8')));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** @param {string} root @returns {Record<string, number>} the saved type numbers */
export function typeBaseline(root) {
  return readCounts(path.join(root, ...QUALITY, 'baseline', CHECKS.types.baseline));
}

/**
 * Moves saved numbers along with moved code: a finding that went from the old file
 * to a new module is the same finding, not a new one.
 * @param {Record<string, number>} baseline saved numbers per "file rule"
 * @param {Record<string, number>} current today's numbers
 * @param {string[]} files the old file and the modules taken out of it
 * @returns {{ next: Record<string, number>, problems: string[] }} `next` is the baseline
 *   with the group's keys set to today's numbers and every other key left alone
 */
export function carryCounts(baseline, current, files) {
  const group = new Set(files);
  const fileOf = (key) => key.slice(0, key.lastIndexOf(' '));
  const ruleOf = (key) => key.slice(key.lastIndexOf(' ') + 1);
  const inGroup = (key) => group.has(fileOf(key));
  const rules = new Set([...Object.keys(baseline), ...Object.keys(current)].filter(inGroup).map(ruleOf));
  const problems = [];
  for (const rule of rules) {
    const total = (table) => files.reduce((sum, file) => sum + (table[`${file} ${rule}`] ?? 0), 0);
    if (total(current) > total(baseline)) {
      problems.push(`${rule}: ${total(baseline)} before the move, ${total(current)} after, across ${files[0]} and its modules`);
    }
  }
  const next = Object.fromEntries(Object.entries(baseline).filter(([key]) => !inGroup(key)));
  for (const [key, count] of Object.entries(current)) if (inGroup(key)) next[key] = count;
  return { next, problems };
}

/**
 * Carries both checks' numbers for every group and saves them when no group got worse.
 * @param {string} root
 * @param {string[][]} groups each one: the old file first, then its modules
 * @returns {{ check: string, problems: string[], before: number, after: number }[]}
 */
export function carryAll(root, groups) {
  return Object.entries(CHECKS).map(([check, { baseline, run }]) => {
    const file = path.join(root, ...QUALITY, 'baseline', baseline);
    const saved = readCounts(file);
    const current = run(root);
    let next = saved;
    const problems = [];
    for (const files of groups) {
      const carried = carryCounts(next, current, files);
      next = carried.next;
      problems.push(...carried.problems);
    }
    const inGroups = (table) => groups.flat().reduce((sum, name) => sum
      + Object.entries(table).filter(([key]) => key.startsWith(`${name} `)).reduce((n, [, count]) => n + count, 0), 0);
    if (problems.length === 0) saveCounts(file, JSON.parse(readFileSync(file, 'utf8')).note, next);
    return { check, problems, before: inGroups(saved), after: inGroups(next) };
  });
}

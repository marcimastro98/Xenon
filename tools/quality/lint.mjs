// Lints the JavaScript (Biome, recommended rules) and compares the result with
// the saved numbers: a file may lose findings, never gain them.
// Only errors and warnings count. Style hints are left out on purpose.
//
//   npm run lint             check
//   npm run lint -- --update save the lower numbers after a clean-up
//   npm run lint -- --rebase save whatever today's numbers are (new Biome, new rules)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCounts, saveCounts, sum } from './baseline-file.mjs';
import { compareCounts } from './ratchet.mjs';
import { REPO_ROOT } from './repo-files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIOME = path.join(HERE, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const CONFIG = path.join(HERE, 'lint.config.json');
const BASELINE = path.join(HERE, 'baseline', 'lint.json');
const NOTE = 'Lint findings per "file rule". Written by tools/quality/lint.mjs: numbers only go down.';
const LINTED = ['server', 'packages', 'tools'];
const COUNTED = new Set(['error', 'warning']);

function keyOf(finding) {
  const file = String(finding.location?.path ?? '').split(path.sep).join('/');
  return `${file} ${String(finding.category).replace(/^lint\//, '')}`;
}

/**
 * Turns Biome's report into one number per "file · rule".
 * @param {{ diagnostics?: object[] }} report Biome's JSON report
 * @returns {Record<string, number>}
 */
export function countLintFindings(report) {
  const counts = {};
  for (const finding of report.diagnostics ?? []) {
    if (!COUNTED.has(finding.severity)) continue;
    const key = keyOf(finding);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function runLinter() {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-lint-'));
  const out = path.join(folder, 'report.json');
  try {
    const run = spawnSync(process.execPath, [
      BIOME, 'lint', `--config-path=${CONFIG}`, '--reporter=json', `--reporter-file=${out}`,
      '--max-diagnostics=none', '--diagnostic-level=warn', ...LINTED,
    ], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (!existsSync(out)) throw new Error(`The linter wrote no report.\n${run.stdout}\n${run.stderr}`);
    return JSON.parse(readFileSync(out, 'utf8'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function printWorse(report, worse) {
  console.log('\nNew lint findings:');
  const wanted = new Set(worse.map((row) => row.key));
  for (const finding of report.diagnostics ?? []) {
    if (!COUNTED.has(finding.severity) || !wanted.has(keyOf(finding))) continue;
    const at = finding.location?.start ?? {};
    console.log(`  ${keyOf(finding).replace(' ', `(${at.line},${at.column}): `)} ${String(finding.message).split('\n')[0]}`);
  }
}

function main(args) {
  if (!existsSync(BIOME)) {
    console.error('Biome is not installed here. Run: npm run quality:install');
    return 1;
  }
  const report = runLinter();
  const counts = countLintFindings(report);
  if (args.includes('--rebase')) {
    console.log(`Saved: ${saveCounts(BASELINE, NOTE, counts)} lint findings are the new starting point.`);
    return 0;
  }
  const { worse, better } = compareCounts(readCounts(BASELINE), counts);
  if (worse.length > 0) {
    printWorse(report, worse);
    return 1;
  }
  if (args.includes('--update')) {
    console.log(`Saved: ${saveCounts(BASELINE, NOTE, counts)} lint findings left.`);
    return 0;
  }
  console.log(`Lint: no new findings (${sum(counts)} old ones left).`);
  if (better.length > 0) console.log(`${better.length} entries got better. Save them with: npm run lint -- --update`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

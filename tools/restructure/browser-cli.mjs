// The browser side of tools/restructure: takes a big classic script, a stylesheet
// or a script written inside a page apart, and proves each move changed nothing.
// Run through cli.mjs. Needs `npm run quality:install` once.
//
//   node tools/restructure/cli.mjs browser analyze <script> [--json]       what may move to an earlier script, what stays and why
//   node tools/restructure/cli.mjs browser extract --from <script> --to <new script> --about "<one sentence>"
//                                                  [--dry-run] <name | first..last> ...
//   node tools/restructure/cli.mjs browser cuts <stylesheet>               the lines where a stylesheet opens a section
//   node tools/restructure/cli.mjs browser split-css <stylesheet> [--dry-run] <line>:<Part.css> ...
//   node tools/restructure/cli.mjs browser inline --from <page> --to <new script> --about "<one sentence>" [--nth 0]
//   node tools/restructure/cli.mjs browser apply <plan.json> [--dry-run]   several moves: [{ from, to, about, picks }, { css, cuts }]
//   node tools/restructure/cli.mjs browser consumers <file>                who names a browser file in code
//   node tools/restructure/cli.mjs browser tests <file> [--write]          point the tests that read it as text at the reader
//   node tools/restructure/cli.mjs browser verify [--base HEAD]            redo the recorded moves from a revision, compare bytes
//   node tools/restructure/cli.mjs browser carry                           move the lint numbers along with the code

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readCounts, saveCounts } from '../quality/baseline-file.mjs';
import { analyzeRun, assignedAtHome, orderProblems, stayReasons } from './browser-analyze.mjs';
import { keptNames, mentionsOf } from './browser-consumers.mjs';
import { perform, replay, showAt } from './browser-extract.mjs';
import { readBrowserLedger, runOf, splitFiles } from './browser-ledger.mjs';
import { resolvePicks } from './browser-plan.mjs';
import { stateProblems } from './browser-state.mjs';
import { readStylesheet } from './browser-styles.mjs';
import { retargetTests } from './browser-test-readers.mjs';
import { Refusal } from './extract-plan.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';
import { carryCounts, checksAvailable, lintCounts } from './ratchets.mjs';
import { syntaxProblems } from './verify.mjs';

const VALUE_FLAGS = new Set(['--from', '--to', '--about', '--base', '--nth']);
const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
const read = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

function readArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_FLAGS.has(argv[i])) { flags[argv[i].slice(2)] = argv[i + 1]; i += 1; }
    else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = true;
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

/**
 * Every top-level statement of a script with the reason it stays, or none when it may move.
 * A `const` that needs something which itself stays is found by trying: all that may move
 * is placed in a script before, and what then reads a value too early stays as well.
 * @param {string} file @param {any} parser
 * @returns {{ records: any[], why: Map<any, string[]> }}
 */
export function movable(file, parser) {
  const scripts = runOf(readBrowserLedger(REPO_ROOT), file).filter((part) => part.endsWith('.js')).map((part) => ({ file: part, text: read(part) }));
  const run = analyzeRun(scripts, parser);
  const own = run.records.filter((record) => record.fileIndex === scripts.length - 1);
  const kept = keptNames(REPO_ROOT, file);
  const why = new Map(own.map((record) => [record, [...stayReasons(record, run),
    ...record.names.filter((name) => kept.has(name)).map((name) => `${name} stays: ${kept.get(name)} reads it in this file`)]]));
  // A function's `window.name = name;` goes where the function goes, and nowhere else.
  for (const record of own) {
    const holder = record.echo && own.find((entry) => entry.names.includes(record.echo));
    if (record.echo && !(holder && why.get(holder).length === 0)) why.get(record).push(`it goes only with the function ${record.echo}, which stays`);
  }
  // A `let` that stays keeps the one statement that assigns it.
  for (const [name, writers] of assignedAtHome(run)) {
    const holder = run.bindings.get(name).record;
    if (writers.length === 1 && why.has(holder) && why.get(holder).length > 0 && why.get(writers[0]).length === 0) {
      why.get(writers[0]).push(`it is the only code that assigns ${name}, which stays`);
    }
  }
  for (let again = true; again;) {
    // The scripts already taken out keep their place, then what may move, then what stays.
    const placeOf = (record) => (!why.has(record) ? record.fileIndex : why.get(record).length === 0 ? scripts.length - 1 : scripts.length);
    const trial = run.records.map((record) => ({ ...record, fileIndex: placeOf(record), was: record.order }));
    trial.sort((a, b) => a.fileIndex - b.fileIndex || a.order - b.order).forEach((record, index) => { record.order = index; });
    const byOldPlace = new Map(trial.map((record) => [record.was, record]));
    const bindings = new Map([...run.bindings].map(([name, binding]) => [name, { ...binding, record: byOldPlace.get(binding.record.order) }]));
    again = false;
    for (const record of trial) {
      if (record.fileIndex !== scripts.length - 1) continue;
      const problems = orderProblems({ records: trial, bindings }, (candidate) => candidate === record);
      if (problems.length) { why.set(run.records[record.was], problems); again = true; }
    }
  }
  return { records: own, why };
}

function showAnalysis(parser, { flags, rest }) {
  const file = posix(rest[0]);
  const { records, why } = movable(file, parser);
  const rows = records.map((record) => ({ lines: record.range, kind: record.kind, names: record.names, stays: why.get(record) }));
  if (flags.json) { console.log(JSON.stringify(rows, null, 1)); return 0; }
  const size = (list) => list.reduce((sum, row) => sum + row.lines[1] - row.lines[0] + 1, 0);
  const free = rows.filter((row) => row.stays.length === 0);
  console.log(`${file}: ${rows.length} top-level statements. ${free.length} may move (${size(free)} lines), ${rows.length - free.length} stay (${size(rows) - size(free)} lines).`);
  for (const row of rows) {
    const what = row.names.join(', ') || '(code that runs while the page loads)';
    console.log(`${row.stays.length ? 'stays' : 'moves'} ${String(row.lines[0]).padStart(6)}-${String(row.lines[1]).padEnd(6)} ${row.kind} ${what}${row.stays.length ? `  # ${row.stays[0]}` : ''}`);
  }
  return 0;
}

function toMove(job, parser) {
  if (job.css) {
    return { kind: 'style', from: posix(job.css), parts: job.cuts.map((cut) => {
      const [at, name] = String(cut).split(':');
      return { file: `${path.posix.dirname(posix(job.css))}/${name}`, at: Number(at) };
    }) };
  }
  if (job.inline) return { kind: 'inline', from: posix(job.inline), file: posix(job.to), about: job.about, nth: Number(job.nth ?? 0) };
  const from = posix(job.from);
  const { records, why } = movable(from, parser);
  const picked = resolvePicks(records, job.picks, (record) => why.get(record).length === 0);
  if (picked.unknown.length) throw new Refusal(picked.unknown.map((pick) => `${from} has no ${pick} at its top level, or its two ends are the wrong way round`));
  return { kind: 'script', from, file: posix(job.to), about: job.about, names: picked.names, skipped: picked.skipped };
}

function runMoves(parser, jobs, dryRun) {
  for (const job of jobs) {
    const move = toMove(job, parser);
    const done = perform({ root: REPO_ROOT, parser, move, dryRun });
    const sizes = done.made.map((file) => `${file} (${done.lines[file]} lines)`).join(', ');
    console.log(`${dryRun ? 'would write' : 'wrote'} ${sizes}; ${move.from} ${dryRun ? 'would be' : 'is'} ${done.lines[move.from]} lines.`);
    if (move.skipped?.length) console.log(`  left in place inside the ranges: ${move.skipped.join(', ')}`);
  }
  if (!dryRun) console.log('Next: browser verify, browser carry, then npm run sizes -- --update and npm run map.');
  return 0;
}

function showCuts({ rest }) {
  const text = read(posix(rest[0]));
  const { between, problems } = readStylesheet(text);
  if (problems.length) { console.error(problems.join('\n')); return 1; }
  const lines = text.split('\n');
  console.log(`${posix(rest[0])}: ${lines.length - 1} lines. Comments that open a section between two rules:`);
  lines.forEach((line, index) => {
    if (between.has(index + 1) && /^\/\*\s*(?:[=─━═-]{2,}|[A-Z0-9])/.test(line) && (index === 0 || lines[index - 1].trim() === '')) {
      console.log(`${String(index + 1).padStart(6)}  ${line.slice(0, 110)}`);
    }
  });
  return 0;
}

function showConsumers({ rest }) {
  for (const mention of mentionsOf(REPO_ROOT, posix(rest[0]))) {
    console.log(`${mention.kind.padEnd(5)} ${mention.file}:${mention.lines.slice(0, 5).join(',')}${mention.kind === 'test' && mention.reader ? '  (through the reader)' : ''}`);
  }
  return 0;
}

function moveTests({ flags, rest }) {
  const { changed, byHand } = retargetTests(REPO_ROOT, posix(rest[0]), Boolean(flags.write));
  console.log(`${changed.length} tests ${flags.write ? 'now read' : 'would read'} ${posix(rest[0])} through server/test/browser-source.mjs.`);
  if (byHand.length) console.log(`By hand (they name the file without a plain readFileSync import):\n  ${byHand.join('\n  ')}`);
  return 0;
}

function verify(parser, { flags }) {
  const base = flags.base || 'HEAD';
  const { problems, replayed, compared } = replay({ root: REPO_ROOT, parser, base });
  const state = stateProblems({ root: REPO_ROOT, parser, base: (file) => showAt(REPO_ROOT, base, file) });
  problems.push(...state.problems, ...syntaxProblems(REPO_ROOT, state.files.filter((file) => file.endsWith('.js'))));
  if (problems.length) { console.error(problems.join('\n')); return 1; }
  console.log(`Proven: ${replayed} moves redone from ${base} give the ${compared.length} files on disk byte for byte. Every moved line is unchanged, `
    + `the ${state.files.length} files of the splits load in a row on every page, declare each name once, and none of the new scripts runs code while it loads.`);
  return 0;
}

function carry() {
  if (!checksAvailable(REPO_ROOT)) { console.error('the lint is not installed (npm run quality:install)'); return 1; }
  const ledger = readBrowserLedger(REPO_ROOT);
  const file = path.join(REPO_ROOT, 'tools', 'quality', 'baseline', 'lint.json');
  const saved = readCounts(file);
  const current = lintCounts(REPO_ROOT);
  let next = saved;
  const problems = [];
  for (const source of splitFiles(ledger)) {
    const carried = carryCounts(next, current, runOf(ledger, source));
    next = carried.next;
    problems.push(...carried.problems);
  }
  if (problems.length) { console.error(`lint: the moved code has more findings than before, nothing saved:\n  ${problems.join('\n  ')}`); return 1; }
  saveCounts(file, JSON.parse(readFileSync(file, 'utf8')).note, next);
  console.log('lint: the numbers of the split files moved along with their code, saved.');
  return 0;
}

/** @param {string[]} argv what follows `browser` on the command line @returns {Promise<number>} the exit code */
export async function main(argv) {
  const [command, ...tail] = argv;
  const args = readArgs(tail);
  const { flags, rest } = args;
  const complete = { analyze: rest.length === 1, cuts: rest.length === 1, consumers: rest.length === 1, tests: rest.length === 1, apply: rest.length === 1, verify: true, carry: true,
    extract: Boolean(flags.from && flags.to && rest.length), 'split-css': rest.length >= 2, inline: Boolean(flags.from && flags.to) }[command];
  if (!complete) {
    console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(4, 16).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    return 2;
  }
  if (command === 'carry') return carry();
  if (command === 'cuts') return showCuts(args);
  if (command === 'consumers') return showConsumers(args);
  if (command === 'tests') return moveTests(args);
  const parser = await openParser();
  try {
    if (command === 'analyze') return showAnalysis(parser, args);
    if (command === 'verify') return verify(parser, args);
    const dryRun = Boolean(flags['dry-run']);
    if (command === 'apply') return runMoves(parser, JSON.parse(readFileSync(rest[0], 'utf8')), dryRun);
    if (command === 'split-css') return runMoves(parser, [{ css: rest[0], cuts: rest.slice(1) }], dryRun);
    if (command === 'inline') return runMoves(parser, [{ inline: flags.from, to: flags.to, about: flags.about, nth: flags.nth }], dryRun);
    return runMoves(parser, [{ from: flags.from, to: flags.to, about: flags.about, picks: rest }], dryRun);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`Refused:\n  ${error.reasons.join('\n  ')}`);
    return 1;
  } finally {
    parser.close();
  }
}

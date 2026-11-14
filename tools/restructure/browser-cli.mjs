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
//   node tools/restructure/cli.mjs browser module <script> [--dry-run]     turn a classic script that runs last into an ES module
//   node tools/restructure/cli.mjs browser module --list [--all]           which scripts can become a module today, and what keeps the others
//   node tools/restructure/cli.mjs browser consumers <file>                who names a browser file in code
//   node tools/restructure/cli.mjs browser tests <file> [--write]          point the tests that read it as text at the reader
//   node tools/restructure/cli.mjs browser verify [--base HEAD]            redo the recorded moves from a revision, compare bytes
//   node tools/restructure/cli.mjs browser carry                           move the lint numbers along with the code

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readCounts, saveCounts } from '../quality/baseline-file.mjs';
import { analyzeRun, assignedAtHome, orderProblems, stayReasons } from './browser-analyze.mjs';
import { keptNames, mentionsOf } from './browser-consumers.mjs';
import { everyPage, perform, replay, showAt } from './browser-extract.mjs';
import { readBrowserLedger, runOf, splitFiles } from './browser-ledger.mjs';
import { candidates } from './browser-module.mjs';
import { nodeKeeps } from './browser-node-loads.mjs';
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
  const inNode = nodeKeeps(REPO_ROOT, file, run, scripts.length - 1);
  const why = new Map(own.map((record) => [record, [...stayReasons(record, run),
    ...record.names.filter((name) => kept.has(name)).map((name) => `${name} stays: ${kept.get(name)} reads it in this file`),
    ...record.names.filter((name) => inNode.has(name)).map((name) => `${name} stays: ${inNode.get(name)} loads this file in Node, alone, and what runs there reaches it`)]]));
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

// What keeps a classic script from becoming a module, by kind (browser-module.mjs), as the list says it.
const HOLDS = { place: 'do not run last in a page', loader: 'are loaded by a list, a loader or Node', names: 'have a name another file has as a word',
  code: 'have code that means something else in a module', split: 'are part of a split', page: 'are loaded by no page, or by one the page check never opens' };

function listModules(parser, { flags }) {
  const rows = candidates({ root: REPO_ROOT, parser, ledger: readBrowserLedger(REPO_ROOT), pages: everyPage(REPO_ROOT) });
  const classic = rows.filter((row) => !row.module);
  const free = classic.filter((row) => row.reasons.length === 0);
  for (const row of free) console.log(`can   ${row.file} (${row.names.length} names leave the shared scope)`);
  if (flags.all) for (const row of classic.filter((entry) => entry.reasons.length)) console.log(`stays ${row.file}  # ${row.reasons[0].text}${row.reasons.length > 1 ? ` (+${row.reasons.length - 1})` : ''}`);
  const held = (kind, test) => classic.filter((row) => row.reasons.length && row.reasons[test]((reason) => reason.kind === kind)).length;
  console.log(`${rows.length - classic.length} modules, ${classic.length} classic scripts: ${free.length} can become a module today.`);
  console.log(`What keeps the others (a script can have several): ${Object.entries(HOLDS).map(([kind, text]) => `${held(kind, 'some')} ${text}`).join('; ')}.`);
  console.log(`Only their place holds back ${held('place', 'every')} of them, only a name ${held('names', 'every')}.`);
  return 0;
}

function convert(parser, { flags, rest }) {
  const file = posix(rest[0]);
  const dryRun = Boolean(flags['dry-run']);
  const done = perform({ root: REPO_ROOT, parser, move: { kind: 'module', file }, dryRun });
  const pages = Object.keys(done.lines).filter((name) => name.endsWith('.html'));
  console.log(`${file} ${dryRun ? 'would be' : 'is'} a module: ${pages.join(', ')} ${pages.length === 1 ? 'loads' : 'load'} it with type="module", and ${done.record.names.length} of its names leave the shared scope.`);
  if (!dryRun) console.log('Next: the page check before and after (side-copy.mjs record, browser-page-check.mjs compare), browser verify, npm run browser -- --update.');
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

/**
 * A script that was written inside a page is old code the lint reads for the first time, because it
 * does not read pages. Its findings are saved once, in the change that makes the file; from then on
 * the file is like any other and its numbers only go down.
 * @param {Record<string, number>} baseline saved numbers per "file rule"
 * @param {Record<string, number>} current today's numbers
 * @param {string[]} files scripts that came out of a page and are new in this change
 * @returns {{ next: Record<string, number>, added: string[] }}
 */
export function firstReadCounts(baseline, current, files) {
  const next = { ...baseline };
  const added = [];
  for (const [key, count] of Object.entries(current)) {
    if (!files.includes(key.slice(0, key.lastIndexOf(' '))) || key in baseline) continue;
    next[key] = count;
    added.push(`${key}: ${count}`);
  }
  return { next, added };
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
  const fromPages = ledger.moves.filter((move) => move.kind === 'inline' && showAt(REPO_ROOT, 'HEAD', move.file) === null).map((move) => move.file);
  const first = firstReadCounts(next, current, fromPages);
  saveCounts(file, JSON.parse(readFileSync(file, 'utf8')).note, first.next);
  console.log('lint: the numbers of the split files moved along with their code, saved.');
  if (first.added.length) console.log(`lint: code that was inside a page is read for the first time, its findings saved as they are:\n  ${first.added.join('\n  ')}`);
  return 0;
}

/** @param {string[]} argv what follows `browser` on the command line @returns {Promise<number>} the exit code */
export async function main(argv) {
  const [command, ...tail] = argv;
  const args = readArgs(tail);
  const { flags, rest } = args;
  const complete = { analyze: rest.length === 1, cuts: rest.length === 1, consumers: rest.length === 1, tests: rest.length === 1, apply: rest.length === 1, verify: true, carry: true,
    extract: Boolean(flags.from && flags.to && rest.length), 'split-css': rest.length >= 2, inline: Boolean(flags.from && flags.to),
    module: flags.list ? rest.length === 0 : rest.length === 1 }[command];
  if (!complete) {
    console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(4, 18).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
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
    if (command === 'module') return flags.list ? listModules(parser, args) : convert(parser, args);
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

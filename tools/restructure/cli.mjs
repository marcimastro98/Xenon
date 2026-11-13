#!/usr/bin/env node
// Takes a big CommonJS file apart by moving declarations into feature modules,
// and proves each move changed nothing. Needs `npm run quality:install` once.
//
//   node tools/restructure/cli.mjs analyze <file> [--json] [--names a,b]
//   node tools/restructure/cli.mjs extract --from <file> --to <dir>/<feature>/<file>.js --about "<one sentence>"
//                                          [--with-deps] [--dry-run] <name> [<name> ...]
//   node tools/restructure/cli.mjs apply <plan.json>               several extractions: [{ from, to, about, names }], put in an
//                                                                  order that works; run again after a refusal, done ones are skipped
//   node tools/restructure/cli.mjs verify [--base HEAD]            redo the recorded moves from a revision, compare bytes
//   node tools/restructure/cli.mjs carry                           move the type and lint numbers along with the code
//   node tools/restructure/cli.mjs remainder <file> [--json]       what is left, by feature, and what holds it
//   node tools/restructure/cli.mjs remainder <file> --movable      the names that can move now, by feature

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readMap } from '../map/map.mjs';
import { analyze, toJson } from './analyze.mjs';
import { extract, replay } from './extract.mjs';
import { Refusal } from './extract-plan.mjs';
import { protectedNames, readLedger } from './ledger.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';
import { orderJobs, pendingJobs } from './plan-order.mjs';
import { carryAll, checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { featureWords, remainder, renderMovable, renderRemainder } from './remainder.mjs';
import { ownersOf } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

const VALUE_FLAGS = new Set(['--from', '--to', '--about', '--base', '--names']);

function readArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      flags[arg.slice(2)] = argv[i];
    } else if (arg.startsWith('--')) flags[arg.slice(2)] = true;
    else rest.push(arg);
  }
  return { flags, rest };
}

const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
const readSource = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

// An entry of load-registrations.json that does not count frees nothing: said aloud, so it is not mistaken for the rule.
function analyzeFile(parser, file) {
  const analysis = analyze(readSource(file), parser, file);
  if (analysis.listProblems.length) {
    console.error(`tools/restructure/load-registrations.json, entries that do not count:\n  ${analysis.listProblems.join('\n  ')}`);
  }
  return analysis;
}

function showAnalysis(parser, { flags, rest }) {
  const file = posix(rest[0]);
  const analysis = analyzeFile(parser, file);
  const json = toJson(analysis);
  if (flags.names) {
    const wanted = new Set(String(flags.names).split(','));
    console.log(JSON.stringify(json.declarations.filter((d) => d.names.some((name) => wanted.has(name))), null, 1));
  } else if (flags.json) console.log(JSON.stringify(json, null, 1));
  else {
    const t = json.totals;
    console.log(`${file}: ${json.lines} lines, ${t.declarations} declarations, ${t.statements} other statements, ${t.state} shared variables.`);
    console.log(`Movable now: ${t.movable} declarations, ${t.movableLines} lines.`);
    for (const d of json.declarations.filter((entry) => entry.movable)) console.log(`  ${String(d.line[0]).padStart(6)}  ${String(d.lines).padStart(4)}  ${d.names.join(', ')}`);
  }
  return 0;
}

function runExtractions(parser, jobs, dryRun) {
  for (const job of jobs) {
    const done = extract({ root: REPO_ROOT, parser, source: posix(job.from), target: posix(job.to), about: job.about,
      names: job.names, withDeps: Boolean(job.withDeps), dryRun });
    console.log(`${dryRun ? 'would move' : 'moved'} ${done.moved.length} declarations to ${done.target} (${done.lines} lines); `
      + `${posix(job.from)} ${dryRun ? 'would lose' : 'lost'} ${done.sourceLines} lines and requires ${done.imported.length} names back.`);
    if (dryRun) console.log(`  ${done.moved.join(', ')}`);
  }
  if (!dryRun) console.log('Next: node tools/restructure/cli.mjs verify, then carry, then npm run sizes -- --update and npm run map.');
  return 0;
}

// The jobs of a plan file that are still to do, dependencies first.
function readPlan(parser, planFile) {
  const jobs = JSON.parse(readFileSync(planFile, 'utf8')).map((job) => ({ ...job, from: posix(job.from), to: posix(job.to) }));
  const ledger = readLedger(REPO_ROOT).sources;
  const todo = pendingJobs(ledger, jobs);
  if (todo.length < jobs.length) console.log(`${jobs.length - todo.length} of ${jobs.length} extractions are done already.`);
  const ordered = [];
  for (const from of new Set(todo.map((job) => job.from))) {
    ordered.push(...orderJobs(analyze(readSource(from), parser, from), todo.filter((job) => job.from === from)));
  }
  return ordered;
}

function verify(parser, { flags }) {
  const base = flags.base || 'HEAD';
  const { problems, replayed, files } = replay({ root: REPO_ROOT, parser, base });
  const all = files.flat();
  problems.push(...syntaxProblems(REPO_ROOT, all));
  if (!checksAvailable(REPO_ROOT)) problems.push('the type check is not installed (npm run quality:install): "cannot find name" was not checked');
  else {
    const counts = typeCounts(REPO_ROOT);
    for (const group of files) problems.push(...unknownNameProblems(counts, typeBaseline(REPO_ROOT), group));
  }
  if (problems.length) { console.error(problems.join('\n')); return 1; }
  console.log(`Proven: ${replayed} moves redone from ${base} give the ${all.length} files on disk byte for byte; every moved line is unchanged, `
    + 'every file parses, no name lost its declaration.');
  return 0;
}

function carry() {
  const groups = Object.entries(readLedger(REPO_ROOT).sources).map(([source, entries]) => [source, ...entries.map((entry) => entry.file)]);
  let failed = false;
  for (const { check, problems, before, after } of carryAll(REPO_ROOT, groups)) {
    if (problems.length) { failed = true; console.error(`${check}: the moved code has more findings than before, nothing saved:\n  ${problems.join('\n  ')}`); }
    else console.log(`${check}: ${before} -> ${after} across the moved files, saved.`);
  }
  return failed ? 1 : 0;
}

function showRemainder(parser, { flags, rest }) {
  const file = posix(rest[0]);
  const analysis = analyzeFile(parser, file);
  const rewrite = createSpecRewriter(REPO_ROOT);
  const owners = new Map();
  const ownerOfSpec = (spec) => {
    if (!owners.has(spec)) {
      let target = null;
      try { target = rewrite(spec, file, file).file; } catch { /* a module that is not there on this machine */ }
      owners.set(spec, target ? ownersOf([target]).get(target) : null);
    }
    return owners.get(spec);
  };
  const map = { ownerOfSpec, words: featureWords(readMap().features, JSON.parse(readSource('tools/restructure/feature-words.json')).words),
    kept: protectedNames(REPO_ROOT, file, analysis.records).names };
  if (flags.movable) { console.log(renderMovable(analysis, map)); return 0; }
  const rows = remainder(analysis, map);
  console.log(flags.json ? JSON.stringify(rows, null, 1) : `${file}: ${analysis.lineCount} lines left.\n\n${renderRemainder(rows)}`);
  return 0;
}

async function main(argv) {
  const [command, ...tail] = argv;
  const args = readArgs(tail);
  if (command === 'carry') return carry();
  const needsFile = { analyze: 1, remainder: 1, apply: 1 }[command] ?? 0;
  const known = ['analyze', 'extract', 'apply', 'verify', 'remainder'].includes(command);
  if (!known || args.rest.length < needsFile || (command === 'extract' && !(args.flags.from && args.flags.to && args.rest.length))) {
    console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    return 2;
  }
  const parser = await openParser();
  try {
    if (command === 'analyze') return showAnalysis(parser, args);
    if (command === 'remainder') return showRemainder(parser, args);
    if (command === 'verify') return verify(parser, args);
    const dryRun = Boolean(args.flags['dry-run']);
    if (command === 'apply') return runExtractions(parser, readPlan(parser, args.rest[0]), false);
    return runExtractions(parser, [{ from: args.flags.from, to: args.flags.to, about: args.flags.about,
      names: args.rest, withDeps: args.flags['with-deps'] }], dryRun);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(`Refused:\n  ${error.reasons.join('\n  ')}`);
    return 1;
  } finally {
    parser.close();
  }
}

process.exitCode = await main(process.argv.slice(2));

#!/usr/bin/env node
// Proves tests by breaking the code: each mutation of a plan swaps one piece of text
// in one file, the plan's tests run, and the file goes back at once. A mutation no
// test catches is a hole in the tests. Run from the repo root:
//
//   node tools/mutate/mutate.mjs <plan.mjs|plan.json>
//
// A plan names the tests and the mutations, paths from the repo root:
//   export default {
//     tests: ['server/test/liquid-streaming.test.mjs'],
//     mutations: [{ name: 'state keeps its plate', file: 'server/styles/x.css', from: 'background: none;', to: '' }],
//   };
// `from` must appear exactly once in the file, so the mutation hits what it means to.
// Exit code 0 only when every mutation was caught. Files are restored after each run,
// and again on exit or Ctrl+C.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUN_TIMEOUT_MS = 180000;

export function parsePlan(plan) {
  const ok = plan && Array.isArray(plan.tests) && plan.tests.length > 0 && Array.isArray(plan.mutations)
    && plan.tests.every((t) => typeof t === 'string' && t)
    && plan.mutations.every((m) => m && ['name', 'file', 'from'].every((k) => typeof m[k] === 'string' && m[k])
      && typeof (m.to ?? '') === 'string');
  if (!ok) throw new Error('a plan needs tests: [paths] and mutations: [{ name, file, from, to }]');
  return { tests: plan.tests, mutations: plan.mutations.map((m) => ({ ...m, to: m.to ?? '' })) };
}

// The text with `from` replaced, or null when it is not there exactly once.
export function applyOnce(text, from, to) {
  const parts = text.split(from);
  return parts.length === 2 ? parts.join(to) : null;
}

// A plan is written with \n, and a file checked out on Windows may end its lines with
// \r\n: the text takes the file's line ends, so one plan works on both.
export function eolLike(text, s) {
  return text.includes('\r\n') ? s.replace(/\r?\n/g, '\r\n') : s;
}

// The names of the failing tests in a TAP report, each once, suites and subtests alike.
// A failing todo or skipped test does not fail the run, so it catches nothing. Node
// escapes # and \ in names.
export function failedTests(tap) {
  const names = [];
  for (const line of tap.split(/\r?\n/)) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(line);
    if (!m || /(?<!\\)#\s*(?:TODO|SKIP)\b/i.test(m[1])) continue;
    const name = m[1].replace(/\\([\\#])/g, '$1');
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

async function loadPlan(file) {
  const abs = path.resolve(file);
  if (abs.endsWith('.json')) return parsePlan(JSON.parse(readFileSync(abs, 'utf8')));
  return parsePlan((await import(pathToFileURL(abs).href)).default);
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tools/mutate/mutate.mjs <plan.mjs|plan.json>'); process.exit(2); }
  const plan = await loadPlan(file);
  const originals = new Map();
  const restore = () => { for (const [f, text] of originals) writeFileSync(f, text); };
  const bail = () => { restore(); process.exit(130); };
  process.on('SIGINT', bail);
  process.on('SIGTERM', bail);
  let missed = 0;
  try {
    for (const m of plan.mutations) {
      const target = path.resolve(m.file);
      if (!originals.has(target)) originals.set(target, readFileSync(target, 'utf8'));
      const original = originals.get(target);
      const broken = applyOnce(original, eolLike(original, m.from), eolLike(original, m.to));
      if (broken === null) { console.log(`${m.name}: SKIPPED, the text is not in ${m.file} exactly once`); missed++; continue; }
      writeFileSync(target, broken);
      const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=60000', ...plan.tests],
        { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, windowsHide: true });
      writeFileSync(target, originals.get(target));
      if (run.error) { console.log(`${m.name}: RUN FAILED (${run.error.code || run.error.message})`); missed++; continue; }
      const caught = failedTests(run.stdout || '');
      // A run that dies before naming a test still fails the suite.
      if (!caught.length && run.status) caught.push(`the run itself (exit ${run.status})`);
      if (!caught.length) missed++;
      console.log(`${m.name}: ${caught.length ? `caught by ${caught.join(' | ')}` : 'NOT CAUGHT'}`);
    }
  } finally {
    restore();
  }
  const intact = [...originals].every(([f, text]) => readFileSync(f, 'utf8') === text);
  console.log(intact ? 'files restored' : 'RESTORE FAILED: check the files by hand');
  process.exit(intact && !missed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

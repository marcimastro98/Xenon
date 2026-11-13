// Asks a throwaway copy of the engine every address it answers a plain GET on,
// and keeps what came back, so the same questions can be asked again after
// routes were moved and the answers compared.
//
//   node tools/restructure/routes-check.mjs record <out.json> [--rev <commit>]
//   node tools/restructure/routes-check.mjs compare <before.json> <after.json>
//   node tools/restructure/routes-check.mjs check --base <commit>     record both, compare
//
// The addresses are read from the handler itself (routes-list.mjs): every branch
// whose test is one address asked with GET. Left out are the addresses the engine
// lists as changing something, and the ones in routes-skip.json, each with its
// reason. A few requests the gate must refuse are asked too. Last come the requests
// of routes-writes.json: a few routes that write, picked by hand because each only
// touches the copy's own data, asked one at a time in the order of the list.
//
// The copy runs with its data, its home folder and its temp folder inside a temp
// folder of its own, and with routes-quiet.cjs loaded first: it can start no
// program and reach nothing, on this PC or outside it. Each start is stopped
// after 45 seconds at the latest. XENON_PORT picks the port (default 3039).

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { copyEngine } from '../ci/request-check.mjs';
import { openParser } from './parser.mjs';
import { kept, levelCounts, recordProblems, settle } from './routes-answers.mjs';
import { askable, exactGetPaths, routeChain, setOfTexts } from './routes-list.mjs';
import { writeRequests } from './routes-writes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const QUIET = path.join(HERE, 'routes-quiet.cjs');
const START_LIMIT_MS = 45_000;
const ANSWER_LIMIT_MS = 5_000;
const AT_ONCE = 6;
const ENGINE = 'server/server.js';

// Requests the gate in front of the routes must refuse, and two it must let through to "no such address".
// The two addresses that change something only write a file of the copy, should a refusal ever be lost.
export const REFUSALS = [
  { label: 'POST /settings from a page of another site', method: 'POST', path: '/settings', headers: { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' }, body: '{}' },
  { label: 'GET /settings read by a page of another site', method: 'GET', path: '/settings', headers: { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' } },
  { label: 'GET /settings/tile as an image on a page of another site', method: 'GET', path: '/settings/tile', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' } },
  { label: 'GET /sdk/grant as a link followed in a browser', method: 'GET', path: '/sdk/grant', headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' } },
  { label: 'POST /settings/tile from a frame with no origin', method: 'POST', path: '/settings/tile', headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' }, body: '{}' },
  { label: 'GET /settings under another host name', method: 'GET', path: '/settings', headers: { Host: 'example.com' } },
  { label: 'OPTIONS /settings', method: 'OPTIONS', path: '/settings', headers: {} },
  { label: 'GET an address nobody answers', method: 'GET', path: '/no-such-address-route-check', headers: {} },
  { label: 'POST an address nobody answers', method: 'POST', path: '/no-such-address-route-check', headers: { 'Content-Type': 'application/json' }, body: '{}' },
];

function ask(port, { method, path: pathname, headers = {}, body }) {
  // The length is said for every body: left to itself Node says none for a DELETE, and the engine cannot read the body.
  const sent = body === undefined ? headers : { 'Content-Length': Buffer.byteLength(body), ...headers };
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: sent, timeout: ANSWER_LIMIT_MS }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks) }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

// One start of one copy: every question asked, a few at a time, then the writes one by one, then the copy is stopped.
async function answersOf(folder, port, questions, writes) {
  const home = path.join(folder, 'home');
  const temp = path.join(folder, 'temp');
  for (const made of [home, temp]) mkdirSync(made, { recursive: true });
  const child = spawn(process.execPath, ['--require', QUIET, 'server/server.js'], { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XENON_PORT: String(port), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp } });
  const limit = setTimeout(() => child.kill(), START_LIMIT_MS);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  const answers = {};
  try {
    let up = false;
    while (!up && child.exitCode === null) {
      up = Boolean(await ask(port, { method: 'GET', path: '/version' }));
      if (!up) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!up) throw new Error(`the copy of the engine did not start; it said:
${output}`);
    const waiting = [...questions];
    const worker = async () => {
      for (let next = waiting.shift(); next; next = waiting.shift()) answers[next.label] = kept(await ask(port, next));
    };
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
    for (const next of writes) answers[next.label] = kept(await ask(port, next));
  } finally {
    clearTimeout(limit);
    if (child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  }
  return answers;
}

/**
 * What turns a copy of the working folder into the engine one commit had. Pure, so it is tested.
 * @param {string} changed `git diff --name-status --no-renames <commit>` for the engine's folders
 * @param {string} untracked `git ls-files --others --exclude-standard` for the same folders
 * @returns {{ file: string, at: string, put: boolean }[]} every file that differs: where it sits in the copy, and
 *   whether the commit's text is put there (`put`) or the file is taken away (the commit did not have it)
 */
export function baseEdits(changed, untracked) {
  const inCopy = (file) => {
    if (file === 'package.json') return file;
    if (file.startsWith('packages/core/')) return `server/shared/${file.slice('packages/core/'.length)}`;
    return /^server\/(?!data\/|test\/|shared\/)/.test(file) ? file : null;
  };
  const rows = [...changed.split('\n').filter(Boolean).map((row) => row.split('\t')), ...untracked.split('\n').filter(Boolean).map((file) => ['A', file])];
  return rows.map(([status, file]) => ({ file, at: inCopy(file), put: status !== 'A' })).filter((edit) => edit.at !== null);
}

// A copy of the engine as one commit had it: the same copy as for the working folder (so the two differ in
// nothing but the code), with every file that changed since the commit put back as the commit had it.
function copyOfCommit(rev) {
  const folder = copyEngine();
  const git = (args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  const where = ['--', 'server', 'packages/core', 'package.json'];
  const edits = baseEdits(git(['diff', '--name-status', '--no-renames', rev, ...where]).toString('utf8'),
    git(['ls-files', '--others', '--exclude-standard', ...where]).toString('utf8'));
  for (const { file, at, put } of edits) {
    const target = path.join(folder, at);
    if (!put) rmSync(target, { force: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, git(['show', `${rev}:${file}`]));
    }
  }
  return folder;
}

/** What to ask an engine, read from its own code. */
export function questionsFor({ engineText, remoteText, skip, writes = [], parser }) {
  const { branches } = routeChain(engineText, parser);
  const paths = exactGetPaths(branches);
  const wrote = writeRequests(branches, writes);
  const mutators = [...setOfTexts(engineText, parser, 'CSRF_MUTATION_PATHS'), ...setOfTexts(remoteText, parser, 'DEFAULT_GET_MUTATORS')];
  const { ask: wanted, skipped, stale } = askable({ paths, mutators, skip });
  return { paths, skipped, stale, writes: wrote.ask, staleWrites: [...wrote.stale, ...wrote.unexplained],
    questions: [...wanted.map((address) => ({ label: `GET ${address}`, method: 'GET', path: address })), ...REFUSALS] };
}

async function record(rev) {
  const port = Number(process.env.XENON_PORT || 3039);
  const read = (file) => (rev ? execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) : readFileSync(path.join(ROOT, file), 'utf8'));
  const skip = JSON.parse(readFileSync(path.join(HERE, 'routes-skip.json'), 'utf8')).paths;
  const writes = JSON.parse(readFileSync(path.join(HERE, 'routes-writes.json'), 'utf8')).requests;
  const parser = await openParser();
  let plan;
  try {
    plan = questionsFor({ engineText: read(ENGINE), remoteText: read('server/remote-access.js'), skip, writes, parser });
  } finally {
    parser.close();
  }
  // Two copies, so what depends on the copy itself (a file's date) is told apart from what the code answers.
  const runs = [];
  for (let run = 0; run < 2; run += 1) {
    const folder = rev ? copyOfCommit(rev) : copyEngine();
    try {
      runs.push(await answersOf(folder, port, plan.questions, plan.writes));
    } finally {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  const answers = settle(runs[0], runs[1]);
  const shapes = Object.fromEntries(Object.entries(runs[0]).filter(([, answer]) => answer.shape !== null).map(([label, answer]) => [label, answer.shape]));
  return { getRoutes: plan.paths.length, asked: plan.questions.length - REFUSALS.length, refusals: REFUSALS.length, writes: plan.writes.length,
    skipped: plan.skipped, staleSkips: plan.stale, staleWrites: plan.staleWrites, levels: levelCounts(answers), answers, shapes };
}

const summary = (made) => `${made.asked} of ${made.getRoutes} GET routes asked (${made.skipped.length} left out), ${made.refusals} requests the gate must refuse, `
  + `${made.writes ?? 0} requests of routes that write, in order; `
  + `compared by body ${made.levels.body}, by shape ${made.levels.shape}, by status ${made.levels.status}, not steady ${made.levels.unsteady}`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
  if (command === 'record' && rest[0]) {
    const made = await record(flag('--rev'));
    writeFileSync(rest[0], `${JSON.stringify(made, null, 1)}\n`);
    console.log(summary(made));
    if (made.staleSkips.length) console.log(`skip list entries that name no GET route: ${made.staleSkips.join(', ')}`);
    if (made.staleWrites.length) console.log(`entries of routes-writes.json that name no route, or do not say what they touch: ${made.staleWrites.join(', ')}`);
    return;
  }
  let before;
  let after;
  if (command === 'compare' && rest.length === 2) [before, after] = rest.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  else if (command === 'check' && flag('--base')) [before, after] = [await record(flag('--base')), await record(null)];
  else {
    console.log('usage: routes-check.mjs record <out.json> [--rev <commit>] | compare <before.json> <after.json> | check --base <commit>');
    process.exitCode = 2;
    return;
  }
  const problems = recordProblems(before, after);
  if (after.staleSkips?.length) problems.push(`the skip list names addresses no GET route answers: ${after.staleSkips.join(', ')}`);
  if (after.staleWrites?.length) problems.push(`routes-writes.json has entries that name no route, or do not say what they touch: ${after.staleWrites.join(', ')}`);
  console.log(problems.length ? problems.join('\n') : `the routes answer as before: ${summary(after)}`);
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

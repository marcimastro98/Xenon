#!/usr/bin/env node
// A copy of this checkout's engine that can stay up longer than a minute without
// touching the PC it runs on: it gets its own port, data, home and temp folders, and
// the code that would act on the PC (the logon task, the links in the user's home,
// the helper and capture installs, the updaters, the paired-device certificate) is cut
// out first. Each cut names one line of the engine and must be found in exactly one
// file; when a cut no longer fits, nothing starts. The copy answers a marker file,
// which the page check asks for before it opens a page.
//
//   node tools/restructure/side-copy.mjs build <folder> <port> [baseRev]
//   node tools/restructure/side-copy.mjs run <folder> <port> [minutes]
//   node tools/restructure/side-copy.mjs record <folder> <port> <out.json> [baseRev] [--engine chromium|webkit]
//
// `build` makes <folder>/server from the working folder, or with the files of `server/`
// as they were at `baseRev`. `run` starts it and ends when the file <folder>/stop
// appears or after the minutes given (default 20), stopping only what it started.
// `record` does both, runs the page check (browser-page-check.mjs) against the copy and
// stops it: one command, and its exit code is 0 only when all of it worked. `--engine webkit` opens the pages in
// Playwright's WebKit and not in Chromium (browser-check-engine.mjs).
// Port 3030 is the installed app's and is refused. Always read the exit code.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownFolders } from '../ci/own-folders.mjs';
import { engineFromArgs } from './browser-check-engine.mjs';
import { CUTS, NOT_COPIED, cutsFor, engineFiles, makeCuts, placeCuts } from './side-copy-cuts.mjs';

export { CUTS, cutsFor, engineFiles, placeCuts };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DAILY_PORT = 3030;
/** Where the copy answers that it is a copy: a file only `build` writes, under a folder the engine serves. */
export const MARKER_ADDRESS = '/public/xenon-side-copy.json';
const OWNED = 'side-copy.root';
const CUT_DONE = 'patched.ok';
const DEFAULT_MINUTES = 20;
const RECORD_MINUTES = 15;
const PAGE_CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser-page-check.mjs');
const POLL_MS = 500;
/** @param {unknown} value @returns {number} the port, refused when it is not one or is the installed app's */
export function sidePort(value) {
  const port = Number(value);
  if (!/^\d{4,5}$/.test(String(value)) || port > 65535) throw new Error(`"${value}" is not a port`);
  if (port === DAILY_PORT) throw new Error(`port ${DAILY_PORT} is the installed app's: a copy never uses it`);
  return port;
}

const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/**
 * `build` empties <folder>/server, so the folder must be one it made (or a new one), away from the checkout.
 * @param {string} root @param {string} [repo] @returns {string} the folder, absolute
 */
export function sideRoot(root, repo = REPO_ROOT) {
  const folder = path.resolve(root);
  if (inside(folder, repo) || inside(repo, folder)) throw new Error(`${folder} is the checkout, inside it or around it: give the copy a folder of its own`);
  if (existsSync(folder) && readdirSync(folder).length && !existsSync(path.join(folder, OWNED))) {
    throw new Error(`${folder} holds files this tool did not put there: give the copy an empty folder`);
  }
  return folder;
}

/** @param {string} root a built copy @param {number} port @returns {string[]} why it must not start, empty when every cut is still in place */
export function cutProblems(root, port) {
  let done;
  try { done = JSON.parse(readFileSync(path.join(root, CUT_DONE), 'utf8')); } catch { return ['this copy was not cut (its build did not finish): it must not start']; }
  const problems = [];
  if (done.port !== port) problems.push(`this copy was built for port ${done.port}, not ${port}`);
  if (!Array.isArray(done.cuts) || done.cuts.length !== cutsFor(port).length) problems.push('the list of cuts of this copy is not the tool\'s: build it again');
  for (const cut of done.cuts ?? []) {
    let text = '';
    try { text = readFileSync(path.join(root, 'server', cut.file), 'utf8'); } catch { /* a missing file holds no cut */ }
    if (!text.includes(cut.to)) problems.push(`the cut in ${cut.file} is gone: build the copy again`);
  }
  return problems;
}

const busy = (port) => new Promise((done) => {
  const probe = createConnection({ host: '127.0.0.1', port });
  probe.once('connect', () => { probe.destroy(); done(true); });
  probe.once('error', () => done(false));
});

// The files of server/ that differ from `baseRev` (committed or not) are written as they were then.
function layBase(root, repo, baseRev) {
  const git = (...args) => {
    const done = spawnSync('git', args, { cwd: repo, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    if (done.error) throw done.error;
    return done;
  };
  if (git('rev-parse', '--verify', `${baseRev}^{commit}`).status !== 0) throw new Error(`"${baseRev}" is not a commit of this checkout`);
  const lines = (done) => done.stdout.toString('utf8').split('\n').filter(Boolean);
  const kept = (file) => !NOT_COPIED.has(file.split('/')[1]);
  const unsaved = lines(git('status', '--porcelain', '--untracked-files=all', '--', 'server')).map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
  const saved = lines(git('diff', '--name-only', baseRev, 'HEAD', '--', 'server'));
  let count = 0;
  for (const file of new Set([...unsaved, ...saved].filter(kept))) {
    const was = git('show', `${baseRev}:${file}`);
    const target = path.join(root, file);
    if (was.status === 0) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, was.stdout); } else rmSync(target, { force: true });
    count += 1;
  }
  return count;
}

/**
 * @param {string} rootArg @param {unknown} portArg @param {string} [baseRev] @param {string} [repo]
 * @returns {Promise<string>} what was built
 */
export async function build(rootArg, portArg, baseRev, repo = REPO_ROOT) {
  const port = sidePort(portArg);
  const root = sideRoot(rootArg, repo);
  if (await busy(port)) throw new Error(`port ${port} is in use: stop the copy that holds it first`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, OWNED), 'made by tools/restructure/side-copy.mjs\n');
  rmSync(path.join(root, CUT_DONE), { force: true });
  const copy = path.join(root, 'server');
  // The link to packages/core goes first and on its own: emptying the folder through it would empty packages/core.
  rmSync(path.join(copy, 'shared'), { force: true });
  rmSync(copy, { recursive: true, force: true });
  const from = path.join(repo, 'server');
  cpSync(from, copy, { recursive: true, filter: (src) => !NOT_COPIED.has(path.relative(from, src).split(path.sep)[0]) });
  const fromBase = baseRev ? layBase(root, repo, baseRev) : 0;
  symlinkSync(path.join(repo, 'packages', 'core'), path.join(copy, 'shared'), 'junction');
  mkdirSync(path.join(copy, 'data'), { recursive: true });
  ownFolders(root);
  const cuts = makeCuts(copy, cutsFor(port));
  mkdirSync(path.join(copy, 'public'), { recursive: true });
  writeFileSync(path.join(copy, MARKER_ADDRESS), `${JSON.stringify({ sideCopy: true, port })}\n`);
  writeFileSync(path.join(root, CUT_DONE), `${JSON.stringify({ port, base: baseRev ?? null, cuts }, null, 1)}\n`);
  return `built for port ${port}: ${cuts.length} cuts made${baseRev ? `, ${fromBase} files as at ${baseRev}` : ''}`;
}

// Only the process started here and what it started itself.
function stopTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

/**
 * @param {string} rootArg @param {unknown} portArg @param {number} [minutes] @param {string} [repo]
 * @returns {Promise<number>} 0 when the copy ran and was stopped, 1 when it ended by itself
 */
export async function run(rootArg, portArg, minutes = DEFAULT_MINUTES, repo = REPO_ROOT) {
  const port = sidePort(portArg);
  const root = sideRoot(rootArg, repo);
  if (!(minutes > 0 && minutes <= 120)) throw new Error(`"${minutes}" minutes: give a time limit between 1 and 120`);
  const problems = cutProblems(root, port);
  if (problems.length) throw new Error(problems.join('\n'));
  if (await busy(port)) throw new Error(`port ${port} is in use: leave that server alone`);
  const stop = path.join(root, 'stop');
  rmSync(stop, { force: true });
  const log = openSync(path.join(root, 'server.log'), 'a');
  const env = { ...process.env, ...ownFolders(root), XENON_PORT: String(port), NODE_PATH: path.join(repo, 'node_modules') };
  const child = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    env, cwd: path.join(root, 'server'), stdio: ['ignore', log, log], detached: process.platform !== 'win32', windowsHide: true,
  });
  closeSync(log);
  let ended = null;
  let asked = false;
  let byItself = false;
  child.once('exit', (code) => { ended = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { asked = true; });
  writeFileSync(path.join(root, 'pid'), `${child.pid}
`);
  console.log(`started pid ${child.pid} on port ${port}, for ${minutes} minutes at most`);
  const until = Date.now() + minutes * 60_000;
  try {
    while (ended === null && !asked && !existsSync(stop) && Date.now() < until) await new Promise((done) => setTimeout(done, POLL_MS));
  } finally {
    byItself = ended !== null;
    if (!byItself) { stopTree(child); await new Promise((done) => setTimeout(done, 1500)); }
    rmSync(stop, { force: true });
    rmSync(path.join(root, 'pid'), { force: true });
  }
  if (byItself) { console.error(`the copy ended by itself with code ${ended}: see ${path.join(root, 'server.log')}`); return 1; }
  console.log('stopped');
  return 0;
}

/**
 * Asked by the page check before it opens a page: the server on `port` must be a copy built here for that port.
 * @param {number} port @param {number} [waitMs] how long to wait for the copy to answer
 * @returns {Promise<void>} throws when it is anything else
 */
export async function mustBeSideCopy(port, waitMs = 60_000) {
  sidePort(port);
  const until = Date.now() + waitMs;
  let why = 'nothing answers';
  do {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}${MARKER_ADDRESS}`);
      const said = answer.ok ? await answer.json().catch(() => null) : null;
      if (said?.sideCopy === true && said.port === port) return;
      why = `a server answers, but not with this port's marker file (status ${answer.status}), so it is not a cut copy`;
      break;
    } catch { /* not up yet */ }
    await new Promise((done) => setTimeout(done, POLL_MS));
  } while (Date.now() < until);
  throw new Error(`port ${port}: ${why}. The page check only opens a copy made by tools/restructure/side-copy.mjs (build, then run).`);
}

/**
 * Builds the copy, runs it, records the pages on it and stops it.
 * @param {string} rootArg @param {unknown} portArg @param {string} outFile @param {string} [baseRev] @param {string} [repo]
 * @param {string} [engine] the engine the pages are opened in, Chromium when nothing is said
 * @returns {Promise<number>} 0 only when the build, the run and the page check all worked
 */
export async function record(rootArg, portArg, outFile, baseRev, repo = REPO_ROOT, engine = 'chromium') {
  console.log(await build(rootArg, portArg, baseRev, repo));
  const root = sideRoot(rootArg, repo);
  const running = run(root, portArg, RECORD_MINUTES + 1, repo);
  running.catch(() => { /* told below, once the page check has ended */ });
  let checked = 1;
  try {
    checked = await new Promise((resolve) => {
      const check = spawn(process.execPath, [PAGE_CHECK, 'record', String(sidePort(portArg)), outFile, '--engine', engine], { stdio: 'inherit', windowsHide: true });
      const limit = setTimeout(() => { console.error(`the page check was stopped after ${RECORD_MINUTES} minutes`); stopTree(check); }, RECORD_MINUTES * 60_000);
      check.once('error', () => { clearTimeout(limit); resolve(1); });
      check.once('exit', (code) => { clearTimeout(limit); resolve(code ?? 1); });
    });
  } finally {
    writeFileSync(path.join(root, 'stop'), '');
  }
  const ran = await running;
  return checked || ran;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { engine, rest: [command, root, port, extra, last] } = engineFromArgs(process.argv.slice(2));
    if (command === 'build' && root && port) console.log(await build(root, port, extra));
    else if (command === 'run' && root && port) process.exitCode = await run(root, port, extra ? Number(extra) : undefined);
    else if (command === 'record' && root && port && extra) process.exitCode = await record(root, port, path.resolve(extra), last, REPO_ROOT, engine);
    else {
      console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(9, 12).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`side-copy: ${error.message}`);
    process.exitCode = 1;
  }
}

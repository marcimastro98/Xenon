// Asks a throwaway copy of the server real questions: read the settings, save one
// harmless setting through the real endpoint, read it back, restart, read it again,
// and hold the live stream open until an event arrives. The boot check says the
// server starts; this says the settings and the live stream still work after code
// that touches them was rewritten.
//
// The server keeps its data next to its own files, so the check copies `server/`
// (without `data` and the tests) to a temp folder and runs the copy there: the
// checkout's own data folder is never read or written.
//
//   node tools/ci/request-check.mjs [--json]      XENON_PORT picks the port (default 3039)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOOT_LIMIT_MS = 60_000;
const EVENT_LIMIT_MS = 30_000;
const POLL_MS = 500;
// The first dashboard that connects makes the server stamp its usage days into the settings: the check opens
// the live stream first and waits until the answer has stopped changing for this many reads, so "the save
// changed one setting" is measured against settings that are at rest.
const SETTLED_READS = 6;
const SETTLE_LIMIT_MS = 30_000;
const SKIPPED = new Set(['data', 'test', 'shared']);
// The setting the check changes: a number every surface models, with no effect outside the lyrics tile.
export const PROBE_KEY = 'lyricsOffsetMs';
export const PROBE_VALUES = [300, 500];
// What differs from one run to the next without anything being wrong.
const VOLATILE = new Set(['rev', 'storeId', PROBE_KEY]);

const CRASH = /Uncaught|Unhandled|TypeError|ReferenceError|SyntaxError|Cannot find module|FATAL|EADDRINUSE/;

/** A short fingerprint of a settings answer, the same for two servers that answer the same. Pure, so it is tested. */
export function settingsFingerprint(settings) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  };
  const kept = Object.fromEntries(Object.entries(settings || {}).filter(([key]) => !VOLATILE.has(key)));
  return createHash('sha256').update(JSON.stringify(stable(kept))).digest('hex').slice(0, 16);
}

/** The top-level settings that differ between two answers, the volatile ones aside. Pure, so it is tested. */
export function differingKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => !VOLATILE.has(key)
    && settingsFingerprint({ [key]: before?.[key] }) !== settingsFingerprint({ [key]: after?.[key] })).sort();
}

/**
 * What went wrong in one run, or [] when every answer was the expected one. Pure, so it is tested.
 * @param {object} seen
 * @param {any} seen.first settings as first read
 * @param {number} seen.saveStatus status of the save
 * @param {any} seen.afterSave settings read after the save
 * @param {any} seen.afterRestart settings read after a restart
 * @param {string[]} seen.events names of the events the live stream sent
 * @param {boolean} seen.toldSave whether a `settings` event arrived after the save was sent
 * @param {number} seen.wanted the value that was saved
 * @param {string} seen.output what both runs of the server printed
 */
export function requestProblems({ first, saveStatus, afterSave, afterRestart, events, toldSave, wanted, output }) {
  const problems = [];
  const isSettings = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (!isSettings(first)) problems.push('the settings could not be read');
  if (saveStatus !== 200) problems.push(`the save answered ${saveStatus ?? 'nothing'}`);
  if (!isSettings(afterSave)) problems.push('the settings could not be read after the save');
  else {
    if (afterSave[PROBE_KEY] !== wanted) problems.push(`${PROBE_KEY} reads ${afterSave[PROBE_KEY]} after saving ${wanted}`);
    if (isSettings(first) && !(Number(afterSave.rev) > Number(first.rev || 0))) problems.push(`the save did not raise rev (${first.rev} -> ${afterSave.rev})`);
    if (isSettings(first) && settingsFingerprint(first) !== settingsFingerprint(afterSave)) {
      problems.push(`the save changed more than the one setting: ${differingKeys(first, afterSave).join(', ')}`);
    }
  }
  if (!isSettings(afterRestart)) problems.push('the settings could not be read after the restart');
  else if (isSettings(afterSave)) {
    if (afterRestart[PROBE_KEY] !== wanted) problems.push(`${PROBE_KEY} reads ${afterRestart[PROBE_KEY]} after the restart, ${wanted} was saved`);
    if (afterRestart.rev !== afterSave.rev) problems.push(`rev changed over the restart (${afterSave.rev} -> ${afterRestart.rev})`);
    if (afterRestart.storeId !== afterSave.storeId) problems.push('the store id changed over the restart');
    if (settingsFingerprint(afterRestart) !== settingsFingerprint(afterSave)) {
      problems.push(`the settings differ after the restart: ${differingKeys(afterSave, afterRestart).join(', ')}`);
    }
  }
  if (!events || events.length === 0) problems.push('the live stream sent no event');
  else if (!toldSave) problems.push('the live stream did not tell the save');
  for (const line of String(output || '').split('\n')) {
    if (CRASH.test(line)) problems.push(`crash line: ${line.trim().slice(0, 300)}`);
  }
  return problems;
}

function ask(port, method, pathname, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not JSON: the caller sees null */ }
        resolve({ status: res.statusCode, json: parsed });
      });
    });
    req.on('error', () => resolve(null));
    req.end(data ?? undefined);
  });
}

// Holds the stream open and collects event names until `done` says it has seen enough.
function listen(port, done) {
  const events = [];
  let request = null;
  const finished = new Promise((resolve) => {
    const timer = setTimeout(resolve, EVENT_LIMIT_MS);
    request = http.get({ host: '127.0.0.1', port, path: '/sse' }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line.startsWith('event: ')) events.push(line.slice(7).trim());
        if (done(events)) { clearTimeout(timer); resolve(); }
      });
      res.on('close', () => { clearTimeout(timer); resolve(); });
    });
    request.on('error', () => { clearTimeout(timer); resolve(); });
  });
  return { events, finished, close: () => { try { request.destroy(); } catch { /* already closed */ } } };
}

function startServer(folder, port, onOutput) {
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: folder, env: { ...process.env, XENON_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  return child;
}

async function untilUp(port, child) {
  const until = Date.now() + BOOT_LIMIT_MS;
  while (Date.now() < until && child.exitCode === null) {
    if (await ask(port, 'GET', '/version')) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

async function settledSettings(port) {
  const until = Date.now() + SETTLE_LIMIT_MS;
  let last = null;
  let same = 0;
  while (Date.now() < until) {
    const settings = (await ask(port, 'GET', '/settings'))?.json?.settings ?? null;
    const mark = settings ? `${settings.rev}:${settingsFingerprint(settings)}` : null;
    same = mark !== null && mark === last?.mark ? same + 1 : 0;
    last = { mark, settings };
    if (same >= SETTLED_READS) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return last?.settings ?? null;
}

function stop(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
}

// A copy of the engine that keeps its data apart: the code, the shared package where `server/shared` points,
// the version file, and the checkout's installed packages reached through a link.
export function copyEngine() {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'xenon-request-check-'));
  cpSync(path.join(ROOT, 'server'), path.join(folder, 'server'), { recursive: true,
    filter: (source) => !(path.dirname(source) === path.join(ROOT, 'server') && SKIPPED.has(path.basename(source))) });
  cpSync(path.join(ROOT, 'packages', 'core'), path.join(folder, 'server', 'shared'), { recursive: true });
  copyFileSync(path.join(ROOT, 'package.json'), path.join(folder, 'package.json'));
  if (existsSync(path.join(ROOT, 'node_modules'))) symlinkSync(path.join(ROOT, 'node_modules'), path.join(folder, 'node_modules'), 'junction');
  return folder;
}

async function main() {
  const port = Number(process.env.XENON_PORT || 3039);
  const folder = copyEngine();
  let output = '';
  const onOutput = (chunk) => { output += chunk; };
  const seen = { first: null, saveStatus: undefined, afterSave: null, afterRestart: null, events: [], toldSave: false, wanted: PROBE_VALUES[0], output: '' };
  let child = startServer(folder, port, onOutput);
  try {
    if (await untilUp(port, child)) {
      let sinceSave = -1;
      const stream = listen(port, (events) => sinceSave >= 0 && events.slice(sinceSave).includes('settings'));
      seen.first = await settledSettings(port);
      if (seen.first && seen.first[PROBE_KEY] === seen.wanted) seen.wanted = PROBE_VALUES[1];
      sinceSave = stream.events.length;
      const save = seen.first ? await ask(port, 'POST', '/settings', { settings: { ...seen.first, [PROBE_KEY]: seen.wanted } }) : null;
      seen.saveStatus = save?.status;
      seen.afterSave = (await ask(port, 'GET', '/settings'))?.json?.settings ?? null;
      await stream.finished;
      stream.close();
      seen.events = stream.events;
      seen.toldSave = stream.events.slice(sinceSave).includes('settings');
    }
    await stop(child);
    child = startServer(folder, port, onOutput);
    if (await untilUp(port, child)) seen.afterRestart = (await ask(port, 'GET', '/settings'))?.json?.settings ?? null;
  } finally {
    await stop(child);
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  seen.output = output;
  const problems = requestProblems(seen);
  const summary = {
    settingsKeys: seen.first ? Object.keys(seen.first).length : 0,
    fingerprint: seen.first ? settingsFingerprint(seen.first) : null,
    rev: [seen.first?.rev ?? null, seen.afterSave?.rev ?? null, seen.afterRestart?.rev ?? null],
    saved: [seen.first?.[PROBE_KEY] ?? null, seen.afterSave?.[PROBE_KEY] ?? null, seen.afterRestart?.[PROBE_KEY] ?? null],
    events: [...new Set(seen.events)].sort(),
    problems,
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 1));
  else if (problems.length) console.log(problems.join('\n'));
  else {
    console.log(`settings read, saved, read back and kept over a restart (${summary.settingsKeys} keys, fingerprint ${summary.fingerprint}, `
      + `rev ${summary.rev.join(' -> ')}); the live stream sent ${summary.events.join(', ')}`);
  }
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

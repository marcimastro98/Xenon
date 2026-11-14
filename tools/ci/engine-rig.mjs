// A throwaway copy of the engine a check can seed, start, ask and read.
//
// The copy keeps its data next to its own files in a temp folder (copyEngine), gets a
// home and a temp folder of its own (ownFolders), listens on this computer only whatever
// its settings say (XENON_BIND_HOST), and cannot open a TCP connection to anywhere else
// (no-network.cjs). The checkout's data and the installed app are never touched.
//
//   const rig = await startRig({ port, seed });   // seed: the settings the store starts with
//   await rig.ask('POST', '/settings', { settings });
//   rig.stored();                                 // the settings file as it is on disk
//   await rig.stop();

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownFolders } from './own-folders.mjs';
import { copyEngine } from './request-check.mjs';

const NO_NETWORK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-network.cjs');
const BOOT_LIMIT_MS = 60_000;
const POLL_MS = 400;
const DAILY_PORT = 3030;
// A port of its own: the gate's other throwaway engines default to 3039, and two checks
// started by two people at once must not meet there.
const RIG_PORT = 3046;
const STOP_LIMIT_MS = 10_000;

/**
 * One request to an engine on this computer.
 * @param {number} port
 * @param {{ method?: string, path: string, body?: any, headers?: Record<string, string> }} asked a body that is not a string is sent as JSON
 * @returns {Promise<{ status: number, headers: Record<string, any>, text: string, json: any } | null>} null when nothing answered
 */
export function request(port, { method = 'GET', path: pathname, body, headers = {} }) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const sent = { ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) }), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: sent }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON: the caller reads the text */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', () => resolve(null));
    req.end(data ?? undefined);
  });
}

/**
 * The events of a live-stream text, in order. Pure, so it is tested.
 * @param {string} text what the stream sent so far
 * @returns {{ name: string, data: any }[]} `data` is the parsed JSON, or the text when it is not JSON
 */
export function streamEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const name = /^event: (.*)$/m.exec(block)?.[1]?.trim();
    if (!name) continue;
    const raw = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
    let data = raw;
    try { data = JSON.parse(raw); } catch { /* kept as text */ }
    events.push({ name, data });
  }
  return events;
}

/**
 * Holds the live stream open and collects what it sends.
 * @param {number} port @param {Record<string, string>} [headers]
 */
export function openStream(port, headers = {}) {
  let text = '';
  let waiting = [];
  const settle = () => { waiting = waiting.filter((entry) => !entry()); };
  const req = http.get({ host: '127.0.0.1', port, path: '/sse', headers }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; settle(); });
  });
  req.on('error', () => {});
  return {
    events: () => streamEvents(text.slice(0, text.lastIndexOf('\n\n') + 2)),
    /** Resolves true once an event passes `wanted`, false after `limitMs`. */
    waitFor(wanted, limitMs = 15_000) {
      return new Promise((resolve) => {
        const check = () => {
          if (!this.events().some(wanted)) return false;
          clearTimeout(timer);
          resolve(true);
          return true;
        };
        const timer = setTimeout(() => { waiting = waiting.filter((entry) => entry !== check); resolve(false); }, limitMs);
        if (!check()) waiting.push(check);
      });
    },
    close: () => { try { req.destroy(); } catch { /* closed already */ } },
  };
}

/** @param {string | number | undefined} asked @returns {number} a port that is not the installed app's */
export function rigPort(asked) {
  const port = Number(asked || RIG_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === DAILY_PORT) throw new Error(`port ${asked}: pick a free port that is not ${DAILY_PORT}, the installed app's`);
  return port;
}

/**
 * Ends a process this check started and waits until it is gone. One that does not leave
 * when asked is ended without asking once `limitMs` has passed, so a failed check leaves
 * nothing running either.
 * @param {import('node:child_process').ChildProcess | null} child @param {number} [limitMs]
 * @returns {Promise<void>}
 */
export function stopChild(child, limitMs = STOP_LIMIT_MS) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone meanwhile */ } }, limitMs);
    child.once('exit', () => { clearTimeout(hard); resolve(); });
    child.kill();
  });
}

/**
 * Ends the process `current()` gives when this one ends, whatever ended it: an error nobody
 * caught must not leave an engine listening. Returns the function that takes the watch off.
 * @param {() => (import('node:child_process').ChildProcess | null)} current
 * @param {{ once: Function, off: Function }} [owner] the process that owns the child
 * @returns {() => void}
 */
export function endWithProcess(current, owner = process) {
  const end = () => { try { current()?.kill('SIGKILL'); } catch { /* gone already */ } };
  owner.once('exit', end);
  return () => { owner.off('exit', end); };
}

/** The environment a rig's engine runs in. Pure, so it is tested. */
export function rigEnvironment(base, folder, port) {
  const preload = `--require "${NO_NETWORK.replaceAll('\\', '/')}"`;
  return {
    ...base, ...ownFolders(folder),
    XENON_PORT: String(port), XENON_BIND_HOST: '127.0.0.1', XENON_RIG_NO_NETWORK: '1',
    NODE_OPTIONS: [base.NODE_OPTIONS, preload].filter(Boolean).join(' '),
  };
}

/**
 * Copies the engine, writes the settings it starts with, starts it and waits until it answers.
 * @param {{ port: number, seed?: any }} options `seed` is the settings object, or a function of the rig's folder that gives it
 */
export async function startRig({ port, seed }) {
  // The real path: macOS hands out its temp folder under a link (/var for /private/var) and a
  // Windows runner under a short name, and a path the engine sends back resolved would not
  // start with the one a rule built from here.
  const folder = realpathSync.native(copyEngine());
  const storeFile = path.join(folder, 'server', 'data', 'settings.json');
  if (seed !== undefined) {
    mkdirSync(path.dirname(storeFile), { recursive: true });
    writeFileSync(storeFile, JSON.stringify(typeof seed === 'function' ? seed(folder) : seed));
  }
  let output = '';
  let child = null;
  const start = async () => {
    child = spawn(process.execPath, ['server/server.js'], { cwd: folder, env: rigEnvironment(process.env, folder, port), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const until = Date.now() + BOOT_LIMIT_MS;
    while (Date.now() < until && child.exitCode === null) {
      if (await request(port, { path: '/version' })) return true;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return false;
  };
  const halt = () => stopChild(child);
  const unwatch = endWithProcess(() => child);
  const rig = {
    folder, port, storeFile,
    up: await start(),
    ask: (method, pathname, body, headers) => request(port, { method, path: pathname, body, headers }),
    storedText: () => readFileSync(storeFile, 'utf8'),
    stored: () => JSON.parse(readFileSync(storeFile, 'utf8')),
    writeStore: (text) => writeFileSync(storeFile, text),
    output: () => output,
    restart: async () => { await halt(); rig.up = await start(); return rig.up; },
    stop: async () => {
      await halt();
      unwatch();
      try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a file still held: the system clears its temp folder */ }
    },
  };
  return rig;
}

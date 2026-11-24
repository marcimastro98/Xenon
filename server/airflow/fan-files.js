'use strict';
// The LHM driver's file calls. On a PC busy on every core the antivirus holds the first
// open of a file written moments before (the service's readings, a sound tool's table,
// settings) for tens of seconds. Four such opens filled the engine's pool of four threads,
// every file call queued behind them, a fan command waited 26 s, the service's lease ran
// out and the fans went back to the BIOS (measured 23 Nov 2026). So the commands (create,
// unlink, list, stat: files the antivirus does not hold) run on one thread of their own,
// queued behind nothing but the previous command. fan.json, the one file here the
// antivirus holds, is read on the shared pool (32 threads, server/engine/thread-pool.js):
// on the commands' thread a held read would hold every command behind it. The thread
// costs about 13 MB, so it starts with the first call and ends after IDLE_MS without one:
// it lives only while Airflow watches or drives the fans.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { readJsonFile } = require('../sensor-service/reader.js');

const WORKER = path.join(__dirname, 'fan-files-worker.js');
const IDLE_MS = 30000;

/**
 * One thread, started on a call when none runs; calls run one at a time, in order.
 * @param {() => Worker} make @param {number} idleMs
 */
function fileThread(make, idleMs) {
  /** @type {Worker | null} */
  let worker = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idle = null;
  let next = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  const fail = (/** @type {Error} */ err) => {
    worker = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  // Ended once nothing has been asked for idleMs; the next call starts another.
  const rest = (/** @type {Worker} */ w) => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      idle = null;
      if (worker !== w) return;
      worker = null;
      void w.terminate();
    }, idleMs);
    idle.unref();
  };
  function start() {
    const w = make();
    // A thread waiting on a file never keeps the engine from exiting.
    w.unref();
    w.on('message', ({ id, ok, value, code, message }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(value);
      else p.reject(Object.assign(new Error(message), { code }));
      if (!pending.size) rest(w);
    });
    w.on('error', (err) => { if (worker === w) fail(err); });
    w.on('exit', () => { if (worker === w) fail(new Error('the file thread stopped')); });
    return w;
  }
  return {
    /** @param {string} op @param {...any} args @returns {Promise<any>} */
    call(op, ...args) {
      if (idle) { clearTimeout(idle); idle = null; }
      if (!worker) worker = start();
      const w = worker;
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, op, args });
      });
    },
    async close() {
      const w = worker;
      if (idle) { clearTimeout(idle); idle = null; }
      fail(new Error('the file thread was closed'));
      if (w) await w.terminate();
    },
  };
}

/**
 * @param {{ make?: () => Worker, idleMs?: number }} [opts]
 */
function createFanFiles({ make = () => new Worker(WORKER), idleMs = IDLE_MS } = {}) {
  const thread = fileThread(make, idleMs);
  return {
    /** fan.json, parsed; null when missing, not a file, too big or broken. The antivirus may hold it. */
    readJson: (/** @type {string} */ file) => readJsonFile(file),
    /** @returns {Promise<{ mtimeMs: number, size: number, file: boolean, dir: boolean }>} */
    stat: (/** @type {string} */ file) => thread.call('stat', file),
    create: (/** @type {string} */ file) => thread.call('create', file),
    unlink: (/** @type {string} */ file) => thread.call('unlink', file),
    /** @returns {Promise<string[]>} */
    list: (/** @type {string} */ dir) => thread.call('list', dir),
    close: () => thread.close(),
  };
}

module.exports = { createFanFiles, IDLE_MS };

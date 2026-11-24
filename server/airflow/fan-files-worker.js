'use strict';
// The thread behind fan-files.js: plain blocking file calls, one at a time, on a thread of
// its own, so they never wait in libuv's shared pool. It knows nothing of fans: the
// engine's side checks every name and path before it gets here.
const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');

const OPS = Object.freeze({
  stat(file) {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size, file: s.isFile(), dir: s.isDirectory() };
  },
  // wx: a name that is already there is never written through.
  create(file) { fs.writeFileSync(file, '', { flag: 'wx' }); },
  unlink(file) { fs.unlinkSync(file); },
  list(dir) { return fs.readdirSync(dir); },
});

parentPort?.on('message', ({ id, op, args }) => {
  try {
    if (!Object.hasOwn(OPS, op)) throw new Error('unknown file call');
    parentPort.postMessage({ id, ok: true, value: OPS[op](...args) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, code: err?.code || 'EFAIL', message: String(err?.message || err) });
  }
});

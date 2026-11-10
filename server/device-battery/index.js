'use strict';
// Battery of devices the OS itself does not report, one backend per OS. Each read runs in
// its own short-lived process (reader-child.js): a device or driver that crashes or hangs
// costs one reading, never the server, and is left out for a day so it cannot do it again.

const path = require('path');
const { fork } = require('child_process');
const { accessFor } = require('./access');

const CHILD = path.join(__dirname, 'reader-child.js');
const READ_LIMIT_MS = 45 * 1000;      // about half a second here; each silent device adds a few
const LEFT_OUT_MS = 24 * 60 * 60 * 1000;
const PAUSE_MS = 60 * 60 * 1000;
const FAILURES_BEFORE_PAUSE = 3;
const SUPPORTED = new Set(['win32', 'linux', 'darwin']);

function startChild() {
  return fork(CHILD, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
}

// Settles once: { result }, or { failure, touching } with the device being read at the end.
function runChild(child, request, limitMs) {
  return new Promise((resolve) => {
    let touching = null;
    let result = null;
    const timer = setTimeout(() => settle('hung'), limitMs);
    if (timer.unref) timer.unref();

    function settle(failure) {
      clearTimeout(timer);
      child.removeAllListeners();
      child.on('error', () => {});
      if (failure === 'hung') child.kill('SIGKILL');
      resolve(result ? { result } : { failure, touching });
    }

    child.on('message', (message) => {
      if ('touching' in message) touching = message.touching;
      if (message.result) result = message.result;
      if (message.result || message.error) settle('failed');
    });
    child.once('error', () => settle('failed'));
    // How it ended goes in the log: a crash left a line nobody could follow up on.
    child.once('exit', (code, signal) => settle(`crashed (${signal || code})`));
    child.send(request, (e) => { if (e) settle('failed'); });
  });
}

function createReader({ start = startChild, now = Date.now, limitMs = READ_LIMIT_MS, platform = process.platform, warn = console.warn } = {}) {
  const leftOut = new Map();
  let failures = 0;
  let pausedUntil = 0;

  function leftOutNow() {
    for (const [key, until] of leftOut) if (now() >= until) leftOut.delete(key);
    return [...leftOut.keys()];
  }

  function noteFailure({ failure, touching }) {
    if (touching) {
      leftOut.set(touching, now() + LEFT_OUT_MS);
      warn(`[battery] device ${touching}: the reader ${failure}, left out for a day`);
      return;
    }
    failures += 1;
    if (failures < FAILURES_BEFORE_PAUSE) return;
    failures = 0;
    pausedUntil = now() + PAUSE_MS;
    warn(`[battery] the device reader ${failure} ${FAILURES_BEFORE_PAUSE} times, paused for an hour`);
  }

  async function read({ ask = true } = {}) {
    if (!SUPPORTED.has(platform) || now() < pausedUntil) return { available: false, devices: [], asked: ask, access: null };
    const outcome = await runChild(start(), { ask, skip: leftOutNow() }, limitMs);
    if (!outcome.result) {
      noteFailure(outcome);
      return { available: false, devices: [], asked: ask, access: null };
    }
    failures = 0;
    const { devices, denied } = outcome.result;
    return { available: true, devices, asked: ask, access: denied ? accessFor(platform) : null };
  }

  return { read };
}

module.exports = { ...createReader(), createReader };

'use strict';
// Why the dashboard engine did not start.
//
// On Windows the engine is launched by `start-hidden.vbs`, from a per-logon
// scheduled task, as `cmd /c node server.js` with the window hidden and no
// redirection. That is the right shape for something meant to run all day
// unseen, and it means a start that FAILS goes nowhere at all: no console, no
// file, no event. The user is left looking at the splash saying "Xenon isn't
// finished installing", presses "Try setup again", and the setup — which finds
// every file present — says there is nothing to do. Round and round, with the
// one fact that would end it never written down anywhere. Reported on Discord.
//
// v4.11.5 closed the same hole twice already: `setup.log` for the installer and
// the shell's crash diary for the native window. This is the third of those
// three processes, and the only one still silent.
//
// Required FIRST in server.js, before any other module, because the failure
// this most needs to catch is one of those requires throwing — a dependency
// that never finished installing, most of all. A handler registered before the
// throw does receive it, including a top-level MODULE_NOT_FOUND.
//
// Rules this file lives by, since it runs before anything is known to work:
//   * no dependencies beyond node's own fs/os/path;
//   * every operation wrapped — a logger that throws would replace a silent
//     failure with a louder one, which is worse than what we started with;
//   * nothing here may change how the server behaves when it starts NORMALLY.
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

// Beside setup.log on Windows. That folder is what the splash and the installer
// already tell people to send, so one place holds the whole story of a bad
// install, and uninstall.ps1 already removes it. Off Windows the engine is not
// started by a hidden launcher at all, so the log is a convenience rather than
// the only witness, and it lives with the rest of the install.
function logDir() {
  // Honoured first so the tests can point this somewhere disposable — there is
  // no other way in, and a logger nobody can exercise is a logger nobody knows
  // works. Also serves a portable install whose folder is read-only.
  if (process.env.XENON_LOG_DIR) return process.env.XENON_LOG_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'Xenon');
  }
  return path.join(__dirname, 'data');
}

const LOG = path.join(logDir(), 'server.log');
const PREV = LOG + '.1';

function stamp() {
  // Local time, not ISO: this is read by a person comparing it against "I
  // pressed the button just now", and by whoever they send it to.
  try { return new Date().toLocaleString(); } catch { return ''; }
}

function write(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, stamp() + '  ' + line + os.EOL);
  } catch { /* a log that cannot be written must never be the problem */ }
}

// One run per file, with the run before it kept beside it — the same shape
// setup.log uses, and for the same reason: the interesting run is often the one
// BEFORE the retry that finally gets reported. Rotating on start (rather than
// appending forever) also means the file cannot grow without bound on a machine
// that restarts the engine daily for months.
function rotate() {
  try {
    if (!fs.existsSync(LOG)) return;
    try { fs.rmSync(PREV, { force: true }); } catch { /* first rotation */ }
    fs.renameSync(LOG, PREV);
  } catch { /* keep appending to the existing file rather than losing the run */ }
}

// Ceiling on teed console lines per run. The engine's console carries 44
// diagnostics, none of them per-request — but a fault that retries in a loop
// could still write forever, and a log that fills the disk is a worse bug than
// the one it was recording. At the cap it says so once and goes quiet; the
// original console is never touched, so nothing is lost that was not already
// being discarded.
const MAX_TEED_LINES = 500;
let teed = 0;

let installed = false;

/**
 * Records the start, and arms the two handlers that turn a silent death into a
 * line in the file. Idempotent.
 *
 * Both handlers RE-RAISE by exiting non-zero. This module exists to make a
 * failure legible, never to keep a broken process alive: an engine that
 * swallowed its own fatal error would answer the port without working, which is
 * a worse thing to debug than not starting at all.
 */
function install() {
  if (installed) return;
  installed = true;
  rotate();
  write(`engine starting — node ${process.version}, pid ${process.pid}, ${process.platform}`);

  process.on('uncaughtException', (err) => {
    const e = err || {};
    // First line only: a MODULE_NOT_FOUND message carries its whole require
    // stack, which the frames below already say more precisely.
    const msg = String(e.message || err || '').split('\n')[0];
    write(`FAILED: ${e.code || e.name || 'Error'}: ${msg}`);
    // The call frames name the file, which is what separates "a dependency is
    // missing" from "settings.json is corrupt". Only real frames — the stack
    // repeats the message first, and for MODULE_NOT_FOUND that is four lines.
    const frames = String(e.stack || '').split('\n').filter((l) => /^\s+at\s/.test(l)).slice(0, 3);
    for (const f of frames) write('  ' + f.trim());
    if (e.code === 'MODULE_NOT_FOUND') {
      write('  A dependency is missing or was not fully installed. Run the Xenon setup again.');
    } else if (e.code === 'EADDRINUSE') {
      write('  Port 3030 is already taken by another program. Xenon cannot share it.');
    } else if (e.code === 'EACCES' || e.code === 'EPERM') {
      write('  Windows refused the operation — an antivirus or a permission on the install folder.');
    }
    process.exit(1);
  });

  // A rejection with no catch does not stop the process today, but it is how a
  // half-started engine ends up answering nothing while looking alive. Recorded
  // without exiting, so it explains a degraded start without causing one.
  process.on('unhandledRejection', (reason) => {
    const r = reason || {};
    write(`unhandled rejection: ${r.code || r.name || ''} ${r.message || String(reason)}`.trim());
  });

  process.on('exit', (code) => {
    if (code !== 0) write(`engine exited with code ${code}`);
  });

  teeConsole();
}

// Copy console.error/console.warn into the file as well.
//
// Under the hidden launcher the engine has no console at all, so every one of
// those diagnostics is written to nowhere. That is not hypothetical: when a user
// asked why Discord notifications would not arrive, the engine had already
// logged the exact rejection Discord gave — and there was no way for anyone to
// read it. Whether the cause was the missing scope or something else was
// unanswerable from the outside, on information the program had and threw away.
//
// error/warn only. console.log is progress, not evidence, and the ordinary
// startup chatter would bury the lines that matter.
//
// The original functions are still called, first and always: a machine that DOES
// have a console keeps behaving exactly as before, and a failure in the tee can
// never cost a message. util.format is what console itself uses, so an Error or
// an object reads the same in the file as it does on screen.
function teeConsole() {
  for (const level of ['error', 'warn']) {
    const original = console[level];
    if (typeof original !== 'function') continue;
    console[level] = function teedConsole(...args) {
      try { original.apply(console, args); } catch { /* keep going: the copy still matters */ }
      try {
        if (teed >= MAX_TEED_LINES) return;
        teed += 1;
        if (teed === MAX_TEED_LINES) {
          write(`[console] ${MAX_TEED_LINES} lines recorded; further console output is not copied here.`);
          return;
        }
        // Bounded per line as well — one enormous object must not become the
        // whole file.
        write('[' + level + '] ' + util.format(...args).slice(0, 2000));
      } catch { /* a log that cannot be written must never be the problem */ }
    };
  }
}

module.exports = { install, write, teeConsole, LOG, PREV, MAX_TEED_LINES };

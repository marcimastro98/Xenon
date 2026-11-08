'use strict';

// What the PresentMons write to server.log: enough to tell, after a game whose
// counter stayed blank, whether no dashboard was connected or PresentMon kept
// ending, and why it ended. One line per change, never one per retry.

const STDERR_KEEP = 2000;   // characters of PresentMon's stderr kept while it runs
const ERROR_MAX = 200;

// PresentMon says on stderr why it stopped: exit code 6 is a trace session that did
// not start, and its line says why (access denied, or an error number). Warnings
// land there too, so only an "error" line counts as the reason.
function createStderrTail() {
  let text = '';
  return {
    add(chunk) { text = (text + chunk).slice(-STDERR_KEEP); },
    // "code 6" becomes "code 6, error: failed to start trace session (error=1450)."
    explain(why) {
      const error = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^error\b/i.test(line));
      return error ? `${why}, ${error.slice(0, ERROR_MAX)}` : why;
    },
  };
}

function createReaderLog(log = console.warn, now = Date.now) {
  let reading = false;
  let failing = false;

  return {
    // Frames are read while a dashboard or a recording needs them, and through a
    // game the reader was already in (fps-demand.js).
    reading(on) {
      if (on === reading) return;
      reading = on;
      log(on ? 'fps: reading frames for a dashboard or a recording' : 'fps: not reading frames, no dashboard, recording or game is open');
    },
    // PresentMon ended on its own. Until rows come again, its retries add nothing.
    ended(startedAt, why) {
      if (failing) return;
      failing = true;
      log(`fps: PresentMon ended after ${Math.round((now() - startedAt) / 1000)} s (${why}), starting it again`);
    },
    // When it came back tells whether a game was already running by then.
    rows() {
      if (!failing) return;
      failing = false;
      log('fps: PresentMon reading again');
    },
  };
}

module.exports = { createReaderLog, createStderrTail };

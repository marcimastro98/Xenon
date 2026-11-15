'use strict';

// A second PresentMon, on one game, for as long as Windows composes it.
//
// A window above a game, or the focus somewhere else, turns it into "Composed:
// Flip", and the display tracking of the main session then reports almost
// nothing: measured 14 rows in 8 s on a game running 240 fps, while a session
// with `-no_track_display` saw all 1667. Those rows made the frame rate read 8
// and every gap between them a stutter. The main session cannot simply drop the
// tracking, because the present mode and the display side both come from it.
//
// This file owns the process and when it runs. What its rows mean is fpsmon.js.

const { createStderrTail } = require('./fps-reader-log');

const LINGER_MS = 15000;      // alt-tabbing must not start and stop a trace each time
const FAST_EXIT_MS = 2500;    // dying this soon means no admin rights or no binary
const FAIL_BACKOFF_MS = 60000;
const LIVE_MS = 2000;         // fpsmon's SAMPLE_WINDOW_MS: quieter than this is not reading
const LOG_EVERY_MS = 60000;

// log: an end it did not ask for goes to server.log, so a counter that went blank
// in a game can be explained. One line a minute at most, however often it fails.
function createGameSession({ launch, onChunk, stopTrace, now = Date.now, log = console.warn }) {
  let proc = null;
  let pid = '';
  let wantedAt = 0;
  let lastChunkAt = 0;
  let retryAt = 0;
  let notedAt = -Infinity;

  function note(line) {
    if (now() - notedAt < LOG_EVERY_MS) return;
    notedAt = now();
    log(line);
  }

  function stop() {
    if (!proc) return;
    try { proc.kill(); } catch { /* already gone */ }
    proc = null;
    pid = '';
    stopTrace();
  }

  function begin(target) {
    const startedAt = now();
    let child;
    try {
      child = launch(target);
    } catch (e) {
      retryAt = startedAt + FAIL_BACKOFF_MS;
      note(`fps: the game's frame reader did not start (${e && e.message})`);
      return;
    }
    proc = child;
    pid = target;
    lastChunkAt = 0;
    let fresh = true;
    // A replaced process can still speak or close: only the current one counts.
    const ended = (why) => {
      if (proc !== child) return;
      proc = null;
      pid = '';
      const ranMs = now() - startedAt;
      if (ranMs < FAST_EXIT_MS) retryAt = now() + FAIL_BACKOFF_MS;
      note(`fps: the game's frame reader ended after ${Math.round(ranMs / 1000)} s (${why})`);
    };
    child.stdout.on('data', (d) => {
      if (proc !== child) return;
      lastChunkAt = now();
      onChunk(d.toString('utf8'), fresh);
      fresh = false;
    });
    const stderr = createStderrTail();
    child.stderr.on('data', (d) => stderr.add(d.toString('utf8')));
    child.on('error', (e) => ended((e && e.code) || 'error'));
    child.on('close', (code, signal) => ended(stderr.explain(signal || 'code ' + code)));
  }

  // One composed row of the tracked game.
  function want(target) {
    const id = String(target || '');
    if (!/^\d+$/.test(id)) return;
    wantedAt = now();
    if (proc && pid === id) return;
    stop();
    if (wantedAt >= retryAt) begin(id);
  }

  // Nobody asked for a while: the game went back to a flip mode, or it closed.
  function tick() {
    if (proc && now() - wantedAt > LINGER_MS) stop();
  }

  // True while this session is the one counting that process.
  function owns(target) {
    return !!proc && pid === String(target) && lastChunkAt > 0 && now() - lastChunkAt <= LIVE_MS;
  }

  return { want, tick, owns, stop };
}

module.exports = { createGameSession, LINGER_MS, FAST_EXIT_MS, FAIL_BACKOFF_MS, LIVE_MS };

'use strict';
// Each reading of the window in front taken in: the lines of the probe split and read, the
// reading kept, and a change told the moment it happens.

const { gameWatch } = require('./game-watch-state.js');
const { isGaming } = require('./game-judge.js');

function handleLine(line) {
  let data;
  try { data = JSON.parse(line); } catch { return; }
  applySample(data);
}

// One probe reading, whatever produced it. Split out of handleLine because the
// Linux probe is an in-process module rather than a child emitting JSON lines —
// there is no script to spawn there, only three xprop reads — and both sources
// must land in exactly the same state and fire the same change notification.
function applySample(data) {
  if (!data || typeof data !== 'object') return;
  gameWatch.last = {
    fullscreen: data.fullscreen === true,
    process: String(data.process || '').toLowerCase(),
    pid: Number(data.pid) || 0,
    at: Date.now(),
  };
  // Re-evaluate on every probe line so flips ride the instant push lines.
  // (Grace expiry without a flip-causing line is still caught here: the probe
  // emits at least every PROBE_INTERVAL_MS.)
  const gaming = isGaming();
  if (gaming !== gameWatch.notified) {
    gameWatch.notified = gaming;
    try { const told = gameWatch.onChange; if (told) told(gaming); } catch { }
  }
}

function onData(chunk) {
  gameWatch.buffer += chunk;
  let nl;
  while ((nl = gameWatch.buffer.indexOf('\n')) >= 0) {
    const line = gameWatch.buffer.slice(0, nl).replace(/\r$/, '').trim();
    gameWatch.buffer = gameWatch.buffer.slice(nl + 1);
    if (!line) continue;
    gameWatch.fastFails = 0; // receiving data → healthy
    handleLine(line);
  }
}

module.exports = { handleLine, applySample, onData };

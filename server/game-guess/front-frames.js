'use strict';
// The frames of the app in front that the FPS reader leaves out. fpsmon.js drops
// a row Windows composes like a desktop app ("Composed: Flip", "Composed: Copy
// with GPU GDI"), or every browser and editor would read as a game. A game played
// in a window can present exactly that way (Final Fantasy XI clients from a
// multi-window launcher), so it was never found. This keeps only the app in
// front's dropped frames, for game-guess/watch.js to ASK about, never to treat
// as a game on its own.

const RECENT_MS = 1500;   // older than this, the app stopped drawing
const MAX_GAPS = 120;     // about two seconds of a 60 fps window

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function createFrontFrames({ now = Date.now } = {}) {
  let pid = '';
  let last = 0;
  const gaps = [];

  // One composed row of the app in front: { pid, present, usesFps }.
  function add(r) {
    if (!r || !r.composed || !(r.present > 0)) return;
    const gap = r.usesFps ? 1000 / r.present : r.present;
    if (String(r.pid) !== pid) { pid = String(r.pid); gaps.length = 0; }
    gaps.push(gap);
    if (gaps.length > MAX_GAPS) gaps.shift();
    last = now();
  }

  // { pid, fps } while it draws, else null.
  function read() {
    if (!gaps.length || now() - last > RECENT_MS) return null;
    const m = median(gaps);
    return m > 0 ? { pid, fps: Math.round(1000 / m) } : null;
  }

  return { add, read };
}

module.exports = { createFrontFrames };

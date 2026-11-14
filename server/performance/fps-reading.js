'use strict';
// Turns the frame times kept for a program into what the dashboard shows: its frames per
// second, its frame statistics, and the frames since a moment.

const { frameStats, toFrameTimes, cleanFrameTimes } = require('../frame-stats.js');

const SAMPLE_WINDOW_MS = 2000;   // a process must have presented this recently

// The lows need a longer tail than the median: 0.1% of 240 frames is a quarter
// of a frame. ~7 s at 300 fps, ~33 s at 60.
const STATS_SAMPLES = 2000;

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The process to read the frame rate from. Doubles as the pruning pass: stale
// PIDs are evicted while we scan, keeping the map bounded to processes that
// presented in the last minute.
// Pure, and prunes nothing — the caller decides what to evict. `wantedPid` is
// the foreground window's, '' when unknown.
function pickEntry(byPid, now, wantedPid) {
  let best = null;
  let front = null;
  const wanted = String(wantedPid || '');
  for (const [pid, entry] of byPid) {
    if (now - entry.lastSeen > SAMPLE_WINDOW_MS) continue;
    if (!entry.samples.length && !entry.display.length) continue;
    if (wanted && String(pid) === wanted) front = entry;
    if (!best || weight(entry) > weight(best)) best = entry;
  }
  // The foreground window only wins when it is actually presenting: one that
  // hands over no frames (the dashboard, a paused game) must not silence a game
  // still running behind it. The loop above has already established that.
  return front || best;
}
function weight(entry) { return Math.max(entry.samples.length, entry.display.length); }

function medianOf(arr) {
  if (!arr || !arr.length) return null;
  const m = median(arr);
  return Number.isFinite(m) && m > 0 ? m : null;
}

// Both sides of one entry.
//
//   presentFps  how often frames are handed over. What Xenon has always read.
//   displayFps  how often the screen actually changes — the number RTSS and the
//               NVIDIA overlay show, and the only one that stays honest under
//               frame generation. Null when the capture carries no display
//               timing (display tracking off, or a CSV that never had it).
//   fps         the frame rate the person is SEEING: display-side when we have
//               it, present-side otherwise.
function entryFps(entry) {
  if (!entry) return { fps: null, presentFps: null, displayFps: null };
  const p = medianOf(entry.samples);
  const d = medianOf(entry.display);
  const presentFps = p == null ? null : Math.round(entry.usesFps ? p : 1000 / p);
  const displayFps = d == null ? null : Math.round(1000 / d);
  return { fps: displayFps != null ? displayFps : presentFps, presentFps, displayFps };
}

// Frame-time statistics for one entry, from the same side entryFps reports: the
// display side when the capture carries it, the present side otherwise.
function entryStats(entry) {
  if (!entry || !entry.presentRing) return null;
  if (entry.displayRing.size()) return Object.assign({ side: 'display' }, frameStats(entry.displayRing.last(STATS_SAMPLES)));
  const s = frameStats(toFrameTimes(entry.presentRing.last(STATS_SAMPLES), entry.usesFps));
  return s && Object.assign({ side: 'present' }, s);
}

// The newest `n` frame times (ms, oldest first) of an entry, from the same
// side entryStats measures, for the performance tile's graph. Null when
// nothing is measured.
function entryWindow(entry, n) {
  if (!entry || !entry.presentRing) return null;
  if (entry.displayRing.size()) return { side: 'display', frames: entry.displayRing.last(n) };
  const frames = cleanFrameTimes(toFrameTimes(entry.presentRing.last(n), entry.usesFps));
  return frames.length ? { side: 'present', frames } : null;
}

// Frame times an entry presented since `mark` (what the last call returned), so
// a game session can add every frame once. A mark from another entry or side
// (the game restarted, the capture gained a display column) starts over: those
// frames are not comparable with the ones already counted. The ring holds
// RING_FRAMES, so a reader every 3 s misses nothing below 2000 FPS.
function entryFramesSince(entry, mark) {
  if (!entry || !entry.presentRing) return { mark: null, frames: [] };
  const display = entry.displayRing.size() > 0;
  const ring = display ? entry.displayRing : entry.presentRing;
  const next = { entry, side: display ? 'display' : 'present', total: ring.total() };
  if (!mark || mark.entry !== entry || mark.side !== next.side) return { mark: next, frames: [] };
  const fresh = ring.last(next.total - mark.total);
  return { mark: next, frames: display ? fresh : cleanFrameTimes(toFrameTimes(fresh, entry.usesFps)) };
}

// The entry of a named game (lowercase, no .exe, as game detection reports it),
// not the foreground one: a session keeps counting its game while the user is
// in another window.
function entryForGame(byPid, game) {
  const want = String(game || '').toLowerCase().replace(/\.exe$/, '');
  if (!want) return null;
  let found = null;
  for (const e of byPid.values()) {
    const name = String(e.name || '').toLowerCase().replace(/\.exe$/, '');
    if (name === want && (!found || e.lastSeen > found.lastSeen)) found = e;
  }
  return found;
}

module.exports = {
  SAMPLE_WINDOW_MS, STATS_SAMPLES, median, pickEntry, weight, medianOf, entryFps, entryStats,
  entryWindow, entryFramesSince, entryForGame,
};

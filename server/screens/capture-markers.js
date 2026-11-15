'use strict';
// Markers on the capture timeline: a bookmark the user drops while a recording
// or Instant Replay runs (Deck, Bit, a key), and an automatic one where the
// game stutters. A log of { t: wall-clock ms, kind } kept for the longest
// replay; a saved video takes the markers inside its own span (between()).
//
// Stutters come from the frames fpsmon already reads (getFramesSince), on the
// status tick: no timer of its own, and nothing is read unless a capture runs,
// a game runs and automatic markers are on.

const KINDS = Object.freeze(['mark', 'stutter']);
const KEEP_MS = 65 * 60 * 1000;      // the longest replay is 60 minutes
const MAX_LOG = 200;
const MAX_PER_CAPTURE = 100;
const SAME_PRESS_MS = 1000;          // two presses this close are one marker
const STUTTER_GAP_MS = 20 * 1000;    // one stutter marker per stretch of trouble
const GAME_WARMUP_MS = 10 * 1000;    // loading hitches are not news
const MIN_BATCH = 30;                // too few frames say nothing about a spike
const SPIKE_MIN_MS = 50;
const SPIKE_TIMES_MEDIAN = 3;

function median(list) {
  const s = list.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// When each spike happened: frames are consecutive frame times ending at `end`.
// Oldest first.
function spikeTimes(frames, end) {
  const valid = frames.filter(f => Number.isFinite(f) && f > 0);
  if (valid.length < MIN_BATCH) return [];
  const limit = Math.max(SPIKE_MIN_MS, SPIKE_TIMES_MEDIAN * median(valid));
  const out = [];
  let after = 0;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i] >= limit) out.push(end - after);
    after += valid[i];
  }
  return out.reverse();
}

function createCaptureMarkers({ fps, active = () => false, autoMarks = () => true, onAdd = () => {}, now = Date.now }) {
  let log = [];
  let frameMark = null;
  let game = '';
  let gameSince = 0;
  let lastStutter = -Infinity;

  function keep(t, kind) {
    log.push({ t, kind });
    const oldest = now() - KEEP_MS;
    log = log.filter(m => m.t >= oldest).slice(-MAX_LOG);
    // The automatic clips (capture-autoclips.js) listen; a listener never breaks the log.
    try { onAdd({ t, kind }); } catch { /* ignored */ }
  }

  // A bookmark from the user. Only while something is recording: a marker no
  // video will ever hold would be a promise the gallery cannot keep.
  function mark() {
    if (!active()) return { ok: false, error: 'not_recording' };
    const t = now();
    const last = log.filter(m => m.kind === 'mark').pop();
    if (last && t - last.t < SAME_PRESS_MS) return { ok: true, already: true };
    keep(t, 'mark');
    return { ok: true };
  }

  function reset() { frameMark = null; game = ''; }

  // Fed by the status tick with what game detection says.
  function tick({ running, game: g } = {}) {
    const name = running ? String(g || '') : '';
    if (!name || !active() || !autoMarks() || !fps || typeof fps.getFramesSince !== 'function') return reset();
    const t = now();
    if (name !== game) { game = name; gameSince = t; frameMark = null; }
    let read;
    try { read = fps.getFramesSince(frameMark, game); } catch { return reset(); }
    frameMark = read && read.mark;
    for (const at of spikeTimes((read && read.frames) || [], t)) {
      if (at < gameSince + GAME_WARMUP_MS || at - lastStutter < STUTTER_GAP_MS) continue;
      lastStutter = at;
      keep(at, 'stutter');
    }
  }

  // The markers of a video that covers [from, to] (wall-clock ms), in seconds
  // from its start.
  function between(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
    return log.filter(m => m.t >= from && m.t <= to)
      .sort((a, b) => a.t - b.t)
      .slice(0, MAX_PER_CAPTURE)
      .map(m => ({ at: Math.round((m.t - from) / 100) / 10, kind: m.kind }));
  }

  return { mark, tick, between };
}

// What a stored entry may carry: sorted, inside the video, capped.
function normalizeMarkers(list, length) {
  if (!Array.isArray(list)) return [];
  const end = Number.isFinite(length) && length > 0 ? length : Infinity;
  return list
    .filter(m => m && KINDS.includes(m.kind) && Number.isFinite(m.at) && m.at >= 0 && m.at <= end)
    .map(m => ({ at: Math.round(m.at * 10) / 10, kind: m.kind }))
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_PER_CAPTURE);
}

// The markers of a trimmed copy: those inside [start, end], from its new start.
function shiftMarkers(list, start, end) {
  return normalizeMarkers(list)
    .filter(m => m.at >= start && m.at <= end)
    .map(m => ({ at: Math.round((m.at - start) * 10) / 10, kind: m.kind }));
}

module.exports = {
  createCaptureMarkers, normalizeMarkers, shiftMarkers, spikeTimes,
  KINDS, KEEP_MS, MAX_PER_CAPTURE, STUTTER_GAP_MS, GAME_WARMUP_MS,
};

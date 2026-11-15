'use strict';
// Clips Instant Replay saves by itself (capture.replayClips): around each
// moment the user marks ('marks', the default) and, with 'all', around every
// stutter capture-markers.js finds too. A clip waits AFTER_MS past the moment
// so it holds what came next, then asks the replay for the stretch from
// BEFORE_S before the first moment; moments close together share one clip, up
// to MAX_S. Only while the replay runs and no recording does: a recording
// already holds the moment. No timer runs unless a clip is waiting.

const BEFORE_S = 15;
const AFTER_MS = 5000;
const MAX_S = 60;
// A game that keeps stuttering makes one clip every 2 minutes, not a full disk.
const STUTTER_GAP_MS = 2 * 60 * 1000;
// The replay takes one save at a time: a clip that meets another save waits.
const RETRY_MS = 1500;
const MAX_TRIES = 5;
const MAX_QUEUED = 10;
// "Clips from marks" on a saved video makes at most this many copies.
const MAX_CLIPS = 20;
// A copy starts at the keyframe before its start: one that would leave out
// less than this of the video is the same video again, not a clip.
const MIN_CUT_S = 3;

function createAutoClips({
  replay, recording = () => false, mode = () => 'marks',
  now = Date.now, timers = { setTimeout, clearTimeout },
}) {
  let pending = null;   // { from, until, mark, tries, timer, saving, next: [] }
  let lastStutterClip = -Infinity;
  let stopped = false;

  const wants = (kind) => {
    const m = mode();
    return m === 'all' || (m === 'marks' && kind === 'mark');
  };
  const live = () => {
    try { return replay.status().on === true && !recording(); } catch { return false; }
  };

  function arm(ms) {
    if (pending.timer) timers.clearTimeout(pending.timer);
    pending.timer = timers.setTimeout(fire, Math.max(0, ms));
    if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
  }

  // A moment from the marker log: { t: wall-clock ms, kind: 'mark' | 'stutter' }.
  function onMark(m) {
    const t = m && Number(m.t);
    const kind = m && m.kind;
    if (stopped || !Number.isFinite(t) || !wants(kind) || !live()) return;
    if (pending) {
      const cap = pending.from + (MAX_S - BEFORE_S) * 1000;
      // Saving, or past what one clip holds: it gets the next clip.
      if (pending.saving || t > cap) {
        if (pending.next.length < MAX_QUEUED) pending.next.push({ t, kind });
        return;
      }
      pending.mark = pending.mark || kind === 'mark';
      const until = Math.min(t + AFTER_MS, cap);
      if (until > pending.until) {
        pending.until = until;
        arm(until - now());
      }
      return;
    }
    if (kind === 'stutter' && t - lastStutterClip < STUTTER_GAP_MS) return;
    pending = { from: t, until: t + AFTER_MS, mark: kind === 'mark', tries: 0, timer: null, saving: false, next: [] };
    arm(pending.until - now());
  }

  async function fire() {
    const p = pending;
    if (!p || stopped) return;
    p.timer = null;
    if (!live()) { pending = null; return; }
    // From BEFORE_S before the first moment to now, whatever the retries took.
    const seconds = Math.min(MAX_S + BEFORE_S, Math.ceil((now() - p.from) / 1000) + BEFORE_S);
    p.saving = true;
    let r = null;
    try { r = await replay.save({ seconds, auto: p.mark ? 'mark' : 'stutter' }); } catch { /* dropped below */ }
    if (stopped || pending !== p) return;
    p.saving = false;
    if (r && r.ok === false && r.error === 'saving' && ++p.tries < MAX_TRIES) { arm(RETRY_MS); return; }
    if (!p.mark && r && r.ok === true) lastStutterClip = p.from;
    pending = null;
    for (const m of p.next) onMark(m);
  }

  function stop() {
    stopped = true;
    if (pending && pending.timer) timers.clearTimeout(pending.timer);
    pending = null;
  }

  return { onMark, stop, waiting: () => !!pending };
}

// The stretches of a saved video `length` s long worth a clip each, for
// "Clips from marks": BEFORE_S before a marker to AFTER_MS after, merged when
// they touch, up to MAX_S and MAX_CLIPS. `which`: 'marks' (the user's),
// 'all' (stutters too) or 'auto' (the user's, or the stutters when there are
// none). A stretch that leaves out less than MIN_CUT_S is no clip.
function markWindows(markers, length, which = 'auto') {
  const list = (Array.isArray(markers) ? markers : []).filter(m => m && Number.isFinite(m.at) && m.at >= 0);
  const own = list.filter(m => m.kind === 'mark');
  const chosen = which === 'all' ? list : which === 'marks' || own.length ? own : list.filter(m => m.kind === 'stutter');
  const end = Number.isFinite(length) && length > 0 ? length : Infinity;
  const out = [];
  for (const m of chosen.slice().sort((a, b) => a.at - b.at)) {
    const start = Math.max(0, m.at - BEFORE_S);
    const stop = Math.min(end, m.at + AFTER_MS / 1000);
    const last = out[out.length - 1];
    if (last && start <= last.end && stop - last.start <= MAX_S) last.end = Math.max(last.end, stop);
    else out.push({ start, end: stop });
  }
  return out
    .filter(w => w.end - w.start >= 1 && end - (w.end - w.start) >= MIN_CUT_S)
    .slice(0, MAX_CLIPS)
    .map(w => ({ start: Math.round(w.start * 10) / 10, end: Math.round(w.end * 10) / 10 }));
}

module.exports = {
  createAutoClips, markWindows, BEFORE_S, AFTER_MS, MAX_S, MAX_CLIPS, MIN_CUT_S, STUTTER_GAP_MS, RETRY_MS, MAX_TRIES,
};

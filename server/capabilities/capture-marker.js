'use strict';
// A bookmark on the recording or Instant Replay that is running
// (server/capture-markers.js): the saved video carries it, and the gallery
// jumps to it. Deck key, AI add_capture_marker, SDK `capture` (it starts
// nothing and reads nothing: a time on the user's own timeline).
//
// deps.capture (injected):
//   host        the capture host: available()
//   markers     () → the markers log
//   recorder    () → the recorder: status() { on, since }
//   onMarker    ({ at }) → tells the dashboards (a toast with the time, when a
//               recording runs; Instant Replay has no "since" worth saying)

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

function recordingSeconds(c, now) {
  try {
    const s = typeof c.recorder === 'function' ? c.recorder().status() : null;
    return s && s.on === true && Number.isFinite(s.since) ? Math.max(0, Math.round((now - s.since) / 1000)) : null;
  } catch { return null; }
}

function run(d, _action, now = Date.now()) {
  const c = d && d.capture;
  if (!available(c) || typeof c.markers !== 'function') return { ok: false, error: 'unavailable' };
  const r = c.markers().mark();
  if (!r.ok || r.already) return r;
  const at = recordingSeconds(c, now);
  const out = at == null ? { ok: true } : { ok: true, at };
  try { if (typeof c.onMarker === 'function') c.onMarker(out); } catch { /* the marker is kept anyway */ }
  return out;
}

module.exports = { run };

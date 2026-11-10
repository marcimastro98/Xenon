'use strict';
// Instant Replay capabilities (server/replay.js).
//   replay         (Deck key, AI save_replay): save the last seconds, turn the
//                  replay on or off, or show the last clip in the file manager.
//   replayOptions  (AI set_instant_replay): read or change the replay's
//                  settings, the same choices as Settings → Recording,
//                  save shortcut included.
// The result carries the clip's id and file name, never its path.
//
// deps.capture (injected, shared with record.js):
//   host        the capture host: available()
//   store       () → the captures index
//   replay      () → the replay manager (replay.js)
//   options()   the capture options in force (capture-settings.js shape)
//   setOptions  (change) → saves a change to hubSettings.capture; the replay
//               follows it (the caller syncs it)
//   reveal      (file) → opens its folder with the file selected

const { REPLAY_MIN_S, REPLAY_MAX_S, REPLAY_WHEN, REPLAY_AUDIO, REPLAY_CLIPS, replayKeyOf } = require('../capture-settings');
const DeckShortcuts = require('../js/deck-shortcuts.js');

const MODES = Object.freeze(['save', 'toggle', 'on', 'off', 'reveal']);

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

// "45", "90s", "2m", "2 min", "1h": a length in whole seconds, or null.
function parseSeconds(v) {
  if (v == null || v === '') return null;
  const m = String(v).trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)?$/);
  if (!m) return NaN;
  const n = Number(m[1].replace(',', '.'));
  const unit = (m[2] || 's')[0];
  const s = Math.round(n * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1));
  return s > 0 ? s : NaN;
}

// What the AI and the Deck hear about the replay: no path, ever.
function describe(status, options) {
  const s = status || {};
  const o = options || {};
  const out = {
    enabled: o.replay === true,
    running: s.on === true,
    seconds: o.replaySeconds,
    when: o.replayWhen,
    audio: o.replayAudio,
    // Clips it saves by itself: around marked moments, stutters too, or never.
    clips: o.replayClips || 'marks',
    // The save shortcut as people read it ("Ctrl+Shift+F10"), or 'off'.
    shortcut: !o.replayKey || o.replayKey === 'off' ? 'off' : DeckShortcuts.formatShortcut(o.replayKey),
  };
  if (s.waiting) out.waitingForGame = true;
  if (s.error) out.error = s.error;
  return out;
}

async function reveal(c) {
  const last = await c.store().last('replay');
  if (!last) return { ok: false, error: 'no_file' };
  c.reveal(last.file);
  return { ok: true, shown: true, name: last.name };
}

async function setEnabled(c, r, on) {
  await c.setOptions({ replay: on });
  await r.sync();
  return { ok: true, ...describe(r.status(), c.options()) };
}

async function run(d, action) {
  const c = d && d.capture;
  const r = c && typeof c.replay === 'function' ? c.replay() : null;
  if (!available(c) || !r || typeof c.store !== 'function' || typeof c.setOptions !== 'function') {
    return { ok: false, error: 'unavailable' };
  }
  const a = action || {};
  const mode = MODES.includes(a.mode) ? a.mode : 'save';
  if (mode === 'reveal') return reveal(c);
  if (mode === 'on') return setEnabled(c, r, true);
  if (mode === 'off') return setEnabled(c, r, false);
  if (mode === 'toggle') return setEnabled(c, r, c.options().replay !== true);
  const seconds = parseSeconds(a.seconds);
  if (Number.isNaN(seconds)) return { ok: false, error: 'bad_seconds' };
  const res = await r.save(seconds ? { seconds } : {});
  return shortOf(res, seconds, c.options().replaySeconds);
}

// Asked for more than the replay keeps (42 s from a 30 s replay): the clip is
// what there was, and the answer says so, so Bit can offer a longer replay.
function shortOf(res, asked, keeps) {
  if (!res || !res.ok || !asked || !(Number(res.seconds) < asked - 1)) return res;
  return { ...res, asked, keeps };
}

// The AI's words → a change to hubSettings.capture, or the name of what is wrong.
function changeOf(a) {
  const change = {};
  if (a.enabled === 'on' || a.enabled === 'off') change.replay = a.enabled === 'on';
  if (REPLAY_WHEN.includes(a.when)) change.replayWhen = a.when;
  if (REPLAY_AUDIO.includes(a.audio)) change.replayAudio = a.audio;
  if (REPLAY_CLIPS.includes(a.clips)) change.replayClips = a.clips;
  const s = parseSeconds(a.seconds);
  if (Number.isNaN(s) || (s != null && (s < REPLAY_MIN_S || s > REPLAY_MAX_S))) return { bad: 'seconds' };
  if (s != null) change.replaySeconds = s;
  if (typeof a.shortcut === 'string' && a.shortcut.trim()) {
    const k = replayKeyOf(a.shortcut === 'default' ? '' : a.shortcut);
    if (k.owner) return { bad: 'reserved', owner: k.owner };
    if (!k.key) return { bad: 'shortcut' };
    change.replayKey = k.key;
  }
  return { change };
}

async function options(d, action) {
  const c = d && d.capture;
  const r = c && typeof c.replay === 'function' ? c.replay() : null;
  if (!available(c) || !r || typeof c.options !== 'function' || typeof c.setOptions !== 'function') {
    return { ok: false, error: 'unavailable' };
  }
  const { change, bad, owner } = changeOf(action || {});
  if (bad === 'seconds') return { ok: false, error: 'bad_seconds', min: REPLAY_MIN_S, max: REPLAY_MAX_S };
  if (bad === 'reserved') return { ok: false, error: 'reserved', owner };
  if (bad) return { ok: false, error: 'bad_shortcut' };
  if (!Object.keys(change).length) return { ok: true, ...describe(r.status(), c.options()) };
  await c.setOptions(change);
  await r.sync();
  return { ok: true, saved: true, ...describe(r.status(), c.options()) };
}

module.exports = { MODES, available, parseSeconds, describe, changeOf, shortOf, run, options };

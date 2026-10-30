'use strict';
// Recording capability: record the monitor in use or the window in front as an
// MP4 in Videos/Xenon/<game or Desktop> (server/recorder.js), stop it, or show
// the last recording in the file manager. The result carries the id and the
// file name, never the path.
//
// deps.capture (injected, shared with screenshot.js):
//   host      the capture host: available()
//   store     () → the captures index
//   recorder  () → the recorder
//   reveal    (file) → opens its folder with the file selected

const MODES = Object.freeze(['toggle', 'start', 'stop', 'reveal']);
const TARGETS = Object.freeze(['screen', 'window']);
const AUDIO = Object.freeze(['sound', 'sound_mic', 'silent']);
// The webcam bubble's corner; 'off' (or anything else) = no webcam.
const WEBCAM = Object.freeze(['off', 'tl', 'tr', 'bl', 'br']);

function available(capture) {
  return !!(capture && capture.host && typeof capture.host.available === 'function' && capture.host.available());
}

async function reveal(c) {
  const last = await c.store().last('recording');
  if (!last) return { ok: false, error: 'no_file' };
  c.reveal(last.file);
  return { ok: true, shown: true, name: last.name };
}

async function run(d, action) {
  const c = d && d.capture;
  const r = c && typeof c.recorder === 'function' ? c.recorder() : null;
  if (!available(c) || !r || typeof c.store !== 'function' || !c.store()) return { ok: false, error: 'unavailable' };
  const mode = MODES.includes(action.mode) ? action.mode : 'toggle';
  if (mode === 'reveal') return reveal(c);
  // "Stop" ends whatever runs (a timelapse too); the key never turns one into the other.
  if (mode === 'stop') return r.stop();
  if (r.status().every) return { ok: false, error: 'running' };
  const target = TARGETS.includes(action.target) ? action.target : 'screen';
  const audio = AUDIO.includes(action.audio) ? action.audio : 'sound';
  const webcam = WEBCAM.includes(action.webcam) && action.webcam !== 'off' ? action.webcam : '';
  const opts = { target, audio, ...(webcam ? { webcam } : {}) };
  if (mode === 'start') return r.start(opts);
  return r.toggle(opts);
}

module.exports = { MODES, TARGETS, AUDIO, WEBCAM, available, run };

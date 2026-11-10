'use strict';
// Timelapse capability: the recorder (server/recorder.js) taking one picture
// every N seconds of the monitor in use or the window in front, played back at
// 30 fps: an hour at "every 2 s" is a minute of video. Silent, " Timelapse" in
// the file name, in the same folder as the recordings. One recording at a
// time: a normal recording running is not stopped by the timelapse key.
//
// deps.capture: the same as record.js (host, store, recorder, reveal).

const { available } = require('./record.js');

const MODES = Object.freeze(['toggle', 'start', 'stop', 'reveal']);
const TARGETS = Object.freeze(['screen', 'window']);
const EVERY = Object.freeze(['1', '2', '5', '10', '30', '60']);
const DEFAULT_EVERY = 5;

async function reveal(c) {
  const last = await c.store().last('recording', e => !!e.lapse);
  if (!last) return { ok: false, error: 'no_file' };
  c.reveal(last.file);
  return { ok: true, shown: true, name: last.name };
}

function everyOf(v) {
  const s = String(v == null ? '' : v).trim();
  return EVERY.includes(s) ? Number(s) : DEFAULT_EVERY;
}

async function run(d, action) {
  const c = d && d.capture;
  const r = c && typeof c.recorder === 'function' ? c.recorder() : null;
  if (!available(c) || !r || typeof c.store !== 'function' || !c.store()) return { ok: false, error: 'unavailable' };
  const mode = MODES.includes(action.mode) ? action.mode : 'toggle';
  if (mode === 'reveal') return reveal(c);
  const now = r.status();
  // The key of one never ends the other: a normal recording says "running".
  if (now.on && !now.every) return mode === 'stop' ? { ok: false, error: 'not_recording' } : { ok: false, error: 'running' };
  if (mode === 'stop') return r.stop();
  const target = TARGETS.includes(action.target) ? action.target : 'screen';
  const opts = { target, every: everyOf(action.every) };
  return mode === 'start' ? r.start(opts) : r.toggle(opts);
}

module.exports = { MODES, TARGETS, EVERY, DEFAULT_EVERY, run };

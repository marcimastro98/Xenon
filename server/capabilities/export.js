'use strict';
// A copy of a video made for sharing (capture-export.js), from the Deck and
// the voice: "make the last clip vertical for TikTok", "compress it for
// Discord", "make a GIF of it". The copy takes seconds to a minute, so the
// action answers at once and the screen follows over SSE `capture_export`
// (js/capture-toast.js); Bit's turn waits for the end through `waitFor`
// (server.js), so it can say how big the copy came out.
//
// deps.capture: store() → captures.js, exports() → capture-export.js.

const { pick } = require('./transcript.js');

// The Deck's one choice; Bit may also give any size in `mb`.
const AS = Object.freeze({
  vertical: { kind: 'vertical' },
  vertical_cam: { kind: 'vertical', webcam: true },
  fit10: { kind: 'fit', mb: 10 },
  fit25: { kind: 'fit', mb: 25 },
  fit50: { kind: 'fit', mb: 50 },
  fit100: { kind: 'fit', mb: 100 },
  gif: { kind: 'gif' },
});
const WAIT_MS = 120000;
const ERRORS = new Set(['no_file', 'not_found', 'not_video', 'busy', 'unavailable', 'bad_size', 'no_webcam', 'already_small',
  'cancelled', 'too_big', 'too_long', 'export_failed', 'disk_full', 'write_failed', 'timeout']);

const fail = code => ({ ok: false, error: ERRORS.has(code) ? code : 'export_failed' });

function deps(d) {
  const c = d && d.capture;
  const store = c && typeof c.store === 'function' ? c.store() : null;
  const exports = c && typeof c.exports === 'function' ? c.exports() : null;
  return store && exports ? { store, exports } : null;
}

// The request the action stands for. `mb` (Bit only) always means a smaller
// copy of that size: validateAction turns a missing `as` into 'vertical', so
// `as` alone cannot say whether Bit asked for a size.
function optionsOf(action) {
  if (action.mb != null && action.mb !== '') return { kind: 'fit', mb: Number(action.mb) };
  const opts = { ...(AS[action.as] || AS.vertical) };
  if (opts.kind === 'vertical' && ['left', 'center', 'right'].includes(action.focus)) opts.focus = action.focus;
  return opts;
}

// The copy being made, for Bit's turn: source id → promise of the result.
const pending = new Map();

async function run(d, action = {}) {
  const k = deps(d);
  if (!k) return fail('unavailable');
  const e = await pick(k.store, action);
  if (!e) return fail(action.id || action.name ? 'not_found' : 'no_file');
  const s = await k.exports.start(e.id, { ...optionsOf(action), from: 'action' });
  if (!s.ok) return fail(s.error);
  pending.set(e.id, s.done);
  s.done.finally(() => { if (pending.get(e.id) === s.done) pending.delete(e.id); });
  return { ok: true, id: e.id, name: e.name, kind: s.kind, working: true };
}

const later = ms => new Promise(resolve => setTimeout(() => resolve(null), ms).unref?.());

// Bit's turn after `run`: the copy's name and size, or `working` when it takes
// longer than the turn may wait (the toast says when it is done).
async function waitFor(id, ms = WAIT_MS) {
  const done = pending.get(String(id || ''));
  if (!done) return null;
  const r = await Promise.race([done, later(ms)]);
  if (!r) return { working: true };
  if (!r.ok) return fail(r.error);
  return { ok: true, copy: r.entry.name, copyId: r.entry.id, bytes: r.bytes, width: r.entry.width, height: r.entry.height };
}

module.exports = { run, waitFor, optionsOf, AS, WAIT_MS };

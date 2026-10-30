'use strict';
// "Send to phone" from the Deck and the voice: a capture joins the file
// transfer's PC → phone list (capture-send.js), and the paired phone downloads
// it over the local network. "send the last clip to my phone".
//
// deps.capture: store() → captures.js, send(id) → server.js sendCaptureToPhone.

const { pick } = require('./transcript.js');

// capture-send.js codes, renamed where the Deck already has a sentence for
// the bare code that means something else (too_big, busy: bug-report.js).
const RENAMED = Object.freeze({ disabled: 'transfer_off', too_big: 'send_too_big', quota: 'send_full', busy: 'send_busy' });
const ERRORS = new Set(['no_file', 'not_found', 'no_phone', 'no_space', 'unavailable', ...Object.values(RENAMED)]);
const fail = (raw) => {
  const code = RENAMED[raw] || raw;
  return { ok: false, error: ERRORS.has(code) ? code : 'send_failed' };
};

// What the Deck key means by "the last one".
async function choose(store, action) {
  if (action.id || action.name) return pick(store, action);
  if (action.what === 'screenshot') return store.last('screenshot');
  if (action.what === 'video') return pick(store, {});
  const [shot, video] = [await store.last('screenshot'), await pick(store, {})];
  if (!shot || !video) return shot || video;
  return shot.createdAt >= video.createdAt ? shot : video;
}

async function run(d, action = {}) {
  const c = d && d.capture;
  const store = c && typeof c.store === 'function' ? c.store() : null;
  if (!store || typeof c.send !== 'function') return fail('unavailable');
  const e = await choose(store, action);
  if (!e) return fail(action.id || action.name ? 'not_found' : 'no_file');
  const r = await c.send(e.id);
  if (!r || !r.ok) return fail(r && r.error);
  return { ok: true, name: e.name, ...(r.already ? { already: true } : {}) };
}

module.exports = { run, choose };

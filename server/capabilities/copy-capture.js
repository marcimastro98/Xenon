'use strict';
// "Copy to a folder" from the Deck and the voice: a screenshot or a video from
// the gallery copied into Desktop, Downloads, Documents, Pictures or Videos
// (capture-copy.js). "save the last clip on my desktop".
//
// deps.capture: store() → captures.js, copyTo(id, to) → server.js copyCaptureTo.

const { choose } = require('./send-capture.js');

const ERRORS = new Set(['no_file', 'not_found', 'bad_place', 'no_space', 'write_failed', 'unavailable']);
const fail = (code) => ({ ok: false, error: ERRORS.has(code) ? code : 'write_failed' });

async function run(d, action = {}) {
  const c = d && d.capture;
  const store = c && typeof c.store === 'function' ? c.store() : null;
  if (!store || typeof c.copyTo !== 'function') return fail('unavailable');
  const e = await choose(store, action);
  if (!e) return fail(action.id || action.name ? 'not_found' : 'no_file');
  const r = await c.copyTo(e.id, action.to || 'desktop');
  return r && r.ok ? { ok: true, name: r.name, folder: r.folder } : fail(r && r.error);
}

module.exports = { run };

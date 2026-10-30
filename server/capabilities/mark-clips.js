'use strict';
// "Clips from marks" (capture-gallery.js clips()): a short copy around each
// marked moment of a saved recording or replay, beside it; the original stays.
// Deck key (the newest video), AI make_clips_from_marks (by name, id or the
// newest). Answers counts and file names, never a path. Not in the SDK: a
// widget would write copies of the user's videos.
//
// deps.capture (injected):
//   host        the capture host: available()
//   store       () → the captures index
//   clips       (id, which) → { ok, clips, of, names, stopped? } (server.js
//               makeMarkClips: the gallery's clips() plus the refresh)

const { pick } = require('./transcript');

const WHICH = Object.freeze(['auto', 'marks', 'all']);

async function run(d, action = {}) {
  const c = d && d.capture;
  if (!c || !c.host || typeof c.host.available !== 'function' || !c.host.available()
    || typeof c.store !== 'function' || typeof c.clips !== 'function') return { ok: false, error: 'unavailable' };
  const e = await pick(c.store(), action);
  if (!e) return { ok: false, error: action.id || action.name ? 'not_found' : 'no_file' };
  const which = WHICH.includes(action.which) ? action.which : 'auto';
  return c.clips(e.id, which);
}

module.exports = { run, WHICH };

'use strict';
// A screenshot made safe to share: e-mail addresses, IBANs and long numbers
// (phones, cards, ids) the PC's own OCR finds on it are painted black in a new
// copy beside it (capture-covers.js); the original stays as it was. "last" is
// the newest screenshot, an id (from list_captures) that one. The answer says
// how many spots of each kind were covered, never what they said.
//
// deps: d.capture (as for the screenshot capability) with covers() → the
// capture-covers module, onSaved(entry) and onNothingCovered() for the toast.

const ERRORS = new Set(['no_ocr_language', 'busy', 'unavailable', 'not_found', 'write_failed', 'unsupported']);

async function picture(c, action) {
  const store = typeof c.store === 'function' ? c.store() : null;
  if (!store) return { error: 'unavailable' };
  if (action.id) {
    const e = store.get(String(action.id));
    if (!e) return { error: 'not_found' };
    return e.kind === 'screenshot' ? { entry: e } : { error: 'not_a_picture' };
  }
  const e = await store.last('screenshot');
  return e ? { entry: e } : { error: 'no_file' };
}

async function run(d, action = {}) {
  const c = d && d.capture;
  const covers = c && typeof c.covers === 'function' ? c.covers() : null;
  if (!covers) return { ok: false, error: 'unavailable' };
  const picked = await picture(c, action);
  if (picked.error) return { ok: false, error: picked.error };
  const r = await covers.cover(picked.entry.id);
  if (!r || r.ok !== true) {
    const code = r && r.error;
    return { ok: false, error: ERRORS.has(code) ? code : code === 'not_picture' ? 'not_a_picture' : 'failed' };
  }
  if (!r.covered) {
    if (typeof c.onNothingCovered === 'function') c.onNothingCovered();
    return { ok: true, covered: 0, found: {} };
  }
  if (typeof c.onSaved === 'function') c.onSaved({ ...r.entry, covered: r.covered });
  return { ok: true, covered: r.covered, found: r.found, id: r.entry.id, name: r.entry.name };
}

module.exports = { run };

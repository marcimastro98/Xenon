'use strict';
// The assistant's view of the user's OWN widgets, so it can change one days
// after it was made: list them, read one's files, and turn an edit into a full
// package. "Own" is the redistribution origin (originExportable: made in Xenon
// or a folder the user claimed); a widget from the Store or a share code is
// someone else's work and is never read or overwritten through here.

const TEXT_FILE_RE = /\.(html?|m?js|css|json|svg|txt|md)$/i;
// What one read may hand the model. A widget the assistant can rewrite fits
// well inside this; a bigger one is read as "too large", never cut short, since
// an edit of a truncated file would lose the rest of it.
const MAX_READ_CHARS = 200000;

// The list: own packages only, what the model needs to pick the right one.
function listOwn(packages, isOwn) {
  return (Array.isArray(packages) ? packages : [])
    .filter((p) => p && p.id && !p.trial && p.surface !== 'ambient' && isOwn(p.id))
    .map((p) => ({ id: p.id, name: p.name || p.id, version: p.version || '', size: p.size || null, description: p.description || '' }));
}

// A widget made in Xenon Maker is its design (doc.js, one JSON document) played
// by the Maker's own runtime (runtime.js, ~190 KB of bundled code that is the
// same in every Maker widget). The runtime is not the widget: reading it would
// push the package past the read limit and tempt an edit of generated code. It
// is listed like an image instead, and an edit keeps it as it is.
const MAKER_DOC_PREFIX = 'window.XENON_MAKER_DOC=';
const MAKER_RUNTIME = 'runtime.js';
const MAKER_HINT = 'Made in Xenon Maker: the design is doc.js (window.XENON_MAKER_DOC = one JSON document). '
  + 'Change values in doc.js and keep its shape; runtime.js is the Maker player, never rewrite or remove it. '
  + 'For a new layout or new parts, suggest opening the widget in Xenon Maker, where Bit edits it with a live preview.';

function isMakerWidget(texts) {
  const doc = texts.get('doc.js');
  return typeof doc === 'string' && doc.trimStart().startsWith(MAKER_DOC_PREFIX) && texts.has(MAKER_RUNTIME);
}

// One package's files as the model reads them: text in full, other assets by
// name and size (an edit keeps them as they are).
function readOwn(payload) {
  const texts = new Map();
  const assets = [];
  for (const f of (payload && payload.files) || []) {
    const buf = Buffer.from(String(f.data || ''), 'base64');
    if (TEXT_FILE_RE.test(f.path)) texts.set(f.path, buf.toString('utf8'));
    else assets.push({ path: f.path, bytes: buf.length });
  }
  const maker = isMakerWidget(texts);
  if (maker) {
    assets.push({ path: MAKER_RUNTIME, bytes: Buffer.byteLength(texts.get(MAKER_RUNTIME), 'utf8') });
    texts.delete(MAKER_RUNTIME);
  }
  const files = [...texts].map(([path, content]) => ({ path, content }));
  const chars = files.reduce((n, f) => n + f.content.length, 0);
  if (chars > MAX_READ_CHARS) return { ok: false, error: 'too_large' };
  return maker
    ? { ok: true, id: payload.id, files, assets, madeWith: 'maker', hint: MAKER_HINT }
    : { ok: true, id: payload.id, files, assets };
}

// An edit sends only the files it changes: everything else comes from the
// installed package, and `remove` drops files the new version no longer uses.
// Files are { path, data(base64) }, the /sdk/install payload shape.
function mergeEdit(current, changed, remove) {
  const drop = new Set((Array.isArray(remove) ? remove : []).map(String));
  const byPath = new Map();
  for (const f of (current && current.files) || []) if (!drop.has(f.path)) byPath.set(f.path, f);
  for (const f of changed) byPath.set(f.path, f);
  return [...byPath.values()];
}

module.exports = { listOwn, readOwn, mergeEdit, MAX_READ_CHARS };

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

// One package's files as the model reads them: text in full, other assets by
// name and size (an edit keeps them as they are).
function readOwn(payload) {
  const files = [];
  const assets = [];
  let chars = 0;
  for (const f of (payload && payload.files) || []) {
    const buf = Buffer.from(String(f.data || ''), 'base64');
    if (!TEXT_FILE_RE.test(f.path)) { assets.push({ path: f.path, bytes: buf.length }); continue; }
    const content = buf.toString('utf8');
    chars += content.length;
    files.push({ path: f.path, content });
  }
  if (chars > MAX_READ_CHARS) return { ok: false, error: 'too_large' };
  return { ok: true, id: payload.id, files, assets };
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

'use strict';
// Slideshow "folder" source — the third storage model behind the Slideshow widget
// (see js/slideshow-widget.js for the other two: uploaded library files and legacy
// inline data: URIs).
//
// A folder source holds ONE string in the settings: the path of a folder on this
// PC. The server enumerates the image files in it and the client asks for them by
// INDEX (`GET /slideshow/file?i=N`). Two things follow from that, and both are the
// point of doing it this way:
//
//  * No copy, no ceiling. The uploaded library caps at SLIDE_MAX_COUNT because each
//    image costs a row in the settings blob and a file in uploads/. A folder costs
//    one path however many images it holds, so a user pointing at their 800-GIF
//    folder is a normal case rather than the edge of the format.
//  * The path never travels on an image request. Only an index does, and it is
//    resolved against THIS module's enumeration of the folder named in the settings.
//    That keeps the "filesystem paths from the wire are allowlisted, never trusted"
//    invariant intact without a containment check on every frame: there is no
//    caller-supplied path to contain.
//
// Deliberate limits, each with a reason:
//  * Non-recursive. "One folder" is what was asked for and what the user can predict;
//    a recursive walk over a home directory is a very different cost.
//  * Symlinks are skipped. readdir(withFileTypes) reports a symlink as a symlink, not
//    a file, so filtering on isFile() drops them without a stat race — a link inside
//    a slideshow folder must not become a read of whatever it points at.
//  * MAX_FILES entries. Bounds the enumeration and the memory it holds.

const fs = require('fs');
const path = require('path');

// Same image allowlist the uploaded library accepts, MIME included, so a folder
// can't serve a file type the widget wouldn't have taken as an upload.
const MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

// The ceiling is owned by js/slideshow-widget.js along with the rest of the
// slideshow rules, so the client's idea of "how many at most" and the server's can
// never drift apart.
const {
  SLIDE_FOLDER_MAX_FILES: MAX_FILES,
  SLIDE_FOLDER_MAX_BYTES: MAX_BYTES,
} = require('./js/slideshow-widget');
const CACHE_TTL_MS = 30000;      // a folder is re-read at most twice a minute
const NAME_MAX = 200;            // skip absurd names rather than carry them around

// ONE collator, reused for every comparison. `a.localeCompare(b, undefined, opts)`
// rebuilds the collation table on each call, which turns sorting a big folder into
// hundreds of milliseconds of blocked event loop — the exact thing the sync-work
// invariant is about. Built once, a 20k-name sort costs tens of milliseconds.
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// One folder is configured at a time, so a single-entry cache is the whole story.
let cache = null;   // { dir, at, files: string[], error: string|null, truncated: bool }

function isAbsoluteDir(dir) {
  return typeof dir === 'string' && dir.length > 0 && path.isAbsolute(dir);
}

// Read the folder and keep the image files, sorted the way a file manager would
// show them (natural order, so `img2.gif` precedes `img10.gif`). The sort is what
// makes an index STABLE between the count the settings pane shows and the file the
// widget later asks for.
async function readFolder(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { files: [], error: 'not_found', truncated: false };
    if (e.code === 'ENOTDIR') return { files: [], error: 'not_a_dir', truncated: false };
    if (e.code === 'EACCES' || e.code === 'EPERM') return { files: [], error: 'denied', truncated: false };
    return { files: [], error: 'read_failed', truncated: false };
  }
  const files = [];
  let truncated = false;
  for (const ent of entries) {
    if (!ent.isFile()) continue;                       // drops dirs AND symlinks
    if (ent.name.length > NAME_MAX) continue;
    if (!MIME_BY_EXT.has(path.extname(ent.name).toLowerCase())) continue;
    if (files.length >= MAX_FILES) { truncated = true; break; }
    files.push(ent.name);
  }
  files.sort(NAME_ORDER.compare);
  return { files, error: null, truncated };
}

async function ensureCache(dir, { refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cache && cache.dir === dir && (now - cache.at) < CACHE_TTL_MS) return cache;
  const res = await readFolder(dir);
  cache = { dir, at: now, files: res.files, error: res.error, truncated: res.truncated };
  return cache;
}

// What the settings pane and the widget both call. Returns a plain summary — the
// file NAMES stay on the server, because nothing on the client needs them and a
// folder of 5000 names is a payload nobody asked for.
async function listFolder(dir, opts) {
  if (!isAbsoluteDir(dir)) return { ok: false, count: 0, error: 'no_folder', truncated: false };
  const c = await ensureCache(dir, opts);
  if (c.error) return { ok: false, count: 0, error: c.error, truncated: false };
  return { ok: true, count: c.files.length, error: null, truncated: c.truncated };
}

// Resolve one index to a file to stream. Returns null for anything out of range or
// no longer resolvable, which the caller turns into a 404 — a folder can change
// under us between the enumeration and the request, and that is not an error worth
// surfacing to the user.
async function resolveFile(dir, index) {
  if (!isAbsoluteDir(dir)) return null;
  // Number('') and Number(null) are both 0, so an absent or blank `i` would
  // otherwise resolve to the first image instead of a 404. Require actual digits.
  if (typeof index !== 'number' && !/^\d+$/.test(String(index ?? ''))) return null;
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return null;
  const c = await ensureCache(dir);
  if (c.error || i >= c.files.length) return null;
  const name = c.files[i];
  const abs = path.join(dir, name);
  // Belt and braces: a name out of readdir cannot contain a separator, so this can
  // only ever hold — but it costs nothing and it is the line a future refactor
  // would have to justify removing.
  if (path.dirname(abs) !== path.resolve(dir)) return null;
  const mime = MIME_BY_EXT.get(path.extname(name).toLowerCase());
  if (!mime) return null;
  return { abs, name, mime };
}

// Drop the cache when the configured folder changes, so switching folders in
// Settings shows the new count immediately instead of up to CACHE_TTL_MS later.
function invalidate() { cache = null; }

module.exports = { listFolder, resolveFile, invalidate, MAX_FILES, MAX_BYTES, MIME_BY_EXT };

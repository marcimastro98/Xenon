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
let cache = null;   // { dir, at, files: string[], error: string|null, truncated: bool, skipped: number, network: bool }

function isAbsoluteDir(dir) {
  return typeof dir === 'string' && dir.length > 0 && path.isAbsolute(dir);
}

// Read the folder and keep the image files, sorted the way a file manager would
// show them (natural order, so `img2.gif` precedes `img10.gif`). The sort is what
// makes an index STABLE between the count the settings pane shows and the file the
// widget later asks for.
// Whether a folder we could not reach looks like it lives on the network — asked
// only once a read has already failed, so it costs nothing in the normal case.
//
// This exists because "not found" is a true answer that sends people the wrong
// way. Reported as a NAS folder that stopped working after an update: told the
// path did not exist, the user mapped the share to a drive letter, pointed Xenon
// at THAT, and was told the same thing — "it doesn't exist, but it truly does".
//
// It does exist; it does not exist *to this process*. Windows scopes mapped
// drives and cached share credentials to a logon token, and the elevated token a
// process gets under a "run with highest privileges" task is a different one from
// the interactive session that made the mapping. So the letter is genuinely
// absent and the UNC path has no credentials, while File Explorer two windows
// away opens both. A folder on C:\ is unaffected, which is exactly the shape of
// the report.
//
// Two things are knowable rather than guessed at: a UNC path is network by
// definition, and a drive letter whose ROOT cannot be reached is either a mapping
// this process cannot see or removable media that is gone — a local fixed disk's
// root is always there. Anything else stays unflagged.
const UNC_RE = /^\\\\[^\\/]/;
const DRIVE_RE = /^([A-Za-z]:)[\\/]/;
async function looksLikeNetwork(dir) {
  if (UNC_RE.test(dir)) return true;
  const m = DRIVE_RE.exec(dir);
  if (!m) return false;
  try {
    await fs.promises.stat(m[1] + path.sep);
    return false;            // the drive is there — the missing part is the folder
  } catch {
    return true;             // the drive itself is not reachable from here
  }
}

async function readFolder(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const fail = async (error) => ({ files: [], error, truncated: false, network: await looksLikeNetwork(dir) });
    if (e.code === 'ENOENT') return fail('not_found');
    if (e.code === 'ENOTDIR') return { files: [], error: 'not_a_dir', truncated: false, network: false };
    if (e.code === 'EACCES' || e.code === 'EPERM') return fail('denied');
    return fail('read_failed');
  }
  const files = [];
  let truncated = false;
  // Entries that were there and were not taken. A folder that reads fine and
  // yields nothing is otherwise indistinguishable from an empty one, and the two
  // want completely different advice — "add some pictures" versus "these are not
  // files I can read". Reported as a folder on a NAS that showed no images and no
  // error at all, while the same pictures worked from C:\. Counting the skips is
  // what turns that into an answer instead of an empty tile.
  let skipped = 0;
  for (const ent of entries) {
    // Drops directories AND symlinks: readdir reports a link as a link, so this
    // keeps one out of a slideshow folder without a stat race. On Windows a
    // reparse point reads as a link too, which is why the count matters — an
    // entry vanishing here looks like nothing at all from the outside.
    if (!ent.isFile()) { skipped++; continue; }
    if (ent.name.length > NAME_MAX) { skipped++; continue; }
    if (!MIME_BY_EXT.has(path.extname(ent.name).toLowerCase())) { skipped++; continue; }
    if (files.length >= MAX_FILES) { truncated = true; break; }
    files.push(ent.name);
  }
  files.sort(NAME_ORDER.compare);
  return { files, error: null, truncated, skipped };
}

async function ensureCache(dir, { refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && cache && cache.dir === dir && (now - cache.at) < CACHE_TTL_MS) return cache;
  const res = await readFolder(dir);
  cache = { dir, at: now, files: res.files, error: res.error, truncated: res.truncated, skipped: res.skipped || 0, network: res.network === true };
  return cache;
}

// What the settings pane and the widget both call. Returns a plain summary — the
// file NAMES stay on the server, because nothing on the client needs them and a
// folder of 5000 names is a payload nobody asked for.
async function listFolder(dir, opts) {
  if (!isAbsoluteDir(dir)) return { ok: false, count: 0, error: 'no_folder', truncated: false };
  const c = await ensureCache(dir, opts);
  if (c.error) return { ok: false, count: 0, error: c.error, truncated: false, skipped: 0, network: c.network === true };
  return { ok: true, count: c.files.length, error: null, truncated: c.truncated, skipped: c.skipped || 0, network: false };
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

module.exports = { listFolder, resolveFile, invalidate, looksLikeNetwork, MAX_FILES, MAX_BYTES, MIME_BY_EXT };

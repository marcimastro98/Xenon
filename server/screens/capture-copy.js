'use strict';
// "Copy to a folder" for a capture: a copy of a screenshot or a video in one of
// the user's own folders (Desktop, Downloads, Documents, Pictures, Videos), so
// "save the last 42 seconds on the desktop" ends with a file the user sees
// there. The folder is one of those five names, never a path from the caller,
// and the answer names the folder and the file, never where it lives.
// The capture itself stays in the gallery as it was. A name already taken gets
// " (2)", " (3)"... and the copy lands as `.part` first, so a half-written file
// never shows on the desktop.

const path = require('path');

const PLACES = Object.freeze(['desktop', 'downloads', 'documents', 'pictures', 'videos']);
const MAX_TRIES = 99;

function createCaptureCopy({ store, folderOf, mkdir, exists, copyFile, rename, unlink }) {
  async function freeName(dir, name) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let n = 1; n <= MAX_TRIES; n++) {
      const candidate = n === 1 ? name : `${base} (${n})${ext}`;
      if (!(await exists(path.join(dir, candidate)))) return candidate;
    }
    return null;
  }

  async function copy(id, to) {
    const place = String(to || '').toLowerCase();
    if (!PLACES.includes(place)) return { ok: false, error: 'bad_place' };
    const e = store.get(String(id || ''));
    if (!e) return { ok: false, error: 'not_found' };
    if (!(await exists(e.file))) return { ok: false, error: 'not_found' };
    let dir;
    try {
      dir = await folderOf(place);
      await mkdir(dir);
    } catch { return { ok: false, error: 'write_failed' }; }
    const name = await freeName(dir, path.basename(e.file));
    if (!name) return { ok: false, error: 'write_failed' };
    const target = path.join(dir, name);
    const part = target + '.part';
    try {
      await copyFile(e.file, part);
      await rename(part, target);
    } catch (err) {
      await unlink(part).catch(() => {});
      return { ok: false, error: err && err.code === 'ENOSPC' ? 'no_space' : 'write_failed' };
    }
    return { ok: true, name, folder: place };
  }

  return { copy };
}

module.exports = { createCaptureCopy, PLACES };

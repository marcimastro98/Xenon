'use strict';
// A picture of the person's own for a pump's Picture face: POST /pump/picture takes one
// image, GIF or WebM (multipart field `asset`), keeps it in uploads/ under a name made
// here (`pump-<time>-<random>.<ext>`) and answers its /uploads/ address, which a pumpSet
// then puts on a face. The type is decided by the extension against an allowlist, the
// size by SLIDESHOW_ASSET_MAX_BYTES, as the slideshow's pictures.
//
// Every upload also clears the pump pictures no screen uses any more, saved or pinned for now
// (live.js pin, never saved). A file younger than GRACE_MS stays: it may be the one just sent,
// before the change that uses it is saved.

const fsp = require('fs').promises;
const path = require('path');
const { readBodyBuffer } = require('../http/read-body.js');
const { parseMultipartBackground } = require('../http/multipart-upload.js');
const { SLIDESHOW_ASSET_MAX_BYTES, SLIDESHOW_ASSET_MIME_BY_EXT } = require('../http/upload-limits.js');

const PREFIX = 'pump-';
const GRACE_MS = 10 * 60000;
const TYPES = new Map([...SLIDESHOW_ASSET_MIME_BY_EXT, ['.webm', 'video/webm']]);
const EXT_BY_TYPE = new Map([...TYPES].map(([ext, type]) => [type, ext]));

// A pump picture's name on disk, made here: the name a file arrived with never reaches it.
const nameFor = (clock, ext) => `${PREFIX}${clock()}-${Math.random().toString(16).slice(2, 10)}${ext}`;

// Every /uploads/ file a screen shows, as file names; `pinned`, the faces shown for now.
function usedPictures(model, pinned = []) {
  const names = new Set();
  const add = (show) => {
    for (const item of Array.isArray(show?.items) ? show.items : []) {
      if (typeof item === 'string' && item.startsWith('/uploads/')) names.add(item.slice('/uploads/'.length));
    }
  };
  for (const s of Object.values(model?.screens || {})) {
    add(s.base);
    for (const m of s.moments || []) add(m.show);
  }
  for (const show of pinned) add(show);
  return names;
}

async function sweep({ dir, keep, clock }) {
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return; }
  for (const name of files) {
    if (!name.startsWith(PREFIX) || keep.has(name)) continue;
    const file = path.join(dir, name);
    try {
      const st = await fsp.stat(file);
      if (st.isFile() && clock() - st.mtimeMs > GRACE_MS) await fsp.unlink(file);
    } catch { /* gone already, or busy: the next upload tries again */ }
  }
}

// The extension the file is kept under, or '' when it is not a picture this face shows.
function extensionOf(file) {
  const fromName = path.extname(file.originalName || '').toLowerCase();
  const ext = TYPES.has(fromName) ? fromName : EXT_BY_TYPE.get(file.contentType) || '';
  if (!ext) return '';
  const said = file.contentType;
  return !said || said === 'application/octet-stream' || said === TYPES.get(ext) ? ext : '';
}

/**
 * @param {{ store: { ready: () => Promise<any> }, dir: string, pinned?: () => any[], clock?: () => number,
 *   warn?: (m: string) => void }} opts
 */
function createPictureUpload({ store, dir, pinned = () => [], clock = Date.now, warn = (_m) => {} }) {
  return async function upload(req, res, { json }) {
    const refuse = (status, error) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error })); };
    let file;
    try { file = parseMultipartBackground(req, await readBodyBuffer(req, SLIDESHOW_ASSET_MAX_BYTES), 'asset'); }
    catch (e) { refuse(e.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, e.code === 'PAYLOAD_TOO_LARGE' ? 'too_big' : 'bad_request'); return; }
    const ext = extensionOf(file);
    if (!ext) { refuse(400, 'bad_type'); return; }
    const name = nameFor(clock, ext);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, name), file.data);
    } catch (e) {
      warn(`pump picture: could not be saved (${e.code || 'error'})`);
      refuse(500, 'write_failed');
      return;
    }
    json({ ok: true, url: `/uploads/${name}`, type: TYPES.get(ext) });
    sweep({ dir, keep: usedPictures(await store.ready().catch(() => null), pinned()), clock }).catch(() => {});
  };
}

module.exports = { createPictureUpload, usedPictures, extensionOf, nameFor, GRACE_MS, PREFIX };

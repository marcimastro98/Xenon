'use strict';
// Delivers a received file into the folder the user chose on the PC: the folder checked, a free
// name found, and the file marked as coming from outside.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { deliveryName } = require('./file-names.js');

const FILE_RE = /^f[0-9a-f]{16}(\.[a-z0-9]{1,8})?$/;

function underPath(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Is this a folder we are willing to write arrivals into? Refuses anything
 * inside DATA_DIR or the app root (an inbox pointing at server/ would let a
 * phone drop files next to our own code), and anything that is not a real
 * directory. A symlink is refused for the same reason slideshow-folder.js
 * filters on isFile: it is a write we cannot see the far end of.
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function validInboxDir(dir, opts) {
  const o = opts || {};
  const d = String(dir || '');
  if (!d) return { ok: false, error: 'empty' };
  if (!path.isAbsolute(d)) return { ok: false, error: 'not_absolute' };
  if (o.dataDir && underPath(d, o.dataDir)) return { ok: false, error: 'inside_data' };
  if (o.appRoot && underPath(d, o.appRoot)) return { ok: false, error: 'inside_app' };
  let st;
  try { st = await fsp.lstat(d); }
  catch (e) { return { ok: false, error: e.code === 'ENOENT' ? 'not_found' : 'denied' }; }
  if (st.isSymbolicLink()) return { ok: false, error: 'symlink' };
  if (!st.isDirectory()) return { ok: false, error: 'not_a_dir' };
  return { ok: true };
}

/**
 * Copy a stored file into the user's folder under its ORIGINAL name.
 *
 * Create-exclusive, always: a paired device must never be able to REPLACE a
 * file in the user's own folder by naming it. A clash gets " (1)", " (2)" and
 * finally the id, never an overwrite.
 *
 * @returns {Promise<{ok:boolean, path?:string, error?:string}>}
 */
async function deliverToInbox(rec, inboxDir, opts) {
  const o = opts || {};
  const srcDir = o.filesDir || '';
  if (!rec || !FILE_RE.test(String(rec.file || ''))) return { ok: false, error: 'bad_record' };
  const check = await validInboxDir(inboxDir, o);
  if (!check.ok) return { ok: false, error: check.error };

  const src = path.join(srcDir, rec.file);
  const wanted = deliveryName(rec.name || rec.file);
  const ext = path.extname(wanted);
  const base = ext ? wanted.slice(0, -ext.length) : wanted;

  for (let i = 0; i <= 50; i++) {
    const candidate = i === 0 ? wanted : `${base} (${i})${ext}`;
    const dest = path.join(inboxDir, candidate);
    // The name was built from an untrusted label, so containment is asserted
    // rather than assumed even though every separator is already gone.
    if (!underPath(dest, inboxDir) || path.dirname(path.resolve(dest)) !== path.resolve(inboxDir)) {
      return { ok: false, error: 'bad_name' };
    }
    let fh = null;
    try {
      fh = await fsp.open(dest, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      return { ok: false, error: e.code === 'ENOSPC' ? 'no_space' : 'write_failed' };
    }
    try {
      await fh.close();
      await fsp.copyFile(src, dest);
      await markFromInternet(dest, o.platform);
      return { ok: true, path: dest };
    } catch (e) {
      try { await fh.close(); } catch { /* already closed */ }
      try { await fsp.unlink(dest); } catch { /* nothing to undo */ }
      return { ok: false, error: e.code === 'ENOSPC' ? 'no_space' : 'write_failed' };
    }
  }
  // 51 files with the same name is a naming collision nobody wants resolved by
  // a 52nd guess; fall back to something that cannot clash.
  const dest = path.join(inboxDir, `${base}-${rec.id}${ext}`);
  try {
    await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    await markFromInternet(dest, o.platform);
    return { ok: true, path: dest };
  } catch { return { ok: false, error: 'write_failed' }; }
}

// A file that arrived from another device gets the same mark Windows puts on
// a download (the Zone.Identifier stream, zone 3). Opening it then goes
// through SmartScreen and Office's Protected View like any file from the
// internet, instead of running with no question asked. Best effort: a drive
// that cannot hold the stream (FAT, exFAT, a network share) keeps the file.
const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n';
async function markFromInternet(dest, platform) {
  if ((platform || process.platform) !== 'win32') return;
  try { await fsp.writeFile(dest + ':Zone.Identifier', ZONE_IDENTIFIER); } catch { /* no ADS here */ }
}

module.exports = {
  FILE_RE, underPath, validInboxDir, deliverToInbox, ZONE_IDENTIFIER, markFromInternet,
};

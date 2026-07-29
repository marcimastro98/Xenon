'use strict';

// ── File transfer between the user's own screens ─────────────────────────────
// A paired phone sends a photo to the PC, and the PC hands a file back. That is
// the whole feature, and it exists because the alternative people actually use
// is routing their own photos through a messaging service and downloading them
// again on the other side.
//
// This module owns the store. It never touches HTTP, so the rules below can be
// read and tested on their own.
//
// The boundaries, and why each one is where it is:
//
//   * The client's filename is a LABEL. What lands on disk is `f<16 hex><ext>`,
//     built here. The extension is validated by SHAPE, not against an
//     allowlist: claude-attach.js uses an allowlist because the point there is
//     material to read, whereas the point here is moving whatever the user
//     wants between their own devices, and an allowlist refuses the .zip and
//     the file with no extension that are half the reason to have this.
//     The safety therefore lives at the two boundaries where a file can DO
//     something: opening it re-applies the Deck registry's blocklist, and
//     serving it forces a download disposition (see server.js).
//
//   * The manifest is a CACHE of the directory, never the authority. `init()`
//     reconciles both ways, so a crash degrades to a missing file rather than
//     to an orphan nobody can see or delete.
//
//   * Retention never runs to make room. A quota refuses a new upload instead,
//     because pruning under pressure would let whoever is uploading evict the
//     files the user put here on purpose. And retention only ever removes a
//     blob that has ALREADY been copied into the user's own folder and is still
//     there — Xenon deletes its own duplicate, never the user's only copy.
//
//   * Delivery into the user's folder is a COPY made after the upload is safely
//     stored, never the upload's own destination. Writing an untrusted stream
//     straight into a settings-supplied directory would put a folder that can
//     be renamed, unmounted or full on the hot path of every transfer, and
//     would point the retention sweeper at a directory Xenon does not own.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { writeFileAtomic, openAtomicWriteStream } = require('./atomic-write.js');
const { parseXdgUserDirs } = require('./diskspace.js');

const STORE_VERSION = 1;
const MAX_LABEL = 120;
const MAX_NAME_BYTES = 255;          // ext4/APFS/NTFS all cap a component here, in BYTES
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_INFLIGHT = 4;
const PROGRESS_MIN_MS = 500;         // one SSE frame per id per half second, no more
const INFLIGHT_STALE_MS = 10 * 60 * 1000;

const ID_RE = /^f[0-9a-f]{16}$/;
const FILE_RE = /^f[0-9a-f]{16}(\.[a-z0-9]{1,8})?$/;
const EXT_RE = /^\.[a-z0-9]{1,8}$/;
// Windows swallows these whole, extension and all, however they are spelled.
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// The MIME a download is served with, keyed on the extension WE stored — never
// on the `?mime=` the client declared. This is not cosmetic: iOS Safari routes
// a download by MIME plus extension, and `video/mp4` is what puts "Save to
// Photos" in the share sheet. Served as `application/octet-stream` the video
// lands in Files as an opaque blob, which is exactly the friction this feature
// exists to remove. On Android the MIME decides the MediaStore collection.
const MEDIA_MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],
  ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'], ['.mkv', 'video/x-matroska'], ['.avi', 'video/x-msvideo'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'], ['.flac', 'audio/flac'], ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.pdf', 'application/pdf'],
]);

// Types whose real MIME must never be sent, however well known it is. These are
// the ones where a stripped header or a sniffing quirk turns a file the user
// received into script running in OUR origin. The download disposition and
// nosniff already say so; this is the layer that does not depend on a header
// surviving. Listed rather than merely omitted, so nobody "completes" the map
// above by adding text/html to it.
const FORCED_OCTET = new Set([
  '.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml',
  '.js', '.mjs', '.css', '.wasm',
]);

// What a browser will actually decode in an <img>. HEIC is deliberately absent:
// an iPhone photo that reached the PC untranscoded cannot be shown, and a
// broken image is a worse answer than an extension chip.
const THUMBABLE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);

/** The MIME a download is served with. Unknown or risky → octet-stream. */
function downloadMimeFor(ext) {
  const e = String(ext || '').toLowerCase();
  if (FORCED_OCTET.has(e)) return 'application/octet-stream';
  return MEDIA_MIME.get(e) || 'application/octet-stream';
}

function isThumbable(ext) {
  return THUMBABLE.has(String(ext || '').toLowerCase());
}

function kindOf(ext) {
  const m = downloadMimeFor(ext);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

// Characters that must not survive into a name we store, show or put in a
// header. Control characters (a CR/LF in a filename is a Content-Disposition
// injection), and the bidi overrides — `photo‮gnp.exe` renders as
// `photo.png` in every UI on earth, which is why this is a strip and not an
// escape.
function stripDangerous(input) {
  const s = String(input == null ? '' : input);
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127 || (c >= 128 && c <= 159)) continue;     // C0 / DEL / C1
    if (c === 0x200e || c === 0x200f) continue;                       // LRM / RLM
    if (c >= 0x202a && c <= 0x202e) continue;                         // LRE…RLO
    if (c >= 0x2066 && c <= 0x2069) continue;                         // LRI…PDI
    if (ch === '/' || ch === '\\') continue;                          // never a separator
    out += ch;
  }
  return out.normalize('NFC');
}

/** Trim a string to a byte budget without splitting a code point. */
function clampUtf8(s, maxBytes) {
  let out = String(s || '');
  if (Buffer.byteLength(out, 'utf8') <= maxBytes) return out;
  const chars = Array.from(out);
  while (chars.length && Buffer.byteLength(chars.join(''), 'utf8') > maxBytes) chars.pop();
  return chars.join('');
}

/** A display label. Shown with textContent, echoed in Content-Disposition. */
function label(name) {
  const s = clampUtf8(stripDangerous(name), MAX_LABEL * 4).slice(0, MAX_LABEL);
  const trimmed = s.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return 'file';
  return trimmed;
}

/**
 * The extension, read from the client's name and validated by shape. A name
 * with no usable extension is stored without one — refusing it would be an
 * arbitrary rule, and a file with no extension is a real thing people move.
 */
function extOf(name) {
  const e = path.extname(stripDangerous(name)).toLowerCase();
  return EXT_RE.test(e) ? e : '';
}

/**
 * A name that will become a real path component in the USER's folder, so this
 * is stricter than `label`: on top of the strip above it drops the characters
 * Windows refuses outright, the trailing dots and spaces Windows silently eats
 * (so `x.txt.` and `x.txt` are not two names for one file), and the reserved
 * device names. Clamped in BYTES, not characters — an emoji is four of them.
 */
function deliveryName(name) {
  let s = stripDangerous(name).replace(/[:*?"<>|]/g, '');
  s = s.replace(/[. ]+$/, '').trim();
  if (!s || s === '.' || s === '..') s = 'file';
  if (WIN_RESERVED_RE.test(s)) s = '_' + s;
  const ext = path.extname(s);
  const base = ext ? s.slice(0, -ext.length) : s;
  const room = MAX_NAME_BYTES - Buffer.byteLength(ext, 'utf8');
  const cut = clampUtf8(base, Math.max(1, room));
  const out = (cut || 'file') + ext;
  return out;
}

/**
 * The Content-Disposition for a download (RFC 6266/5987).
 *
 * The bare `filename=` parameter is ASCII-only, so a real name travels in
 * `filename*` and the ASCII form is the fallback for clients that predate it.
 * Quotes and backslashes are replaced rather than escaped, because the value
 * here is a filename and not a place to be clever; CR/LF are already gone via
 * `label`, and this is where their absence matters most — a newline in a
 * header value is a response-splitting bug.
 *
 * `attachment` is the primary guarantee that a file the user received never
 * renders inline in our own origin.
 */
function contentDisposition(name) {
  const clean = label(name);
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/**
 * The user's Downloads folder, without shelling out to PowerShell (which would
 * break the rule that a path everything must work on is not a Windows path).
 * On a non-English Linux desktop the folder is localised on disk — an Italian
 * install has ~/Scaricati — so the answer comes from xdg-user-dirs, parsed by
 * the function diskspace.js already exports and tests. Injectable so both
 * branches run wherever the suite does.
 */
function resolveDownloadsDir(opts) {
  const o = opts || {};
  // `undefined` means "ask this machine"; an explicitly empty value means the
  // caller knows there is no home directory, and must not be answered with the
  // real one — that is how an injected test case silently reads the host.
  const home = o.homedir === undefined ? (os.homedir() || '') : String(o.homedir || '');
  const platform = o.platform || process.platform;
  if (!home) return '';
  if (platform === 'linux') {
    let xdg = o.xdg;
    if (xdg === undefined) {
      try {
        const cfg = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs');
        xdg = parseXdgUserDirs(fs.readFileSync(cfg, 'utf8'), home);
      } catch { xdg = null; }
    }
    if (xdg && xdg.download) return xdg.download;
    return path.join(home, 'Downloads');
  }
  // Windows and macOS both keep the English name on disk; macOS localises only
  // what Finder displays.
  return path.join(home, 'Downloads');
}

/** Where arrivals land by default: a folder of our own inside Downloads. */
function defaultInboxDir(opts) {
  const dl = resolveDownloadsDir(opts);
  return dl ? path.join(dl, 'Xenon') : '';
}

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
    return { ok: true, path: dest };
  } catch { return { ok: false, error: 'write_failed' }; }
}

/**
 * Stream a request body to disk, bounded, without ever holding it in memory.
 *
 * Lives here rather than inline in the route so that the one piece of this
 * feature with no second chance can be exercised for real. That was not
 * caution: the first version of this deadlocked on commit and every upload
 * would have hung at 100%, and it looked completely correct.
 *
 * Two decisions the shape depends on:
 *
 *  * `req` is deliberately NOT part of the pipeline. `pipeline` destroys every
 *    stream it is given when one fails, and destroying the request destroys the
 *    socket — so an over-size upload would get a connection reset instead of
 *    the 413 that tells it what happened, and the client would retry forever.
 *    Piping in by hand keeps backpressure (that is `pipe`'s job) while leaving
 *    the request alive to be answered.
 *  * The size is checked DURING the stream, not from Content-Length. A
 *    Content-Length is a claim, and chunked encoding carries none at all.
 *
 * On failure the temp file is removed and the error carries `code` (one of
 * XFER_TOO_BIG / XFER_ABORTED / a system code) plus how many bytes arrived.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} target final path; the write goes to `<target>.part` first
 * @param {{limit:number, onProgress?:(n:number)=>void}} opts
 * @returns {Promise<{bytes:number}>}
 */
async function receiveStream(req, target, opts) {
  const o = opts || {};
  const limit = Number(o.limit) > 0 ? Number(o.limit) : DEFAULT_MAX_BYTES;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const handle = await openAtomicWriteStream(target);
  let received = 0;

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > limit) {
        cb(Object.assign(new Error('too_big'), { code: 'XFER_TOO_BIG' }));
        return;
      }
      if (onProgress) onProgress(received);
      cb(null, chunk);          // the same Buffer through, never a copy
    },
  });

  const onReqError = (e) => counter.destroy(e);
  const onReqAborted = () => counter.destroy(Object.assign(new Error('aborted'), { code: 'XFER_ABORTED' }));

  try {
    req.on('error', onReqError);
    req.on('aborted', onReqAborted);
    req.pipe(counter);
    await pipeline(counter, handle.stream);
    await handle.commit();
    return { bytes: received };
  } catch (e) {
    await handle.abort();
    throw Object.assign(e || new Error('write_failed'), { received });
  } finally {
    req.off('error', onReqError);
    req.off('aborted', onReqAborted);
    try { req.unpipe(counter); } catch { /* already unpiped by the failure */ }
  }
}

// ── the store ────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.dir          DATA_DIR/transfer
 * @param {string} [o.dataDir]    refused as an inbox
 * @param {string} [o.appRoot]    refused as an inbox
 * @param {()=>number} [o.now]
 * @param {()=>string} [o.rand]   16 hex characters
 */
function createFileTransfer(o) {
  const opts = o || {};
  const dir = opts.dir || '';
  const filesDir = path.join(dir, 'files');
  const indexFile = path.join(dir, 'index.json');
  const now = opts.now || Date.now;
  const rand = opts.rand || (() => crypto.randomBytes(8).toString('hex'));
  const dataDir = opts.dataDir || '';
  const appRoot = opts.appRoot || '';

  let maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  let quotaBytes = Number(opts.quotaBytes) > 0 ? Number(opts.quotaBytes) : DEFAULT_QUOTA_BYTES;
  let keepMs = Number(opts.keepMs) > 0 ? Number(opts.keepMs) : DEFAULT_KEEP_MS;
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : DEFAULT_MAX_FILES;
  const maxInflight = Number(opts.maxInflight) > 0 ? Number(opts.maxInflight) : DEFAULT_MAX_INFLIGHT;

  let records = [];            // newest first
  let usedBytes = 0;
  let loaded = false;
  const inflight = new Map();  // id -> { reserved, at, received, lastEmit, name, ext, direction, from }

  function limits(next) {
    if (next && Number(next.maxBytes) > 0) maxBytes = Number(next.maxBytes);
    if (next && Number(next.quotaBytes) > 0) quotaBytes = Number(next.quotaBytes);
    if (next && Number(next.keepMs) > 0) keepMs = Number(next.keepMs);
    return { maxBytes, quotaBytes, keepMs, maxFiles, maxInflight };
  }

  // Explicit known-key rebuild of anything read off disk — never a spread.
  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    const file = String(raw.file || '');
    if (!ID_RE.test(id) || !FILE_RE.test(file)) return null;
    const size = Number(raw.size);
    return {
      id,
      file,
      name: label(raw.name || file),
      ext: EXT_RE.test(String(raw.ext || '')) ? String(raw.ext) : '',
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      direction: raw.direction === 'out' ? 'out' : 'in',
      from: label(raw.from || '').slice(0, 40),
      at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0,
      delivered: typeof raw.delivered === 'string' ? raw.delivered : '',
    };
  }

  function reservedBytes() {
    let n = 0;
    for (const r of inflight.values()) n += r.reserved;
    return n;
  }

  async function persist() {
    if (!dir) return;
    const body = JSON.stringify({ v: STORE_VERSION, records }, null, 2);
    try { await writeFileAtomic(indexFile, body); }
    catch { /* the blobs are the truth; a lost index is rebuilt by init() */ }
  }

  /**
   * Load the manifest and reconcile it against the directory in BOTH
   * directions: a record whose blob is gone is dropped, a blob no record knows
   * about is deleted, and every `.part` is swept (an in-flight upload cannot
   * survive a restart by definition). Called once at boot so `begin()` can stay
   * synchronous and the pipe can be attached in the tick the route is entered.
   */
  async function init() {
    if (!dir) { loaded = true; return; }
    await fsp.mkdir(filesDir, { recursive: true }).catch(() => {});
    let parsed = null;
    try { parsed = JSON.parse(await fsp.readFile(indexFile, 'utf8')); } catch { parsed = null; }
    const wanted = [];
    for (const raw of (parsed && Array.isArray(parsed.records)) ? parsed.records : []) {
      const rec = normalizeRecord(raw);
      if (rec && !wanted.some((r) => r.id === rec.id)) wanted.push(rec);
    }

    let names = [];
    try { names = await fsp.readdir(filesDir); } catch { names = []; }
    const onDisk = new Set();
    for (const n of names) {
      if (n.endsWith('.part')) {
        await fsp.unlink(path.join(filesDir, n)).catch(() => {});
        continue;
      }
      onDisk.add(n);
    }

    records = [];
    usedBytes = 0;
    for (const rec of wanted) {
      if (!onDisk.has(rec.file)) continue;             // blob gone: the record is a lie
      onDisk.delete(rec.file);
      try {
        const st = await fsp.stat(path.join(filesDir, rec.file));
        rec.size = st.size;                            // the file is the authority, not the record
      } catch { continue; }
      records.push(rec);
      usedBytes += rec.size;
    }
    for (const orphan of onDisk) {
      await fsp.unlink(path.join(filesDir, orphan)).catch(() => {});
    }
    records.sort((a, b) => b.at - a.at);
    loaded = true;
    if (wanted.length !== records.length) await persist();
  }

  /**
   * Reserve room for one upload and mint its id. Synchronous on purpose.
   *
   * @returns {{id:string, ext:string, target:string, limit:number}
   *          | {error:string, status:number, max?:number}}
   */
  function begin(input) {
    const i = input || {};
    if (!loaded || !dir) return { error: 'not_ready', status: 503 };
    if (inflight.size >= maxInflight) return { error: 'busy', status: 503 };

    const declared = Number(i.declaredLength);
    const known = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (known > maxBytes) return { error: 'too_big', status: 413, max: maxBytes };
    // An unknown length (chunked) reserves the worst case. Anything else lets N
    // parallel uploads each pass the quota check and blow it together.
    const reserved = known || maxBytes;
    if (usedBytes + reservedBytes() + reserved > quotaBytes) {
      return { error: 'quota', status: 507, max: maxBytes };
    }

    const id = 'f' + rand();
    const ext = extOf(i.name);
    const file = id + ext;
    if (!ID_RE.test(id) || !FILE_RE.test(file)) return { error: 'bad_name', status: 400 };

    inflight.set(id, {
      reserved,
      at: now(),
      received: 0,
      lastEmit: null,
      file,
      name: label(i.name),
      ext,
      direction: i.direction === 'out' ? 'out' : 'in',
      from: label(i.from || '').slice(0, 40),
    });
    return { id, ext, file, target: path.join(filesDir, file), limit: maxBytes };
  }

  /**
   * Record progress. Returns true at most once every PROGRESS_MIN_MS per id, so
   * a 2 GB upload is a couple of frames a second rather than thirty thousand.
   */
  function noteProgress(id, received) {
    const rec = inflight.get(id);
    if (!rec) return false;
    rec.received = received;
    const t = now();
    // `null` rather than 0 for "never emitted": a numeric sentinel makes the
    // first sample depend on where the clock's origin happens to be, which is
    // fine against Date.now() and wrong against any injected clock.
    if (rec.lastEmit !== null && t - rec.lastEmit < PROGRESS_MIN_MS) return false;
    rec.lastEmit = t;
    return true;
  }

  function inflightList() {
    const out = [];
    for (const [id, r] of inflight) {
      out.push({
        id, name: r.name, direction: r.direction, from: r.from,
        received: r.received, total: r.reserved === maxBytes ? 0 : r.reserved, pending: true,
      });
    }
    return out;
  }

  /**
   * Turn a finished upload into a record. The rename itself belongs to the
   * caller's atomic write handle; by the time this runs the blob is in place.
   */
  async function commit(id, bytes) {
    const held = inflight.get(id);
    if (!held) return null;
    inflight.delete(id);
    const rec = {
      id,
      file: held.file,
      name: held.name,
      ext: held.ext,
      size: Number.isFinite(Number(bytes)) && Number(bytes) >= 0 ? Number(bytes) : 0,
      direction: held.direction,
      from: held.from,
      at: now(),
      delivered: '',
    };
    records.unshift(rec);
    usedBytes += rec.size;
    await persist();
    return rec;
  }

  /** Forget an upload that never finished. The caller's handle unlinks the .part. */
  function abort(id) {
    inflight.delete(id);
  }

  /** Note where a copy was delivered, so retention knows the user has their own. */
  async function markDelivered(id, absPath) {
    const rec = records.find((r) => r.id === id);
    if (!rec) return null;
    rec.delivered = String(absPath || '');
    await persist();
    return rec;
  }

  function publicOf(rec, includePaths) {
    const out = {
      id: rec.id,
      name: rec.name,
      ext: rec.ext,
      size: rec.size,
      mime: downloadMimeFor(rec.ext),
      kind: kindOf(rec.ext),
      thumb: isThumbable(rec.ext),
      direction: rec.direction,
      from: rec.from,
      at: rec.at,
      delivered: !!rec.delivered,
    };
    // The absolute path is a fact about THIS PC. A paired phone has no use for
    // it and it should not travel to one, so it is opt-in per call rather than
    // filtered by whoever remembers to.
    if (includePaths && rec.delivered) out.deliveredPath = rec.delivered;
    return out;
  }

  function list(o2) {
    const c = o2 || {};
    const limit = Number(c.limit) > 0 ? Number(c.limit) : 100;
    return records.slice(0, limit).map((r) => publicOf(r, c.includePaths === true));
  }

  function get(id) {
    const key = String(id || '');
    if (!ID_RE.test(key)) return null;
    const rec = records.find((r) => r.id === key);
    if (!rec || !FILE_RE.test(rec.file)) return null;
    return rec;
  }

  function absOf(rec) {
    return path.join(filesDir, rec.file);
  }

  /**
   * Remove Xenon's copy. The file already delivered into the user's folder is
   * deliberately NOT touched: this list is Xenon's, the folder is theirs.
   */
  async function remove(id) {
    const idx = records.findIndex((r) => r.id === String(id || ''));
    if (idx < 0) return false;
    const [rec] = records.splice(idx, 1);
    usedBytes = Math.max(0, usedBytes - rec.size);
    await fsp.unlink(absOf(rec)).catch(() => {});
    await persist();
    return true;
  }

  /**
   * Retention. Age and count only, NEVER pressure — see the header. And only a
   * record whose delivered copy is confirmed still on disk is eligible, so the
   * one thing this can delete is Xenon's own duplicate.
   */
  async function prune() {
    if (!loaded) return { removed: 0, bytes: 0 };
    const t = now();
    const doomed = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec.delivered) continue;                       // the only copy: never ours to remove
      const tooOld = keepMs > 0 && (t - rec.at) > keepMs;
      const tooMany = i >= maxFiles;
      if (!tooOld && !tooMany) continue;
      try { await fsp.access(rec.delivered); } catch { continue; }   // their copy vanished: keep ours
      doomed.push(rec);
    }
    let bytes = 0;
    for (const rec of doomed) {
      await fsp.unlink(absOf(rec)).catch(() => {});
      const idx = records.indexOf(rec);
      if (idx >= 0) records.splice(idx, 1);
      usedBytes = Math.max(0, usedBytes - rec.size);
      bytes += rec.size;
    }
    if (doomed.length) await persist();
    return { removed: doomed.length, bytes };
  }

  /**
   * Reap an upload whose socket died in a way `pipeline` never reported. Belt
   * for the braces: the route aborts its own handle on every failure path.
   */
  async function sweepInflight(maxAgeMs) {
    // `>= 0`, not `> 0`. The shutdown path passes 0 meaning "everything, whatever
    // its age"; the old test read that as "no argument given" and fell back to
    // the ten-minute threshold, so the one sweep that exists to leave no `.part`
    // behind swept nothing at all.
    const asked = Number(maxAgeMs);
    const age = Number.isFinite(asked) && asked >= 0 ? asked : INFLIGHT_STALE_MS;
    const t = now();
    let n = 0;
    for (const [id, rec] of Array.from(inflight)) {
      if (t - rec.at < age) continue;
      inflight.delete(id);
      await fsp.unlink(path.join(filesDir, rec.file + '.part')).catch(() => {});
      n++;
    }
    return n;
  }

  function stats() {
    return {
      count: records.length,
      bytes: usedBytes,
      quotaBytes,
      maxBytes,
      inflight: inflight.size,
      reserved: reservedBytes(),
    };
  }

  function deliver(rec, inboxDir) {
    return deliverToInbox(rec, inboxDir, { filesDir, dataDir, appRoot });
  }

  return {
    init, begin, commit, abort, noteProgress, inflightList, markDelivered,
    list, get, absOf, remove, prune, sweepInflight, stats, limits, deliver,
    isLoaded: () => loaded,
    get dir() { return dir; },
    get filesDir() { return filesDir; },
  };
}

module.exports = {
  createFileTransfer,
  receiveStream,
  deliverToInbox,
  validInboxDir,
  resolveDownloadsDir,
  defaultInboxDir,
  downloadMimeFor,
  contentDisposition,
  isThumbable,
  kindOf,
  label,
  extOf,
  deliveryName,
  clampUtf8,
  stripDangerous,
  FILE_RE,
  ID_RE,
  MEDIA_MIME,
  FORCED_OCTET,
  DEFAULT_MAX_BYTES,
  DEFAULT_QUOTA_BYTES,
  PROGRESS_MIN_MS,
  INFLIGHT_STALE_MS,
};

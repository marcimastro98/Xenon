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
const { writeFileAtomic } = require('./atomic-write.js');
const { parseXdgUserDirs } = require('./diskspace.js');

const STORE_VERSION = 1;
const { DEFAULT_MAX_BYTES, receiveStream } = require('./transfer/receive-stream.js');
const DEFAULT_QUOTA_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_INFLIGHT = 4;
const PROGRESS_MIN_MS = 500;         // one SSE frame per id per half second, no more
const INFLIGHT_STALE_MS = 10 * 60 * 1000;

const ID_RE = /^f[0-9a-f]{16}$/;
// Windows swallows these whole, extension and all, however they are spelled.
// Shared with the sound/icon pack validators (see win-reserved.js for the
// forms covered: "con .txt", COM¹, CONIN$ …).
require('./win-reserved');

const {
  EXT_RE, stripDangerous, clampUtf8, label, extOf, deliveryName, contentDisposition,
} = require('./transfer/file-names.js');

const {
  FILE_RE, validInboxDir, deliverToInbox, ZONE_IDENTIFIER, markFromInternet,
} = require('./transfer/inbox-delivery.js');

const {
  MEDIA_MIME, FORCED_OCTET, downloadMimeFor, isThumbable, kindOf,
} = require('./transfer/file-kinds.js');

/**
 * The user's Downloads folder, without shelling out to PowerShell (which would
 * break the rule that a path everything must work on is not a Windows path).
 * On a non-English Linux desktop the folder is localised on disk — an Italian
 * install has ~/Scaricati — so the answer comes from xdg-user-dirs, parsed by
 * the function diskspace.js already exports and tests. Injectable so both
 * branches run wherever the suite does.
 */
// This machine's parsed user-dirs.dirs, read once per process — the resolver
// sits on the upload/status request path via defaultInboxDir(), and a
// synchronous read-and-parse per request is exactly the hot-path cost the
// invariants forbid (diskspace.js reads the same file once at construction for
// the same reason). The file only changes when the user renames their folders,
// which a restart is allowed to be the answer to. `undefined` = not read yet;
// only the real-machine lookup is cached, injected test inputs never are.
let _xdgCache;
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
      const machine = o.homedir === undefined;
      if (machine && _xdgCache !== undefined) {
        xdg = _xdgCache;
      } else {
        try {
          const cfg = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'user-dirs.dirs');
          xdg = parseXdgUserDirs(fs.readFileSync(cfg, 'utf8'), home);
        } catch { xdg = null; }
        if (machine) _xdgCache = xdg;
      }
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

    // A directory we could not READ is not an empty directory, and the whole
    // reconciliation below rests on that difference. This used to swallow the
    // error into `names = []`, which then meant "every blob is gone" — so every
    // record was dropped as a lie and the emptied manifest was written back over
    // the good one. One unreadable moment at boot (antivirus holding the folder,
    // a roaming/OneDrive-backed %LOCALAPPDATA% not yet materialised, a
    // half-mounted profile) permanently destroyed the list while the files
    // themselves were still sitting there, and the dashboard went on showing the
    // old list until the next request made the server answer with nothing.
    //
    // Reported as "if I delete one photo they all get deleted and there is no
    // way back": the delete was not the cause, it was the first request that
    // asked the server and got the truth.
    //
    // So: when the directory cannot be listed we keep every record, reconcile
    // nothing, and persist nothing. The records may be wrong, and a wrong record
    // is recoverable — a deleted one is not.
    let names = null;
    try { names = await fsp.readdir(filesDir); } catch { names = null; }
    if (names === null) {
      records = wanted;
      records.sort((a, b) => b.at - a.at);
      usedBytes = records.reduce((n, r) => n + (Number(r.size) || 0), 0);
      loaded = true;
      return;                                          // nothing verified, nothing written
    }
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
      // The blob is there (readdir just said so), so a stat that fails is the
      // filesystem being momentarily unhelpful, not a missing file. Keep the
      // record with the size it was stored with rather than dropping it — the
      // same rule as above, one file down.
      try {
        const st = await fsp.stat(path.join(filesDir, rec.file));
        rec.size = st.size;                            // the file is the authority, not the record
      } catch { /* keep rec.size */ }
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
   * Put back a record this session removed, if its blob is still on disk. The
   * undo window is the caller's (server.js holds the timer); this is only the
   * store half. Returns the record, or null when it is already gone for good.
   */
  async function restore(rec) {
    if (!rec || !rec.id || records.some((r) => r.id === rec.id)) return null;
    try { await fsp.access(absOf(rec)); } catch { return null; }
    records.push(rec);
    records.sort((a, b) => b.at - a.at);
    usedBytes += Number(rec.size) || 0;
    await persist();
    return rec;
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
  async function remove(id, opts) {
    const idx = records.findIndex((r) => r.id === String(id || ''));
    if (idx < 0) return false;
    const [rec] = records.splice(idx, 1);
    usedBytes = Math.max(0, usedBytes - rec.size);
    // The blob survives the record when the caller asks, so an undo has
    // something to put back. It is NOT left forever: the caller unlinks it when
    // its window closes, and a restart reclaims it as an orphan in init().
    if (!(opts && opts.keepBlob)) await fsp.unlink(absOf(rec)).catch(() => {});
    await persist();
    return rec;
  }

  /** Finish a deferred delete: the blob a keepBlob remove() left behind. */
  async function discardBlob(rec) {
    if (!rec || !FILE_RE.test(String(rec.file || ''))) return;
    await fsp.unlink(absOf(rec)).catch(() => {});
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
    list, get, absOf, remove, restore, discardBlob, prune, sweepInflight, stats, limits, deliver,
    isLoaded: () => loaded,
    get dir() { return dir; },
    get filesDir() { return filesDir; },
  };
}

module.exports = {
  markFromInternet, ZONE_IDENTIFIER,
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

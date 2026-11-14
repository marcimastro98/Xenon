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
const { PROGRESS_MIN_MS, INFLIGHT_STALE_MS } = require('./transfer/inflight-limits.js');

const ID_RE = /^f[0-9a-f]{16}$/;

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

const { makeInflight } = require('./transfer/inflight-uploads.js');

const { makeRecords } = require('./transfer/store-records.js');

const { makeLoad } = require('./transfer/store-load.js');

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

  const caps = {
    maxBytes: undefined, // given its first value further down, where it was declared
    quotaBytes: undefined, // given its first value further down, where it was declared
    keepMs: undefined, // given its first value further down, where it was declared
  };
  caps.maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  caps.quotaBytes = Number(opts.quotaBytes) > 0 ? Number(opts.quotaBytes) : DEFAULT_QUOTA_BYTES;
  caps.keepMs = Number(opts.keepMs) > 0 ? Number(opts.keepMs) : DEFAULT_KEEP_MS;
  const maxFiles = Number(opts.maxFiles) > 0 ? Number(opts.maxFiles) : DEFAULT_MAX_FILES;
  const maxInflight = Number(opts.maxInflight) > 0 ? Number(opts.maxInflight) : DEFAULT_MAX_INFLIGHT;

  const shelf = {
    records: [],            // newest first
    usedBytes: 0,
    loaded: false,
  };
  const inflight = new Map();  // id -> { reserved, at, received, lastEmit, name, ext, direction, from }

  function limits(next) {
    if (next && Number(next.maxBytes) > 0) caps.maxBytes = Number(next.maxBytes);
    if (next && Number(next.quotaBytes) > 0) caps.quotaBytes = Number(next.quotaBytes);
    if (next && Number(next.keepMs) > 0) caps.keepMs = Number(next.keepMs);
    return { maxBytes: caps.maxBytes, quotaBytes: caps.quotaBytes, keepMs: caps.keepMs, maxFiles, maxInflight };
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

  const {
    reservedBytes, noteProgress, inflightList, abort, sweepInflight,
  } = makeInflight({ filesDir, now, caps, inflight });

  async function persist() {
    if (!dir) return;
    const body = JSON.stringify({ v: STORE_VERSION, records: shelf.records }, null, 2);
    try { await writeFileAtomic(indexFile, body); }
    catch { /* the blobs are the truth; a lost index is rebuilt by init() */ }
  }

  const { init } = makeLoad({ dir, filesDir, indexFile, shelf, normalizeRecord, persist });

  const {
    restore, commit, markDelivered, list, absOf, remove, discardBlob, prune, stats,
  } = makeRecords({ filesDir, now, caps, maxFiles, shelf, inflight, reservedBytes, persist });

  /**
   * Reserve room for one upload and mint its id. Synchronous on purpose.
   *
   * @returns {{id:string, ext:string, target:string, limit:number}
   *          | {error:string, status:number, max?:number}}
   */
  function begin(input) {
    const i = input || {};
    if (!shelf.loaded || !dir) return { error: 'not_ready', status: 503 };
    if (inflight.size >= maxInflight) return { error: 'busy', status: 503 };

    const declared = Number(i.declaredLength);
    const known = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (known > caps.maxBytes) return { error: 'too_big', status: 413, max: caps.maxBytes };
    // An unknown length (chunked) reserves the worst case. Anything else lets N
    // parallel uploads each pass the quota check and blow it together.
    const reserved = known || caps.maxBytes;
    if (shelf.usedBytes + reservedBytes() + reserved > caps.quotaBytes) {
      return { error: 'quota', status: 507, max: caps.maxBytes };
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
    return { id, ext, file, target: path.join(filesDir, file), limit: caps.maxBytes };
  }

  function get(id) {
    const key = String(id || '');
    if (!ID_RE.test(key)) return null;
    const rec = shelf.records.find((r) => r.id === key);
    if (!rec || !FILE_RE.test(rec.file)) return null;
    return rec;
  }

  function deliver(rec, inboxDir) {
    return deliverToInbox(rec, inboxDir, { filesDir, dataDir, appRoot });
  }

  return {
    init, begin, commit, abort, noteProgress, inflightList, markDelivered,
    list, get, absOf, remove, restore, discardBlob, prune, sweepInflight, stats, limits, deliver,
    isLoaded: () => shelf.loaded,
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

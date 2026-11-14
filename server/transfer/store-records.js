'use strict';
// The finished files of the transfer store: a record made from an upload, where its copy went,
// what the list shows of it, its removal and its return, and retention, which removes only a
// copy the user also has elsewhere.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { FILE_RE } = require('./inbox-delivery.js');
const { downloadMimeFor, isThumbable, kindOf } = require('./file-kinds.js');

function makeRecords({ filesDir, now, caps, maxFiles, shelf, inflight, reservedBytes, persist }) {
  /**
   * Put back a record this session removed, if its blob is still on disk. The
   * undo window is the caller's (server.js holds the timer); this is only the
   * store half. Returns the record, or null when it is already gone for good.
   */
  async function restore(rec) {
    if (!rec || !rec.id || shelf.records.some((r) => r.id === rec.id)) return null;
    try { await fsp.access(absOf(rec)); } catch { return null; }
    shelf.records.push(rec);
    shelf.records.sort((a, b) => b.at - a.at);
    shelf.usedBytes += Number(rec.size) || 0;
    await persist();
    return rec;
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
    shelf.records.unshift(rec);
    shelf.usedBytes += rec.size;
    await persist();
    return rec;
  }

  /** Note where a copy was delivered, so retention knows the user has their own. */
  async function markDelivered(id, absPath) {
    const rec = shelf.records.find((r) => r.id === id);
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
    return shelf.records.slice(0, limit).map((r) => publicOf(r, c.includePaths === true));
  }

  function absOf(rec) {
    return path.join(filesDir, rec.file);
  }

  /**
   * Remove Xenon's copy. The file already delivered into the user's folder is
   * deliberately NOT touched: this list is Xenon's, the folder is theirs.
   */
  async function remove(id, opts) {
    const idx = shelf.records.findIndex((r) => r.id === String(id || ''));
    if (idx < 0) return false;
    const [rec] = shelf.records.splice(idx, 1);
    shelf.usedBytes = Math.max(0, shelf.usedBytes - rec.size);
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
    if (!shelf.loaded) return { removed: 0, bytes: 0 };
    const t = now();
    const doomed = [];
    for (let i = 0; i < shelf.records.length; i++) {
      const rec = shelf.records[i];
      if (!rec.delivered) continue;                       // the only copy: never ours to remove
      const tooOld = caps.keepMs > 0 && (t - rec.at) > caps.keepMs;
      const tooMany = i >= maxFiles;
      if (!tooOld && !tooMany) continue;
      try { await fsp.access(rec.delivered); } catch { continue; }   // their copy vanished: keep ours
      doomed.push(rec);
    }
    let bytes = 0;
    for (const rec of doomed) {
      await fsp.unlink(absOf(rec)).catch(() => {});
      const idx = shelf.records.indexOf(rec);
      if (idx >= 0) shelf.records.splice(idx, 1);
      shelf.usedBytes = Math.max(0, shelf.usedBytes - rec.size);
      bytes += rec.size;
    }
    if (doomed.length) await persist();
    return { removed: doomed.length, bytes };
  }

  function stats() {
    return {
      count: shelf.records.length,
      bytes: shelf.usedBytes,
      quotaBytes: caps.quotaBytes,
      maxBytes: caps.maxBytes,
      inflight: inflight.size,
      reserved: reservedBytes(),
    };
  }

  return { restore, commit, markDelivered, list, absOf, remove, discardBlob, prune, stats };
}

module.exports = { makeRecords };

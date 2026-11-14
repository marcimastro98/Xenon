'use strict';
// The uploads of the transfer store that have not finished: the room each one holds against the
// quota, its progress, the list shown while it runs, and the reaping of one whose connection
// died.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { PROGRESS_MIN_MS, INFLIGHT_STALE_MS } = require('./inflight-limits.js');

function makeInflight({ filesDir, now, caps, inflight }) {
  function reservedBytes() {
    let n = 0;
    for (const r of inflight.values()) n += r.reserved;
    return n;
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
        received: r.received, total: r.reserved === caps.maxBytes ? 0 : r.reserved, pending: true,
      });
    }
    return out;
  }

  /** Forget an upload that never finished. The caller's handle unlinks the .part. */
  function abort(id) {
    inflight.delete(id);
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

  return { reservedBytes, noteProgress, inflightList, abort, sweepInflight };
}

module.exports = { makeInflight };

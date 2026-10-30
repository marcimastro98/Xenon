'use strict';
// The gallery's work on what Xenon captured (captures.js keeps the index):
// small previews, a trimmed copy of a video, the file onto the clipboard,
// deletion. The engine (apps/capture) does the pixels and the streams; this
// module keeps the jobs in order and the paths on this side of the wire.
//
// Previews are JPEGs in `thumbDir/<id>.jpg`, made the first time the gallery
// asks for one, two at a time, and deleted with their capture (`forget`). A
// preview that failed once is not asked of the engine again until a restart.
// A trim copies the streams as stored (no re-encoding, so instant and without
// loss) from the keyframe at or before the asked start; one at a time. The
// copy is a new capture beside the original, which is never touched.
// "Clips from marks" is a row of such trims, one per marked moment.

const path = require('path');
const { VIDEO_KINDS } = require('./captures');
const { createEngineJobs } = require('./capture-jobs');
const { shiftMarkers } = require('./capture-markers');
const { markWindows } = require('./capture-autoclips');

const THUMB_WIDTH = 480;
const THUMB_PARALLEL = 2;
const THUMB_TIMEOUT_MS = 20000;
// A trim reads the source once from the keyframe; a long 4K clip is gigabytes.
const TRIM_TIMEOUT_MS = 60000;
const TRIM_MS_PER_SECOND = 100;
// Shorter than this is a slip of the handles, not a clip.
const MIN_TRIM_SECONDS = 0.5;
const ENGINE_ERRORS = new Set(['empty', 'disk_full', 'write_failed', 'trim_failed']);

function createCaptureGallery({
  host, store, thumbDir, mkdir, exists, unlink,
  timers = { setTimeout, clearTimeout },
}) {
  const { job } = createEngineJobs(host, ['thumb_done', 'trim_done'], timers);
  const making = new Map(); // id → Promise of the preview
  const failed = new Set();
  const queue = [];
  let running = 0;
  let trimming = false;

  const thumbFile = id => path.join(thumbDir, `${id}.jpg`);

  function next() {
    while (running < THUMB_PARALLEL && queue.length) {
      const task = queue.shift();
      running++;
      task().finally(() => { running--; next(); });
    }
  }

  async function makeThumb(e) {
    try { await mkdir(thumbDir); } catch { return null; }
    const out = thumbFile(e.id);
    const ev = await job('thumb', {
      src: e.file, out, width: THUMB_WIDTH, video: VIDEO_KINDS.includes(e.kind),
    }, `thumb-${e.id}`, THUMB_TIMEOUT_MS);
    if (!ev || ev.error) {
      // The engine missing or gone is not this file's fault: ask again later.
      if (ev && ev.error === 'thumb_failed') failed.add(e.id);
      return null;
    }
    return out;
  }

  // The preview's file for `id` (server side only), made when missing; null
  // when there is none (unknown id, file gone, engine absent, not decodable).
  async function thumb(id) {
    const e = store.get(id);
    if (!e || failed.has(e.id) || !host.available()) return null;
    const out = thumbFile(e.id);
    if (await exists(out)) return out;
    if (!(await exists(e.file))) return null;
    if (making.has(e.id)) return making.get(e.id);
    const p = new Promise((resolve) => {
      queue.push(() => makeThumb(e).then(resolve, () => resolve(null)));
      next();
    }).finally(() => making.delete(e.id));
    making.set(e.id, p);
    return p;
  }

  // A trimmed copy of video `id` from `start` to `end` (seconds). Answers the
  // new capture's public entry and where it really starts (a keyframe).
  async function trim(id, { start, end } = {}) {
    const e = store.get(id);
    if (!e) return { ok: false, error: 'not_found' };
    if (!VIDEO_KINDS.includes(e.kind)) return { ok: false, error: 'not_video' };
    const a = Number(start);
    let b = Number(end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0) return { ok: false, error: 'bad_range' };
    if (e.seconds > 0) b = Math.min(b, e.seconds);
    if (b - a < MIN_TRIM_SECONDS) return { ok: false, error: 'too_short' };
    if (!host.available()) return { ok: false, error: 'unavailable' };
    if (trimming) return { ok: false, error: 'busy' };
    trimming = true;
    try {
      return await cut(e, a, b, 'Trim');
    } finally {
      trimming = false;
    }
  }

  // A short copy around each marked moment of video `id` (markWindows), made
  // one after the other; another trim waits for the whole row. Answers how
  // many were made and, when one failed midway, why the rest are missing.
  async function clips(id, { which = 'auto' } = {}) {
    const e = store.get(id);
    if (!e) return { ok: false, error: 'not_found' };
    if (!VIDEO_KINDS.includes(e.kind)) return { ok: false, error: 'not_video' };
    const has = Array.isArray(e.markers) && e.markers.length > 0;
    const windows = markWindows(e.markers, e.seconds, ['marks', 'all'].includes(which) ? which : 'auto');
    if (!windows.length) return { ok: false, error: has ? 'whole_video' : 'no_marks' };
    if (!host.available()) return { ok: false, error: 'unavailable' };
    if (trimming) return { ok: false, error: 'busy' };
    trimming = true;
    const made = [];
    try {
      for (const w of windows) {
        const r = await cut(e, w.start, w.end, 'Clip');
        if (!r.ok) return made.length ? { ok: true, clips: made.length, of: windows.length, stopped: r.error, entries: made } : r;
        made.push(r.entry);
      }
      return { ok: true, clips: made.length, of: windows.length, entries: made };
    } finally {
      trimming = false;
    }
  }

  // One copy of e from a to b, named "<name> <suffix>" beside it.
  async function cut(e, a, b, suffix) {
    if (!(await exists(e.file))) return { ok: false, error: 'not_found' };
    const plan = await store.planBeside(e, suffix);
    const ev = await job('trim', { src: e.file, out: plan.file, start: a, end: b },
      plan.id, TRIM_TIMEOUT_MS + (b - a) * TRIM_MS_PER_SECOND);
    if (!ev || ev.error) {
      const code = ev && ev.error;
      return { ok: false, error: ENGINE_ERRORS.has(code) ? code : 'trim_failed' };
    }
    // The copy really starts at the keyframe: its markers count from there.
    const from = Number(ev.start) || 0;
    const entry = store.add({
      id: plan.id, kind: e.kind, file: plan.file, game: e.game,
      width: e.width, height: e.height, hdr: e.hdr, seconds: Number(ev.seconds), lapse: e.lapse, webcam: e.webcam,
      markers: shiftMarkers(e.markers, from, b),
    });
    if (!entry) return { ok: false, error: 'trim_failed' };
    return { ok: true, entry, start: from };
  }

  // The file onto the clipboard, as Explorer's Copy puts it (paste it into a
  // chat, a mail, a folder).
  async function copy(id) {
    const e = store.get(id);
    if (!e || !(await exists(e.file))) return { ok: false, error: 'not_found' };
    const reply = await host.request('copy_files', { paths: [e.file] });
    if (!reply || reply.ok !== true) return { ok: false, error: (reply && reply.error) === 'unavailable' ? 'unavailable' : 'copy_failed' };
    return { ok: true };
  }

  // A capture is gone (deleted here or pruned): its preview goes with it.
  function forget(id) {
    failed.delete(id);
    unlink(thumbFile(id)).catch(() => {});
  }

  return { thumb, trim, clips, copy, forget };
}

module.exports = { createCaptureGallery, THUMB_WIDTH, MIN_TRIM_SECONDS };

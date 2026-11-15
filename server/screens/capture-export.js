'use strict';
// Copies of a video made for sharing (apps/capture, export.rs): a vertical
// 9:16 copy for phones (the part of the picture to keep, or the webcam on top
// and the game below), a copy that fits a size (a chat's upload limit) and a
// GIF. The engine re-encodes, so a copy takes seconds to a minute: one at a
// time, started at once and followed through `onProgress` (the gallery's SSE,
// ids and numbers only). The copy is a new capture beside the original, which
// is never touched.

const { VIDEO_KINDS } = require('./captures');
const { createEngineJobs } = require('./capture-jobs');

const KINDS = Object.freeze(['vertical', 'fit', 'gif']);
const FOCUS = Object.freeze(['left', 'center', 'right']);
// The sizes the gallery offers; Bit may ask for any whole number up to FIT_MB_MAX.
const FIT_SIZES_MB = Object.freeze([10, 25, 50, 100]);
const FIT_MB_MAX = 4000; // the engine's own limit
// Re-encoding runs at several times real time; a busy GPU slows it down, and
// a copy that fits a size may be encoded twice.
const BASE_TIMEOUT_MS = 120000;
const MS_PER_SECOND = 2000;
const FIT_FACTOR = 3;
const ENGINE_ERRORS = new Set(['cancelled', 'too_big', 'too_long', 'export_failed', 'disk_full', 'write_failed', 'timeout']);

// The copy's name beside the original: "<name> Vertical.mp4", "<name> 25 MB.mp4", "<name> GIF.gif".
function suffixOf(kind, mb) {
  if (kind === 'fit') return `${mb} MB`;
  return kind === 'gif' ? 'GIF' : 'Vertical';
}

// The request checked against the capture: an error code, or what the engine gets.
function shape(e, { kind, focus, webcam, mb } = {}) {
  if (!KINDS.includes(kind)) return { error: 'bad_kind' };
  if (kind === 'fit') {
    const n = Number(mb);
    if (!Number.isInteger(n) || n < 1 || n > FIT_MB_MAX) return { error: 'bad_size' };
    return { body: { kind, mb: n } };
  }
  if (kind === 'gif') return { body: { kind } };
  const f = FOCUS.includes(focus) ? focus : 'center';
  if (webcam === true && !e.webcam) return { error: 'no_webcam' };
  return { body: { kind, focus: f, ...(webcam === true ? { webcam: e.webcam } : {}) } };
}

function timeoutFor(e, kind) {
  const ms = BASE_TIMEOUT_MS + (e.seconds > 0 ? e.seconds : 600) * MS_PER_SECOND;
  return kind === 'fit' ? ms * FIT_FACTOR : ms;
}

function createCaptureExport({
  host, store, sizeOf, onProgress = () => {}, onDone = () => {},
  timers = { setTimeout, clearTimeout },
}) {
  const { job } = createEngineJobs(host, ['export_done'], timers);
  let running = null; // { id (source), token (the copy's id), kind, pct, from }

  const tell = (fn, value) => { try { fn(value); } catch { /* a listener never breaks an export */ } };

  host.onEvent((ev) => {
    if (!ev || ev.event !== 'export_progress' || !running || String(ev.token) !== running.token) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(ev.pct) || 0)));
    running.pct = pct;
    tell(onProgress, { id: running.id, kind: running.kind, pct, from: running.from });
  });

  async function run(e, plan, body, kind) {
    const ev = await job('export', { src: e.file, out: plan.file, seconds: e.seconds || undefined, ...body },
      plan.id, timeoutFor(e, kind));
    if (!ev || ev.error) {
      const code = ev && ev.error;
      // Gone past its time: the engine may still be working on it.
      if (code === 'timeout') host.request('export_cancel', {}).catch(() => {});
      return { ok: false, error: ENGINE_ERRORS.has(code) ? code : 'export_failed' };
    }
    const entry = store.add({
      id: plan.id, kind: kind === 'gif' ? 'gif' : e.kind, file: plan.file, game: e.game,
      width: Number(ev.width), height: Number(ev.height), hdr: e.hdr, seconds: e.seconds, lapse: e.lapse,
      // Only a copy of the same picture keeps the bubble where it was.
      webcam: kind === 'fit' ? e.webcam : undefined,
    });
    if (!entry) return { ok: false, error: 'export_failed' };
    return { ok: true, entry, bytes: Number(ev.bytes) || 0 };
  }

  // Starts a copy of video `id`. Answers at once with `done`, the promise of
  // the result ({ ok, entry, bytes } or { ok:false, error }). `from` says who
  // asked ('gallery' or 'action'): the gallery follows its own copy, a key or
  // Bit is followed by a toast.
  async function start(id, options = {}) {
    const e = store.get(id);
    if (!e) return { ok: false, error: 'not_found' };
    if (!VIDEO_KINDS.includes(e.kind)) return { ok: false, error: 'not_video' };
    const s = shape(e, options);
    if (s.error) return { ok: false, error: s.error };
    if (!host.available()) return { ok: false, error: 'unavailable' };
    if (running) return { ok: false, error: 'busy' };
    const kind = s.body.kind;
    const from = options.from === 'action' ? 'action' : 'gallery';
    running = { id: e.id, token: '', kind, pct: 0, from };
    let plan;
    try {
      const bytes = await sizeOf(e.file);
      if (bytes == null) throw Object.assign(new Error(), { code: 'not_found' });
      // Already under the size: a copy would only come out bigger.
      if (kind === 'fit' && bytes <= s.body.mb * 1e6) throw Object.assign(new Error(), { code: 'already_small' });
      plan = await store.planBeside(e, suffixOf(kind, s.body.mb), kind === 'gif' ? '.gif' : undefined);
    } catch (err) {
      running = null;
      const code = err && err.code;
      return { ok: false, error: code === 'not_found' || code === 'already_small' ? code : 'export_failed' };
    }
    running.token = plan.id;
    tell(onProgress, { id: e.id, kind, pct: 0, from });
    const done = run(e, plan, s.body, kind)
      .catch(() => ({ ok: false, error: 'export_failed' }))
      .then((r) => {
        running = null;
        tell(onDone, { id: e.id, kind, from, ...r });
        return r;
      });
    return { ok: true, id: e.id, kind, done };
  }

  // Stops the copy being made; nothing is left on disk.
  async function cancel() {
    if (!running) return { ok: false, error: 'not_exporting' };
    const reply = await host.request('export_cancel', {});
    return reply && reply.ok === true ? { ok: true } : { ok: false, error: 'unavailable' };
  }

  // What a gallery opened in the middle of a copy shows.
  function status() {
    return running ? { exporting: true, id: running.id, kind: running.kind, pct: running.pct, from: running.from } : { exporting: false };
  }

  return { start, cancel, status };
}

module.exports = { createCaptureExport, shape, suffixOf, timeoutFor, KINDS, FOCUS, FIT_SIZES_MB, FIT_MB_MAX };

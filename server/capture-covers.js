'use strict';
// Screenshots made ready to share, as new copies beside the original (which is
// never touched):
// - spots: where the picture shows an e-mail, an IBAN or a long number, read
//   by the engine's OCR (apps/capture, cover.rs); only rectangles come back,
//   never the text, and the gallery's editor proposes them as covers;
// - cover: a copy with those spots painted black (Bit, the Deck key);
// - save: the editor's own drawing (arrows, boxes, text, covers), sent as a
//   PNG of the same size and written here.
// One cover or save at a time; paths stay on this side of the wire.

const { createEngineJobs } = require('./capture-jobs');

const SPOT_KINDS = Object.freeze(['email', 'iban', 'number']);
const MAX_SPOTS = 200;
const SPOTS_TIMEOUT_MS = 30000;
// The editor's PNG of an 8K screenshot is well under this.
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ENGINE_ERRORS = new Set(['no_ocr_language', 'write_failed', 'unsupported']);

// Width and height of a PNG from its header; null for anything else.
function pngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// The engine's spots, checked: known kinds, whole pixels inside the picture.
function cleanSpots(list, width, height) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, MAX_SPOTS)) {
    if (!s || !SPOT_KINDS.includes(s.kind)) continue;
    const [x, y, w, h] = [s.x, s.y, s.w, s.h].map(Number);
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0) continue;
    if (x + w > width || y + h > height) continue;
    out.push({ kind: s.kind, x, y, w, h });
  }
  return out;
}

function countKinds(spots) {
  const found = {};
  for (const s of spots) found[s.kind] = (found[s.kind] || 0) + 1;
  return found;
}

function createCaptureCovers({ host, store, exists, writeFile, rename, unlink, timers = { setTimeout, clearTimeout } }) {
  const { job } = createEngineJobs(host, ['cover_done'], timers);
  let seq = 0;
  let writing = false;

  // The screenshot `id` on disk, or the error to answer.
  async function picture(id) {
    const e = store.get(id);
    if (!e) return { error: 'not_found' };
    if (e.kind !== 'screenshot') return { error: 'not_picture' };
    if (!host.available()) return { error: 'unavailable' };
    if (!(await exists(e.file))) return { error: 'not_found' };
    return { e };
  }

  async function read(e, out) {
    const ev = await job('cover', out ? { src: e.file, out } : { src: e.file }, `cover-${++seq}`,
      SPOTS_TIMEOUT_MS);
    if (!ev || ev.error) {
      const code = ev && ev.error;
      return { error: ENGINE_ERRORS.has(code) ? code : 'cover_failed' };
    }
    const width = Number(ev.width);
    const height = Number(ev.height);
    if (!(width > 0 && height > 0)) return { error: 'cover_failed' };
    return { width, height, spots: cleanSpots(ev.spots, width, height) };
  }

  // Where screenshot `id` shows something private: `{ width, height, spots }`.
  async function spots(id) {
    const p = await picture(id);
    if (p.error) return { ok: false, error: p.error };
    const r = await read(p.e);
    return r.error ? { ok: false, error: r.error } : { ok: true, ...r };
  }

  // One write at a time; `fn` answers what the caller gets.
  async function oneAtATime(fn) {
    if (writing) return { ok: false, error: 'busy' };
    writing = true;
    try { return await fn(); } finally { writing = false; }
  }

  // A copy of screenshot `id` with every private spot painted over. Nothing
  // found = no copy (`covered: 0`).
  function cover(id) {
    return oneAtATime(async () => {
      const p = await picture(id);
      if (p.error) return { ok: false, error: p.error };
      const plan = await store.planBeside(p.e, 'Covered');
      const r = await read(p.e, plan.file);
      if (r.error) return { ok: false, error: r.error };
      const found = countKinds(r.spots);
      if (!r.spots.length) return { ok: true, covered: 0, found };
      const entry = store.add({ id: plan.id, kind: 'screenshot', file: plan.file, game: p.e.game, width: r.width, height: r.height });
      if (!entry) return { ok: false, error: 'cover_failed' };
      return { ok: true, entry, covered: r.spots.length, found };
    });
  }

  // The editor's drawing of screenshot `id` as a new capture beside it. The
  // PNG must be the same size as the original. Needs no engine.
  function save(id, png) {
    return oneAtATime(async () => {
      const e = store.get(id);
      if (!e || !(await exists(e.file))) return { ok: false, error: 'not_found' };
      if (e.kind !== 'screenshot') return { ok: false, error: 'not_picture' };
      return write(e, png);
    });
  }

  async function write(e, png) {
    if (!Buffer.isBuffer(png) || png.length > MAX_PNG_BYTES) return { ok: false, error: 'too_large' };
    const size = pngSize(png);
    if (!size) return { ok: false, error: 'bad_image' };
    if (e.width && e.height && (size.width !== e.width || size.height !== e.height)) return { ok: false, error: 'bad_image' };
    const plan = await store.planBeside(e, 'Edited');
    const part = plan.file + '.part';
    try {
      await writeFile(part, png);
      await rename(part, plan.file);
    } catch {
      unlink(part).catch(() => {});
      return { ok: false, error: 'write_failed' };
    }
    const entry = store.add({ id: plan.id, kind: 'screenshot', file: plan.file, game: e.game, width: size.width, height: size.height });
    return entry ? { ok: true, entry } : { ok: false, error: 'write_failed' };
  }

  return { spots, cover, save };
}

module.exports = { createCaptureCovers, pngSize, cleanSpots, SPOT_KINDS, MAX_PNG_BYTES };

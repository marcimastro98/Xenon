'use strict';
// What Xenon captured for the user (screenshots, recordings and Instant
// Replay clips), indexed in DATA_DIR/captures.json. Each capture gets an
// opaque id; its path stays in this file and in this process. Callers, the
// wire and the AI only ever see the id and the file NAME, and "show" reveals
// the file locally. Only files Xenon created are in the index, so an id can
// never point anywhere else.
//
// Files land in <Pictures>/Xenon/<game or Desktop>/<game or Desktop> <date time>.png
// (recordings: <Videos>/Xenon/... .mp4, or <chosen folder>/<game or Desktop>/
// when the user picked one), the folders read OneDrive-aware by user-folders.js.
//
// A space limit for videos (recordings and replay clips together) deletes the
// oldest ones Xenon made (only files in this index, never the one just saved)
// until the rest fit.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeName } = require('./benchmark');
const { normalizeMarkers } = require('./capture-markers');
const { markWindows } = require('./capture-autoclips');

// A GIF is only ever an exported copy of a video (capture-export.js).
const KINDS = Object.freeze(['screenshot', 'recording', 'replay', 'gif']);
// The kinds that are videos: saved under Videos, counted by the space limit.
const VIDEO_KINDS = Object.freeze(['recording', 'replay']);
const EXT = Object.freeze({ screenshot: '.png', recording: '.mp4', replay: '.mp4', gif: '.gif' });
const MAX_ENTRIES = 2000;
// A timelapse is a recording that took one picture every `lapse` seconds.
const LAPSE_EVERY = Object.freeze([1, 2, 5, 10, 30, 60]);
// The corner a recording's webcam bubble sits in (recorder.js WEBCAM).
const WEBCAM_CORNERS = Object.freeze(['tl', 'tr', 'bl', 'br']);
// How many of the newest captures "show the last one" checks are still on disk.
const LAST_LOOKBACK = 20;
const ID_RE = /^[a-f0-9]{16}$/;

const pad = n => String(n).padStart(2, '0');

function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// The folder and file label: the game's name, or "Desktop" outside a game.
function labelOf(game) {
  return game ? safeName(game) : 'Desktop';
}

const posInt = v => (Number.isInteger(v) && v > 0 && v < 1e6 ? v : null);
// A video's length in seconds, to the hundredth.
const seconds = v => (Number.isFinite(v) && v > 0 && v < 1e6 ? Math.round(v * 100) / 100 : null);

// A stored entry as written by add(); anything else on load is dropped.
function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (!ID_RE.test(e.id) || !KINDS.includes(e.kind)) return null;
  if (typeof e.file !== 'string' || !path.isAbsolute(e.file) || !Number.isFinite(e.createdAt)) return null;
  return {
    id: e.id, kind: e.kind, file: e.file, name: path.basename(e.file),
    game: typeof e.game === 'string' ? e.game.slice(0, 80) : '',
    createdAt: e.createdAt,
    width: posInt(e.width), height: posInt(e.height), hdr: e.hdr === true,
    ...(VIDEO_KINDS.includes(e.kind) ? { seconds: seconds(e.seconds) } : {}),
    ...(e.kind === 'recording' && LAPSE_EVERY.includes(e.lapse) ? { lapse: e.lapse } : {}),
    ...(e.kind === 'recording' && WEBCAM_CORNERS.includes(e.webcam) ? { webcam: e.webcam } : {}),
    ...markersOf(e),
  };
}

// Bookmarks and stutters on a video's timeline (capture-markers.js); none = no field.
function markersOf(e) {
  if (!VIDEO_KINDS.includes(e.kind)) return {};
  const list = normalizeMarkers(e.markers, seconds(e.seconds));
  return list.length ? { markers: list } : {};
}

// What may leave the server: everything but the path.
function publicEntry(e) {
  if (!e) return null;
  const { file, ...rest } = e; // eslint-disable-line no-unused-vars
  // How many clips "Clips from marks" would cut: the gallery offers it only then
  // (an auto clip holds its own mark, and cutting it again gives the same video).
  const clips = rest.markers ? markWindows(rest.markers, rest.seconds).length : 0;
  return clips ? { ...rest, clips } : rest;
}

function createCaptures({
  file, writeFileAtomic, picturesDir, videosDir = picturesDir, exists = p => fs.promises.access(p).then(() => true, () => false),
  now = Date.now, randomId = () => crypto.randomBytes(8).toString('hex'),
  stat = p => fs.promises.stat(p), unlink = p => fs.promises.unlink(p), onRemove = () => {},
}) {
  let entries = []; // newest first
  let saving = Promise.resolve();

  async function load() {
    let raw;
    try { raw = await fs.promises.readFile(file, 'utf8'); } catch { return; }
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j && j.entries) ? j.entries : [];
      entries = list.map(normalizeEntry).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_ENTRIES);
    } catch {
      try { await fs.promises.rename(file, file + '.corrupt-' + now()); } catch { /* gone */ }
      entries = [];
    }
  }

  function save() {
    const body = JSON.stringify({ version: 1, entries });
    saving = saving.then(() => writeFileAtomic(file, body)).catch((e) => {
      console.warn('[captures] save failed:', e && e.message);
    });
    return saving;
  }

  // Where the next capture of `kind` goes. Two in the same second get " (2)".
  // `root`: a folder the user chose (already checked); the game's subfolder
  // goes straight in it, without the "Xenon" level the default folders get.
  async function plan({ kind, game, root, lapse }) {
    if (!KINDS.includes(kind)) throw new Error(`unknown capture kind: ${kind}`);
    const label = labelOf(game);
    const dir = root && path.isAbsolute(root)
      ? path.join(root, label)
      : path.join(VIDEO_KINDS.includes(kind) ? await videosDir() : await picturesDir(), 'Xenon', label);
    // A replay clip or a timelapse says so in its name: it sits next to the recordings.
    const tag = kind === 'replay' ? ' Replay' : kind === 'recording' && LAPSE_EVERY.includes(lapse) ? ' Timelapse' : '';
    const base = `${label}${tag} ${stampOf(now())}`;
    let name = base + EXT[kind];
    for (let n = 2; await exists(path.join(dir, name)) && n < 100; n++) name = `${base} (${n})${EXT[kind]}`;
    let id = randomId();
    while (entries.some(e => e.id === id)) id = randomId();
    return { id, dir, file: path.join(dir, name), name };
  }

  // Where an edited copy of `entry` goes: beside it, "<name> Trim.mp4";
  // `ext` when the copy is another kind of file (a GIF of a video).
  async function planBeside(entry, suffix, ext = path.extname(entry.file)) {
    const dir = path.dirname(entry.file);
    const base = `${path.basename(entry.file, path.extname(entry.file))} ${suffix}`;
    let name = base + ext;
    // The index too: several copies planned in a row ("Clips from marks").
    const taken = async (f) => entries.some(e => e.file === f) || await exists(f);
    for (let n = 2; await taken(path.join(dir, name)) && n < 100; n++) name = `${base} (${n})${ext}`;
    let id = randomId();
    while (entries.some(e => e.id === id)) id = randomId();
    return { id, dir, file: path.join(dir, name), name };
  }

  // Records a capture the engine has written. Returns the public entry.
  function add({ id, kind, file: f, game = '', width, height, hdr, seconds: secs, lapse, webcam, markers }) {
    const e = normalizeEntry({ id, kind, file: f, game, createdAt: now(), width, height, hdr, seconds: secs, lapse, webcam, markers });
    if (!e) return null;
    entries = [e, ...entries.filter(x => x.id !== e.id)].slice(0, MAX_ENTRIES);
    save();
    return publicEntry(e);
  }

  // The server-side entry (with its path) for an id; null for anything unknown.
  function get(id) {
    return typeof id === 'string' && ID_RE.test(id) ? entries.find(e => e.id === id) || null : null;
  }

  // The newest capture of `kind` still on disk: the user may have deleted the
  // latest ones in the file manager. Looks at the newest few only; `match`
  // narrows the kind (a timelapse among the recordings).
  async function last(kind, match = () => true) {
    const recent = entries.filter(e => (!kind || e.kind === kind) && match(e)).slice(0, LAST_LOOKBACK);
    for (const e of recent) if (await exists(e.file)) return e;
    return null;
  }

  function list({ kind, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 50));
    return entries.filter(e => !kind || e.kind === kind).slice(0, n).map(publicEntry);
  }

  // The gallery's page: newest first, `kind` a kind or 'video', `game` a
  // folder label ('Desktop' outside a game), `before` the createdAt of the
  // last one already shown. Files the user deleted in the file manager are
  // skipped, not forgotten: a chosen folder on a drive that is unplugged now
  // comes back with it.
  async function browse({ kind, game, before, limit = 60 } = {}) {
    const n = Math.max(1, Math.min(200, Math.trunc(Number(limit)) || 60));
    // A GIF is a moving picture made from a video: it sits with the videos.
    const kinds = kind === 'video' ? [...VIDEO_KINDS, 'gif'] : KINDS.includes(kind) ? [kind] : KINDS;
    const cut = Number(before) > 0 ? Number(before) : Infinity;
    const out = [];
    let more = false;
    for (const e of entries) {
      if (e.createdAt >= cut || !kinds.includes(e.kind) || (game && labelOf(e.game) !== game)) continue;
      if (!(await exists(e.file))) continue;
      if (out.length === n) { more = true; break; }
      out.push(publicEntry(e));
    }
    return { entries: out, more };
  }

  // The folder labels in the index, with how many captures each has.
  function games() {
    const count = new Map();
    for (const e of entries) count.set(labelOf(e.game), (count.get(labelOf(e.game)) || 0) + 1);
    return [...count].map(([label, n]) => ({ label, count: n })).sort((a, b) => b.count - a.count);
  }

  // Deletes one capture: its file (already gone is fine) and its entry.
  async function remove(id) {
    const e = get(id);
    if (!e) return { ok: false, error: 'not_found' };
    try { await unlink(e.file); } catch (err) {
      if (!err || err.code !== 'ENOENT') return { ok: false, error: 'delete_failed' };
    }
    entries = entries.filter(x => x.id !== e.id);
    save();
    try { onRemove(e.id); } catch { /* a listener never breaks the index */ }
    return { ok: true, name: e.name };
  }

  // The size of every file of `kind` (a kind or a list of kinds) still on
  // disk, oldest first.
  async function sizes(kind) {
    const kinds = Array.isArray(kind) ? kind : [kind];
    const out = [];
    for (const e of entries.filter(x => kinds.includes(x.kind)).reverse()) {
      try { out.push({ e, size: (await stat(e.file)).size }); } catch { /* deleted by the user */ }
    }
    return out;
  }

  // Bytes the captures of `kind` take on disk.
  async function usage(kind) {
    return (await sizes(kind)).reduce((n, x) => n + x.size, 0);
  }

  // Deletes the oldest captures of `kind` until the rest fit in `maxBytes`,
  // never `keep` (the one just saved). Returns how many went and the bytes freed.
  async function prune({ kind, maxBytes, keep }) {
    if (!(maxBytes > 0)) return { removed: 0, freed: 0 };
    const files = await sizes(kind);
    let total = files.reduce((n, x) => n + x.size, 0);
    let removed = 0;
    let freed = 0;
    const gone = new Set();
    for (const { e, size } of files) {
      if (total <= maxBytes) break;
      if (e.id === keep) continue;
      try { await unlink(e.file); } catch { continue; }
      total -= size;
      freed += size;
      removed++;
      gone.add(e.id);
    }
    if (gone.size) {
      entries = entries.filter(x => !gone.has(x.id));
      save();
      for (const id of gone) { try { onRemove(id); } catch { /* as in remove() */ } }
    }
    return { removed, freed };
  }

  return { load, plan, planBeside, add, get, last, list, browse, games, remove, usage, prune, flush: () => saving };
}

module.exports = { createCaptures, normalizeEntry, publicEntry, labelOf, stampOf, KINDS, VIDEO_KINDS, LAPSE_EVERY, WEBCAM_CORNERS, MAX_ENTRIES };

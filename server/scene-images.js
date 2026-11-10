'use strict';
// Pictures of Ambient scenes live in files of their own, not inside settings.
//
// The scene editor puts a picture into the scene as a data: URI, up to about
// 1.4 MB each and 24 MB for all scenes together. All of that sat inside
// settings.json, and every settings save, a single switch included, sent,
// parsed, rewrote and broadcast the whole file: with a few picture scenes,
// tens of megabytes per tap, and every other screen downloading them again.
//
// On every settings write, a large picture inside a scene is stored once as
// /uploads/sceneimg-<hash>.<ext> (the same kind of local path a tile picture
// already uses, which the scene schema accepts) and the scene keeps only the
// path. Same picture, same file. What goes the other way, so nothing changes
// for the user:
//
//  · A backup puts the pictures back inside the scenes (inlineForBackup), so
//    a backup file still carries them to another PC.
//  · Sharing a scene already puts /uploads pictures back inside the code
//    (preset-share.js inlineSceneAssets).
//  · A picture is removed only when no scene and no daily copy of settings
//    (store-snapshots.js) names it, so putting back a copy never points at a
//    picture that was swept.
//
// Only PNG, JPEG, WebP and GIF whose bytes match their type are moved. SVG
// stays inside the scene: as a data: picture it can never run anything, while
// an SVG file served from Xenon's own address could.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');

const PREFIX = 'sceneimg-';
const MIN_CHARS = 16 * 1024;                     // small pictures cost nothing inline
const KEEP_UNUSED_MS = 2 * 24 * 60 * 60 * 1000;  // grace before the day's copy names it
const DATA_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const PATH_RE = /^\/uploads\/(sceneimg-[a-f0-9]{32}\.(?:png|jpg|webp|gif))$/;
const EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function bytesMatch(buf, ext) {
  if (!buf || buf.length < 12) return false;
  if (ext === 'png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === 'jpg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'gif') return buf.slice(0, 4).toString('latin1') === 'GIF8';
  if (ext === 'webp') return buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP';
  return false;
}

// The picture fields of a scene, as [holder, key] pairs. The same two places
// preset-share.js inlineSceneAssets reads.
function pictureSlots(scene) {
  const out = [];
  if (!scene || typeof scene !== 'object') return out;
  if (scene.bg && typeof scene.bg === 'object' && typeof scene.bg.url === 'string') out.push([scene.bg, 'url']);
  for (const c of Array.isArray(scene.components) ? scene.components : []) {
    if (c && c.props && typeof c.props === 'object' && typeof c.props.url === 'string') out.push([c.props, 'url']);
  }
  return out;
}

/**
 * Move the large pictures out of the scenes. Answers a new array (the input is
 * not changed) and whether anything moved. A picture that cannot be stored
 * stays inside its scene: nothing is ever lost here.
 */
async function externalize(scenes, uploadsDir) {
  if (!Array.isArray(scenes) || !scenes.length) return { scenes: Array.isArray(scenes) ? scenes : [], changed: false };
  let changed = false;
  const out = [];
  for (const scene of scenes) {
    const slots = pictureSlots(scene);
    if (!slots.some(([h, k]) => h[k].length >= MIN_CHARS && DATA_RE.test(h[k]))) { out.push(scene); continue; }
    const copy = JSON.parse(JSON.stringify(scene));
    for (const [holder, key] of pictureSlots(copy)) {
      const v = holder[key];
      if (v.length < MIN_CHARS) continue;
      const m = v.match(DATA_RE);
      if (!m) continue;
      const ext = EXT[m[1]];
      const buf = Buffer.from(m[2], 'base64');
      if (!bytesMatch(buf, ext)) continue;
      const name = `${PREFIX}${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
      const file = path.join(uploadsDir, name);
      try {
        if (!fs.existsSync(file)) {
          await fs.promises.mkdir(uploadsDir, { recursive: true });
          await writeFileAtomic(file, buf);
        } else {
          // Touch it, so a picture back in use is not swept as unused.
          const now = new Date();
          await fs.promises.utimes(file, now, now).catch(() => {});
        }
      } catch { continue; }
      holder[key] = '/uploads/' + name;
      changed = true;
    }
    out.push(copy);
  }
  return { scenes: changed ? out : scenes, changed };
}

function referencedNames(scenes) {
  const set = new Set();
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    for (const [h, k] of pictureSlots(scene)) {
      const m = h[k].match(PATH_RE);
      if (m) set.add(m[1]);
    }
  }
  return set;
}

// For a backup: the pictures go back inside the scenes, up to the size all
// scenes together could always hold inside settings (so a backup is never
// bigger than it used to be). A picture past that, or whose file is missing,
// keeps its path, which the scene schema still accepts and which still works
// when the backup goes back onto this PC.
const BACKUP_INLINE_MAX_CHARS = 24 * 1024 * 1024;
async function inlineForBackup(scenes, uploadsDir, { maxChars = BACKUP_INLINE_MAX_CHARS } = {}) {
  if (!Array.isArray(scenes)) return [];
  let total = 0;
  const out = [];
  for (const scene of scenes) {
    if (!pictureSlots(scene).some(([h, k]) => PATH_RE.test(h[k]))) { out.push(scene); continue; }
    const copy = JSON.parse(JSON.stringify(scene));
    for (const [holder, key] of pictureSlots(copy)) {
      const m = holder[key].match(PATH_RE);
      if (!m) continue;
      try {
        const buf = await fs.promises.readFile(path.join(uploadsDir, m[1]));
        const uri = `data:${MIME[m[1].split('.').pop()]};base64,${buf.toString('base64')}`;
        if (total + uri.length > maxChars) continue;
        total += uri.length;
        holder[key] = uri;
      } catch { /* missing: keep the path */ }
    }
    out.push(copy);
  }
  return out;
}

// The pictures named by the daily copies of settings: putting one of those
// copies back must find its pictures.
const NAME_IN_TEXT_RE = /sceneimg-[a-f0-9]{32}\.(?:png|jpg|webp|gif)/g;
async function namesInSnapshots(snapshotsDir) {
  const set = new Set();
  if (!snapshotsDir) return set;
  let files = [];
  try { files = await fs.promises.readdir(snapshotsDir); } catch { return set; }
  for (const f of files) {
    if (!/^settings[-.].*\.json$/.test(f)) continue;
    try {
      const text = await fs.promises.readFile(path.join(snapshotsDir, f), 'utf8');
      for (const m of text.matchAll(NAME_IN_TEXT_RE)) set.add(m[0]);
    } catch { /* unreadable copy: it names nothing we can keep for it */ }
  }
  return set;
}

// Remove a picture only when no scene names it, no daily copy of settings
// names it, and it was written more than KEEP_UNUSED_MS ago (a picture added
// and removed again before the day's copy was taken).
let _lastSweep = 0;
async function sweepUnused(uploadsDir, scenes, { now = Date.now(), minIntervalMs = 60 * 60 * 1000, snapshotsDir = '' } = {}) {
  if (now - _lastSweep < minIntervalMs) return [];
  _lastSweep = now;
  const keep = referencedNames(scenes);
  for (const n of await namesInSnapshots(snapshotsDir)) keep.add(n);
  const removed = [];
  let names = [];
  try { names = await fs.promises.readdir(uploadsDir); } catch { return removed; }
  for (const n of names) {
    if (!n.startsWith(PREFIX) || keep.has(n)) continue;
    try {
      const p = path.join(uploadsDir, n);
      const st = await fs.promises.stat(p);
      if (now - st.mtimeMs < KEEP_UNUSED_MS) continue;
      await fs.promises.unlink(p);
      removed.push(n);
    } catch { /* gone already */ }
  }
  return removed;
}

function _resetSweepClock() { _lastSweep = 0; }

module.exports = { PREFIX, MIN_CHARS, KEEP_UNUSED_MS, BACKUP_INLINE_MAX_CHARS, externalize, inlineForBackup, referencedNames, sweepUnused, _resetSweepClock };

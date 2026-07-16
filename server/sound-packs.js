'use strict';
// Installed soundboard packs — the server half of the 'sounds' preset kind.
//
// A pack is a folder under DATA_DIR/sounds/packs/<packId>/ holding a
// manifest.json plus one clip per file (<clipId>.<mp3|ogg|wav>). Packs arrive
// ONLY through installSoundPack() (POST /sound-pack, i.e. the preset import
// flow) and are validated fail-closed here:
//   - ids are strict charset tokens, so every filename is server-derived —
//     AND deterministic: the same pack installs to the same paths on every
//     machine, which is what lets a shared Deck profile reference a clip as
//     `packs/<packId>/<clipId>.<ext>` and still play after re-import
//     (sanitizeDeckProfile keeps exactly that shape and strips everything else);
//   - every clip must carry the magic bytes of its declared format;
//   - per-clip and per-pack size caps keep an exported pack publishable
//     (the catalog's hard ceiling is a 2 MB share code).
// Playback stays the existing browser path: GET /deck/sound?path=packs/…,
// which re-validates the pack-relative shape segment by segment.

const fs = require('fs');
const path = require('path');

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Windows reserved device names pass PACK_ID_RE but aren't usable folder names.
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const CLIP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const CLIP_EXTS = Object.freeze(['mp3', 'ogg', 'wav']);
// The pack-relative reference a Deck key / SDK widget may use as playSound.file.
// Segments mirror PACK_ID_RE + CLIP_ID_RE — nothing else survives export/import.
const PACK_FILE_RE = /^packs\/([a-z0-9][a-z0-9-]{1,40})\/([a-z0-9][a-z0-9_-]{0,40}\.(?:mp3|ogg|wav))$/;
const MAX_CLIPS = 24;
const CLIP_MAX_BYTES = 512 * 1024;             // decoded bytes per clip
const PACK_MAX_BYTES = Math.floor(1.4 * 1024 * 1024); // decoded bytes per pack (≈1.9 MB encoded)
const NAME_MAX = 60;
const AUTHOR_MAX = 40;
const LABEL_MAX = 40;
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}$/;
const MANIFEST_MAX_BYTES = 64 * 1024;
const MAX_PACKS = 64;

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Magic-byte check per declared format — a renamed executable never lands in
// the sound library, whatever extension it claims.
function clipLooksValid(ext, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (ext === 'mp3') {
    // ID3 tag or a bare MPEG frame sync (0xFF Ex/Fx).
    return buf.subarray(0, 3).toString('latin1') === 'ID3'
      || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  }
  if (ext === 'ogg') return buf.subarray(0, 4).toString('latin1') === 'OggS';
  if (ext === 'wav') {
    return buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WAVE';
  }
  return false;
}

// Pure validation of an install payload ({ manifest, clips }). One bad clip
// rejects the WHOLE pack (all-or-nothing, like widget manifests), so a
// published pack never silently loses entries.
function validateSoundPack(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'bad_payload' };
  const man = payload.manifest && typeof payload.manifest === 'object' ? payload.manifest : null;
  if (!man) return { ok: false, error: 'bad_manifest' };
  const id = cleanText(man.id, 41);
  if (!PACK_ID_RE.test(id) || WIN_RESERVED_RE.test(id)) return { ok: false, error: 'bad_pack_id' };
  const name = cleanText(man.name, NAME_MAX);
  if (!name) return { ok: false, error: 'bad_name' };
  const author = cleanText(man.author, AUTHOR_MAX);
  const versionRaw = cleanText(man.version, 20);
  const version = VERSION_RE.test(versionRaw) ? versionRaw : '1.0.0';

  const rawClips = Array.isArray(payload.clips) ? payload.clips : [];
  if (!rawClips.length) return { ok: false, error: 'no_clips' };
  if (rawClips.length > MAX_CLIPS) return { ok: false, error: 'too_many_clips' };

  const clips = [];
  const seen = new Set();
  let total = 0;
  for (const raw of rawClips) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad_clip' };
    const clipId = cleanText(raw.id, 41);
    if (!CLIP_ID_RE.test(clipId)) return { ok: false, error: 'bad_clip_id', clip: clipId };
    if (seen.has(clipId)) return { ok: false, error: 'duplicate_clip_id', clip: clipId };
    seen.add(clipId);
    const ext = CLIP_EXTS.includes(raw.ext) ? raw.ext : '';
    if (!ext) return { ok: false, error: 'bad_clip_ext', clip: clipId };
    let bytes;
    try { bytes = Buffer.from(String(raw.data || ''), 'base64'); } catch { bytes = null; }
    if (!bytes || !bytes.length) return { ok: false, error: 'bad_clip_data', clip: clipId };
    if (bytes.length > CLIP_MAX_BYTES) return { ok: false, error: 'clip_too_large', clip: clipId };
    total += bytes.length;
    if (total > PACK_MAX_BYTES) return { ok: false, error: 'pack_too_large' };
    if (!clipLooksValid(ext, bytes)) return { ok: false, error: 'clip_rejected', clip: clipId };
    clips.push({ id: clipId, label: cleanText(raw.label, LABEL_MAX) || clipId, ext, bytes });
  }
  return { ok: true, manifest: { id, name, author, version }, clips };
}

// ── Filesystem store ────────────────────────────────────────────────────────
function createSoundPacks({ dir }) {
  const ROOT = path.resolve(dir); // DATA_DIR/sounds/packs

  // Temp-dir + rename install (atomic analog of writeFileAtomic): a crash never
  // leaves a half-written pack; a reinstall of the same id replaces it wholesale
  // at the SAME clip paths, so existing Deck keys keep pointing at valid files.
  async function install(payload) {
    const v = validateSoundPack(payload);
    if (!v.ok) return v;
    await fs.promises.mkdir(ROOT, { recursive: true });
    const tmp = await fs.promises.mkdtemp(path.join(ROOT, '.tmp-'));
    try {
      const files = [];
      for (const clip of v.clips) {
        const file = clip.id + '.' + clip.ext;
        await fs.promises.writeFile(path.join(tmp, file), clip.bytes);
        files.push({ id: clip.id, label: clip.label, ext: clip.ext, file });
      }
      const manifest = Object.assign({}, v.manifest, { clips: files });
      await fs.promises.writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const dest = path.join(ROOT, v.manifest.id);
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.rename(tmp, dest);
      return { ok: true, id: v.manifest.id, count: v.clips.length };
    } catch {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: 'install_failed' };
    }
  }

  // List installed pack manifests. Each clip carries its pack-relative `path`
  // (the exact string a playSound key stores), so pickers use it verbatim.
  async function list() {
    let entries = [];
    try { entries = await fs.promises.readdir(ROOT, { withFileTypes: true }); } catch { return []; }
    const packs = [];
    for (const ent of entries) {
      if (packs.length >= MAX_PACKS) break;
      if (!ent.isDirectory() || !PACK_ID_RE.test(ent.name)) continue;
      try {
        const manPath = path.join(ROOT, ent.name, 'manifest.json');
        const stat = await fs.promises.stat(manPath);
        if (stat.size > MANIFEST_MAX_BYTES) continue;
        const man = JSON.parse(await fs.promises.readFile(manPath, 'utf8'));
        if (!man || man.id !== ent.name || !Array.isArray(man.clips)) continue;
        packs.push({
          id: ent.name,
          name: cleanText(man.name, NAME_MAX) || ent.name,
          author: cleanText(man.author, AUTHOR_MAX),
          version: cleanText(man.version, 20),
          clips: man.clips
            .filter((c) => c && CLIP_ID_RE.test(String(c.id || '')) && PACK_FILE_RE.test('packs/' + ent.name + '/' + String(c.file || '')))
            .slice(0, MAX_CLIPS)
            .map((c) => ({
              id: c.id,
              label: cleanText(c.label, LABEL_MAX) || c.id,
              path: 'packs/' + ent.name + '/' + c.file,
            })),
        });
      } catch { /* skip unreadable pack */ }
    }
    return packs;
  }

  async function remove(id) {
    if (!PACK_ID_RE.test(String(id || ''))) return false;
    try {
      await fs.promises.rm(path.join(ROOT, String(id)), { recursive: true, force: true });
      return true;
    } catch { return false; }
  }

  // Resolve a pack-relative playSound reference ('packs/<id>/<clip>.<ext>') to
  // an absolute file under ROOT, or null. Segments are validated by the single
  // PACK_FILE_RE match, and the result is prefix-asserted anyway.
  function resolve(ref) {
    const m = PACK_FILE_RE.exec(String(ref || ''));
    if (!m) return null;
    const abs = path.join(ROOT, m[1], m[2]);
    return abs.startsWith(ROOT + path.sep) ? abs : null;
  }

  return { install, list, remove, resolve };
}

module.exports = {
  PACK_ID_RE,
  CLIP_ID_RE,
  PACK_FILE_RE,
  CLIP_EXTS,
  MAX_CLIPS,
  CLIP_MAX_BYTES,
  PACK_MAX_BYTES,
  clipLooksValid,
  validateSoundPack,
  createSoundPacks,
};

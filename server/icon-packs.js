'use strict';
// Installed Deck icon packs — the server half of the 'icons' preset kind.
//
// A pack is a folder under DATA_DIR/icon-packs/<packId>/ holding a
// manifest.json plus one file per icon (<iconId>.svg | <iconId>.png). Packs
// arrive ONLY through installIconPack() (POST /icon-pack, i.e. the preset
// import flow) and are validated fail-closed at this boundary:
//   - ids are strict charset tokens, so every filename is server-derived
//     (<validated-id>.<allowlisted-ext>) — the wire never names a path;
//   - SVGs that contain anything active or external are REJECTED, never
//     rewritten (a sanitizer needs a real XML parser; a reject-list stays
//     auditable and fail-closed — see svgProblem);
//   - PNGs must carry the PNG magic bytes;
//   - per-icon and per-pack size caps bound disk use.
// Icons are served back only through resolve() (segment regexes + prefix
// assert) with a deny-all CSP; the picker embeds a picked icon into the key
// as a data: URI, so keys keep working after the pack is uninstalled.
//
// NOTE: the client-side builder in js/preset-share.js duplicates svgProblem()
// for instant feedback while composing a pack. The server copy here is the
// authority; test/icon-packs.test.mjs asserts the two stay in agreement.

const fs = require('fs');
const path = require('path');

// Pack ids are creator-declared but strictly shaped (same shape as SDK package
// ids), so a reinstall/update of the same pack replaces the same folder.
const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Windows reserved device names (con, aux, nul, com1…) pass PACK_ID_RE but
// behave inconsistently as folder names across OSes — reject them so a pack id
// is always a real installable folder.
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const ICON_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const ICON_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,40}\.(svg|png)$/;
const MAX_ICONS = 120;
const ICON_MAX_BYTES = 24 * 1024;          // decoded bytes per icon
const PACK_MAX_BYTES = 2 * 1024 * 1024;    // decoded bytes per pack
const NAME_MAX = 60;
const AUTHOR_MAX = 40;
const LABEL_MAX = 40;
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}$/;
const MANIFEST_MAX_BYTES = 256 * 1024;     // read guard when listing installed packs
const MAX_PACKS = 64;                      // list() scan bound

const MIME_BY_EXT = { svg: 'image/svg+xml', png: 'image/png' };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── SVG acceptance (reject, never rewrite) ─────────────────────────────────
// Anything that could run script, pull an external resource, or embed foreign
// content fails the whole icon with a named reason. False rejects are fine
// (the author fixes their file); false accepts are not. Scans the RAW text, so
// a payload "hidden" in a comment or CDATA still trips the matching rule.
function svgProblem(text) {
  const s = String(text || '');
  if (!s.trim()) return 'empty';
  // Optional BOM + optional <?xml ...?> prolog + whitespace, then <svg.
  const head = s.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*\?>/i, '').trimStart();
  if (!/^<svg[\s>]/i.test(head)) return 'not_svg';
  if (/<!doctype|<!entity/i.test(s)) return 'doctype';
  if (/<script/i.test(s)) return 'script';
  if (/<foreignobject/i.test(s)) return 'foreign_object';
  if (/<(iframe|embed|object|image|video|audio)[\s>/]/i.test(s)) return 'embedded_content';
  // Attribute event handlers (onload=, onclick=, …) in attribute position. The
  // boundary class includes '/' so a slash-separated form (<animate/onbegin=…>)
  // can't slip past.
  if (/[\s"'<\/]on[a-z]+\s*=/i.test(s)) return 'event_handler';
  if (/javascript:/i.test(s)) return 'javascript_uri';
  if (/data:text/i.test(s)) return 'data_text_uri';
  // CSS @import pulls an external stylesheet from inside <style>.
  if (/@import/i.test(s)) return 'css_import';
  // SMIL that animates an href (<set|animate attributeName="href" to/values=…>)
  // is an external-reference vector the href-attribute scan below wouldn't see.
  if (/attributename\s*=\s*["']?\s*(?:xlink:)?href\b/i.test(s)) return 'animated_href';
  // Every href/xlink:href must be a local fragment (#gradient etc.).
  const hrefRe = /(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = hrefRe.exec(s))) {
    const value = (m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] || '').trim();
    if (!value.startsWith('#')) return 'external_href';
  }
  // Every url(...) (CSS fills, filters, style attrs) must be a local fragment.
  const urlRe = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  while ((m = urlRe.exec(s))) {
    if (!String(m[2] || '').trim().startsWith('#')) return 'external_url';
  }
  return '';
}

function pngLooksValid(buf) {
  return Buffer.isBuffer(buf) && buf.length > PNG_MAGIC.length && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Pure validation of an install payload ({ manifest, icons }). Returns
// { ok: true, manifest, icons: [{ id, label, type, bytes }] } with decoded
// bytes, or { ok: false, error, icon? } naming the first offending icon —
// one bad icon rejects the WHOLE pack (same all-or-nothing rule as widget
// manifests), so a published pack never silently loses entries.
function validateIconPack(payload) {
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

  const rawIcons = Array.isArray(payload.icons) ? payload.icons : [];
  if (!rawIcons.length) return { ok: false, error: 'no_icons' };
  if (rawIcons.length > MAX_ICONS) return { ok: false, error: 'too_many_icons' };

  const icons = [];
  const seen = new Set();
  let total = 0;
  for (const raw of rawIcons) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad_icon' };
    const iconId = cleanText(raw.id, 41);
    if (!ICON_ID_RE.test(iconId)) return { ok: false, error: 'bad_icon_id', icon: iconId };
    if (seen.has(iconId)) return { ok: false, error: 'duplicate_icon_id', icon: iconId };
    seen.add(iconId);
    const type = raw.type === 'png' ? 'png' : raw.type === 'svg' ? 'svg' : '';
    if (!type) return { ok: false, error: 'bad_icon_type', icon: iconId };
    let bytes;
    try { bytes = Buffer.from(String(raw.data || ''), 'base64'); } catch { bytes = null; }
    if (!bytes || !bytes.length) return { ok: false, error: 'bad_icon_data', icon: iconId };
    if (bytes.length > ICON_MAX_BYTES) return { ok: false, error: 'icon_too_large', icon: iconId };
    total += bytes.length;
    if (total > PACK_MAX_BYTES) return { ok: false, error: 'pack_too_large' };
    if (type === 'svg') {
      const problem = svgProblem(bytes.toString('utf8'));
      if (problem) return { ok: false, error: 'svg_rejected', icon: iconId, reason: problem };
    } else if (!pngLooksValid(bytes)) {
      return { ok: false, error: 'png_rejected', icon: iconId };
    }
    icons.push({ id: iconId, label: cleanText(raw.label, LABEL_MAX) || iconId, type, bytes });
  }
  return { ok: true, manifest: { id, name, author, version }, icons };
}

// ── Filesystem store ────────────────────────────────────────────────────────
function createIconPacks({ dir }) {
  const ROOT = path.resolve(dir);

  // Atomic-install analog of writeFileAtomic: build the whole pack in a temp
  // sibling dir, then swap it into place — a crash mid-install never leaves a
  // half-written pack, and a reinstall of the same id replaces it wholesale.
  async function install(payload) {
    const v = validateIconPack(payload);
    if (!v.ok) return v;
    await fs.promises.mkdir(ROOT, { recursive: true });
    const tmp = await fs.promises.mkdtemp(path.join(ROOT, '.tmp-'));
    try {
      const files = [];
      for (const icon of v.icons) {
        const file = icon.id + '.' + icon.type;
        await fs.promises.writeFile(path.join(tmp, file), icon.bytes);
        files.push({ id: icon.id, label: icon.label, type: icon.type, file });
      }
      const manifest = Object.assign({}, v.manifest, { icons: files });
      await fs.promises.writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const dest = path.join(ROOT, v.manifest.id);
      await fs.promises.rm(dest, { recursive: true, force: true });
      await fs.promises.rename(tmp, dest);
      return { ok: true, id: v.manifest.id, count: v.icons.length };
    } catch (e) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: 'install_failed' };
    }
  }

  // List installed pack manifests (no file data). A folder with a missing or
  // malformed manifest is skipped, never fatal.
  async function list() {
    let entries = [];
    try { entries = await fs.promises.readdir(ROOT, { withFileTypes: true }); } catch { return []; }
    const packs = [];
    for (const ent of entries) {
      if (packs.length >= MAX_PACKS) break;
      if (!ent.isDirectory() || !PACK_ID_RE.test(ent.name)) continue;
      try {
        const stat = await fs.promises.stat(path.join(ROOT, ent.name, 'manifest.json'));
        if (stat.size > MANIFEST_MAX_BYTES) continue;
        const man = JSON.parse(await fs.promises.readFile(path.join(ROOT, ent.name, 'manifest.json'), 'utf8'));
        if (!man || man.id !== ent.name || !Array.isArray(man.icons)) continue;
        packs.push({
          id: ent.name,
          name: cleanText(man.name, NAME_MAX) || ent.name,
          author: cleanText(man.author, AUTHOR_MAX),
          version: cleanText(man.version, 20),
          icons: man.icons
            .filter((icon) => icon && ICON_ID_RE.test(String(icon.id || '')) && ICON_FILE_RE.test(String(icon.file || '')))
            .slice(0, MAX_ICONS)
            .map((icon) => ({ id: icon.id, label: cleanText(icon.label, LABEL_MAX) || icon.id, type: icon.type === 'png' ? 'png' : 'svg', file: icon.file })),
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

  // Resolve one icon file for serving. Both segments are regex-validated and
  // the joined path is prefix-asserted — the wire never names a path shape
  // these regexes don't produce.
  function resolve(packId, fileName) {
    const id = String(packId || '');
    const file = String(fileName || '');
    if (!PACK_ID_RE.test(id) || !ICON_FILE_RE.test(file)) return null;
    const abs = path.join(ROOT, id, file);
    if (!abs.startsWith(ROOT + path.sep)) return null;
    const ext = file.slice(file.lastIndexOf('.') + 1);
    return { abs, mime: MIME_BY_EXT[ext] || 'application/octet-stream' };
  }

  return { install, list, remove, resolve };
}

module.exports = {
  PACK_ID_RE,
  ICON_ID_RE,
  ICON_FILE_RE,
  MAX_ICONS,
  ICON_MAX_BYTES,
  PACK_MAX_BYTES,
  svgProblem,
  pngLooksValid,
  validateIconPack,
  createIconPacks,
};

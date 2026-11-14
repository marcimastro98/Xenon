'use strict';
// The files of a widget package: which file a request for an asset may reach, its type, and the
// files read back for sharing within their size limits.

const fs = require('node:fs');
const path = require('node:path');
const { WIDGET_ID_RE, SEGMENT_RE, ASSET_MIME } = require('./package-names.js');
const { isReservedAsset } = require('./frame-scripts.js');

// Resolve a widget asset request to an absolute path under rootDir/<id>/, or
// null. Defense in depth: id + every path segment validated against strict
// regexes (no '..', '\', '%', or empty segments survive), extension
// allowlisted, then the normalized result is prefix-checked anyway.
function resolveAsset(rootDir, id, relPath) {
  if (!WIDGET_ID_RE.test(String(id || ''))) return null;
  let decoded;
  try { decoded = decodeURIComponent(String(relPath || '')); } catch { return null; }
  if (!decoded || decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  if (segments.length > 8) return null;
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..' || seg.startsWith('..')) return null;
  }
  // The probe filename is reserved: it is served from memory by the route, and
  // a package file by that name must never shadow it from disk.
  if (isReservedAsset(segments[segments.length - 1])) return null;
  const ext = path.extname(segments[segments.length - 1]).toLowerCase();
  if (!ASSET_MIME[ext]) return null;
  const base = path.join(rootDir, id);
  const abs = path.normalize(path.join(base, ...segments));
  if (!abs.startsWith(base + path.sep)) return null;
  return abs;
}

function mimeFor(absPath) {
  return ASSET_MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
}

// ── Installable package PAYLOAD (a widget shipped inside a shared bundle) ────
// A bundle can carry a widget as { id, files:[{path,data(base64)}] } and install
// it via POST /sdk/install instead of the user dropping a folder. These caps
// bound a hostile payload; the validator below is the SAME trust boundary the
// folder scan applies (manifest rebuilt, every path/extension re-checked) — for
// files arriving over the wire. Pure + unit-tested in sdk-widgets.test.mjs.
const PAYLOAD_MAX_FILES = 40;
const PAYLOAD_MAX_FILE_BYTES = 512 * 1024;
const PAYLOAD_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

// One relative asset path from a payload: same per-segment charset + extension
// allowlist as resolveAsset (minus the FS). Returns the clean 'a/b.png' form, or
// '' if it isn't a safe, allowlisted asset path. '..'/backslash/percent/absolute
// are all impossible by construction.
function normalizeAssetRelPath(relPath) {
  const decoded = String(relPath == null ? '' : relPath).trim();
  if (!decoded || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('%')) return '';
  const segments = decoded.split('/');
  if (segments.length > 8) return '';
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..' || seg.startsWith('..')) return '';
  }
  const ext = path.extname(segments[segments.length - 1]).toLowerCase();
  if (!ASSET_MIME[ext]) return '';   // manifest.json (.json) is in ASSET_MIME
  return segments.join('/');
}

// Read an installed package's files into an embeddable payload
// { id, files:[{ path, data(base64) }] } for a bundle export, or null. Only
// allowlisted asset files are included and the same caps apply, so a re-import
// round-trips through validateWidgetPayload.
async function readPackagePayload(rootDir, id) {
  if (!WIDGET_ID_RE.test(String(id || ''))) return null;
  const base = path.join(rootDir, id);
  const files = [];
  let total = 0;
  async function walk(dir, prefix) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= PAYLOAD_MAX_FILES) return;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (rel.split('/').length < 8) await walk(path.join(dir, ent.name), rel); continue; }
      const norm = normalizeAssetRelPath(rel);
      if (!norm) continue;
      let bytes;
      try { bytes = await fs.promises.readFile(path.join(dir, ent.name)); } catch { continue; }
      if (bytes.length > PAYLOAD_MAX_FILE_BYTES) continue;
      total += bytes.length;
      if (total > PAYLOAD_MAX_TOTAL_BYTES) return;
      files.push({ path: norm, data: bytes.toString('base64') });
    }
  }
  await walk(base, '');
  if (!files.some(f => f.path === 'manifest.json')) return null;
  return { id, files };
}

module.exports = {
  resolveAsset, mimeFor, PAYLOAD_MAX_FILES, PAYLOAD_MAX_FILE_BYTES, PAYLOAD_MAX_TOTAL_BYTES,
  normalizeAssetRelPath, readPackagePayload,
};

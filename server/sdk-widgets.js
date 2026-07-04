'use strict';
// Third-party widget SDK — server-side package validation and asset resolution.
//
// A "widget package" is a folder under DATA_DIR/widgets/<id>/ containing a
// manifest.json plus the HTML/JS/CSS assets of a sandboxed dashboard widget.
// This module is the SECURITY BOUNDARY for everything that comes out of those
// folders: the manifest is rebuilt key-by-key (never spread), asset paths are
// resolved against a strict allowlist, and every served asset carries a CSP
// that (a) re-sandboxes the document even when opened directly as a top-level
// page and (b) blocks ALL network access from widget code. The latter is
// load-bearing: a sandboxed iframe has an opaque origin, so its fetches would
// arrive at the local API with `Origin: null` — which isAllowedRequest()
// deliberately accepts for the iCUE WebView. Without `connect-src 'none'` a
// hostile widget could call the local API directly. All host interaction goes
// through the postMessage bridge in js/custom-widget.js instead, where grants
// are enforced.
//
// Pure and requireable (no server state) so the hostile-input paths are unit
// tested in server/test/sdk-widgets.test.mjs.

const fs = require('fs');
const path = require('path');

// Version of the host↔widget postMessage protocol (see docs/WIDGET_SDK.md).
const SDK_API_VERSION = 1;

// Data streams a package may request; each maps 1:1 to an SSE event the
// dashboard already receives. The host only forwards streams the user granted.
const SDK_STREAMS = Object.freeze(['status', 'system', 'media', 'audio']);

// Action categories a package may request → the deck-action types each grants.
// Deliberately a small, low-blast-radius subset of the action registry; every
// dispatched action is still fully re-validated by server/actions/registry.js.
const SDK_ACTION_CATEGORIES = Object.freeze({
  media: Object.freeze(['media']),
  volume: Object.freeze(['volume', 'appVolume', 'appMute']),
  mic: Object.freeze(['micMute']),
  lighting: Object.freeze(['lighting']),
  url: Object.freeze(['openUrl']),
});

// Package ids are folder names: short, lowercase, no dots/slashes → they can
// never traverse and are safe inside a URL path segment.
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// Entry document and asset filenames (per path segment): conservative charset,
// must carry an allowlisted extension, and '..' is impossible by construction.
const ENTRY_RE = /^[A-Za-z0-9._-]+\.html?$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const ASSET_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
});

// The CSP served with EVERY widget asset. `sandbox allow-scripts` keeps the
// document sandboxed (opaque origin, no allow-same-origin) even when navigated
// to directly; `connect-src 'none'` closes the Origin:null hole described in
// the header comment. Do not weaken either directive — a widget that "needs"
// network access is a protocol design change, not a CSP relaxation.
const WIDGET_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  'sandbox allow-scripts',
].join('; ');

const MANIFEST_MAX_BYTES = 32 * 1024;
const MAX_PACKAGES = 32;

function cleanStr(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanList(value, allowed, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!allowed.includes(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// Rebuild a raw manifest into the exact shape the host trusts. Returns
// { ok:true, manifest } or { ok:false, reason } — never a spread of the input.
function normalizeManifest(raw, folderId) {
  if (!WIDGET_ID_RE.test(String(folderId || ''))) return { ok: false, reason: 'bad_id' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad_manifest' };
  if (raw.api !== SDK_API_VERSION) return { ok: false, reason: 'unsupported_api' };
  // A manifest that names an id must name its own folder (no identity spoofing).
  if (raw.id != null && String(raw.id) !== folderId) return { ok: false, reason: 'id_mismatch' };
  const name = cleanStr(raw.name, 60);
  if (!name) return { ok: false, reason: 'missing_name' };
  const entry = raw.entry == null ? 'index.html' : cleanStr(raw.entry, 80);
  if (!ENTRY_RE.test(entry)) return { ok: false, reason: 'bad_entry' };
  const version = cleanStr(raw.version, 20);
  if (version && !/^[0-9A-Za-z._-]+$/.test(version)) return { ok: false, reason: 'bad_version' };
  return {
    ok: true,
    manifest: {
      id: folderId,
      api: SDK_API_VERSION,
      name,
      version: version || '0.0.0',
      author: cleanStr(raw.author, 60),
      description: cleanStr(raw.description, 200),
      entry,
      streams: cleanList(raw.streams, SDK_STREAMS, SDK_STREAMS.length),
      actions: cleanList(raw.actions, Object.keys(SDK_ACTION_CATEGORIES), Object.keys(SDK_ACTION_CATEGORIES).length),
    },
  };
}

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

// Scan the packages dir. Returns { packages:[manifest…], invalid:[{id,reason}] }.
// Bounded, async, tolerant: a broken folder shows up as invalid with a reason
// (surfaced in Settings) instead of hiding or throwing.
async function listPackages(rootDir) {
  const packages = [];
  const invalid = [];
  let entries = [];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return { packages, invalid };   // dir missing → nothing installed
  }
  for (const ent of entries) {
    if (packages.length >= MAX_PACKAGES) break;
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    if (!WIDGET_ID_RE.test(id)) { invalid.push({ id: String(id).slice(0, 60), reason: 'bad_id' }); continue; }
    let raw;
    try {
      const stat = await fs.promises.stat(path.join(rootDir, id, 'manifest.json'));
      if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) { invalid.push({ id, reason: 'bad_manifest' }); continue; }
      raw = JSON.parse(await fs.promises.readFile(path.join(rootDir, id, 'manifest.json'), 'utf8'));
    } catch {
      invalid.push({ id, reason: 'missing_manifest' });
      continue;
    }
    const res = normalizeManifest(raw, id);
    if (!res.ok) { invalid.push({ id, reason: res.reason }); continue; }
    try {
      await fs.promises.access(path.join(rootDir, id, res.manifest.entry));
    } catch {
      invalid.push({ id, reason: 'missing_entry' });
      continue;
    }
    packages.push(res.manifest);
  }
  return { packages, invalid };
}

module.exports = {
  SDK_API_VERSION,
  SDK_STREAMS,
  SDK_ACTION_CATEGORIES,
  WIDGET_CSP,
  normalizeManifest,
  resolveAsset,
  mimeFor,
  listPackages,
};

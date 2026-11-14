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
//
// ── CHANGING WHAT WIDGETS CAN SEE OR DO ─────────────────────────────────────
// The lists below are the SDK's public surface, and they are mirrored. Change
// one without the others and the grant is silently unusable, or worse, granted
// and undocumented. All of these move together:
//
//   1. here                       SDK_STREAMS / SDK_ACTION_CATEGORIES
//   2. server/js/custom-widget.js the bridge that dispatches, and the
//                                 permission LABEL the user reads
//   3. server/js/settings.js      SDK_WIDGET_STREAMS / SDK_WIDGET_ACTION_CATS,
//                                 which the permission dialog is built from
//   4. server/js/i18n/<code>.js   that label, in all 11 languages
//   5. docs/WIDGET_SDK.md         the capability table — regenerate with
//                                 tools/gen-sdk-reference.mjs (a test fails if
//                                 the generated block goes stale)
//
// The generated block covers the NAMES. It cannot know that a payload gained a
// field or that a setting now changes what a stream carries, so anything of
// that kind is documented by hand and pinned with a test — a promise in the
// guide that nothing enforces is a promise that goes stale. Recent examples to
// copy: section 3c (readings added to `system`), and the note on `agenda`
// saying the Upcoming tile's limits do not filter the stream.

const fs = require('fs');
const path = require('path');
require('./js/deck-actions.js');
require('./js/deck-shortcuts.js'); // nothing is taken from it here, but it runs code when it loads
// A package may declare the SILHOUETTE of its own tile. It goes through the very
// same validator a shared preset does (js/dashboard-instances.js) rather than a
// second copy of the rules here — one boundary, two doors.
require('./js/dashboard-instances.js');

const {
  SDK_API_VERSION, SDK_STREAMS, SDK_ACTION_CATEGORIES, SDK_ACTION_LIMITS, sdkActionWithinLimits,
  SDK_ACTION_TYPES, SDK_MACRO_ACTION_TYPES,
} = require('./widget-sdk/surface.js');

// The only playSound.file shape SDK code (bridge actions AND manifest macros)
// may use — sourced from the authority (sound-packs.js) so the server can
// never drift from the install boundary. The client copies (js/preset-share.js,
// js/custom-widget.js) must be kept in step by hand.
const SDK_SOUND_FILE_RE = require('./sound-packs').PACK_FILE_RE;

const { WIDGET_ID_RE } = require('./widget-sdk/package-names.js');


const {
  WIDGET_CSP, widgetAssetRoot, widgetCspFor, assetCsp,
} = require('./widget-sdk/frame-csp.js');


const { MANIFEST_MAX_BYTES, MAX_PACKAGES, TILE_SIZES } = require('./widget-sdk/manifest-limits.js');


// Proxy request limits (enforced again by the /sdk/fetch handler).
// Every limit a widget can meet lives in sdk-limits/limits.js and reaches it in init.limits.
const { SDK_LIMITS, limitFor } = require('./sdk-limits/limits.js');
const { isPrivateNetworkHost, validateProxyRequest } = require('./widget-sdk/proxy-request.js');

const {
  resolveUserHosts, normalizeKeySuggestion, validateHandlerArgs, macroCategories,
} = require('./widget-sdk/manifest-parts.js');

const { normalizeManifest } = require('./widget-sdk/manifest-normalize.js');

const {
  PERF_PROBE_FILENAME, FRAME_GUARD_FILENAME, FRAME_GUARD_SOURCE, isReservedAsset, injectFrameGuard,
  prepareWidgetHtml, PERF_PROBE_SOURCE, injectPerfProbe,
} = require('./widget-sdk/frame-scripts.js');


const {
  resolveAsset, mimeFor, PAYLOAD_MAX_FILES, PAYLOAD_MAX_FILE_BYTES, PAYLOAD_MAX_TOTAL_BYTES,
  normalizeAssetRelPath, readPackagePayload,
} = require('./widget-sdk/package-assets.js');

// Scan the packages dir. Returns { packages:[manifest…], invalid:[{id,reason}] }.
// Bounded, async, tolerant: a broken folder shows up as invalid with a reason
// (shown under the tile widget picker) instead of hiding or throwing.
async function listPackages(rootDir) {
  const packages = [];
  const invalid = [];
  let skipped = 0;               // real packages past MAX_PACKAGES — see the cap
  let entries = [];
  try {
    entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  } catch {
    return { packages, invalid, skipped };   // dir missing → nothing installed
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    // Past the cap: keep walking, but only to count. Skipping the loop entirely
    // is what made the overflow invisible, and the count costs no disk — the
    // directory entries are already in hand.
    if (packages.length >= MAX_PACKAGES) { skipped++; continue; }
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
  return { packages, invalid, skipped };
}


// Validate an embedded, installable widget package from a shared bundle:
//   { id, files:[{ path, data(base64) }] }
// Returns { ok, id, manifest, files:[{ relPath, bytes:Buffer }] } or
// { ok:false, reason }. SECURITY BOUNDARY, pure: the manifest is rebuilt through
// normalizeManifest (never spread), every file path is re-validated, size/count
// caps are enforced, and both manifest.json and the declared entry must be
// present BEFORE the caller writes a single byte.
function validateWidgetPayload(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'bad_payload' };
  const id = String(raw.id || '').trim();
  if (!WIDGET_ID_RE.test(id)) return { ok: false, reason: 'bad_id' };
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > PAYLOAD_MAX_FILES) return { ok: false, reason: 'bad_files' };
  const seen = new Set();
  const files = [];
  let total = 0;
  let manifestRaw = null;
  for (const f of raw.files) {
    if (!f || typeof f !== 'object') return { ok: false, reason: 'bad_files' };
    const relPath = normalizeAssetRelPath(f.path);
    if (!relPath || seen.has(relPath)) return { ok: false, reason: 'bad_path' };
    // Reserved probe name: drop the file, keep the rest of the bundle valid —
    // resolveAsset would refuse to serve it anyway, this just avoids dead bytes.
    if (isReservedAsset(relPath.split('/').pop())) continue;
    seen.add(relPath);
    let bytes;
    try { bytes = Buffer.from(String(f.data == null ? '' : f.data), 'base64'); } catch { return { ok: false, reason: 'bad_data' }; }
    if (bytes.length > PAYLOAD_MAX_FILE_BYTES) return { ok: false, reason: 'file_too_large' };
    total += bytes.length;
    if (total > PAYLOAD_MAX_TOTAL_BYTES) return { ok: false, reason: 'too_large' };
    if (relPath === 'manifest.json') {
      if (bytes.length > MANIFEST_MAX_BYTES) return { ok: false, reason: 'bad_manifest' };
      try { manifestRaw = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, reason: 'bad_manifest' }; }
    }
    files.push({ relPath, bytes });
  }
  if (!manifestRaw) return { ok: false, reason: 'missing_manifest' };
  const res = normalizeManifest(manifestRaw, id);
  if (!res.ok) return { ok: false, reason: res.reason };
  if (!files.some(f => f.relPath === res.manifest.entry)) return { ok: false, reason: 'missing_entry' };
  return { ok: true, id, manifest: res.manifest, files };
}

const {
  installPackageStaged, mergeOrigin, originExportable, installOverwrite, migrateGrantStorageGroups,
} = require('./widget-sdk/package-install.js');

module.exports = {
  TILE_SIZES,
  SDK_API_VERSION,
  SDK_LIMITS,
  limitFor,
  SDK_STREAMS,
  SDK_ACTION_CATEGORIES,
  SDK_ACTION_TYPES,
  SDK_MACRO_ACTION_TYPES,
  SDK_ACTION_LIMITS,
  sdkActionWithinLimits,
  SDK_SOUND_FILE_RE,      // unit-tested (SDK soundboard file boundary)
  WIDGET_CSP, widgetCspFor, widgetAssetRoot,
  normalizeManifest,
  normalizeKeySuggestion,
  isPrivateNetworkHost,   // unit-tested (proxy allowlist boundary)
  validateProxyRequest,
  resolveUserHosts,       // unit-tested (user-filled host slot boundary)
  macroCategories,
  validateHandlerArgs,    // unit-tested (handler-args coercion boundary)
  resolveAsset,
  mimeFor,
  PERF_PROBE_FILENAME,
  PERF_PROBE_SOURCE,
  injectPerfProbe,        // unit-tested (probe injection is a pure transform)
  FRAME_GUARD_FILENAME,
  FRAME_GUARD_SOURCE,
  isReservedAsset,
  injectFrameGuard,       // unit-tested (must land ahead of every widget script)
  prepareWidgetHtml,
  assetCsp,               // unit-tested (an SVG document runs no scripts)
  listPackages,
  validateWidgetPayload,  // unit-tested (bundle install boundary)
  installPackageStaged,   // unit-tested (the automatic update's swap-and-rollback install)
  readPackagePayload,
  mergeOrigin,            // unit-tested (redistribution policy)
  originExportable,
  installOverwrite,       // unit-tested (writing over an installed id)
  migrateGrantStorageGroups,   // unit-tested (grants that predate the recorded group)
};

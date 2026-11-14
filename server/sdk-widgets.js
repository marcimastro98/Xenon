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
const { validateAction, clampDelay } = require('./js/deck-actions.js');
require('./js/deck-shortcuts.js'); // nothing is taken from it here, but it runs code when it loads
// A package may declare the SILHOUETTE of its own tile. It goes through the very
// same validator a shared preset does (js/dashboard-instances.js) rather than a
// second copy of the rules here — one boundary, two doors.
const { normalizeTileShape, normalizeWidgetIcon } = require('./js/dashboard-instances.js');
const WidgetOptions = require('./widget-options/options.js');

const {
  SDK_API_VERSION, SDK_STREAMS, SDK_ACTION_CATEGORIES, SDK_ACTION_LIMITS, sdkActionWithinLimits,
  SDK_ACTION_TYPES, categoryOfActionType,
} = require('./widget-sdk/surface.js');

// The only playSound.file shape SDK code (bridge actions AND manifest macros)
// may use — sourced from the authority (sound-packs.js) so the server can
// never drift from the install boundary. The client copies (js/preset-share.js,
// js/custom-widget.js) must be kept in step by hand.
const SDK_SOUND_FILE_RE = require('./sound-packs').PACK_FILE_RE;

// A macro runs on the server, where nothing stamps a timer with its widget, so a
// macro step could name the user's own timers. Refused at install instead.
const SDK_MACRO_ACTION_TYPES = Object.freeze(SDK_ACTION_TYPES.filter((type) => !SDK_ACTION_CATEGORIES.timers.includes(type)));

const { WIDGET_ID_RE, SDK_SUB_ID_RE, ENTRY_RE } = require('./widget-sdk/package-names.js');


const {
  WIDGET_CSP, widgetAssetRoot, widgetCspFor, assetCsp,
} = require('./widget-sdk/frame-csp.js');


const {
  MANIFEST_MAX_BYTES, MAX_PACKAGES, MAX_MACROS, MAX_MACRO_STEPS, MAX_STATES, MAX_HANDLERS,
  MAX_MACRO_STEP_DELAY_MS, TILE_SIZES,
} = require('./widget-sdk/manifest-limits.js');


// Proxy request limits (enforced again by the /sdk/fetch handler).
// Every limit a widget can meet lives in sdk-limits/limits.js and reaches it in init.limits.
const { SDK_LIMITS, limitFor } = require('./sdk-limits/limits.js');
const { isPrivateNetworkHost, validateProxyRequest } = require('./widget-sdk/proxy-request.js');

const {
  cleanStr, cleanList, normalizeHosts, normalizeUserHosts, resolveUserHosts, normalizeHooks,
  normalizeHandlerParams, normalizeKeySuggestion, validateHandlerArgs, macroCategories,
} = require('./widget-sdk/manifest-parts.js');

function normalizeDeckExtras(raw, declaredActions) {
  const empty = { actions: [], states: [], handlers: [] };
  if (raw == null) return { ok: true, deck: empty };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const deck = { actions: [], states: [], handlers: [] };
  if (raw.actions != null) {
    if (!Array.isArray(raw.actions) || raw.actions.length > MAX_MACROS) return { ok: false };
    for (const m of raw.actions) {
      if (!m || typeof m !== 'object') return { ok: false };
      const id = typeof m.id === 'string' ? m.id.trim() : '';
      const name = cleanStr(m.name, 40);
      if (!SDK_SUB_ID_RE.test(id) || !name) return { ok: false };
      if (deck.actions.some(a => a.id === id)) return { ok: false };
      if (!Array.isArray(m.steps) || !m.steps.length || m.steps.length > MAX_MACRO_STEPS) return { ok: false };
      const steps = [];
      for (const s of m.steps) {
        const action = validateAction(s && s.action);
        if (!action || !SDK_MACRO_ACTION_TYPES.includes(action.type)) return { ok: false };
        if (!sdkActionWithinLimits(s.action) || !sdkActionWithinLimits(action)) return { ok: false };
        // A macro step may only touch categories the manifest also DECLARES in
        // `actions` — otherwise the user is never asked to grant that category
        // and the macro can never run (macro_unavailable). Fail loud at install.
        const cat = categoryOfActionType(action.type);
        if (!cat || !declaredActions.includes(cat)) return { ok: false };
        // A manifest macro's playSound may only reference an installed sound
        // pack's clip — never an arbitrary local path. Fail loud at install.
        if (action.type === 'playSound' && !SDK_SOUND_FILE_RE.test(String(action.file || ''))) return { ok: false };
        steps.push({ action, delayMs: Math.min(MAX_MACRO_STEP_DELAY_MS, clampDelay(s && s.delayMs)) });
      }
      deck.actions.push({ id, name, steps });
    }
  }
  if (raw.states != null) {
    if (!Array.isArray(raw.states) || raw.states.length > MAX_STATES) return { ok: false };
    for (const st of raw.states) {
      if (!st || typeof st !== 'object') return { ok: false };
      const id = typeof st.id === 'string' ? st.id.trim() : '';
      const name = cleanStr(st.name, 40);
      if (!SDK_SUB_ID_RE.test(id) || !name) return { ok: false };
      if (deck.states.some(a => a.id === id)) return { ok: false };
      deck.states.push({ id, name });
    }
  }
  if (raw.handlers != null) {
    if (!Array.isArray(raw.handlers) || raw.handlers.length > MAX_HANDLERS) return { ok: false };
    for (const h of raw.handlers) {
      if (!h || typeof h !== 'object') return { ok: false };
      const id = typeof h.id === 'string' ? h.id.trim() : '';
      const name = cleanStr(h.name, 40);
      if (!SDK_SUB_ID_RE.test(id) || !name) return { ok: false };
      if (deck.handlers.some(a => a.id === id)) return { ok: false };
      const params = normalizeHandlerParams(h.params);
      if (params === null) return { ok: false };
      const key = normalizeKeySuggestion(h.key);
      deck.handlers.push({ id, name, params, ...(key ? { key: { combo: key.combo } } : {}) });
    }
  }
  return { ok: true, deck };
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
  const actions = cleanList(raw.actions, Object.keys(SDK_ACTION_CATEGORIES), Object.keys(SDK_ACTION_CATEGORIES).length);
  const hosts = normalizeHosts(raw.hosts);
  if (!hosts.ok) return { ok: false, reason: 'bad_hosts' };
  const userHosts = normalizeUserHosts(raw.userHosts);
  if (!userHosts.ok) return { ok: false, reason: 'bad_user_hosts' };
  const hooks = normalizeHooks(raw.hooks);
  if (!hooks.ok) return { ok: false, reason: 'bad_hooks' };
  const deck = normalizeDeckExtras(raw.deck, actions);
  if (!deck.ok) return { ok: false, reason: 'bad_deck' };
  // Persistent storage + secrets (all opt-in, all shown in the permission
  // dialog). `storageGroup` — a shared namespace id several sibling widgets can
  // share — is validated on the package-id charset and IMPLIES `storage`, so a
  // grouped widget never has to declare both. A malformed group id rejects the
  // whole manifest (loud, like hosts/hooks).
  let storageGroup = '';
  if (raw.storageGroup != null) {
    const g = typeof raw.storageGroup === 'string' ? raw.storageGroup.trim() : '';
    if (!SDK_SUB_ID_RE.test(g)) return { ok: false, reason: 'bad_storage_group' };
    storageGroup = g;
  }
  const storage = raw.storage === true || !!storageGroup;
  const secrets = raw.secrets === true;
  // Backward compatible split: `island:true` is the original one-line text
  // projection. A structured object must opt into `dynamic:true`; it receives a
  // separate grant so an old "short text only" approval never silently expands
  // into interactive/takeover UI after a package update.
  const islandObj = !!(raw.island && typeof raw.island === 'object' && !Array.isArray(raw.island));
  const islandDynamic = !!(islandObj && raw.island.dynamic === true);
  // `full:true` asks for the whole Music-style bar rather than the capsule. It
  // is a third, separately consented step for the same reason dynamic was split
  // off the legacy line: taking over the entire top bar is visibly more than
  // replacing the clock, so an existing approval must never grow into it. It
  // implies dynamic — there is no way to fill a bar with the one-line text API.
  const islandFull = !!(islandObj && raw.island.full === true);
  const island = raw.island === true || islandDynamic || islandFull;
  // Same backward-compatible split as `island`: `badge:true` stays the read-only
  // chip it has always been, and an object must opt into `action:true` to become
  // tappable. A chip the user can press is a different promise from a number they
  // can read, so an approval given to the old form must not grow into it.
  const badgeObj = !!(raw.badge && typeof raw.badge === 'object' && !Array.isArray(raw.badge));
  const badgeAction = !!(badgeObj && raw.badge.action === true);
  // Exactly the island's rule: an object alone asks for nothing, so `badge: {}`
  // stays off — only `true` or an object that opts into something turns it on.
  const badge = raw.badge === true || badgeAction;
  // The mini slot: a small host-rendered block in the topbar's button row, drawn
  // with the island's own block vocabulary. A separate capability from `island`
  // on purpose — it is a different place on screen, so the permission dialog has
  // to be able to offer it, and the user to refuse it, on its own.
  const mini = raw.mini === true;
  // A button of the package's own in the top bar, placed, hidden and restyled
  // by the user like the built-in ones (an `sdk:<id>` entry in
  // topbarClock.actions). Its face (glyph + short label) is plain text the host
  // draws; a tap only posts a message to the package's frame.
  const topbarButton = raw.topbarButton === true;
  const clipboard = raw.clipboard === true;
  const accent = raw.accent === true;
  const ai = raw.ai === true;
  // Asking to cover the dashboard. Normalized away for an ambient package: an
  // Ambient scene already owns the whole screen, so the grant would be a
  // permission line that buys the user nothing.
  const expand = raw.expand === true && raw.surface !== 'ambient';
  // The tile's silhouette. Cosmetic and confined to the package's OWN tile, so
  // unlike `accent` (which tints the whole dashboard) it carries no grant — and
  // like every other cosmetic field a malformed one is dropped rather than
  // rejecting the package. An ambient scene already owns the screen, so a shape
  // there would clip nothing meaningful.
  const shape = raw.surface === 'ambient' ? null : normalizeTileShape(raw.shape);
  return {
    ok: true,
    manifest: {
      id: folderId,
      api: SDK_API_VERSION,
      name,
      version: version || '0.0.0',
      author: cleanStr(raw.author, 60),
      description: cleanStr(raw.description, 200),
      // Persistent per-package (or per-group) key/value store, and a write-only
      // secret vault for API keys used via {{secret:NAME}} in proxied requests.
      storage,
      storageGroup,
      secrets,
      // Where the package renders: a dashboard tile (default) or the fullscreen
      // Ambient/screensaver surface. Anything but the exact literal is a tile.
      surface: raw.surface === 'ambient' ? 'ambient' : 'tile',
      // A package may ask to run headless: handlers, badges and structured Live
      // Activities are the capabilities that can meaningfully outlive a tile.
      background: raw.background === true && (deck.deck.handlers.length > 0 || badge || mini || topbarButton || islandDynamic || islandFull),
      // Legacy text projection + the separately-consented structured surfaces.
      // All remain host-rendered and never weaken the widget iframe sandbox.
      island,
      islandDynamic: islandDynamic || islandFull,
      islandFull,
      // The widget may show a small persistent text chip next to the clock, in
      // both topbar chromes — up to a few widgets at once (unlike `island`,
      // which is a single shared slot). Same host-rendered/grant-gated shape.
      badge,
      badgeAction,
      // A small block in the topbar's button row, in the place the USER put it
      // (Settings → Dynamic Island → Bottoni della barra). Host-rendered from the
      // island's block allowlist — never guest DOM, so the chrome never becomes a
      // surface that runs package code.
      mini,
      // Its own button among the bar's buttons (see `topbarButton` above).
      topbarButton,
      // The widget may ask to write to the system clipboard — but only through a
      // host-rendered confirmation the user taps for each copy (the widget never
      // copies on its own). Write-only, no read; enforced entirely host-side in
      // js/custom-widget.js, so there is no server enforcement here.
      clipboard,
      // The widget may ask the AI the user set for Bit (Sparks, their own key,
      // Ollama or their plan) plain questions, through POST /sdk/ai: no tools,
      // no history, a daily number per widget the user chooses. Enforced
      // server-side (grant + this flag) in server.js and sdk-ai.js.
      ai,
      // The widget may tint the dashboard's ACCENT at runtime — the same channel
      // the album-art accent uses, for sources Windows' media session never sees
      // (a Plex/Plexamp client, a game overlay). Runtime only: it never writes a
      // setting, it cannot touch background/surface/text, it follows the user's
      // "album theme" toggle, and it is released the moment the widget goes away.
      // Enforced host-side in js/custom-widget.js, like clipboard.
      accent,
      // The widget may ask to paint its tile over the whole dashboard — the same
      // thing `browserOpen`'s `expand` does for the Browser tile, for a package
      // whose content genuinely needs the room (a board, a map, a game). Like
      // clipboard it is widget-INITIATED but never silent: the host requires a
      // live user gesture, draws its own way out, and collapses on Escape, on a
      // page change and on teardown. Host-side only, so there is no server
      // enforcement here — the grant is what this flag feeds.
      expand,
      // The tile's silhouette (a curated preset id or the package's own path in
      // a unit square). The user's per-tile choice always wins over it: the
      // package proposes, the dashboard's own style editor disposes.
      shape,
      // The package's own glyph for its tab and its "+" result (a 24x24 path,
      // drawn as the built-in icons are). Cosmetic and confined to the package's
      // own entries, so no grant; a malformed one is dropped and the generic
      // puzzle stays, like every other cosmetic field.
      icon: normalizeWidgetIcon(raw.icon),
      // The key the creator suggests for showing or hiding the placed widget
      // (normalizeKeySuggestion): offered, never set. A scene is never placed.
      key: raw.surface === 'ambient' ? null : normalizeKeySuggestion(raw.key),
      // Where the "+" panel files the widget: one of the panel's own categories.
      // Cosmetic like the icon (no grant); anything else is dropped and the panel
      // falls back to the catalog entry's category, then "other".
      category: ['productivity', 'media', 'system', 'streaming'].includes(raw.category) ? raw.category : null,
      // The shape the widget was drawn for, so a new tile of it starts with that
      // shape instead of the default span (js/dashboard-grid.js spanForSize).
      // Cosmetic like the category; anything else is dropped.
      size: TILE_SIZES.includes(raw.size) && raw.surface !== 'ambient' ? raw.size : null,
      // The widget's own choices, set by the person in the Xenon menu's panel of it and
      // handed back in `init.options` (widget-options/). They only shape what the widget
      // draws, so no grant; an entry that is not right is dropped.
      options: raw.surface === 'ambient' ? [] : WidgetOptions.normalizeDeclared(raw.options),
      // On the screen its box takes the size the widget asks for (`layer` message `fit`),
      // so the menu offers no size of its own. Cosmetic, no grant.
      fit: raw.fit === true && raw.surface !== 'ambient',
      entry,
      streams: cleanList(raw.streams, SDK_STREAMS, SDK_STREAMS.length),
      actions,
      hosts: hosts.hosts,
      // Blanks the user fills in at approval time; the values live in the grant,
      // never in the package. resolveUserHosts turns the two into the extra
      // hosts this package may reach.
      userHosts: userHosts.userHosts,
      hooks: hooks.hooks,
      deck: deck.deck,
    },
  };
}

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

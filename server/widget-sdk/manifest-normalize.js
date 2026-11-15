'use strict';
// A package's manifest rebuilt key by key, never spread: every field checked and clamped, the
// Deck extras (macros, states, handlers) among them, with the reason when the manifest is
// refused.

const { validateAction, clampDelay } = require('../js/deck-actions.js');
// A package may declare the SILHOUETTE of its own tile. It goes through the very
// same validator a shared preset does (js/dashboard-instances.js) rather than a
// second copy of the rules here — one boundary, two doors.
const { normalizeTileShape, normalizeWidgetIcon } = require('../js/dashboard-instances.js');
const WidgetOptions = require('../widget-options/options.js');
const {
  SDK_API_VERSION, SDK_STREAMS, SDK_ACTION_CATEGORIES, sdkActionWithinLimits,
  SDK_MACRO_ACTION_TYPES, categoryOfActionType,
} = require('./surface.js');
const SDK_SOUND_FILE_RE = require('../store-catalog/sound-packs.js').PACK_FILE_RE;
const { WIDGET_ID_RE, SDK_SUB_ID_RE, ENTRY_RE } = require('./package-names.js');
const {
  MAX_MACROS, MAX_MACRO_STEPS, MAX_STATES, MAX_HANDLERS, MAX_MACRO_STEP_DELAY_MS, TILE_SIZES,
} = require('./manifest-limits.js');
const {
  cleanStr, cleanList, normalizeHosts, normalizeUserHosts, normalizeHooks, normalizeHandlerParams,
  normalizeKeySuggestion,
} = require('./manifest-parts.js');

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

module.exports = { normalizeDeckExtras, normalizeManifest };

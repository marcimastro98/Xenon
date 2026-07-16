'use strict';
// Deck widget runtime: loads per-instance config, renders the key grid with
// Option-B navigation chrome (back + crumb + page index + arrows/dots), and
// handles folder/page navigation. Keys are visual-only in this phase — wiring
// real action execution arrives in a later phase.
(function () {
  const STORE_KEY = 'deck.config.v1';        // { [instanceId]: fullDeckConfig } — each instance owns its config
  const DIRTY_KEY = 'deck.dirty.v1';         // outbox: { [instanceId | '__presets']: seq } — local changes not yet acked by the server
  const PRESETS_KEY = 'deck.presets.v1';     // saved profile presets [{ id, name, profile }]
  const KEYPRESETS_KEY = 'deck.keypresets.v1'; // saved single-key presets [{ id, name, key }]
  const LEGACY_REV_KEYS = ['deck.config.rev', 'deck.config.instrev'];   // pre-outbox client counters — cleared at boot
  // Per-instance size ceiling for a saved config, kept well under the server's 8 MB
  // /deck-config accept limit (server.js DECK_MAX_BYTES). A single oversized instance
  // would be rejected with 413 and the outbox would retry the identical body forever,
  // blocking every other deck edit — so reject the edit up front with clear feedback.
  // Realistic decks are a few hundred KB; this only trips on many large image/GIF caps
  // (e.g. a big GIF applied to a whole page).
  const DECK_INSTANCE_MAX_BYTES = 4 * 1024 * 1024;
  const nav = new Map();                      // instanceId -> { path:[], pageIndex }
  const deckBase = () => (typeof SERVER !== 'undefined' ? SERVER : '');
  let deckFlushTimer = null;                  // debounced outbox flush handle
  let deckFlushToken = 0;                     // identifies the live flush; a newer flush supersedes an in-flight retry chain
  let deckDirtySeq = 0;                       // monotonic seq for outbox entries (ack matching)
  let lastServerRev = 0;                      // newest server-assigned store rev we've seen (GET ack / POST ack / SSE)

  // Latest known live state; key nodes bound via data-state-bound reflect it.
  const stateSnapshot = { micMuted: false, speakerMuted: false, obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, remoteConnected: false, remoteActive: false, sbGlobals: {}, sdkStates: {}, sdkStateMeta: {}, discordMuted: false, discordDeafened: false, mediaPlaying: false, mediaSource: '', haStates: {}, timers: {}, masterVolume: NaN, discordInputVolume: NaN, discordOutputVolume: NaN };
  // Latest OBS program-scene thumbnail; painted onto one host key by applyScenePreview.
  let scenePreview = { scene: '', image: '' };
  let obsToastTimer = null;   // auto-dismiss timer for the "OBS pronto" toast
  const resizeObservers = new Map();   // instanceId -> { cancel() } (auto-fit grid teardown)
  const firstPaintFits = new Map();    // instanceId -> rAF id (deferred first-paint auto-fit)
  // Display-only auto-fit overrides: instanceId -> fitted config. Auto-fit adapts
  // the grid to the tile size for RENDERING only; it must never write to the
  // durable store, bump the rev, or back up to the server. Persisting a boot-time
  // (often transient) measurement is what made the saved grid drift — different
  // column/row counts on every restart, reshuffling the keys. The durable config
  // changes solely on genuine user edits; auto-fit lives here, in memory, and is
  // recomputed each session. Promoted to durable when the user edits on top of it.
  const displayConfigs = new Map();    // instanceId -> fitted config (render-only)
  // Edit-mode auto-fit state: the edit toolbar/footer shrink the well, so the
  // edit grid is fitted against the EDIT well (measured after paint, cached
  // here) — caps keep their live, touch-comfortable size and the ROW count
  // adapts, instead of scaling the full live grid into a half-height well.
  const editWellSizes = new Map();     // instanceId -> { w, h } (edit-mode well)
  const editFits = new Map();          // instanceId -> pending rAF id

  const tr = (k, fb) => (typeof t === 'function' ? t(k) : (fb != null ? fb : k));
  // Inline SVGs for the docked now-playing transport (mirrors the chat mini-player).
  const NP_SVG = {
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6V6Zm3.5 6 8.5 6V6l-8.5 6Z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2V6ZM6 18l8.5-6L6 6v12Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z"/></svg>',
  };
  // Speaker glyphs for the Standby screen (mirrors the Volume panel icons): the
  // idle screen shows the active output device + its volume instead of going blank.
  const SPK_SVG = {
    on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02ZM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77 0-4.28-2.99-7.86-7-8.77Z"/></svg>',
    off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63Zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71ZM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3ZM12 4 9.91 6.09 12 8.18V4Z"/></svg>',
  };
  // Faceplate icons: pencil (edit) and check (done).
  const EDIT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
  const DONE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z"/></svg>';
  // Bookmark glyph: "save this profile as a reusable preset".
  const SAVE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v16l9-4 9 4V5a2 2 0 0 0-2-2Z"/></svg>';
  const SHARE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 1 0-3-3c0 .24.04.47.09.7L8.04 9.81A2.99 2.99 0 0 0 3 12a3 3 0 0 0 5.04 2.19l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.92Z"/></svg>';
  function keyMinFor(cfg) {
    const sizes = (window.DeckModel && window.DeckModel.KEY_SIZES) || { sm: 56, md: 76, lg: 104 };
    return sizes[cfg.keySize] || sizes.md || 76;
  }
  function deckLookFor(cfg, profileId) {
    const M = window.DeckModel;
    if (M && typeof M.effectiveDeckLook === 'function') return M.effectiveDeckLook(cfg, profileId);
    return { capStyle: cfg.capStyle, keyShape: cfg.keyShape, plate: cfg.plate, wellImage: cfg.wellImage, mediaStyle: cfg.mediaStyle };
  }
  // True while the dashboard Layout editor is open. The deck must NOT auto-fit its
  // key grid then: the tile is mid-resize (GridStack hasn't applied its final cell
  // height yet, and the user is actively dragging the corner), so measuring it now
  // would compact the deck to a sliver and re-rendering mid-drag fights GridStack's
  // resize. We let it settle once editing ends (the ResizeObserver re-fits then).
  function isLayoutEditing() {
    return typeof document !== 'undefined' && document.body && document.body.classList.contains('layout-editing');
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }
  // Effective DURABLE config for an instance: its OWN stored config, normalized.
  // Each Deck instance owns its full config (grid + profiles + keys + view prefs),
  // so an unknown/empty instance returns a blank deck — a newly added Deck tile
  // starts empty instead of inheriting another deck's keys. Bypasses the render-only
  // auto-fit override (use getConfig for the rendered grid).
  function durableConfig(instanceId, all) {
    return window.DeckStore.instanceConfig(window.DeckModel, all || readStore(), instanceId);
  }
  function getConfig(instanceId) {
    // A live auto-fit override (render grid adapted to the tile) takes precedence
    // over the durable store, so edits act on exactly the grid the user sees and
    // promote it to durable on save.
    if (displayConfigs.has(instanceId)) return displayConfigs.get(instanceId);
    return durableConfig(instanceId);
  }
  // ── Outbox (linear persistence) ───────────────────────────────────
  // The SERVER owns the deck store and assigns every revision. The client never
  // pushes the whole blob: every local change marks just the touched instance (or
  // the preset lists, sentinel DeckStore.PRESETS_ID) dirty here, and the flush
  // sends precise ops ({t:'set'|'del'|'presets'}) until the server acks them.
  // A stale open dashboard therefore has an EMPTY outbox and can never overwrite
  // or delete decks it didn't just touch — the failure mode that kept reverting a
  // key edit (and once wiped a second deck) after a reboot. The map persists in
  // localStorage so an unsent edit survives a reload (not a WebView storage wipe —
  // nothing can survive that if the change never reached the server).
  function readDirty() {
    try { const o = JSON.parse(localStorage.getItem(DIRTY_KEY)); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
    catch { return {}; }
  }
  function writeDirty(map) {
    try {
      if (Object.keys(map).length) localStorage.setItem(DIRTY_KEY, JSON.stringify(map));
      else localStorage.removeItem(DIRTY_KEY);
    } catch { /* quota */ }
  }
  function markDirty(id) {
    const map = readDirty();
    // Seqs from a previous page life may be ahead of our in-memory counter.
    for (const k of Object.keys(map)) { if (Number.isFinite(map[k]) && map[k] > deckDirtySeq) deckDirtySeq = map[k]; }
    map[id] = ++deckDirtySeq;
    writeDirty(map);
    queueDeckFlush();
  }
  function saveConfig(instanceId, config) {
    // Was the grid the user just edited an auto-fit OVERRIDE — a render-only reshape
    // of this instance's canonical grid to fit THIS tile? If so, its column/row count
    // is a per-tile artifact, not a user choice, so we fold the edit back onto the
    // instance's own canonical grid: reshapeDeckConfig preserves linear slot order,
    // so the edited key keeps its position and the saved grid never drifts. The manual
    // cols/rows steppers only exist with auto-fit OFF (no override present), so a
    // deliberate grid change still passes straight through.
    const hadFitOverride = displayConfigs.has(instanceId);
    const M = window.DeckModel;
    let cfg = M.normalizeDeckConfig(config);
    // Reject an oversized edit before it can poison the outbox (see
    // DECK_INSTANCE_MAX_BYTES): keep the previous config and tell the user, rather
    // than silently looping a 413 and losing this and every later deck edit.
    let serialized = '';
    try { serialized = JSON.stringify(cfg); } catch { serialized = ''; }
    if (serialized.length > DECK_INSTANCE_MAX_BYTES) {
      if (typeof showHubToast === 'function') {
        showHubToast('Xenon', tr('deck_too_large_title', 'Deck troppo grande'), tr('deck_too_large', 'Le immagini di questo Deck superano il limite. Riduci o rimuovi qualche immagine dei tasti.'));
      }
      return false;
    }
    displayConfigs.delete(instanceId);
    let all = readStore();
    if (hadFitOverride) {
      const prev = window.DeckStore.instanceConfig(M, all, instanceId);
      if (cfg.cols !== prev.cols || cfg.rows !== prev.rows) {
        cfg = M.reshapeDeckConfig(cfg, prev.cols, prev.rows, { preserve: true });
      }
    }
    // Each Deck owns its full config (grid + profiles + keys + view prefs); writing
    // it under the instance's own key keeps decks independent — editing one never
    // touches another.
    all = window.DeckStore.writeInstanceConfig(M, all, instanceId, cfg);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota: keep in-memory render */ }
    markDirty(instanceId);   // outbox → flushed to the server as a precise 'set' op until acked
  }
  // One-time migration from the v3.0 shared-library model to independent decks:
  // give each existing instance its own snapshot of the library (so nothing on
  // screen disappears on upgrade) and drop the library key. Runs at boot and again
  // after a server hydrate restores a pre-migration copy. Idempotent: a no-op once
  // the library is gone (see DeckStore.migrateStore).
  function migrateDeckLibrary() {
    const { store, changed } = window.DeckStore.migrateStore(window.DeckModel, readStore());
    if (!changed) return false;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* quota */ }
    for (const id of Object.keys(store)) markDirty(id);   // the split rewrote every instance
    return true;
  }
  // Render-only persistence for auto-fit reshapes: holds the fitted grid in memory
  // for getConfig/render WITHOUT touching the store, the rev, or the server backup.
  // This is the fix for the grid drifting (and keys reshuffling) on every restart.
  function saveConfigDisplay(instanceId, config) {
    displayConfigs.set(instanceId, config);
  }

  // Total placed keys across every profile/page of a stored config. 0 = empty.
  // On any parse error returns 1 (treat as non-empty so cleanup never drops it).
  function countConfigKeys(rawConfig) {
    try {
      const cfg = window.DeckModel.normalizeDeckConfig(rawConfig);
      let n = 0;
      const walk = (folder) => {
        for (const page of folder.pages) {
          n += page.keys.filter(Boolean).length;
          for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) walk(k.folder);
        }
      };
      for (const prof of cfg.profiles) walk(prof.root);
      return n;
    } catch { return 1; }
  }

  // Permanently drop a COPY instance's stored config — called when a deck copy is
  // removed from the layout (a page delete, or the tile's ✕). Guarded to '~'-suffixed
  // copies so the user's primary 'deck' can never be wiped through this path.
  function forgetInstance(instanceId) {
    const id = String(instanceId || '');
    if (id.indexOf('~') < 0) return;        // only copies; never the base deck
    closeDeckStyleModal();                  // don't leave a portaled modal for a gone deck
    displayConfigs.delete(id);
    editWellSizes.delete(id);
    const all = readStore();
    if (!(id in all)) return;
    delete all[id];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota */ }
    const o = resizeObservers.get(id);
    if (o) { o.cancel(); resizeObservers.delete(id); }   // drop this copy's auto-fit observer
    markDirty(id);   // absent locally → flushes as an explicit 'del' op
  }

  // One-shot cleanup of cruft from older removals that didn't forget the config:
  // remove stored configs for COPY instances that are no longer in the layout AND
  // hold no keys. Empty + orphaned = nothing to lose. The base 'deck' and any copy
  // that still has keys are NEVER touched (data is surfaced, not silently deleted).
  let _prunedOrphans = false;
  function pruneOrphanEmptyConfigs() {
    if (_prunedOrphans) return;
    try {
      if (typeof getDashboardLayout !== 'function') return;
      const layout = getDashboardLayout();
      if (!layout || !Array.isArray(layout.copies)) return;   // layout not ready yet
      _prunedOrphans = true;
      const live = new Set(layout.copies.map((c) => c && c.id).filter(Boolean));
      const all = readStore();
      const removed = [];
      for (const id of Object.keys(all)) {
        if (id.indexOf('~') < 0) continue;          // never the primary 'deck'
        if (live.has(id)) continue;                 // still placed
        if (countConfigKeys(all[id]) > 0) continue; // has keys → keep, don't lose data
        delete all[id]; removed.push(id);
      }
      if (removed.length) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota */ }
        for (const id of removed) markDirty(id);    // flush each as an explicit 'del' op
      }
    } catch { /* never break boot over cleanup */ }
  }

  // ── Profile presets (save a profile, reuse it on any deck) ────────
  // A preset is { id, name, profile, createdAt } where `profile` is a DeckModel
  // profile object. Stored locally and backed up to the server alongside the
  // configs (it rides the same rev / last-writer-wins).
  function readPresets() {
    try { const a = JSON.parse(localStorage.getItem(PRESETS_KEY)); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function writePresets(list) {
    const safe = Array.isArray(list) ? list.slice(0, 60) : [];
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(safe)); } catch { /* quota */ }
    markDirty(window.DeckStore.PRESETS_ID);   // both preset lists travel in one 'presets' op
  }
  function listProfilePresets() { return readPresets(); }
  function deleteProfilePreset(id) {
    writePresets(readPresets().filter(p => p.id !== id));
    if (window.forgetInstalledContentResource) window.forgetInstalledContentResource('deckPresetIds', id);
  }
  // Save profile `profileId` of `instanceId` as a named preset (prompts for a name).
  function saveProfileAsPreset(instanceId, profileId, defName) {
    const profile = window.DeckModel.getProfile(getConfig(instanceId), profileId);
    if (!profile) return;
    const suggested = defName || profile.name || tr('deck_profile_default', 'Profilo');
    const name = (typeof prompt === 'function') ? prompt(tr('preset_name_prompt', 'Nome del preset:'), suggested) : suggested;
    if (name === null) return;  // cancelled
    const list = readPresets().slice();
    list.push({ id: 'dp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: String(name || '').trim() || suggested, profile, createdAt: Date.now() });
    writePresets(list);
  }
  // Insert preset `presetId` as a new profile on `instanceId` (fresh id, reshaped
  // to that deck's grid) and make it active.
  function insertProfilePreset(instanceId, presetId) {
    const ps = readPresets().find(p => p.id === presetId);
    if (!ps) return;
    saveConfig(instanceId, window.DeckModel.addProfileFromTemplate(getConfig(instanceId), ps.profile));
  }

  // ── Reuse profiles across independent decks ───────────────────────
  // Count placed keys in a single profile's tree (0 = empty placeholder).
  function countProfileKeys(prof) {
    try {
      let n = 0;
      const walk = (folder) => {
        for (const page of folder.pages) {
          n += page.keys.filter(Boolean).length;
          for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) walk(k.folder);
        }
      };
      walk(prof.root);
      return n;
    } catch { return 0; }
  }
  // The deck instances that actually exist on the dashboard right now: the base
  // 'deck' plus any copy still placed in the layout. A removed deck tile can leave
  // its config behind (a copy that missed forgetInstance), and its profiles then
  // leaked into the profile/share pickers as "ghosts" — this is the gate that keeps
  // them out. Returns null when the layout isn't known yet, so nothing live is ever
  // hidden (fail-open).
  function liveInstanceSet() {
    try {
      if (typeof getDashboardLayout !== 'function') return null;
      const layout = getDashboardLayout();
      if (!layout || !Array.isArray(layout.copies)) return null;
      return new Set(layout.copies.map((c) => c && c.id).filter(Boolean));
    } catch { return null; }
  }
  function isLiveInstance(id, live) {
    if (String(id).indexOf('~') < 0) return true;   // the primary 'deck' is always live
    return live ? live.has(id) : true;              // unknown layout → treat as live
  }
  // Stored COPY configs no longer placed anywhere on the dashboard — leftovers from
  // removed deck tiles. Empty [] when the layout isn't known (never guess).
  function listOrphanInstances() {
    const live = liveInstanceSet();
    if (!live) return [];
    return Object.keys(readStore()).filter((id) => id.indexOf('~') >= 0 && !live.has(id));
  }
  // Drop every orphaned copy config at once (each flushes an explicit 'del' op, so
  // the server store is pruned too). Returns how many were removed.
  function purgeOrphanInstances() {
    const orphans = listOrphanInstances();
    orphans.forEach((id) => forgetInstance(id));
    return orphans.length;
  }
  // Profiles that live on OTHER deck instances, offered in the profile menu as one-tap
  // "copy into this deck" sources — so a newly added (independent) deck can pull in a
  // profile already built elsewhere without first saving it as a preset. Deduped by
  // name against this deck and across decks; empty placeholder profiles are skipped.
  // Returns [{ instanceId, profileId, name }].
  function listOtherDeckProfiles(instanceId) {
    const M = window.DeckModel;
    const all = readStore();
    const mine = new Set((durableConfig(instanceId, all).profiles || []).map(p => String(p.name || '').toLowerCase()));
    const seen = new Set();
    const out = [];
    const live = liveInstanceSet();
    for (const otherId of Object.keys(all)) {
      if (otherId === instanceId) continue;
      if (!isLiveInstance(otherId, live)) continue;   // hide profiles from removed decks
      let cfg; try { cfg = M.normalizeDeckConfig(all[otherId]); } catch { continue; }
      for (const prof of (cfg.profiles || [])) {
        const key = String(prof.name || '').toLowerCase();
        if (!key || mine.has(key) || seen.has(key)) continue;
        if (countProfileKeys(prof) === 0) continue; // skip empty placeholders
        seen.add(key);
        out.push({ instanceId: otherId, profileId: prof.id, name: prof.name });
      }
    }
    return out;
  }
  // Copy profile `profileId` from `sourceInstanceId` into `targetInstanceId` as a new
  // profile (fresh id, reshaped to the target grid) and make it active. A COPY — the
  // decks stay independent, exactly like inserting a preset.
  function copyDeckProfileInto(targetInstanceId, sourceInstanceId, profileId) {
    const M = window.DeckModel;
    let cfg; try { cfg = M.normalizeDeckConfig(readStore()[sourceInstanceId]); } catch { return; }
    const prof = (cfg.profiles || []).find(p => p.id === profileId);
    if (!prof) return;
    saveConfig(targetInstanceId, M.addProfileFromTemplate(getConfig(targetInstanceId), prof));
  }

  // ── Shared-profile bridge (PresetShare) ───────────────────────────
  // The deck tiles currently on the dashboard, as import targets.
  function listDeckTargets() {
    return deckInstances().map(({ instanceId }, i) => {
      const cfg = getConfig(instanceId);
      return { instanceId, label: 'Deck ' + (i + 1), profiles: cfg.profiles.length };
    });
  }
  // Every non-empty profile across every stored deck (for the share picker).
  function listAllDeckProfiles() {
    const M = window.DeckModel;
    const all = readStore();
    const out = [];
    const live = liveInstanceSet();
    for (const id of Object.keys(all)) {
      if (!isLiveInstance(id, live)) continue;   // never surface a removed deck's profiles
      let cfg; try { cfg = M.normalizeDeckConfig(all[id]); } catch { continue; }
      for (const prof of (cfg.profiles || [])) {
        const keys = countProfileKeys(prof);
        if (keys > 0) out.push({ instanceId: id, profileId: prof.id, name: prof.name, keys, imported: prof.imported === true, installId: prof.installId || '' });
      }
    }
    return out;
  }
  // Deep-cloned profile object for export (PresetShare sanitizes + encodes it).
  function getProfileTemplate(instanceId, profileId) {
    const cfg = durableConfig(instanceId);
    const M = window.DeckModel;
    const prof = M.getProfile(cfg, profileId);
    if (!prof) return prof;
    // Snapshot the effective presentation so importing this profile never depends
    // on the receiver's Deck defaults. Imported third-party artwork stays home.
    const clone = JSON.parse(JSON.stringify(prof));
    const effective = M.effectiveDeckLook(cfg, profileId);
    clone.look = {
      capStyle: effective.capStyle,
      keyShape: effective.keyShape,
      plate: effective.plate,
      wellImage: (effective.wellImage && effective.wellImage.imported !== true) ? effective.wellImage : null,
      mediaStyle: (effective.mediaStyle && effective.mediaStyle.imported !== true) ? effective.mediaStyle : null,
    };
    return clone;
  }
  // Land an imported (already-sanitized) shared profile: as a new profile on
  // `instanceId` (fresh id, grid grown to fit, becomes active — the exact
  // "copy from another deck" path), or into the profile-preset library when no
  // deck tile is on the dashboard, so the import is never a dead end.
  function importSharedProfile(instanceId, profile, installId) {
    if (!profile || typeof profile !== 'object') return { ok: false };
    // Someone else's work: mark it so exports can refuse to redistribute it.
    // normalizeProfile preserves the flag; sanitizeDeckProfile strips it on export.
    const look = (profile.look && typeof profile.look === 'object') ? Object.assign({}, profile.look) : null;
    if (look) {
      // Third-party artwork provenance is profile-local: it blocks redistribution
      // without leaking the imported look into sibling profiles.
      if (look.wellImage) look.wellImage = Object.assign({}, look.wellImage, { imported: true });
      if (look.mediaStyle) look.mediaStyle = Object.assign({}, look.mediaStyle, { imported: true });
    }
    const marked = Object.assign({}, profile, { imported: true, look });
    if (/^xi_[a-z0-9]{8,32}$/.test(String(installId || ''))) marked.installId = String(installId);
    const inst = deckInstances().find(d => d.instanceId === instanceId);
    if (inst) {
      const cfg = window.DeckModel.addProfileFromTemplate(getConfig(instanceId), marked);
      saveConfig(instanceId, cfg);
      const state = navOf(instanceId);
      state.path = []; state.pageIndex = 0;
      render(inst.tile, instanceId);
      return { ok: true, added: true, instanceId, profileId: cfg.activeProfile };
    }
    const list = readPresets().slice();
    const presetId = 'dp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    list.push({
      id: presetId,
      name: String(marked.name || '').trim() || 'Profile',
      profile: marked, createdAt: Date.now(), installId: marked.installId || undefined,
    });
    writePresets(list);
    return { ok: true, savedAsPreset: true, presetId };
  }

  // Imported resource inventory + receipt-checked removal used by the content
  // manager. A missing/old receipt may only touch legacy `imported` entries;
  // a normal receipt must match the profile/preset installId exactly.
  function listImportedResources() {
    const profiles = [];
    const M = window.DeckModel;
    const all = readStore();
    for (const instanceId of Object.keys(all)) {
      let cfg; try { cfg = M.normalizeDeckConfig(all[instanceId]); } catch { continue; }
      for (const profile of (cfg.profiles || [])) {
        if (profile.imported === true) profiles.push({ instanceId, profileId: profile.id, installId: profile.installId || '' });
      }
    }
    const presets = readPresets()
      .filter(p => p && p.profile && p.profile.imported === true)
      .map(p => ({ presetId: p.id, installId: p.installId || p.profile.installId || '' }));
    return { profiles, presets };
  }

  function removeImportedResources(resources, installId, legacy) {
    const refs = Array.isArray(resources && resources.deckProfiles) ? resources.deckProfiles : [];
    const presetIds = new Set(Array.isArray(resources && resources.deckPresetIds) ? resources.deckPresetIds : []);
    const isOwner = (item) => legacy === true
      ? item && item.imported === true && !item.installId
      : item && item.installId === installId;
    let removed = 0;
    const all = readStore();
    for (const ref of refs) {
      if (!ref || !all[ref.instanceId]) continue;
      let cfg; try { cfg = window.DeckModel.normalizeDeckConfig(all[ref.instanceId]); } catch { continue; }
      const target = cfg.profiles.find(p => p.id === ref.profileId);
      if (!isOwner(target)) continue;
      if (cfg.profiles.length <= 1) cfg = window.DeckModel.addProfile(cfg, tr('deck_profile_default', 'Profile'));
      cfg = window.DeckModel.removeProfile(cfg, target.id);
      saveConfig(ref.instanceId, cfg);
      removed++;
    }
    const before = readPresets();
    const after = before.filter((p) => {
      if (!presetIds.has(p.id)) return true;
      const owner = Object.assign({}, p.profile || {}, { installId: p.installId || (p.profile && p.profile.installId) || '' });
      return !isOwner(owner);
    });
    if (after.length !== before.length) {
      removed += before.length - after.length;
      writePresets(after);
    }
    if (removed) renderAll();
    return removed;
  }

  // ── Single-key presets (save one key, reuse on any slot) ──────────
  function readKeyPresets() {
    try { const a = JSON.parse(localStorage.getItem(KEYPRESETS_KEY)); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function writeKeyPresets(list) {
    const safe = Array.isArray(list) ? list.slice(0, 120) : [];
    try { localStorage.setItem(KEYPRESETS_KEY, JSON.stringify(safe)); } catch { /* quota */ }
    markDirty(window.DeckStore.PRESETS_ID);   // both preset lists travel in one 'presets' op
  }
  function listKeyPresets() { return readKeyPresets(); }
  function deleteKeyPreset(id) { writeKeyPresets(readKeyPresets().filter(p => p.id !== id)); }
  // Save a raw key object (built by the key editor) as a named preset. Prompts for
  // a name (defaults to the key's title). Called from DeckEditor via window.Deck.
  function saveKeyPreset(keyObj, defName) {
    if (!keyObj || typeof keyObj !== 'object') return;
    const suggested = defName || keyObj.title || tr('deck_edit_name', 'Tasto');
    const name = (typeof prompt === 'function') ? prompt(tr('preset_name_prompt', 'Nome del preset:'), suggested) : suggested;
    if (name === null) return;  // cancelled
    const list = readKeyPresets().slice();
    list.push({ id: 'dk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: String(name || '').trim() || suggested, key: keyObj, createdAt: Date.now() });
    writeKeyPresets(list);
  }

  // ── Outbox flush + server adoption ────────────────────────────────
  // Sends the dirty entries as precise ops and clears each one only when the
  // server acks it AND no newer edit re-marked it while the POST was in flight.
  // Retries with capped backoff for as long as the page lives (the dirty data is
  // already safe in localStorage) — a one-shot save to a server mid-restart is
  // exactly what silently lost a key edit before.
  function buildOutboxOps() {
    return window.DeckStore.buildDeckOps(Object.keys(readDirty()), readStore(), readPresets(), readKeyPresets());
  }
  function flushDeckOutbox(token, attempt) {
    if (token !== deckFlushToken) return;            // superseded by a newer flush
    const map = readDirty();
    const ids = Object.keys(map);
    if (!ids.length) return;
    const taken = {}; for (const id of ids) taken[id] = map[id];   // seqs this attempt carries
    const ops = window.DeckStore.buildDeckOps(ids, readStore(), readPresets(), readKeyPresets());
    // NO keepalive here: this flush runs while the page is alive (it's debounced
    // 250ms after the edit), so it doesn't need to outlive an unload — and keepalive
    // caps the request body at 64KB across the whole page. A deck config carries
    // base64 image icons (one instance is easily ~56KB; several dirty at once exceed
    // 64KB), so a keepalive POST would throw "Failed to fetch" and retry forever,
    // and the edit would NEVER reach the server (it only showed locally). The
    // pagehide beacon below keeps keepalive for the unload case; the retry loop and
    // the boot re-flush cover anything that doesn't land in time.
    fetch(deckBase() + '/deck-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops }),
    })
      .then((res) => {
        // 413 = the body exceeds the server's size cap. Retrying the identical payload
        // can never succeed, so mark it fatal and stop the loop below instead of
        // hammering forever (which would also block every other pending deck edit).
        if (res.status === 413) { const e = new Error('deck-config too large'); e.fatal = true; throw e; }
        if (!res.ok) throw new Error('deck-config ' + res.status);
        return res.json().catch(() => null);
      })
      .then((data) => {
        const cur = readDirty();
        for (const id of ids) { if (cur[id] === taken[id]) delete cur[id]; }
        writeDirty(cur);
        if (data && Number.isFinite(data.rev)) lastServerRev = Math.max(lastServerRev, data.rev);
        if (Object.keys(cur).length) queueDeckFlush();   // something re-dirtied mid-flight — go again
      })
      .catch((err) => {
        if (token !== deckFlushToken) return;
        if (err && err.fatal) {
          // Leave the ops dirty (still cached locally + rendered) so a later, smaller
          // edit re-flushes them, but stop retrying and surface the reason.
          if (typeof showHubToast === 'function') {
            showHubToast('Xenon', tr('deck_too_large_title', 'Deck troppo grande'), tr('deck_too_large', 'Le immagini di questo Deck superano il limite. Riduci o rimuovi qualche immagine dei tasti.'));
          }
          return;
        }
        setTimeout(() => flushDeckOutbox(token, attempt + 1), Math.min(800 * Math.pow(2, attempt), 10000));
      });
  }
  function queueDeckFlush() {
    clearTimeout(deckFlushTimer);
    const token = ++deckFlushToken;
    deckFlushTimer = setTimeout(() => { deckFlushTimer = null; flushDeckOutbox(token, 0); }, 250);
  }
  // Flush on tab hide / shutdown so a change made just before a restart still
  // reaches disk (mirrors the notes + settings beacons). Sends only the unsent
  // outbox — never the whole blob. The dirty entries stay in localStorage (a
  // beacon has no response to ack against); re-sending them later is idempotent.
  function sendDeckBeacon() {
    try {
      const ops = buildOutboxOps();
      if (!ops.length) return;   // everything already acked — nothing to flush
      const body = JSON.stringify({ ops });
      // sendBeacon refuses bodies over its ~64KB queue limit (returns false), and a
      // deck op carries base64 image icons that can exceed it. When it refuses, fall
      // back to a PLAIN fetch (no keepalive — keepalive would re-impose the same 64KB
      // cap). On unload it's best-effort, but the debounced flush has normally already
      // delivered the edit; this just covers an edit made moments before the close.
      if (navigator.sendBeacon && navigator.sendBeacon(deckBase() + '/deck-config', new Blob([body], { type: 'application/json' }))) return;
      fetch(deckBase() + '/deck-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
    } catch { /* nothing else to try */ }
  }
  // Adopt the server copy — the single source of truth. Every instance the local
  // outbox is NOT holding an unsent edit for takes the server's content (including
  // deletions: a local-only instance with no pending edit was removed elsewhere).
  // Dirty instances keep the local copy and stay queued until the server acks them.
  // One guard: a COMPLETELY empty server store never overwrites local data — that's
  // server-side data loss (a fresh/lost deck.json), so we restore it from the local
  // cache instead of blanking the user's decks.
  function adoptServerDeck(data) {
    const serverConfigs = (data.configs && typeof data.configs === 'object' && !Array.isArray(data.configs)) ? data.configs : {};
    const serverPresets = Array.isArray(data.presets) ? data.presets.slice(0, 60) : [];
    const serverKeyPresets = Array.isArray(data.keyPresets) ? data.keyPresets.slice(0, 120) : [];
    const local = readStore();
    const dirty = readDirty();
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    const serverEmpty = !Object.keys(serverConfigs).length && !serverPresets.length && !serverKeyPresets.length;
    const localHasData = Object.keys(local).length > 0 || readPresets().length > 0 || readKeyPresets().length > 0;
    if (serverEmpty && localHasData) {
      for (const id of Object.keys(local)) markDirty(id);
      if (readPresets().length || readKeyPresets().length) markDirty(window.DeckStore.PRESETS_ID);
      lastServerRev = Math.max(lastServerRev, Number.isFinite(data.rev) ? data.rev : 0);
      return;
    }

    const next = {};
    for (const id of Object.keys(serverConfigs)) {
      next[id] = (has(dirty, id) && has(local, id)) ? local[id] : serverConfigs[id];
    }
    for (const id of Object.keys(dirty)) {   // unsent local creations absent from the server
      if (id === window.DeckStore.PRESETS_ID) continue;
      if (!has(next, id) && has(local, id)) next[id] = local[id];
    }
    const changed = JSON.stringify(next) !== JSON.stringify(local);
    if (changed) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* quota */ }
    }
    if (!has(dirty, window.DeckStore.PRESETS_ID)) {
      try { localStorage.setItem(PRESETS_KEY, JSON.stringify(serverPresets)); } catch { /* quota */ }
      try { localStorage.setItem(KEYPRESETS_KEY, JSON.stringify(serverKeyPresets)); } catch { /* quota */ }
    }
    lastServerRev = Math.max(lastServerRev, Number.isFinite(data.rev) ? data.rev : 0);
    if (changed) {
      migrateDeckLibrary();     // a restored copy may still carry the v3.0 shared library → split it
      displayConfigs.clear();   // drop any pre-hydrate auto-fit so the grid re-fits from the adopted config
      renderAll();
    }
    if (Object.keys(readDirty()).length) queueDeckFlush();   // keep pushing whatever is still unsent
  }
  async function hydrateDeckFromServer(attempt = 0) {
    const MAX_HYDRATE_ATTEMPTS = 6;   // ~13s of backoff total — covers a slow Node cold-start
    try {
      const res = await fetch(deckBase() + '/deck-config', { cache: 'no-store' });
      if (!res.ok) throw new Error('deck-config ' + res.status);
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') return;
      adoptServerDeck(data);
    } catch {
      // Right after a PC cold boot the WebView can load the dashboard before Node
      // has finished starting, so this fetch fails. The server copy is the ONLY
      // source of the keys when the WebView wiped its localStorage on restart, so a
      // single failed fetch would leave the Deck blank until a manual refresh (the
      // reported symptom). Retry a few times with backoff until the server answers.
      if (attempt < MAX_HYDRATE_ATTEMPTS) {
        setTimeout(() => hydrateDeckFromServer(attempt + 1), 500 + attempt * 700);
      }
    }
  }
  // SSE 'deck' event: another client saved a change. Re-sync unless we've already
  // seen this rev (our own POST ack advances lastServerRev, so own writes no-op).
  function onServerDeckRev(rev) {
    if (!Number.isFinite(rev) || rev <= lastServerRev) return;
    hydrateDeckFromServer();
  }
  // Actions whose effect lives in the browser (e.g. Xenon AI) run here and never
  // reach the server allowlist. Everything else POSTs to /actions/run.
  function runClientAction(action) {
    if (action.type === 'ai') {
      const mode = action.mode || 'prompt';
      if (mode === 'voice') { if (window.startVoiceSession) window.startVoiceSession(); return true; }
      // 'open': reveal the AI text chat. In v3.0 it lives in the media tile's Chat
      // tab (the voice overlay holds only the orb), so openMediaChat() — not the
      // empty overlay — is the right target. Fall back to the overlay if absent.
      if (mode === 'open')  {
        if (window.openMediaChat) { window.openMediaChat(); return true; }
        if (window.openAiPanel) window.openAiPanel();
        return true;
      }
      // 'prompt': reveal the chat tab and post the configured question as a chat
      // message (shows the Q + the written answer; no voice). Prefer aiAsk; fall
      // back to revealing the chat + injecting the text, for any older ai.js build.
      if (window.aiAsk) { window.aiAsk(action.prompt); return true; }
      if (window.openMediaChat) window.openMediaChat();
      else if (window.openAiPanel) window.openAiPanel();
      const aiInput = document.getElementById('ai-text-input');
      if (aiInput && window.aiSendText && action.prompt) { aiInput.value = action.prompt; window.aiSendText(); }
      return true;
    }
    // Open the live per-app volume mixer overlay (touch faders) — a browser-side UI.
    if (action.type === 'appMixer') { openDeckMixer(); return true; }
    return false;
  }
  // Soundboard playback lives in the browser — a Chromium <audio> element handles
  // mp3/wav/ogg natively, async, with no lingering OS processes. The server only
  // streams the (allowlisted, by extension) local file at /deck/sound. One element
  // is cached per file so 'stop'/'toggle' can act on the same playing instance.
  const _deckSounds = new Map();
  // Stop every playing soundboard clip at once (the panic key).
  function stopAllDeckSounds() {
    for (const a of _deckSounds.values()) { a.pause(); a.currentTime = 0; }
    return true;
  }
  function playDeckSound(action) {
    const file = String(action.file || '').trim();
    const mode = action.mode || 'play';
    let a = _deckSounds.get(file);
    if (mode === 'stop') { if (a) { a.pause(); a.currentTime = 0; } return Promise.resolve(true); }
    if (!file) return Promise.resolve(false);        // nothing configured → flash so it's not a silent no-op
    if (mode === 'toggle' && a && !a.paused) { a.pause(); a.currentTime = 0; return Promise.resolve(true); }
    if (!a) { a = new Audio('/deck/sound?path=' + encodeURIComponent(file)); _deckSounds.set(file, a); }
    else { a.currentTime = 0; }
    // Optional per-clip volume (0–100; absent/invalid = full volume). The empty
    // string must NOT reach Number() — Number('') is 0 and would mute the clip.
    const rawVol = action.volume == null ? '' : String(action.volume).trim();
    const vol = rawVol === '' ? NaN : Number(rawVol.replace(',', '.'));
    a.volume = (Number.isFinite(vol) && vol >= 0 && vol <= 100) ? vol / 100 : 1;
    // Resolve true once playback actually starts, false if the file can't load/play
    // (missing file, bad codec) — surfacing the failure as the key's error flash.
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; a.removeEventListener('playing', onPlay); a.removeEventListener('error', onErr); resolve(ok); };
      const onPlay = () => finish(true);
      const onErr = () => finish(false);
      a.addEventListener('playing', onPlay, { once: true });
      a.addEventListener('error', onErr, { once: true });
      a.play().then(() => finish(true)).catch(() => finish(false));
    });
  }
  // Shared player handle for other host modules: custom-widget.js dispatches an
  // SDK widget's granted soundboard actions here (pack-relative clips only —
  // the caller gates the file shape). Same element cache, same panic stop.
  window.DeckSoundPlayer = { play: playDeckSound, stopAll: stopAllDeckSounds };
  // Returns true on success, false on a real failure (so the key can flash an
  // error). A missing/handled-client action counts as success — nothing failed.
  async function runAction(action) {
    if (!action) return true;
    if (action.type === 'playSound') return playDeckSound(action);   // browser-played soundboard
    if (action.type === 'soundStopAll') return stopAllDeckSounds();  // stop every playing clip
    if (runClientAction(action)) return true;
    try {
      const res = await fetch('/actions/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action),
      });
      const data = await res.json().catch(() => null);
      return !!(data && data.ok);   // the dispatcher reports {ok:false,error} for e.g. a missing path / OBS offline
    } catch (e) { return false; }
  }
  // Briefly flash a key red to surface a failed action (path not found, OBS
  // offline, …) — actions must not fail silently.
  function flashError(node) {
    if (!node) return;
    node.classList.remove('has-error');
    void node.offsetWidth;          // restart the animation if it's still mid-flash
    node.classList.add('has-error');
    setTimeout(() => node.classList.remove('has-error'), 600);
  }
  // Build the lighting action for a key's reaction: set colour/effect when `on`,
  // else restore the lights to normal. Returns null when the key has no reaction.
  function lightingAction(light, on) {
    if (!light || !light.color) return null;
    return on
      ? { type: 'lighting', mode: 'set', color: light.color, style: light.style || 'solid' }
      : { type: 'lighting', mode: 'restore' };
  }
  // Run a trigger's steps in order, pausing delayMs before each. A single action
  // is one zero-delay step. Sequencing/delays are client-side; each step POSTs.
  async function runTrigger(trigger) {
    const steps = window.DeckActions.triggerSteps(trigger);
    let ok = true;
    for (const step of steps) {
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (!(await runAction(step.action))) ok = false;   // run every step; report if any failed
    }
    return ok;
  }
  // Visual press feedback for ANY key node (action, folder, or edit-mode): the key
  // visibly depresses while held so a tap always looks like a real button click —
  // independent of whether a gesture/action is configured. A minimum hold keeps a
  // quick tap visible, and inline styles guarantee it regardless of CSS cascade.
  function bindPressFeedback(node) {
    if (!node || node._pressBound) return;
    node._pressBound = true;
    const PRESS_MIN_MS = 90;
    let pressedAt = 0, unpressTimer = null;
    const press = () => {
      if (unpressTimer) { clearTimeout(unpressTimer); unpressTimer = null; }
      node.classList.add('is-pressed');
      // Depression on the way down: deep enough to read clearly on the touchscreen,
      // but with a soft ease-out so it still feels fluid (the "real" feel comes from
      // the springy release below, not from making the motion tiny).
      node.style.transition = 'transform .11s cubic-bezier(.33,0,.2,1), filter .11s ease';
      node.style.transform = 'translateY(2px) scale(.92)';
      node.style.filter = 'brightness(.86)';
      pressedAt = Date.now();
    };
    const release = () => {
      const wait = Math.max(0, PRESS_MIN_MS - (Date.now() - pressedAt));
      if (unpressTimer) clearTimeout(unpressTimer);
      unpressTimer = setTimeout(() => {
        node.classList.remove('is-pressed');
        // Springy, fluid pop back to rest — a slight overshoot makes it feel real.
        node.style.transition = 'transform .34s cubic-bezier(.34,1.5,.5,1), filter .22s ease';
        node.style.transform = '';
        node.style.filter = '';
        // Specular glint: a light band sweeps across the glass as the cap springs
        // back (one-shot; CSS keeps it off under perf-mode / reduced-motion).
        node.classList.remove('is-glint');
        void node.offsetWidth;              // restart the sweep on rapid taps
        node.classList.add('is-glint');
        // Hand the transition back to the stylesheet once the spring has settled.
        const clear = () => { node.style.transition = ''; node.removeEventListener('transitionend', clear); };
        node.addEventListener('transitionend', clear);
        unpressTimer = null;
      }, wait);
    };
    node.addEventListener('pointerdown', (e) => { if (!(e.button != null && e.button > 0)) press(); });
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('pointerleave', release);
    node.addEventListener('animationend', (e) => {
      if (e.animationName === 'deck-key-glint') node.classList.remove('is-glint');
    });
  }

  // The three PERSISTENT (latching) tap effects: pressing the key toggles them on and
  // they stay until the next press — held depressed, blinking in a loop, or dark.
  const LATCH_CLS = { stay: 'fx-hold', flash: 'fx-blink', off: 'fx-dark' };

  // Apply (or clear) a key's persistent-effect class. Latch membership lives on the
  // per-instance nav state so it survives grid re-renders (media/state updates).
  function setLatch(node, key, state, on) {
    if (!state.latched) state.latched = new Set();
    node.classList.remove('fx-hold', 'fx-blink', 'fx-dark');
    const cls = LATCH_CLS[key.press];
    if (on && cls) { node.classList.add(cls); state.latched.add(key.id); }
    else state.latched.delete(key.id);
  }

  // Tap feedback when a key fires: persistent effects (stay/flash/off) toggle their
  // latch; 'glow' plays its one-shot accent pulse; 'press' is the bare tactile depress.
  function fireFeedback(node, key, state) {
    const fx = key.press || 'glow';
    if (LATCH_CLS[fx]) { setLatch(node, key, state, !(state.latched && state.latched.has(key.id))); return; }
    if (fx === 'press') return;                 // depress only
    node.classList.remove('is-running');
    void node.offsetWidth;                      // reflow so the pulse restarts on rapid taps
    node.classList.add('is-running');           // 'glow'
  }

  // ── Touch faders (slider keys) ─────────────────────────────────────────
  // Map a slider key's target + a 0–100 value to the registry action it drives.
  function sliderAction(slider, value) {
    const v = String(value);
    switch (slider.target) {
      case 'volume':        return { type: 'volume', mode: 'set', value: v };
      case 'appVolume':     return { type: 'appVolume', app: slider.app, mode: 'set', value: v };
      case 'spotifyVolume': return { type: 'spotifyVolume', mode: 'set', value: v };
      case 'obsInput':      return { type: 'obsInputVolume', source: slider.source, value: v };
      case 'haLight':       return { type: 'haLight', entity: slider.entity, mode: 'brightness', value: v };
      case 'discordInput':  return { type: 'discordInputVol', mode: 'set', value: v };
      case 'discordOutput': return { type: 'discordOutputVol', mode: 'set', value: v };
      default: return null;
    }
  }

  function paintSlider(node, pct) {
    const clamped = Math.min(100, Math.max(0, Math.round(pct)));
    if (clamped === node._sliderValue) return;   // no repaint when the rounded value didn't move
    const fill = node.querySelector('.deck-slider-fill');
    const badge = node.querySelector('.deck-key-live');
    if (fill) fill.style[node.dataset.orient === 'h' ? 'width' : 'height'] = clamped + '%';
    if (badge) badge.textContent = clamped + '%';
    node._sliderValue = clamped;
  }

  // Pointer protocol: capture on the key so the pager's swipe handler never
  // sees the gesture; `data-deck-dragging` on the deck root is the belt-and-
  // braces flag other touch handlers early-return on. Dispatch is throttled to
  // one /actions/run per 100ms during the drag, plus one final on release.
  function bindSliderKey(node, key) {
    const slider = key.slider;
    let dragging = false, lastSent = 0, pendingTimer = null, pendingValue = null;
    const send = (value, force) => {
      const action = sliderAction(slider, value);
      if (!action) return;
      const now = Date.now();
      if (!force && now - lastSent < 100) {
        pendingValue = value;
        if (!pendingTimer) pendingTimer = setTimeout(() => { pendingTimer = null; if (pendingValue != null) { const v = pendingValue; pendingValue = null; send(v, true); } }, 100 - (now - lastSent));
        return;
      }
      lastSent = now;
      runAction(action).then((ok) => { if (!ok) flashError(node); });
    };
    // The rect is cached for the whole drag — pointer capture is held, so the
    // key can't move/resize mid-gesture and a per-move getBoundingClientRect
    // would only force layout at touch-sample rate.
    let dragRect = null;
    const pctFromEvent = (e) => {
      const r = dragRect || node.getBoundingClientRect();
      if (node.dataset.orient === 'h') return ((e.clientX - r.left) / Math.max(1, r.width)) * 100;
      return (1 - (e.clientY - r.top) / Math.max(1, r.height)) * 100;   // vertical: bottom = 0
    };
    node.addEventListener('pointerdown', (e) => {
      dragging = true;
      node.setPointerCapture(e.pointerId);
      e.stopPropagation();
      const rootEl = node.closest('.deck-root');
      if (rootEl) rootEl.setAttribute('data-deck-dragging', '1');
      dragRect = node.getBoundingClientRect();
      const pct = pctFromEvent(e);
      paintSlider(node, pct);
      send(node._sliderValue);
    });
    node.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.stopPropagation();
      const prev = node._sliderValue;
      paintSlider(node, pctFromEvent(e));
      if (node._sliderValue !== prev) send(node._sliderValue);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      dragRect = null;
      const rootEl = node.closest('.deck-root');
      if (rootEl) rootEl.removeAttribute('data-deck-dragging');
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; pendingValue = null; }
      send(node._sliderValue, true);   // final authoritative value
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    // Seed from the current snapshot so the fader doesn't paint at 0; targets
    // with no live feed start centred (the first drag takes over from there).
    const seed = sliderLiveValue(slider);
    paintSlider(node, seed !== null ? seed : 50);
  }

  // Current live value for a slider's target from the state snapshot (0–100),
  // or null when the target has NO live feed (per-app/Spotify/OBS volumes
  // aren't broadcast) — null means "leave the fader where the user put it"
  // instead of faking a value and snapping their drag back.
  function sliderLiveValue(slider) {
    switch (slider.target) {
      case 'volume':        return Number.isFinite(stateSnapshot.masterVolume) ? stateSnapshot.masterVolume : null;
      case 'haLight': {
        const entry = slider.entity && stateSnapshot.haStates ? stateSnapshot.haStates[slider.entity] : null;
        if (!entry) return null;
        if (typeof entry.brightness === 'number') return Math.round((entry.brightness / 255) * 100);
        return entry.state === 'on' ? 100 : 0;
      }
      case 'discordInput':  return Number.isFinite(stateSnapshot.discordInputVolume) ? stateSnapshot.discordInputVolume : null;
      case 'discordOutput': return Number.isFinite(stateSnapshot.discordOutputVolume) ? Math.min(100, stateSnapshot.discordOutputVolume) : null;
      default: return null;   // appVolume / spotifyVolume / obsInput: write-only targets
    }
  }

  // Reposition idle sliders when live values arrive (never mid-drag, and never
  // for write-only targets — their fader keeps the last dragged position).
  function applySliderValues() {
    document.querySelectorAll('.deck-key.is-slider').forEach((node) => {
      if (!node._deckSlider) return;
      const rootEl = node.closest('.deck-root');
      if (rootEl && rootEl.hasAttribute('data-deck-dragging')) return;
      const live = sliderLiveValue(node._deckSlider);
      if (live !== null) paintSlider(node, live);
    });
  }

  // Bind tap / double-tap / press-and-hold on an action key node. Each gesture
  // fires the matching trigger (if configured). Busy guard = no reentrancy.
  function bindActionKey(node, key, state) {
    bindPressFeedback(node);                  // universal click depression
    const triggers = key.triggers || {};
    const hasDouble = !!triggers.double;
    const hasHold = !!triggers.hold;
    let holdTimer = null, tapTimer = null, holdFired = false;
    const HOLD_MS = 500, DOUBLE_MS = 260;

    function fire(which) {
      const trig = triggers[which];
      if (!trig || node.dataset.busy) return;
      node.dataset.busy = '1';
      // Tap feedback: persistent effects toggle their latch; 'glow' plays its pulse to
      // completion regardless of how fast the action resolves. (Previously the class
      // was removed in .finally(), so a quick action cut the flash before it showed.)
      fireFeedback(node, key, state);
      // One-shot LED reaction: light up immediately on press, in parallel with the
      // action (state-mode reactions are handled on state edges in applyKeyStates).
      if (key.light && key.light.when === 'press') runAction(lightingAction(key.light, true));
      runTrigger(trig)
        .then((ok) => { if (!ok) flashError(node); })
        .finally(() => { delete node.dataset.busy; });
    }
    function clearTimers() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }

    node.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;       // primary button / touch only
      holdFired = false;
      if (hasHold) holdTimer = setTimeout(() => {
        holdFired = true;
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        fire('hold');
      }, HOLD_MS);
    });
    node.addEventListener('pointerup', () => {
      clearTimers();
      if (holdFired) return;                               // hold already handled this press
      if (!hasDouble) { fire('tap'); return; }
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; fire('double'); }
      else tapTimer = setTimeout(() => { tapTimer = null; fire('tap'); }, DOUBLE_MS);
    });
    node.addEventListener('pointercancel', clearTimers);
    node.addEventListener('pointerleave', clearTimers);
    // The run pulse is fixed-duration: clear it when the animation ends, not when the
    // action resolves, so even an instant action shows a full confirmation flash.
    node.addEventListener('animationend', (e) => {
      if (e.animationName === 'deck-key-run') node.classList.remove('is-running');
    });
  }

  // Edit-mode interactions for a PLACED key: a quick-delete badge, drag-to-reorder
  // (drop on another slot to swap; drop on an empty slot to move there), and a plain
  // tap to open the editor. A small movement threshold separates a tap from a drag.
  function bindEditKey(tile, instanceId, navCtx, slotIndex, key, node) {
    bindPressFeedback(node);

    // Quick-delete badge (top-left). Its own pointerdown is swallowed so it never
    // starts a drag or the cap's press depression.
    const del = el('button', 'deck-key-del');
    del.type = 'button';
    del.title = tr('deck_edit_delete', 'Elimina');
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6 18 18M18 6 6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      saveConfig(instanceId, window.DeckModel.setKeyAt(getConfig(instanceId), navCtx, slotIndex, null));
      render(tile, instanceId);
    });
    node.appendChild(del);

    const THRESH = 7;
    let pid = null, downX = 0, downY = 0, dragging = false, moved = false, clone = null, ox = 0, oy = 0;

    const slotUnder = (x, y) => {
      for (const elx of document.elementsFromPoint(x, y)) {
        const k = elx.closest && elx.closest('.deck-key');
        if (k && k.dataset.slot != null && tile.contains(k)) return k;
      }
      return null;
    };
    const clearDrop = () => tile.querySelectorAll('.deck-key.is-drop').forEach((n) => n.classList.remove('is-drop'));
    // The drag clone is appended to <body>, which on the Xeneon Edge sits inside an
    // <html> with CSS `zoom` applied (fractional-DPR compensation). `zoom` magnifies
    // a descendant's inline px, so client-space coordinates (clientX/Y, getBoundingClientRect)
    // must be divided by the zoom factor when written to the clone, or it drifts away
    // from the finger. On desktop (zoom = 1) this is a no-op.
    const zoom = () => (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
    const startDrag = (e) => {
      dragging = true;
      node.classList.add('is-dragging');
      const r = node.getBoundingClientRect();
      const z = zoom();
      ox = e.clientX - r.left; oy = e.clientY - r.top;          // offset stays in client space
      clone = node.cloneNode(true);
      clone.classList.add('deck-drag-clone');
      clone.classList.remove('is-editing', 'is-dragging');
      const cdel = clone.querySelector('.deck-key-del'); if (cdel) cdel.remove();
      // Body-level clone: re-supply the deck-scoped sizing vars (the cell edge = the
      // node's width) and the resolved radius so it matches outside the deck subtree.
      // Sizes/positions are divided by the zoom so the magnified inline px land right.
      clone.style.setProperty('--deck-cell', (r.width / z) + 'px');
      clone.style.setProperty('--deck-key-min', (r.width / z) + 'px');
      clone.style.borderRadius = getComputedStyle(node).borderRadius;
      Object.assign(clone.style, { position: 'fixed', left: (r.left / z) + 'px', top: (r.top / z) + 'px', width: (r.width / z) + 'px', height: (r.height / z) + 'px', margin: '0' });
      document.body.appendChild(clone);
      try { node.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    };
    const moveClone = (e) => {
      const z = zoom();
      clone.style.left = ((e.clientX - ox) / z) + 'px';
      clone.style.top = ((e.clientY - oy) / z) + 'px';
      clearDrop();
      const tgt = slotUnder(e.clientX, e.clientY);
      if (tgt && tgt !== node) tgt.classList.add('is-drop');
    };
    const endDrag = (e) => {
      if (clone) { clone.remove(); clone = null; }
      clearDrop();
      node.classList.remove('is-dragging');
      if (!dragging) return;
      dragging = false;
      const tgt = slotUnder(e.clientX, e.clientY);
      const to = tgt ? parseInt(tgt.dataset.slot, 10) : NaN;
      if (Number.isInteger(to) && to !== slotIndex) {
        saveConfig(instanceId, window.DeckModel.swapKeysAt(getConfig(instanceId), navCtx, slotIndex, to));
      }
      render(tile, instanceId);   // rebuild (also clears any transient drag state)
    };

    node.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      pid = e.pointerId; downX = e.clientX; downY = e.clientY; moved = false;
    });
    node.addEventListener('pointermove', (e) => {
      if (pid == null || e.pointerId !== pid) return;
      if (!dragging && (Math.abs(e.clientX - downX) > THRESH || Math.abs(e.clientY - downY) > THRESH)) {
        moved = true; startDrag(e);
      }
      if (dragging) { e.preventDefault(); e.stopPropagation(); moveClone(e); }   // also blocks the pager swipe
    });
    const up = (e) => { if (pid != null && e.pointerId === pid) { endDrag(e); pid = null; } };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);

    node.addEventListener('click', (e) => {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; return; }
      openEditor(tile, instanceId, navCtx, slotIndex, key);
    });
  }

  function navOf(instanceId) {
    if (!nav.has(instanceId)) nav.set(instanceId, { path: [], pageIndex: 0, editing: false });
    return nav.get(instanceId);
  }

  const el = makeEl; // shared DOM factory from utils.js

  // Only allow image icons from schemes that cannot run script: remote images,
  // inline data images, and object URLs. Anything else falls back to a glyph.
  function safeIconSrc(value) {
    const v = String(value || '').trim();
    return (/^https?:\/\//i.test(v) || /^data:image\//i.test(v) || /^blob:/i.test(v)) ? v : '';
  }

  // The OBS "role" a key plays, from its trigger actions: 'scene' (set scene OR
  // cycle next), 'record', 'stream', or null. Used to pick which key hosts the
  // live scene thumbnail. obsSceneNext has no state binding, so this marker is
  // the only way to recognise a cycle scene key.
  function obsRoleOf(key) {
    if (!key || key.kind !== 'action' || !key.triggers || !window.DeckActions) return null;
    const types = [];
    ['tap', 'double', 'hold'].forEach((tr) => {
      const steps = window.DeckActions.triggerSteps(key.triggers[tr]);
      if (steps[0] && steps[0].action) types.push(steps[0].action.type);
    });
    if (types.some((t) => t === 'obsScene' || t === 'obsSceneNext')) return 'scene';
    if (types.includes('obsRecord')) return 'record';
    if (types.includes('obsStream')) return 'stream';
    return null;
  }

  function renderKey(key) {
    if (!key) {
      return el('div', 'deck-key is-empty');
    }
    const btn = el('div', 'deck-key' + (key.kind === 'folder' ? ' is-folder' : '') + (key.kind === 'slider' ? ' is-slider' : ''));
    btn.dataset.keyId = key.id;
    if (key.press) btn.dataset.press = key.press;   // tap-feedback effect (read by fire)
    if (key.pressColor) btn.style.setProperty('--fx-color', key.pressColor);   // effect colour
    if (key.bg) {
      // Drive the cap's accent via a CSS var so the LCD bevel + rim glow compose
      // around the colour (instead of a flat fill). key.bg is validated hex upstream.
      btn.classList.add('has-accent');
      btn.style.setProperty('--key-accent', key.bg);
      if (key.bg2) {
        // Two-colour face: CSS blends accent → accent2 along the chosen direction.
        btn.classList.add('has-gradient');
        btn.style.setProperty('--key-accent2', key.bg2);
        btn.dataset.grad = key.bgDir || 'd';
      }
    }
    // Backdrop picture: a layer UNDER the icon/label (unlike an icon of type
    // 'image', which IS the face). --key-dim drives its legibility scrim; when
    // the key also has an accent, the scrim tints so the photo reads as backlit.
    if (key.bgImage && key.bgImage.value) {
      const bgSrc = safeIconSrc(key.bgImage.value);
      if (bgSrc) {
        btn.classList.add('has-bgimg');
        btn.style.setProperty('--key-dim', String((key.bgImage.dim == null ? 35 : key.bgImage.dim) / 100));
        if (key.bgImage.blur) { btn.classList.add('has-bgblur'); btn.style.setProperty('--key-blur', key.bgImage.blur + 'px'); }
        const wrap = el('div', 'deck-key-bgimg');
        const bgImg = document.createElement('img');
        bgImg.src = bgSrc; bgImg.alt = '';
        wrap.appendChild(bgImg);
        btn.appendChild(wrap);
      }
    }
    // Ambient cap animation: a dedicated layer so the motion stays on cheap
    // opacity/transform (never repainting the whole cap). Paused by perf-mode.
    if (key.anim && key.anim !== 'none') {
      btn.classList.add('anim-' + key.anim);
      btn.appendChild(el('div', 'deck-key-anim'));
    }
    const ico = el('div', 'deck-ico');
    if (key.iconColor) ico.style.color = key.iconColor;     // tints builtin SVGs + glyphs (currentColor)
    if (key.iconSize) btn.dataset.icosize = key.iconSize;
    const iconType = key.icon && key.icon.type;
    const iconSrc = iconType === 'image' ? safeIconSrc(key.icon.value) : '';
    const builtinSvg = iconType === 'builtin' && window.DeckIcons && window.DeckIcons.has(key.icon.value)
      ? window.DeckIcons.el(key.icon.value) : null;
    if (iconSrc) {
      const img = document.createElement('img');
      img.src = iconSrc; img.alt = '';
      ico.appendChild(img);
      // Image fit: 'cover' = full-bleed (label gets a readable scrim), 'contain' =
      // whole picture with padding, 'small' = a compact centred icon with the title
      // below (rendered like a normal glyph — no full-bleed).
      const fit = (key.icon && key.icon.fit) || 'cover';
      if (fit === 'small') { ico.classList.add('is-img-small'); }
      else { btn.classList.add('has-image'); if (fit === 'contain') btn.classList.add('fit-contain'); }
    } else if (builtinSvg) {
      ico.classList.add('is-builtin');
      ico.appendChild(builtinSvg);
    } else {
      // Emoji (or an unrecognised builtin id, which we don't print as raw text).
      ico.textContent = (iconType === 'emoji' && key.icon && key.icon.value) || (key.kind === 'folder' ? '📁' : '■');
    }
    btn.appendChild(ico);
    const label = el('div', 'deck-label', key.title || '');
    if (key.labelColor) label.style.color = key.labelColor;
    if (key.labelBold) label.classList.add('is-bold');
    if (key.labelPos) btn.dataset.labelpos = key.labelPos;   // 'top' | 'hidden' (bottom = default)
    if (key.labelSize) btn.dataset.labelsize = key.labelSize;
    btn.appendChild(label);
    if (key.state && key.state.source) {
      btn._deckState = key.state;                  // full state (carries scene/input params)
      btn.dataset.stateBound = '1';
      btn.dataset.stateKind = key.state.source;     // state marker (kept for introspection; no default visual)
      // Alternate face while ON (toggle keys): the base face nodes are kept on
      // the node so applyStateStyle can swap and restore them losslessly.
      if (key.stateStyle) {
        btn._deckStateStyle = key.stateStyle;
        btn._ssBase = { ico, labelEl: label, labelText: key.title || '', accent: key.bg || '', iconFrag: null };
        btn._ssApplied = false;
      }
      if (window.DeckModel.evaluateKeyState(key.state, stateSnapshot)) {
        btn.classList.add('is-on');
        applyStateStyle(btn, true);
      }
    }
    // Touch fader: a track + fill layer the pointer drags. The value bubble
    // reuses the live-badge element; live SSE values reposition the fill when
    // the user isn't dragging (see applySliderValues).
    if (key.kind === 'slider' && key.slider) {
      btn._deckSlider = key.slider;
      btn.dataset.slider = key.slider.target;
      btn.dataset.orient = key.slider.orient || 'v';
      if (key.slider.target === 'haLight' && key.slider.entity) btn.dataset.haEntity = key.slider.entity;
      const track = el('div', 'deck-slider');
      track.appendChild(el('div', 'deck-slider-fill'));
      btn.appendChild(track);
      btn.appendChild(el('div', 'deck-key-live'));
      btn.classList.add('has-live');
    }
    // Live value badge (timer countdown / SDK widget state text) — painted via
    // textContent only; updated by applyLiveFaces + the self-stopping ticker.
    if (key.kind === 'action' && key.live && key.live.source) {
      btn._deckLive = key.live;
      btn.dataset.liveBound = '1';
      const liveEl = el('div', 'deck-key-live');
      btn.appendChild(liveEl);
      paintLiveFace(btn);
    }
    if (key.light) btn._deckLight = key.light;       // LED reaction config read at runtime
    const obsRole = obsRoleOf(key);                  // mark OBS keys so one can host the scene thumbnail
    if (obsRole) btn.dataset.obsRole = obsRole;
    // Hint, in a bottom corner, that this key has extra gestures beyond a plain
    // tap: a "double" marker (two dots) and/or a "hold" marker (a bar).
    const trg = key.triggers || {};
    if (key.kind === 'action' && (trg.double || trg.hold)) {
      const ind = el('div', 'deck-key-trig');
      if (trg.double) ind.appendChild(el('i', 'tind tind-double'));
      if (trg.hold) ind.appendChild(el('i', 'tind tind-hold'));
      btn.appendChild(ind);
    }
    return btn;
  }

  // Build a single, non-interactive key cap for the editor's live preview. The raw
  // key is run through the SAME normalization as persistence (so the preview shows
  // exactly what will be saved), then rendered with renderKey. `look` carries the
  // deck-level cap theme + shape so the preview matches the device it belongs to.
  // Returns a `.deck-root` wrapper (which the cap-style/shape CSS selectors need).
  function renderKeyPreview(rawKey, look) {
    const M = window.DeckModel;
    let key = null;
    try {
      const c = M.normalizeDeckConfig({ cols: 1, rows: 1, profiles: [{ id: 'p', name: 'P', root: { pages: [{ keys: [rawKey] }] } }], activeProfile: 'p' });
      key = c.profiles[0].root.pages[0].keys[0];
    } catch { key = null; }
    const root = el('div', 'deck-root deck-ed-preview-root');
    root.dataset.capstyle = (look && look.capStyle) || 'lcd';
    root.dataset.shape = (look && look.keyShape) || 'rounded';
    root.appendChild(renderKey(key));   // pure visual node (no interaction bound)
    return root;
  }

  function crumbLabel(cfg, state) {
    // The crumb names the profile being SHOWN (a Smart-Profiles auto-switch may
    // temporarily differ from the persisted activeProfile).
    const shownId = (state.volatileProfile && cfg.profiles.some((p) => p.id === state.volatileProfile))
      ? state.volatileProfile : cfg.activeProfile;
    const profile = cfg.profiles.find(p => p.id === shownId) || cfg.profiles[0];
    if (!state.path.length) return profile.name;
    let folder = profile.root, title = profile.name;
    for (const id of state.path) {
      let found = null;
      for (const page of folder.pages) { const k = page.keys.find(key => key && key.kind === 'folder' && key.id === id); if (k) { found = k; break; } }
      if (!found) break;
      title = found.title || title; folder = found.folder;
    }
    return title;
  }

  // Edit-mode toolbar: key-size segmented control, auto-fit toggle, manual grid
  // steppers (only when auto-fit is off), and a now-playing dock toggle. Each
  // control mutates the persisted config and re-renders.
  // Downscale a picked decoration image (shared rasterToCanvas core, utils.js)
  // to a data: URL for the deck config. Small GIFs are kept byte-identical so
  // they keep animating — same trick as the key-image reader.
  async function deckDecorImageToDataUrl(file, maxEdge) {
    if (!file) return '';
    if (file.type === 'image/gif' && file.size <= 1024 * 1024) return fileToDataUrl(file);
    const cv = await rasterToCanvas(file, maxEdge);
    if (!cv) return '';
    try { return cv.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85); }
    catch { return ''; }
  }

  function buildTools(tile, instanceId, cfg, profileId) {
    const tools = el('div', 'deck-tools');
    // The inline toolbar keeps only the structural grid controls (size, fit,
    // cols/rows, media). The whole-device LOOK (theme/shape/plate) and the
    // background/music styling live in a dedicated modal with a live preview —
    // opened by the "Customize" button below — so this bar stays uncluttered.
    const rowLayout = el('div', 'deck-tools-row');
    tools.appendChild(rowLayout);

    const sizeGrp = el('div', 'deck-tools-grp');
    sizeGrp.appendChild(el('span', 'deck-tools-cap', tr('deck_keysize', 'Tasti')));
    const seg = el('div', 'deck-seg');
    [['sm', tr('deck_keysize_sm', 'S')], ['md', tr('deck_keysize_md', 'M')], ['lg', tr('deck_keysize_lg', 'L')]].forEach(([val, label]) => {
      const b = el('button', cfg.keySize === val ? 'active' : '', label); b.type = 'button';
      b.addEventListener('click', () => {
        if (cfg.keySize === val) return;
        const next = applyAutoGrid(tile, instanceId, Object.assign({}, getConfig(instanceId), { keySize: val }));
        saveConfig(instanceId, next);
        render(tile, instanceId);
      });
      seg.appendChild(b);
    });
    sizeGrp.appendChild(seg);
    rowLayout.appendChild(sizeGrp);

    const fit = el('button', 'deck-pill' + (cfg.autoFit ? ' on' : ''), tr('deck_autofit', 'Auto')); fit.type = 'button';
    fit.addEventListener('click', () => {
      // Toggle the per-instance flag only; do NOT bake the current tile fit into the
      // durable grid. Turning auto-fit ON lets render() fit the DISPLAY next frame
      // (render-only); turning it OFF reveals the canonical saved grid as-is. Baking
      // the fit here is what seeded the cross-instance grid drift.
      const next = Object.assign({}, getConfig(instanceId), { autoFit: !cfg.autoFit });
      saveConfig(instanceId, next);
      render(tile, instanceId);
    });
    rowLayout.appendChild(fit);

    if (!cfg.autoFit) {
      const min = window.DeckModel.DECK_MIN, max = window.DeckModel.DECK_MAX;
      const mkStepper = (dim, label) => {
        const grp = el('div', 'deck-tools-grp');
        grp.appendChild(el('span', 'deck-tools-cap', label));
        const dec = el('button', 'deck-step', '−'); dec.type = 'button'; dec.disabled = cfg[dim] <= min;
        const val = el('span', 'deck-step-val', String(cfg[dim]));
        const inc = el('button', 'deck-step', '+'); inc.type = 'button'; inc.disabled = cfg[dim] >= max;
        const setDim = (n) => {
          const cur = getConfig(instanceId);
          const cols = dim === 'cols' ? n : cur.cols;
          const rows = dim === 'rows' ? n : cur.rows;
          saveConfig(instanceId, window.DeckModel.reshapeDeckConfig(cur, cols, rows, { compact: false }));
          render(tile, instanceId);
        };
        dec.addEventListener('click', () => setDim(cfg[dim] - 1));
        inc.addEventListener('click', () => setDim(cfg[dim] + 1));
        grp.append(dec, val, inc);
        return grp;
      };
      rowLayout.appendChild(mkStepper('cols', tr('deck_cols', 'Col')));
      rowLayout.appendChild(mkStepper('rows', tr('deck_rows', 'Righe')));
    }

    const media = el('button', 'deck-pill' + (cfg.showMedia ? ' on' : ''), tr('deck_media_preview', 'Musica')); media.type = 'button';
    media.addEventListener('click', () => {
      saveConfig(instanceId, Object.assign({}, getConfig(instanceId), { showMedia: !cfg.showMedia }));
      render(tile, instanceId);
    });
    rowLayout.appendChild(media);

    // Open the appearance modal (theme/shape/plate + background + music, with a
    // live preview of the deck and its music bar).
    const custom = el('button', 'deck-pill deck-customize', tr('deck_style_open', 'Personalizza')); custom.type = 'button';
    custom.addEventListener('click', () => openDeckStyleModal(tile, instanceId, profileId));
    rowLayout.appendChild(custom);

    return tools;
  }

  // ── Deck appearance modal ───────────────────────────────────────────────────
  // A focused dialog for the whole-device LOOK (theme/shape/plate) plus the
  // background and now-playing-strip styling, with a LIVE, non-interactive preview
  // of the deck and its music bar so colour/gradient choices are visible while you
  // pick them. Every change saves + re-renders the real deck AND rebuilds the modal.
  let deckStyleOverlay = null;
  let deckStyleKeydown = null;
  let deckStyleCtx = null;   // { tile, instanceId } — the deck to repaint on close
  function closeDeckStyleModal() {
    if (deckStyleKeydown) { document.removeEventListener('keydown', deckStyleKeydown); deckStyleKeydown = null; }
    if (deckStyleOverlay) { deckStyleOverlay.remove(); deckStyleOverlay = null; }
    // The deck behind the modal was left un-repainted while editing (it's hidden);
    // repaint it once now so it reflects the saved changes.
    if (deckStyleCtx) {
      const { tile, instanceId, flush } = deckStyleCtx; deckStyleCtx = null;
      // A colour drag whose picker never fired 'change' still has to persist.
      if (flush) { try { flush(); } catch (_) {} }
      try { render(tile, instanceId); } catch (_) {}
    }
  }
  function buildDeckStylePreview(cfg, profileId) {
    const targetProfile = cfg.profiles.some((p) => p.id === profileId) ? profileId : cfg.activeProfile;
    const look = deckLookFor(cfg, targetProfile);
    const view = window.DeckModel.resolveView(cfg, { profileId: targetProfile, path: [], pageIndex: 0 });
    const root = el('div', 'deck-root deck-style-preview-root');
    root.dataset.keysize = cfg.keySize;
    root.dataset.capstyle = look.capStyle;
    root.dataset.shape = look.keyShape;
    root.dataset.plate = look.plate;
    root.style.setProperty('--deck-cols', cfg.cols);
    root.style.setProperty('--deck-rows', cfg.rows);
    root.style.setProperty('--deck-key-min', keyMinFor(cfg) + 'px');
    const device = el('div', 'deck-device');
    const well = el('div', 'deck-well');
    const wl = buildWellBg(look.wellImage);
    if (wl) { well.classList.add('has-bgimg'); well.appendChild(wl); }
    const grid = el('div', 'deck-grid');
    (view.page.keys || []).forEach((key) => grid.appendChild(renderKey(key)));
    well.appendChild(grid);
    device.appendChild(well);
    device.appendChild(buildNowPlaying(look.mediaStyle));   // always shown so music styling is visible
    root.appendChild(device);
    return root;
  }
  function openDeckStyleModal(tile, instanceId, profileId) {
    closeDeckStyleModal();
    const M = window.DeckModel;
    const initial = getConfig(instanceId);
    const targetProfile = initial.profiles.some((p) => p.id === profileId) ? profileId : initial.activeProfile;
    const getLook = () => deckLookFor(getConfig(instanceId), targetProfile);
    const overlay = el('div', 'deck-style-modal');
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeDeckStyleModal(); });
    const dialog = el('div', 'deck-style-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', tr('deck_style_title', 'Aspetto Deck'));
    overlay.appendChild(dialog);

    // Live preview host — swapped on every change so colour/gradient/theme picks
    // are visible immediately. Controls are built ONCE and self-manage their state,
    // so a live colour drag never rebuilds (and never kills) the picker element.
    const previewHost = el('div', 'deck-style-preview');
    // Rebuilt synchronously (a handful of keys + the music bar — cheap); rAF was
    // unreliable when the tab isn't the foreground one.
    const refreshPreview = () => { previewHost.replaceChildren(buildDeckStylePreview(getConfig(instanceId), targetProfile)); };
    // Persist + update the preview only; the deck behind is hidden, so it's
    // repainted once on close (closeDeckStyleModal) instead of on every keystroke.
    const saveRender = (patch) => {
      saveConfig(instanceId, M.setProfileLook(getConfig(instanceId), targetProfile, patch));
      refreshPreview();
    };
    // Continuous colour drags preview WITHOUT persisting — saveConfig stringifies
    // the whole multi-deck store (base64 key images included) plus an outbox op,
    // far too heavy per 'input' tick. The pending change persists on the picker's
    // 'change' (release); closeDeckStyleModal flushes it as a safety net.
    let livePending = null;
    const previewWith = (patch) => {
      previewHost.replaceChildren(buildDeckStylePreview(M.setProfileLook(getConfig(instanceId), targetProfile, patch), targetProfile));
    };

    // Segmented enum pick — updates the active button locally, no rebuild.
    const seg = (capKey, capFb, field, values, decorate) => {
      const cfg = getLook();
      const grp = el('div', 'deck-style-grp');
      grp.appendChild(el('span', 'deck-style-cap', tr(capKey, capFb)));
      const s = el('div', 'deck-seg');
      values.forEach((val) => {
        const b = el('button', cfg[field] === val ? 'active' : ''); b.type = 'button';
        decorate(b, val);
        b.addEventListener('click', () => {
          if (getLook()[field] === val) return;
          s.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          saveRender({ [field]: val });
        });
        s.appendChild(b);
      });
      grp.appendChild(s);
      return grp;
    };
    // Two-colour gradient toggle — manages its own disabled state, no rebuild.
    // `applyGrad(grad, persist)` previews (persist=false, per 'input' tick) or
    // saves (persist=true, on toggle/release).
    const gradPick = (getGrad, applyGrad) => {
      const grp = el('div', 'deck-style-grp');
      grp.appendChild(el('span', 'deck-style-cap', tr('decor_gradient', 'Gradiente')));
      const g = getGrad() || {};
      const chk = el('input'); chk.type = 'checkbox'; chk.className = 'deck-decor-gradchk'; chk.checked = !!(g.c1 && g.c2);
      const c1 = el('input'); c1.type = 'color'; c1.className = 'deck-decor-swatch'; c1.value = g.c1 || '#1ed760';
      const c2 = el('input'); c2.type = 'color'; c2.className = 'deck-decor-swatch'; c2.value = g.c2 || '#101216';
      const setDisabled = () => { c1.disabled = c2.disabled = !chk.checked; };
      setDisabled();
      const gradOf = () => chk.checked ? { c1: c1.value, c2: c2.value, angle: (getGrad() || {}).angle || 135 } : null;
      const commit = () => { setDisabled(); livePending = null; applyGrad(gradOf(), true); };
      const live = () => { setDisabled(); applyGrad(gradOf(), false); livePending = commit; };
      chk.addEventListener('change', commit);
      c1.addEventListener('input', live);
      c2.addEventListener('input', live);
      c1.addEventListener('change', commit);
      c2.addEventListener('change', commit);
      grp.append(chk, c1, c2);
      return grp;
    };
    // Image upload/clear — self-updates its label and clear button, no rebuild.
    const imagePick = (capKey, capFb, getHasImg, onFile, onClear) => {
      const grp = el('div', 'deck-style-grp');
      grp.appendChild(el('span', 'deck-style-cap', tr(capKey, capFb)));
      const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
      const btn = el('button', 'deck-pill'); btn.type = 'button';
      const clr = el('button', 'deck-step', '✕'); clr.type = 'button'; clr.title = tr('deck_decor_remove', 'Rimuovi');
      const refreshBtn = () => {
        const has = getHasImg();
        btn.textContent = tr(has ? 'deck_decor_change' : 'deck_decor_add', has ? 'Cambia' : 'Carica');
        btn.classList.toggle('on', has);
        clr.hidden = !has;
      };
      btn.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0]; file.value = ''; if (!f) return;
        btn.disabled = true;
        const src = await deckDecorImageToDataUrl(f, 720);
        btn.disabled = false;
        if (src) { onFile(src); refreshBtn(); }
        else if (window.XenonToast) window.XenonToast.show({ type: 'error', kicker: 'Deck', message: tr('deck_decor_fail', 'Immagine non caricata') });
      });
      // Paste raw SVG markup instead of uploading a file (stored as a data: URI).
      const svgBtn = el('button', 'deck-pill', tr('svg_paste', 'Incolla SVG')); svgBtn.type = 'button';
      svgBtn.addEventListener('click', async () => {
        const uri = await openSvgPasteDialog();
        if (uri) { onFile(uri); refreshBtn(); }
      });
      clr.addEventListener('click', () => { onClear(); refreshBtn(); });
      grp.append(btn, svgBtn, file, clr);
      refreshBtn();
      return grp;
    };

    // Header
    const head = el('div', 'deck-style-head');
    head.appendChild(el('span', 'deck-style-title', tr('deck_style_title', 'Aspetto Deck')));
    const close = el('button', 'deck-style-close', '✕'); close.type = 'button'; close.title = tr('deck_style_done', 'Fine');
    close.addEventListener('click', closeDeckStyleModal);
    head.appendChild(close);
    dialog.appendChild(head);
    // Live preview
    refreshPreview();
    dialog.appendChild(previewHost);
    // Controls
    const cfg0 = getLook();
    const body = el('div', 'deck-style-body');
    const SHAPE_SVG = {
      rounded: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="3.5"/></svg>',
      square: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/></svg>',
      circle: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/></svg>',
    };
    body.appendChild(seg('deck_capstyle', 'Tema', 'capStyle', M.CAP_STYLES || ['lcd', 'flat', 'neon', 'glass', 'vivid'],
      (b, v) => { b.textContent = tr('deck_capstyle_' + v, v.toUpperCase()); }));
    body.appendChild(seg('deck_shape', 'Forma', 'keyShape', M.KEY_SHAPES || ['rounded', 'square', 'circle'],
      (b, v) => { b.innerHTML = SHAPE_SVG[v] || ''; b.title = tr('deck_shape_' + v, v); }));
    body.appendChild(seg('deck_plate', 'Base', 'plate', M.PLATE_STYLES || ['graphite', 'carbon', 'steel', 'midnight', 'none'],
      (b, v) => { b.textContent = tr('deck_plate_' + v, v); }));
    // Background section
    body.appendChild(el('div', 'deck-style-subhead', tr('deck_decor_well', 'Sfondo')));
    body.appendChild(imagePick('deck_decor_well', 'Sfondo', () => !!(getLook().wellImage || {}).src,
      (src) => { const cur = getLook(); saveRender({ wellImage: Object.assign({ fit: 'cover', dim: 30, blur: 0 }, cur.wellImage, { src }) }); },
      () => { const cur = getLook(); const wi = Object.assign({}, cur.wellImage); delete wi.src; saveRender({ wellImage: wi.grad ? wi : null }); }));
    body.appendChild(gradPick(
      () => (getLook().wellImage || {}).grad || null,
      (grad, persist) => {
        const cur = getLook();
        const wi = Object.assign({ fit: 'cover', dim: 30, blur: 0 }, cur.wellImage);
        if (grad) wi.grad = grad; else delete wi.grad;
        const patch = { wellImage: (wi.src || wi.grad) ? wi : null };
        if (persist) saveRender(patch); else previewWith(patch);
      }));
    // Music section
    body.appendChild(el('div', 'deck-style-subhead', tr('deck_decor_media', 'Musica')));
    const accGrp = el('div', 'deck-style-grp');
    accGrp.appendChild(el('span', 'deck-style-cap', tr('deck_style_accent', 'Colore')));
    // A checkbox so the accent can be turned OFF again (a plain colour input can
    // never be "unset"); toggling it off drops the tint from the strip.
    const accChk = el('input'); accChk.type = 'checkbox'; accChk.className = 'deck-decor-gradchk';
    accChk.checked = !!(cfg0.mediaStyle && cfg0.mediaStyle.accent);
    const acc = el('input'); acc.type = 'color'; acc.className = 'deck-decor-swatch';
    acc.value = (cfg0.mediaStyle && cfg0.mediaStyle.accent) || '#1ed760';
    acc.disabled = !accChk.checked;
    const syncAcc = (persist) => {
      acc.disabled = !accChk.checked;
      const cur = getLook();
      const ms = Object.assign({}, cur.mediaStyle);
      if (accChk.checked) ms.accent = acc.value; else delete ms.accent;
      const patch = { mediaStyle: (ms.src || ms.grad || ms.accent) ? ms : null };
      if (persist) { livePending = null; saveRender(patch); }
      else { previewWith(patch); livePending = () => syncAcc(true); }
    };
    accChk.addEventListener('change', () => syncAcc(true));
    acc.addEventListener('input', () => syncAcc(false));
    acc.addEventListener('change', () => syncAcc(true));
    accGrp.append(accChk, acc);
    body.appendChild(accGrp);
    body.appendChild(imagePick('deck_decor_media_bg', 'Sfondo musica', () => !!(getLook().mediaStyle || {}).src,
      (src) => { const cur = getLook(); saveRender({ mediaStyle: Object.assign({ dim: 40 }, cur.mediaStyle, { src }) }); },
      () => { const cur = getLook(); const ms = Object.assign({}, cur.mediaStyle); delete ms.src; delete ms.dim; saveRender({ mediaStyle: (ms.grad || ms.accent) ? ms : null }); }));
    body.appendChild(gradPick(
      () => (getLook().mediaStyle || {}).grad || null,
      (grad, persist) => {
        const cur = getLook();
        const ms = Object.assign({}, cur.mediaStyle);
        if (grad) ms.grad = grad; else delete ms.grad;
        const patch = { mediaStyle: (ms.src || ms.grad || ms.accent) ? ms : null };
        if (persist) saveRender(patch); else previewWith(patch);
      }));
    dialog.appendChild(body);

    deckStyleKeydown = (e) => { if (e.key === 'Escape') closeDeckStyleModal(); };
    document.addEventListener('keydown', deckStyleKeydown);
    document.body.appendChild(overlay);
    deckStyleOverlay = overlay;
    deckStyleCtx = { tile, instanceId, flush: () => { if (livePending) { const f = livePending; livePending = null; f(); } } };
  }

  // The docked now-playing transport — mirrors the chat mini-player. Buttons drive
  // the shared media session via mediaAction(); content filled by applyDeckMediaInto.
  // A normalized {c1,c2,angle} gradient → a CSS linear-gradient(). Delegates to
  // the tile serializer (dashboard-layout.js, always loaded) — one CSS form for
  // tiles and Deck, so they can't drift.
  function deckGradCss(grad) { return tileGradCss(grad); }
  // Build the well-background layer (image, gradient, or both) from a wellImage
  // config, or null when there's nothing to show. Shared by render() and the
  // style-modal preview so the two never drift.
  function buildWellBg(wellImage) {
    const grad = wellImage && deckGradCss(wellImage.grad);
    if (!wellImage || (!wellImage.src && !grad)) return null;
    const wl = el('div', 'deck-well-bg');
    // Same composition rule as the tile decor bg (dashboard-layout.js).
    paintDecorBgLayer(wl, grad, wellImage.src, wellImage.fit || 'cover');
    if (wellImage.blur) wl.style.filter = `blur(${wellImage.blur}px)`;
    wl.style.setProperty('--deck-well-dim', String((wellImage.dim != null ? wellImage.dim : 30) / 100));
    return wl;
  }
  function buildNowPlaying(mediaStyle) {
    const np = el('div', 'deck-np is-idle');   // always mounted; idle until media plays
    // Optional user styling of the strip: an accent tint and/or a custom backdrop
    // picture (an underlay behind the album backdrop, so it shows in standby too).
    if (mediaStyle) {
      if (mediaStyle.accent) { np.style.setProperty('--deck-np-accent', mediaStyle.accent); np.classList.add('has-accent'); }
      const g = deckGradCss(mediaStyle.grad);
      if (mediaStyle.src || g) {
        np.classList.add('has-userbg');
        const ub = el('div', 'deck-np-userbg');
        const img = cssUrl(mediaStyle.src);
        ub.style.backgroundImage = [g, img].filter(Boolean).join(', ');   // gradient over image
        if (g && img) { ub.style.backgroundSize = 'cover, cover'; ub.style.backgroundPosition = 'center'; }
        const dim = (mediaStyle.dim != null) ? mediaStyle.dim : (mediaStyle.src ? 40 : 0);
        ub.style.setProperty('--deck-np-userdim', String(dim / 100));
        np.appendChild(ub);
      }
    }
    np.appendChild(el('div', 'deck-np-bg'));   // blurred album backdrop = the "screen" colour
    const cover = el('div', 'deck-np-cover');
    const spk = el('div', 'deck-np-spk');      // speaker glyph shown in the idle/standby face
    spk.innerHTML = SPK_SVG.on;
    cover.appendChild(spk);
    np.appendChild(cover);
    const info = el('div', 'deck-np-info');
    info.appendChild(el('div', 'deck-np-title', tr('deck_np_standby', 'Standby')));
    info.appendChild(el('div', 'deck-np-artist', ''));
    np.appendChild(info);
    const actions = el('div', 'deck-np-actions');
    const mk = (cls, svg, action, title) => {
      const b = el('button', 'deck-np-btn' + cls); b.type = 'button'; b.title = title; b.innerHTML = svg;
      b.addEventListener('click', (e) => { e.stopPropagation(); if (typeof mediaAction === 'function') mediaAction(action); });
      return b;
    };
    actions.appendChild(mk('', NP_SVG.prev, 'previous', tr('tip_prev', 'Precedente')));
    const playBtn = mk(' primary', NP_SVG.play, 'playpause', tr('tip_play', 'Play/Pausa'));
    playBtn.dataset.npPlay = '1';
    actions.appendChild(playBtn);
    actions.appendChild(mk('', NP_SVG.next, 'next', tr('tip_next', 'Successivo')));
    np.appendChild(actions);
    // Standby-only volume meter (the output device's master level).
    const vol = el('div', 'deck-np-vol');
    vol.appendChild(el('div', 'deck-np-vol-fill'));
    np.appendChild(vol);
    return np;
  }

  // Fill one deck instance's now-playing screen from the global media + audio state.
  // The screen is always mounted (so the cap grid never reflows); it shows the track
  // when playing and a Standby face (output device + volume) when nothing plays.
  function applyDeckMediaInto(tile) {
    const np = tile.querySelector('.deck-np');
    if (!np) return;
    const playing = typeof hasActiveMedia === 'function' && hasActiveMedia();
    const cover = np.querySelector('.deck-np-cover');
    const bg = np.querySelector('.deck-np-bg');
    const title = np.querySelector('.deck-np-title');
    const artist = np.querySelector('.deck-np-artist');
    const playBtn = np.querySelector('[data-np-play]');
    // The screen stays mounted (so the cap grid never reflows); when nothing plays it
    // drops to a useful "standby" face showing the active output device + its volume.
    np.classList.toggle('is-idle', !playing);
    if (!playing) {
      np.classList.remove('has-cover');
      if (cover) { cover.classList.remove('has-image'); cover.style.backgroundImage = ''; }
      if (bg) bg.style.backgroundImage = '';
      const ad = (typeof audioData !== 'undefined' && audioData && audioData.speaker) ? audioData.speaker : null;
      const muted = ad ? !!ad.muted : false;
      const v = ad && Number.isFinite(Number(ad.volume)) ? Math.max(0, Math.min(100, Math.round(Number(ad.volume)))) : null;
      const devName = (ad && (ad.name || ad.label)) || tr('deck_np_standby', 'Standby');
      np.classList.toggle('is-muted', muted);
      const spk = np.querySelector('.deck-np-spk');
      if (spk) spk.innerHTML = muted ? SPK_SVG.off : SPK_SVG.on;
      if (title) title.textContent = devName;
      if (artist) artist.textContent = muted ? tr('deck_np_muted', 'Muto') : (v != null ? v + '%' : tr('deck_np_standby', 'Standby'));
      const fill = np.querySelector('.deck-np-vol-fill');
      if (fill) fill.style.width = (muted || v == null ? 0 : v) + '%';
      if (playBtn) playBtn.innerHTML = NP_SVG.play;
      return;
    }
    np.classList.remove('is-muted');
    const md = (typeof mediaData !== 'undefined' && mediaData) || {};
    const thumb = md.thumbnail || '';
    np.classList.toggle('has-cover', !!thumb);
    if (cover) { cover.classList.toggle('has-image', !!thumb); cover.style.backgroundImage = thumb ? 'url("' + thumb + '")' : ''; }
    if (bg) bg.style.backgroundImage = thumb ? 'url("' + thumb + '")' : '';
    if (title) title.textContent = (typeof cleanTitle === 'function' ? cleanTitle(md.title) : md.title) || tr('media_unknown_title', '');
    if (artist) artist.textContent = md.artist || md.album || '';
    if (playBtn) playBtn.innerHTML = md.playbackStatus === 'Playing' ? NP_SVG.pause : NP_SVG.play;
  }
  function applyDeckMedia() {
    document.querySelectorAll('[data-dashboard-widget="deck"]').forEach(applyDeckMediaInto);
  }

  // Defer the first-paint auto-fit to the next frames, so the deck measures the
  // tile at its SETTLED size (after the dashboard layout pass runs fitGridHeights).
  // Double rAF lands after GridStack has applied the cell height; measuring then
  // avoids persisting a transient portrait shape on a fresh load / iCUE reload.
  function scheduleFirstPaintFit(tile, instanceId) {
    const prev = firstPaintFits.get(instanceId);
    if (prev) cancelAnimationFrame(prev);
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        firstPaintFits.delete(instanceId);
        if (!tile.isConnected) return;
        const cur = getConfig(instanceId);
        if (!cur.autoFit) return;
        const st = navOf(instanceId);
        if (st.editing || isLayoutEditing()) return;
        const fitted = applyAutoGrid(tile, instanceId, cur);
        if (fitted.cols !== cur.cols || fitted.rows !== cur.rows) {
          saveConfigDisplay(instanceId, fitted);   // render-only; never drifts the durable grid
          render(tile, instanceId);
        }
      });
      firstPaintFits.set(instanceId, raf2);
    });
    firstPaintFits.set(instanceId, raf1);
  }

  // Measure the live key grid and reshape `cfg` to the column/row count that fits
  // at its key size. Returns the (possibly) reshaped config; a no-op when auto-fit
  // is off or the grid isn't measurable yet. Uses { preserve:true } so a user's
  // intentional empty slots are kept and a key is NEVER repacked — the grid grows
  // to fit the highest occupied slot, so even a transient/smaller first-paint
  // measurement can't compact the saved layout.
  //
  // Auto-fit fills the tile with keys at the SELECTED PHYSICAL SIZE (S/M/L →
  // KEY_SIZES), Stream-Deck style — NOT by inflating a few keys to fill the space.
  // gridForSize() does exactly this (and expands columns/rows so the caps reach the
  // edges, like a Stream Deck XL), so S = many small keys, L = fewer larger keys,
  // none oversized. The previous "largest-cap" heuristic produced 3 giant caps on a
  // wide tile with few keys. Pure: no DOM.
  function computeAutoGrid(cfg, w, h) {
    const DM = window.DeckModel;
    if (!(w > 20 && h > 20) || !(DM && DM.gridForSize && DM.reshapeDeckConfig)) return cfg;
    const { cols, rows } = DM.gridForSize(w, h, cfg.keySize);
    const grid = DM.reshapeDeckConfig(cfg, cols, rows, { preserve: true });
    if (grid.cols === cfg.cols && grid.rows === cfg.rows) return cfg;
    return grid;
  }

  // The well's CONTENT box — the same box the CSS square-cap formula reads via
  // container-query units (container-type:size queries the content box). A bare
  // clientWidth/Height also counts the well padding (up to 13px per side), which
  // made gridForSize see a bigger area than the CSS and fit an extra column/row
  // the caps then had to shrink for — the classic "grid sfasata" at some sizes.
  function wellContentSize(well) {
    const cs = getComputedStyle(well);
    const w = well.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const h = well.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    return { w: Math.max(0, w), h: Math.max(0, h) };
  }

  // Reshape `cfg` to auto-fill the tile. Measures the WELL (the available area),
  // not the grid — the grid letterboxes to a square block, so measuring it would
  // feed back. Normal view only: while editing, the grid is fitted against the
  // EDIT well by scheduleEditFit (caps keep their live size, the row count
  // adapts), so this normal-view fit must never run on the transient edit well.
  function applyAutoGrid(tile, instanceId, cfg) {
    if (!cfg.autoFit || !(window.DeckModel && window.DeckModel.reshapeDeckConfig)) return cfg;
    if (navOf(instanceId).editing) return cfg;
    const well = tile.querySelector('.deck-well');
    if (!well) return cfg;
    const { w, h } = wellContentSize(well);
    return computeAutoGrid(cfg, w, h);
  }

  // Fit the EDIT grid to the edit-mode well, measured after paint (double rAF,
  // like the first-paint fit). The toolbar/footer shrink the well while editing,
  // so scaling the full live grid into it made the caps too small to press; the
  // edit view instead keeps the live cap size and shows the rows that fit —
  // {preserve} reshaping always grows the grid to the highest occupied slot, so
  // every placed key stays reachable. Render-only, like every auto-fit.
  function scheduleEditFit(tile, instanceId) {
    const prev = editFits.get(instanceId);
    if (prev) cancelAnimationFrame(prev);
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        editFits.delete(instanceId);
        if (!tile.isConnected) return;
        const st = navOf(instanceId);
        const cur = getConfig(instanceId);
        if (!st.editing || !cur.autoFit) return;
        const well = tile.querySelector('.deck-well');
        if (!well) return;
        const { w, h } = wellContentSize(well);
        if (!(w > 20 && h > 20)) return;
        editWellSizes.set(instanceId, { w, h });   // sync re-fit source for later edit renders
        const fitted = computeAutoGrid(cur, w, h);
        if (fitted.cols !== cur.cols || fitted.rows !== cur.rows) {
          saveConfigDisplay(instanceId, fitted);   // render-only; converges (the well size is stable)
          render(tile, instanceId);
        }
      });
      editFits.set(instanceId, raf2);
    });
    editFits.set(instanceId, raf1);
  }

  // Observe the grid so the deck re-fits its key count as the tile resizes. One
  // observer per instance; rebuilt on each render. Disabled while editing the deck
  // (so the user's grid choices aren't reflowed under them), while the dashboard
  // Layout editor is open (the tile is mid-resize), and when auto-fit is off.
  function setupAutoFit(tile, instanceId, state) {
    const old = resizeObservers.get(instanceId);
    if (old) { old.cancel(); resizeObservers.delete(instanceId); }
    if (state.editing || isLayoutEditing() || typeof ResizeObserver === 'undefined') return;
    const cfg = getConfig(instanceId);
    if (!cfg.autoFit) return;
    const well = tile.querySelector('.deck-well');
    if (!well) return;
    let raf = 0, disposed = false, lastW = well.clientWidth, lastH = well.clientHeight;
    const ro = new ResizeObserver(() => {
      if (raf || disposed) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // Bail if this fit was torn down (deck/layout edit started) since it was
        // queued: re-fitting against the now-transient well (edit toolbar + footer
        // shrink it) is exactly what collapsed the grid to a single row.
        if (disposed || state.editing || isLayoutEditing()) return;
        const g = tile.querySelector('.deck-well');
        if (!g) return;
        // Dead-zone on the raw client box: the well padding is constant per key
        // size, so the delta matches the content box — and no-op frames skip the
        // getComputedStyle read wellContentSize does (applyAutoGrid re-measures
        // the content box itself once a real resize gets past this gate).
        const w = g.clientWidth, h = g.clientHeight;
        if (Math.abs(w - lastW) < 4 && Math.abs(h - lastH) < 4) return;
        lastW = w; lastH = h;
        const cur = getConfig(instanceId);
        if (!cur.autoFit) return;
        const next = applyAutoGrid(tile, instanceId, cur);   // same fill algorithm as first-paint
        if (next.cols === cur.cols && next.rows === cur.rows) return;  // no change after fill
        saveConfigDisplay(instanceId, next);   // render-only; the durable grid stays put
        render(tile, instanceId);   // re-render re-creates this observer
      });
    });
    ro.observe(well);
    // Store a teardown that ALSO cancels a pending rAF — a disconnect()ed observer
    // can still have one queued, which would run against the wrong (edit) well.
    resizeObservers.set(instanceId, {
      cancel() { disposed = true; if (raf) cancelAnimationFrame(raf); ro.disconnect(); },
    });
  }

  function render(tile, instanceId) {
    const state = navOf(instanceId);
    let cfg = getConfig(instanceId);
    // While EDITING with auto-fit on, keep showing a grid FITTED TO THE EDIT
    // WELL. Two reasons: (1) every toolbar change goes through saveConfig, which
    // — by design — folds the fitted cols/rows back onto the canonical durable
    // grid and clears the display override, so without a re-fit the editor
    // repaints the letterboxed canonical shape (e.g. 4×2 giant caps after
    // tapping "S"); (2) the toolbar/footer shrink the well, so fitting the FULL
    // live grid into it made the caps too small to press — fitting the edit
    // well keeps the live cap size and adapts the row count instead. The sync
    // path below uses the size scheduleEditFit measured after the last paint.
    if (state.editing && cfg.autoFit) {
      const cached = editWellSizes.get(instanceId);
      if (cached) {
        const fitted = computeAutoGrid(cfg, cached.w, cached.h);
        if (fitted.cols !== cfg.cols || fitted.rows !== cfg.rows) {
          saveConfigDisplay(instanceId, fitted);   // render-only, like every auto-fit
          cfg = fitted;
        }
      }
    }
    // Smart Profiles: an auto-switch match overrides which profile is SHOWN —
    // a volatile, render-only choice that never writes activeProfile (mirrors
    // display-only auto-fit). Ignored if the matched profile no longer exists.
    const shownProfile = (state.volatileProfile && cfg.profiles.some((p) => p.id === state.volatileProfile))
      ? state.volatileProfile : cfg.activeProfile;
    const view = window.DeckModel.resolveView(cfg, {
      profileId: shownProfile, path: state.path, pageIndex: state.pageIndex,
    });
    state.pageIndex = view.pageIndex; // resolveView clamps
    const navCtx = { profileId: shownProfile, path: state.path, pageIndex: view.pageIndex };
    const look = deckLookFor(cfg, shownProfile);

    // Preserve the layout-editor overlay (the hide / move-page controls that
    // dashboard-layout.js appends to the tile). A bare replaceChildren() would
    // wipe it on every deck re-render — auto-fit, media updates — leaving the
    // deck the only widget you couldn't hide while editing the layout.
    const keepControls = Array.from(tile.children).filter(
      child => child.classList && child.classList.contains('layout-controls'),
    );
    tile.replaceChildren(...keepControls);
    const root = el('div', 'deck-root');
    root.classList.toggle('is-editing', state.editing);
    root.dataset.keysize = cfg.keySize;
    // Whole-device look: cap material, cap shape and faceplate finish (see
    // DeckPanel.css [data-capstyle] / [data-shape] / [data-plate] variants).
    root.dataset.capstyle = look.capStyle;
    root.dataset.shape = look.keyShape;
    root.dataset.plate = look.plate;
    root.style.setProperty('--deck-cols', cfg.cols);
    root.style.setProperty('--deck-rows', cfg.rows);
    root.style.setProperty('--deck-key-min', keyMinFor(cfg) + 'px');
    // Suppress the browser's long-press / right-click context menu on the deck so
    // a press-and-hold triggers OUR hold gesture instead of the native menu.
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // Navigation bar (Option B)
    const bar = el('div', 'deck-bar');
    const back = el('button', 'deck-back');
    back.type = 'button';
    back.textContent = '‹';
    back.hidden = state.path.length === 0;
    back.addEventListener('click', () => { state.path = state.path.slice(0, -1); state.pageIndex = 0; closeProfileMenu(state, instanceId); render(tile, instanceId); });
    bar.appendChild(back);
    // At the profile root the crumb is a switcher: tap to open the profile menu.
    // Inside a folder it stays a plain breadcrumb (the back button handles nav).
    if (state.path.length === 0) {
      const crumbBtn = el('button', 'deck-crumb deck-crumb-btn' + (state.profileMenu ? ' is-open' : ''));
      crumbBtn.type = 'button';
      crumbBtn.appendChild(el('span', 'deck-crumb-text', crumbLabel(cfg, state)));
      crumbBtn.appendChild(el('span', 'deck-crumb-caret', '▾'));
      crumbBtn.title = tr('deck_profiles', 'Profili');
      crumbBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.profileMenu = !state.profileMenu;
        if (!state.profileMenu) state.renamingProfile = null;
        render(tile, instanceId);
      });
      bar.appendChild(crumbBtn);
    } else {
      bar.appendChild(el('span', 'deck-crumb', crumbLabel(cfg, state)));
    }
    bar.appendChild(el('span', 'deck-spacer'));
    bar.appendChild(el('span', 'deck-index', (view.pageIndex + 1) + ' / ' + view.pageCount));
    const edit = el('button', 'deck-edit');
    edit.type = 'button';
    if (state.editing) edit.classList.add('is-on');
    edit.innerHTML = state.editing ? DONE_SVG : EDIT_SVG;
    edit.title = state.editing ? 'done' : 'edit';
    edit.addEventListener('click', () => { state.editing = !state.editing; render(tile, instanceId); });
    bar.appendChild(edit);

    // The profile switcher popover is portaled to <body> at the END of render (so
    // it escapes the deck tile's `overflow:hidden`); here we only tear it down
    // when it isn't meant to be open.
    if (!(state.profileMenu && state.path.length === 0)) closeProfileMenu(state, instanceId);

    // Everything lives inside one device chassis: faceplate header, recessed key
    // well, page footer, and the optional now-playing screen.
    const device = el('div', 'deck-device');
    device.appendChild(bar);
    if (state.editing) device.appendChild(buildTools(tile, instanceId, cfg, shownProfile));

    const well = el('div', 'deck-well');
    // Free-form background behind the key grid: image, gradient, or both (additive;
    // classic look when unset).
    const wl = buildWellBg(look.wellImage);
    if (wl) { well.classList.add('has-bgimg'); well.appendChild(wl); }
    const grid = el('div', 'deck-grid');
    view.page.keys.forEach((key, slotIndex) => {
      const node = renderKey(key);
      if (state.editing) {
        node.classList.add('is-editing');
        node.dataset.slot = slotIndex;           // drop target for drag-to-reorder
        if (!key) {
          node.classList.add('is-add'); node.textContent = '+';
          node.addEventListener('click', () => openEditor(tile, instanceId, navCtx, slotIndex, key));
        } else {
          bindEditKey(tile, instanceId, navCtx, slotIndex, key, node);   // delete badge + drag + tap-to-edit
        }
      } else if (key && key.kind === 'folder') {
        bindPressFeedback(node);                  // folders click visibly too
        node.addEventListener('click', () => { state.path = state.path.concat(key.id); state.pageIndex = 0; render(tile, instanceId); });
      } else if (key && key.kind === 'action') {
        // Re-apply a persistent (latched) effect so it survives grid re-renders. If the
        // key's effect is no longer a latching one, drop the stale latch.
        if (state.latched && state.latched.has(key.id)) {
          const cls = LATCH_CLS[key.press];
          if (cls) node.classList.add(cls);
          else state.latched.delete(key.id);
        }
        bindActionKey(node, key, state);
      } else if (key && key.kind === 'slider') {
        bindSliderKey(node, key);
      }
      grid.appendChild(node);
    });
    well.appendChild(grid);
    device.appendChild(well);

    // Footer: arrows + page dots (only when more than one page, or in edit mode)
    if (view.pageCount > 1 || state.editing) {
      const foot = el('div', 'deck-foot');
      const prev = el('button', 'deck-arrow', '‹'); prev.type = 'button';
      prev.disabled = view.pageIndex === 0;
      prev.addEventListener('click', () => { state.pageIndex = Math.max(0, view.pageIndex - 1); render(tile, instanceId); });
      const dots = el('div', 'deck-dots');
      for (let i = 0; i < view.pageCount; i++) { const d = el('i'); if (i === view.pageIndex) d.classList.add('active'); dots.appendChild(d); }
      const next = el('button', 'deck-arrow', '›'); next.type = 'button';
      next.disabled = view.pageIndex >= view.pageCount - 1;
      next.addEventListener('click', () => { state.pageIndex = Math.min(view.pageCount - 1, view.pageIndex + 1); render(tile, instanceId); });
      foot.appendChild(prev); foot.appendChild(dots); foot.appendChild(next);
      if (state.editing) {
        const addPg = el('button', 'deck-arrow', '＋'); addPg.type = 'button'; addPg.title = tr('deck_addpage', 'add page');
        addPg.addEventListener('click', () => {
          const cfg2 = getConfig(instanceId);
          saveConfig(instanceId, window.DeckModel.addPageAt(cfg2, navCtx));
          state.pageIndex = view.pageCount;
          render(tile, instanceId);
        });
        foot.appendChild(addPg);
        if (view.pageCount > 1) {
          const delPg = el('button', 'deck-arrow', '🗑'); delPg.type = 'button'; delPg.title = tr('deck_delpage', 'delete page');
          delPg.addEventListener('click', () => {
            const cfg2 = getConfig(instanceId);
            saveConfig(instanceId, window.DeckModel.removePageAt(cfg2, navCtx, view.pageIndex));
            state.pageIndex = Math.max(0, view.pageIndex - 1);
            render(tile, instanceId);
          });
          foot.appendChild(delPg);
        }
      }
      device.appendChild(foot);
    }

    // Now-playing dock (optional). Hidden while editing: it steals vertical
    // space the edit grid needs for touch-sized caps, and it isn't editable —
    // the "Musica" toolbar pill still shows/toggles the setting.
    if (cfg.showMedia && !state.editing) device.appendChild(buildNowPlaying(look.mediaStyle));

    root.appendChild(device);
    tile.appendChild(root);

    // First-paint auto-fit: if the stored grid doesn't match the tile size, reshape
    // once and re-render at the fitted grid (converges — the fitted grid is stable).
    // Skipped while the Layout editor is open (the tile is mid-resize); the deck
    // re-fits once editing ends. See isLayoutEditing().
    //
    // Deferred to the next frames: the dashboard layout pass renders the deck BEFORE
    // GridStack settles the tile's cell height (fitGridHeights runs a frame later),
    // so a synchronous measure here can read a transient portrait size and persist a
    // wrong column count. The ResizeObserver wouldn't correct it, because the well's
    // OUTER size doesn't change when only the inner grid reshapes — leaving 2 columns
    // stuck until a manual reload. Measuring after the layout settles avoids that.
    if (cfg.autoFit && !state.editing && !isLayoutEditing()) {
      scheduleFirstPaintFit(tile, instanceId);
    }
    // Edit-mode counterpart of the first-paint fit: measure the edit well after
    // this paint and refit the row count to it (see scheduleEditFit).
    if (cfg.autoFit && state.editing) {
      scheduleEditFit(tile, instanceId);
    }
    setupAutoFit(tile, instanceId, state);
    applyScenePreview();      // (re)assign the thumbnail host whenever the page/keys change
    applyDeckMediaInto(tile); // fill the now-playing dock from current media state

    // Portal the profile popover to <body>, anchored under the crumb button. This
    // is done last (the crumb button is now in the DOM, so it has a layout rect)
    // and as a body child so the tile's `overflow:hidden` can't clip it.
    if (profileMenuOwner === instanceId) removeProfileMenuDom();
    if (state.profileMenu && state.path.length === 0) {
      const anchor = tile.querySelector('.deck-crumb-btn');
      if (anchor) {
        profileMenuEl = buildProfileMenu(tile, instanceId, cfg, state);
        profileMenuOwner = instanceId;
        document.body.appendChild(profileMenuEl);
        positionProfileMenu(profileMenuEl, anchor);
        armProfileMenuDismiss(tile, instanceId, state);
        // Focus the inline rename field once it's in the DOM so typing is immediate.
        if (state.renamingProfile) {
          const inp = profileMenuEl.querySelector('.deck-pmenu-input');
          if (inp) { inp.focus(); inp.select(); }
        }
      }
    }
    scheduleHaWatchSync();   // the rendered key set may have changed its HA bindings
  }

  // ── HA entity subscriptions for bound keys ─────────────────────────────────
  // After a render, tell the server which HA entities the visible deck keys are
  // bound to (haEntity states now; haLight sliders reuse this). Debounced and
  // signature-guarded, so bursts of re-renders cost at most one POST and an
  // unchanged set costs zero.
  let haWatchTimer = null;
  let haWatchSig = null;   // null = never sent (an initial empty set is not worth a POST)
  let haWatchKeepalive = null;   // refreshes the server-side TTL while bindings exist
  // The server prunes watch entries after 15 min (HA_DECK_WATCH_TTL_MS) and the
  // signature guard below suppresses re-POSTs for an unchanged set — so an idle
  // surface must re-POST on its own or its entities silently drop out of the
  // ha_states broadcasts. Half the server TTL keeps the entry alive with one
  // tiny loopback POST every 7 minutes, and ONLY while bound entities exist.
  const HA_WATCH_KEEPALIVE_MS = 7 * 60 * 1000;
  // Per-SURFACE id: the server unions the sets across surfaces (dashboard,
  // Virtual Deck popup, second browser), keyed by this id.
  const haWatchClientId = 'c' + Math.random().toString(36).slice(2, 12);
  function scheduleHaWatchSync() {
    if (haWatchTimer) return;
    haWatchTimer = setTimeout(() => {
      haWatchTimer = null;
      const ids = new Set();
      document.querySelectorAll('.deck-key[data-state-bound]').forEach((node) => {
        const st = node._deckState;
        if (st && st.source === 'haEntity' && st.entity) ids.add(st.entity);
      });
      document.querySelectorAll('.deck-key.is-slider[data-ha-entity]').forEach((node) => {
        ids.add(node.dataset.haEntity);
      });
      const list = Array.from(ids).sort();
      const sig = list.join(',');
      if (sig === haWatchSig || (haWatchSig === null && !list.length)) return;
      haWatchSig = sig;
      if (haWatchKeepalive) { clearTimeout(haWatchKeepalive); haWatchKeepalive = null; }
      if (list.length) {
        haWatchKeepalive = setTimeout(() => {
          haWatchKeepalive = null;
          haWatchSig = null;          // force the next sync past the signature guard
          scheduleHaWatchSync();
        }, HA_WATCH_KEEPALIVE_MS);
      }
      fetch(deckBase() + '/ha/deck-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: haWatchClientId, entities: list }),
      }).catch(() => { haWatchSig = null; });   // retry on the next render
    }, 300);
  }

  // Place the portaled popover just under its anchor (the crumb button), clamped
  // to the viewport so it never spills off-screen on a small panel.
  function positionProfileMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    // On the Xeneon Edge, <html> carries CSS `zoom` (fractional-DPR compensation),
    // which magnifies the inline px of a body-portaled fixed element. getBoundingClientRect
    // is in visual (zoomed) space, while offsetWidth/innerWidth and the written inline px
    // are in layout space — so convert the anchor rect to layout coords by dividing by the
    // zoom (mirrors the drag-clone). On desktop (zoom = 1) this is a no-op.
    const z = (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
    const rLeft = r.left / z, rTop = r.top / z, rBottom = r.bottom / z;
    menu.style.visibility = 'hidden';     // measure before painting to avoid a flash at 0,0
    const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 0;
    const margin = 8;
    let left = rLeft;
    left = Math.max(margin, Math.min(left, window.innerWidth - mw - margin));
    let top = rBottom + 6;
    if (top + mh > window.innerHeight - margin) top = Math.max(margin, rTop - mh - 6);  // flip above if no room below
    menu.style.left = Math.round(left) + 'px';
    menu.style.top = Math.round(top) + 'px';
    menu.style.visibility = '';
  }

  // ── Profile switcher popover ──────────────────────────────────────────
  // The popover is portaled to <body>; only one is ever open across all decks,
  // tracked with its owning instance so a background re-render of a *different*
  // deck can't tear down the menu the user is interacting with.
  let profileMenuEl = null, profileMenuOwner = null;
  function removeProfileMenuDom() {
    if (profileMenuEl) { profileMenuEl.remove(); profileMenuEl = null; }
    profileMenuOwner = null;
  }

  // Tear down the outside-click / Escape dismiss handlers (if armed) and drop the
  // transient menu state. Only removes the portaled DOM if this instance owns it.
  function closeProfileMenu(state, instanceId) {
    if (instanceId == null || profileMenuOwner === instanceId) removeProfileMenuDom();
    if (state._pmenuDismiss) { state._pmenuDismiss(); state._pmenuDismiss = null; }
    state.profileMenu = false;
    state.renamingProfile = null;
  }

  // While the menu is open, dismiss it on a click outside (the crumb button is
  // exempt so it can toggle) or Escape. Re-armed on every render; the previous
  // handlers are removed first so exactly one set is ever active per instance.
  function armProfileMenuDismiss(tile, instanceId, state) {
    if (state._pmenuDismiss) state._pmenuDismiss();
    const onDown = (e) => {
      const t2 = e.target;
      if (t2.closest && (t2.closest('.deck-pmenu') || t2.closest('.deck-crumb-btn'))) return;
      cleanup();
      state.profileMenu = false; state.renamingProfile = null;
      render(tile, instanceId);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      cleanup();
      state.profileMenu = false; state.renamingProfile = null;
      render(tile, instanceId);
    };
    // Arm on the NEXT frame: the very tap that opens the menu is still in flight
    // (pointerdown → … → click). Listening immediately would let that same gesture's
    // trailing pointer event close the menu the instant it opened.
    let raf = requestAnimationFrame(() => {
      raf = 0;
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    });
    function cleanup() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      state._pmenuDismiss = null;
    }
    state._pmenuDismiss = cleanup;
  }

  // Build the profile popover for one deck instance. Mutates persisted config via
  // DeckModel helpers and re-renders; transient UI state (open/rename) lives on
  // the per-instance nav object.
  function buildProfileMenu(tile, instanceId, cfg, state) {
    const menu = el('div', 'deck-pmenu');
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.appendChild(el('div', 'deck-pmenu-head', tr('deck_profiles', 'Profili')));

    const list = el('div', 'deck-pmenu-list');
    cfg.profiles.forEach((p) => {
      const row = el('div', 'deck-pmenu-row' + (p.id === cfg.activeProfile ? ' active' : ''));
      if (state.editing && state.renamingProfile === p.id) {
        const inp = el('input', 'deck-pmenu-input');
        inp.type = 'text'; inp.value = p.name; inp.maxLength = 40;
        const commit = () => {
          if (state.renamingProfile !== p.id) return;   // already handled (blur after Enter)
          saveConfig(instanceId, window.DeckModel.renameProfile(getConfig(instanceId), p.id, inp.value));
          state.renamingProfile = null;
          render(tile, instanceId);
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.stopPropagation(); state.renamingProfile = null; render(tile, instanceId); }
        });
        inp.addEventListener('blur', commit);
        row.appendChild(inp);
        list.appendChild(row);
        return;
      }
      const pick = el('button', 'deck-pmenu-pick'); pick.type = 'button';
      pick.appendChild(el('span', 'deck-pmenu-dot'));
      pick.appendChild(el('span', 'deck-pmenu-name', p.name));
      pick.addEventListener('click', () => {
        // Read the store once: checking the captured cfg but mutating a fresh
        // read could act on two different versions of the config.
        const cur = getConfig(instanceId);
        state.volatileProfile = undefined;   // a manual pick always wins over auto-switch
        if (p.id !== cur.activeProfile) {
          saveConfig(instanceId, window.DeckModel.setActiveProfile(cur, p.id));
          state.path = []; state.pageIndex = 0;
        }
        closeProfileMenu(state, instanceId);
        render(tile, instanceId);
      });
      row.appendChild(pick);

      if (state.editing) {
        const tools = el('div', 'deck-pmenu-tools');
        const ren = el('button', 'deck-pmenu-tool'); ren.type = 'button';
        ren.innerHTML = EDIT_SVG; ren.title = tr('deck_profile_rename', 'Rinomina');
        ren.addEventListener('click', (e) => { e.stopPropagation(); state.renamingProfile = p.id; render(tile, instanceId); });
        tools.appendChild(ren);
        const save = el('button', 'deck-pmenu-tool'); save.type = 'button';
        save.innerHTML = SAVE_SVG; save.title = tr('deck_profile_save', 'Salva come preset');
        save.addEventListener('click', (e) => { e.stopPropagation(); saveProfileAsPreset(instanceId, p.id, p.name); render(tile, instanceId); });
        tools.appendChild(save);
        if (window.PresetShare && window.PresetShare.shareDeckProfile) {
          const share = el('button', 'deck-pmenu-tool'); share.type = 'button';
          share.innerHTML = SHARE_SVG; share.title = tr('deck_profile_share', 'Condividi');
          share.addEventListener('click', (e) => {
            e.stopPropagation();
            const profile = window.DeckModel.getProfile(getConfig(instanceId), p.id);
            closeProfileMenu(state, instanceId);
            render(tile, instanceId);
            window.PresetShare.shareDeckProfile(profile);
          });
          tools.appendChild(share);
        }
        const del = el('button', 'deck-pmenu-tool danger', '🗑'); del.type = 'button';
        del.title = tr('deck_profile_delete', 'Elimina'); del.disabled = cfg.profiles.length <= 1;
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          saveConfig(instanceId, window.DeckModel.removeProfile(getConfig(instanceId), p.id));
          if (window.forgetInstalledContentResource) {
            window.forgetInstalledContentResource('deckProfiles', { instanceId, profileId: p.id });
          }
          state.path = []; state.pageIndex = 0; state.renamingProfile = null;
          render(tile, instanceId);
        });
        tools.appendChild(del);
        row.appendChild(tools);
      }
      list.appendChild(row);
    });
    menu.appendChild(list);

    if (state.editing) {
      const add = el('button', 'deck-pmenu-add'); add.type = 'button';
      add.textContent = '＋ ' + tr('deck_profile_new', 'Nuovo profilo');
      add.addEventListener('click', () => {
        const cur = getConfig(instanceId);
        const name = tr('deck_profile_default', 'Profilo') + ' ' + (cur.profiles.length + 1);
        const next = window.DeckModel.addProfile(cur, name);
        saveConfig(instanceId, next);
        state.path = []; state.pageIndex = 0;
        state.renamingProfile = next.activeProfile;   // jump straight into naming the new profile
        render(tile, instanceId);
      });
      menu.appendChild(add);
      // Smart Profiles: configure app → profile auto-switch rules for this deck.
      const smart = el('button', 'deck-pmenu-add'); smart.type = 'button';
      smart.textContent = '⚡ ' + tr('deck_autoswitch_title', 'Profili smart');
      if (cfg.autoSwitch && cfg.autoSwitch.enabled) smart.classList.add('is-on');
      smart.addEventListener('click', () => {
        closeProfileMenu(state, instanceId);
        openAutoSwitchDialog(tile, instanceId);
      });
      menu.appendChild(smart);
    }

    // Virtual Deck: open this deck as its own always-on-top window on the PC
    // (view + press; editing stays here). Available outside edit mode too.
    const popupBtn = el('button', 'deck-pmenu-add'); popupBtn.type = 'button';
    popupBtn.textContent = '🖥 ' + tr('deck_popup_open', 'Apri sul PC');
    popupBtn.addEventListener('click', () => {
      closeProfileMenu(state, instanceId);
      fetch(deckBase() + '/deck/popup/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: instanceId }),
      }).catch(() => {});
      render(tile, instanceId);
    });
    menu.appendChild(popupBtn);

    // Profiles that exist on OTHER decks — tap to copy one into this deck. Lets a
    // freshly added (independent) deck reuse profiles built elsewhere without first
    // saving them as presets. Shown only when there are any to offer; the copy is
    // independent, so editing it here never touches the source deck.
    const others = listOtherDeckProfiles(instanceId);
    if (others.length) {
      menu.appendChild(el('div', 'deck-pmenu-head', tr('deck_profiles_other', 'Da un altro Deck')));
      const olist = el('div', 'deck-pmenu-list');
      others.forEach((op) => {
        const row = el('div', 'deck-pmenu-row');
        const pick = el('button', 'deck-pmenu-pick'); pick.type = 'button';
        pick.appendChild(el('span', 'deck-pmenu-name', op.name));
        pick.addEventListener('click', () => {
          copyDeckProfileInto(instanceId, op.instanceId, op.profileId);
          state.path = []; state.pageIndex = 0;
          closeProfileMenu(state, instanceId);
          render(tile, instanceId);
        });
        row.appendChild(pick);
        olist.appendChild(row);
      });
      menu.appendChild(olist);
    }

    // Saved profile presets: tap to add as a new profile here; (edit mode) delete
    // with the ×. Shown when there are presets, or always while editing so the
    // section is discoverable right after saving the first one.
    const presets = listProfilePresets();
    if (presets.length || state.editing) {
      menu.appendChild(el('div', 'deck-pmenu-head', tr('deck_presets', 'Preset profili')));
      const plist = el('div', 'deck-pmenu-list');
      if (!presets.length) {
        plist.appendChild(el('div', 'deck-pmenu-empty', tr('deck_presets_empty', 'Nessun preset salvato')));
      }
      presets.forEach((ps) => {
        const row = el('div', 'deck-pmenu-row');
        const pick = el('button', 'deck-pmenu-pick'); pick.type = 'button';
        pick.appendChild(el('span', 'deck-pmenu-name', ps.name));
        pick.addEventListener('click', () => {
          insertProfilePreset(instanceId, ps.id);
          state.path = []; state.pageIndex = 0;
          closeProfileMenu(state, instanceId);
          render(tile, instanceId);
        });
        row.appendChild(pick);
        if (state.editing) {
          const tools = el('div', 'deck-pmenu-tools');
          const del = el('button', 'deck-pmenu-tool danger', '×'); del.type = 'button';
          del.title = tr('preset_delete', 'Elimina preset');
          del.addEventListener('click', (e) => { e.stopPropagation(); deleteProfilePreset(ps.id); render(tile, instanceId); });
          tools.appendChild(del);
          row.appendChild(tools);
        }
        plist.appendChild(row);
      });
      menu.appendChild(plist);
    }

    // Clean up leftovers from removed deck tiles (configs that outlived their tile).
    // Shown only in edit mode and only when such orphans actually exist, so a tidy
    // dashboard never sees it. The current, live decks are never touched.
    if (state.editing) {
      const orphans = listOrphanInstances();
      if (orphans.length) {
        const clean = el('button', 'deck-pmenu-clean'); clean.type = 'button';
        clean.textContent = '🗑 ' + tr('deck_purge_orphans', 'Rimuovi Deck non più presenti') + ' (' + orphans.length + ')';
        clean.title = tr('deck_purge_orphans_hint', 'Elimina i profili rimasti da Deck rimossi dalla dashboard');
        clean.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof confirm === 'function' && !confirm(tr('deck_purge_orphans_confirm', 'Rimuovere i profili rimasti da Deck non più presenti sulla dashboard? I Deck attuali non vengono toccati.'))) return;
          purgeOrphanInstances();
          render(tile, instanceId);
        });
        menu.appendChild(clean);
      }
    }
    return menu;
  }

  function openEditor(tile, instanceId, navCtx, slotIndex, key) {
    if (!window.DeckEditor) return;
    const lookCfg = getConfig(instanceId);
    const look = deckLookFor(lookCfg, navCtx.profileId);
    window.DeckEditor.open({
      key: key || null,
      look: { capStyle: look.capStyle, keyShape: look.keyShape },
      onSave: (rawKey) => {
        const cfg = getConfig(instanceId);
        saveConfig(instanceId, window.DeckModel.setKeyAt(cfg, navCtx, slotIndex, rawKey));
        render(tile, instanceId);
      },
      onDelete: () => {
        const cfg = getConfig(instanceId);
        saveConfig(instanceId, window.DeckModel.setKeyAt(cfg, navCtx, slotIndex, null));
        render(tile, instanceId);
      },
      // "Apply this style to the whole page": repaint every placed key on the
      // page being edited with the style currently composed in the editor.
      onApplyStyle: (style) => {
        const cfg = getConfig(instanceId);
        saveConfig(instanceId, window.DeckModel.applyStyleToPage(cfg, navCtx, style));
        render(tile, instanceId);
      },
    });
  }

  // Render every deck tile in the DOM. The base tile has no instance attribute;
  // each duplicated copy carries data-dashboard-instance="deck~xxxx" (set by the
  // layout copy system), so each instance gets its own config + nav state.
  function renderAll() {
    const live = new Set();
    document.querySelectorAll('[data-dashboard-widget="deck"]').forEach((tile) => {
      const instanceId = tile.getAttribute('data-dashboard-instance') || 'deck';
      live.add(instanceId);
      render(tile, instanceId);
    });
    // Sweep auto-fit observers for instances no longer placed (widget or page
    // removed): setupAutoFit only cancels on a same-instance re-render, so a
    // removed instance would otherwise leak its ResizeObserver + closure.
    for (const [id, obs] of resizeObservers) {
      if (!live.has(id)) { obs.cancel(); resizeObservers.delete(id); }
    }
  }

  // Merge a new scene thumbnail and repaint the host key. Called by the SSE
  // 'obs_preview' handler. An empty image clears all previews.
  function setScenePreview(data) {
    if (data && typeof data === 'object') scenePreview = { scene: String(data.scene || ''), image: String(data.image || '') };
    applyScenePreview();
  }
  // Paint the on-air scene thumbnail onto ONE host key per deck instance, chosen by
  // priority: on-air scene key > any scene key > record key > stream key. Clears
  // every OBS key first so the host can move (e.g. on a scene change). The image is
  // set via the --deck-preview custom property (CSS uses it with !important), so a
  // key's accent background is left untouched and reappears when the preview clears.
  function applyScenePreview() {
    document.querySelectorAll('[data-dashboard-widget="deck"]').forEach((tile) => {
      const nodes = tile.querySelectorAll('.deck-key[data-obs-role]');
      nodes.forEach((n) => { n.classList.remove('has-preview'); n.style.removeProperty('--deck-preview'); });
      if (!scenePreview.image) return;
      const find = (pred) => Array.prototype.find.call(nodes, pred);
      const host =
        find((n) => n.dataset.obsRole === 'scene' && n._deckState && n._deckState.scene === scenePreview.scene)
        || find((n) => n.dataset.obsRole === 'scene')
        || find((n) => n.dataset.obsRole === 'record')
        || find((n) => n.dataset.obsRole === 'stream');
      if (host) {
        host.style.setProperty('--deck-preview', 'url("' + scenePreview.image + '")');
        host.classList.add('has-preview');
      }
    });
  }

  // Toast feedback while the server auto-launches OBS for a clicked OBS action.
  // {launching:true} → persistent "Avvio OBS…"; {launching:false, ok} → on success
  // swap to "OBS pronto" then dismiss; on failure (timeout) just dismiss (the key's
  // red flash already signals the error — don't claim "pronto").
  function setObsLaunching(data) {
    const on = !!(data && data.launching);
    let toast = document.getElementById('deck-obs-toast');
    if (on) {
      if (obsToastTimer) { clearTimeout(obsToastTimer); obsToastTimer = null; }
      if (!toast) { toast = document.createElement('div'); toast.id = 'deck-obs-toast'; toast.className = 'deck-toast'; document.body.appendChild(toast); }
      toast.textContent = '⏳ ' + (typeof t === 'function' ? t('deck_obs_launching') : 'Avvio OBS…');
      requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
    } else if (toast) {
      if (obsToastTimer) clearTimeout(obsToastTimer);
      if (data && data.ok) {
        toast.textContent = '✓ ' + (typeof t === 'function' ? t('deck_obs_ready') : 'OBS pronto');
        obsToastTimer = setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 400); obsToastTimer = null; }, 2000);
      } else {
        toast.classList.remove('visible'); setTimeout(() => toast.remove(), 400); obsToastTimer = null;
      }
    }
  }

  // ── Live key faces (timer countdown / SDK state text) ────────────────────
  // One key face may show a live value badge. The 1s ticker exists ONLY while a
  // rendered timer-bound key is actually counting down, and stops itself the
  // moment none is — no periodic work while the deck is static.
  let liveTicker = null;

  function paintLiveFace(node) {
    const out = window.DeckModel.formatLiveValue(node._deckLive, stateSnapshot, Date.now());
    const badge = node.querySelector('.deck-key-live');
    if (!badge) return false;
    badge.textContent = out.text;
    if (out.color) badge.style.color = out.color;
    else badge.style.removeProperty('color');
    node.classList.toggle('has-live', !!out.text);
    // "Still ticking" = a timer binding whose resolved entry is running.
    if (node._deckLive.source !== 'timer') return false;
    const bag = stateSnapshot.timers || {};
    const name = node._deckLive.name;
    // bag keys are LOWERCASED (timersByLabel) — mirror formatLiveValue's lookup
    // or a mixed-case binding paints once and never starts the 1s ticker.
    if (name) { const t = bag[String(name).toLowerCase()]; return !!(t && t.status === 'running'); }
    return Object.values(bag).some((t) => t && t.status === 'running');
  }

  function applyLiveFaces() {
    let ticking = false;
    document.querySelectorAll('.deck-key[data-live-bound]').forEach((node) => {
      if (paintLiveFace(node)) ticking = true;
    });
    if (ticking && !liveTicker) liveTicker = setInterval(applyLiveFaces, 1000);
    else if (!ticking && liveTicker) { clearInterval(liveTicker); liveTicker = null; }
  }

  // Swap a key's face to its alternate ON style (icon glyph / label / accent)
  // and restore the original losslessly when the state turns off. The base
  // icon's real nodes are parked in a fragment (never rebuilt from strings), so
  // image/builtin faces survive the round-trip; all text goes via textContent.
  function applyStateStyle(node, on) {
    const ss = node._deckStateStyle;
    const base = node._ssBase;
    if (!ss || !base || on === node._ssApplied) return;
    node._ssApplied = on;
    if (ss.icon) {
      if (on && !base.iconFrag) {
        base.iconFrag = document.createDocumentFragment();
        while (base.ico.firstChild) base.iconFrag.appendChild(base.ico.firstChild);
        base.ico.textContent = ss.icon;
      } else if (!on && base.iconFrag) {
        base.ico.textContent = '';
        base.ico.appendChild(base.iconFrag);
        base.iconFrag = null;
      }
    }
    if (ss.label) base.labelEl.textContent = on ? ss.label : base.labelText;
    if (ss.color) {
      if (on) { node.classList.add('has-accent'); node.style.setProperty('--key-accent', ss.color); }
      else if (base.accent) { node.style.setProperty('--key-accent', base.accent); }
      else { node.style.removeProperty('--key-accent'); node.classList.remove('has-accent'); }
    }
  }

  // Toggle .is-on for every state-bound key node against the current snapshot.
  function applyKeyStates() {
    document.querySelectorAll('.deck-key[data-state-bound]').forEach((node) => {
      const on = window.DeckModel.evaluateKeyState(node._deckState, stateSnapshot);
      node.classList.toggle('is-on', on);
      applyStateStyle(node, on);
      const light = node._deckLight;
      if (light && light.when === 'state') {
        if (on && !node._wasOn) runAction(lightingAction(light, true));        // turned on → light up
        else if (!on && node._wasOn) runAction(lightingAction(light, false));  // turned off → restore
      }
      node._wasOn = on;
    });
    applyLiveFaces();
    applySliderValues();
  }

  // Merge a partial state update (e.g. { micMuted: true }) and re-apply. Called
  // by the mic/speaker mute handlers so keys reflect live state without polling.
  // Change-guarded on primitives: the `media` SSE beats every ~2s during
  // playback with usually-unchanged mediaPlaying/mediaSource, and re-running
  // the three DOM passes for that would be constant idle work. Object payloads
  // (timers/haStates/sdkStates/obsMutes…) arrive only on real events and are
  // fresh objects each push, so they always count as changed.
  function refreshStates(partial) {
    if (!partial || typeof partial !== 'object') { applyKeyStates(); return; }
    let changed = false;
    for (const k of Object.keys(partial)) {
      const next = partial[k];
      const prev = stateSnapshot[k];
      if (next !== null && typeof next === 'object') { changed = true; }
      else if (!Object.is(prev, next)) { changed = true; }   // Object.is: NaN === NaN for the volume fields
      stateSnapshot[k] = next;
    }
    if (changed) applyKeyStates();
  }

  // ── Smart Profiles config dialog (per-deck app → profile rules) ─────────
  // Small self-contained modal: enable toggle, revert behaviour, rule rows
  // (exe + profile) with an app suggestion list from the open-windows endpoint.
  // Saves through the normal ops outbox (normalizeAutoSwitch re-validates).
  function openAutoSwitchDialog(tile, instanceId) {
    document.querySelectorAll('.deck-asw-backdrop').forEach((n) => n.remove());
    const cfg = getConfig(instanceId);
    const model = {
      enabled: !!(cfg.autoSwitch && cfg.autoSwitch.enabled),
      revert: (cfg.autoSwitch && cfg.autoSwitch.revert) || 'default',
      rules: ((cfg.autoSwitch && cfg.autoSwitch.rules) || []).map((r) => ({ exe: r.exe, profile: r.profile })),
    };
    const backdrop = el('div', 'deck-asw-backdrop deck-ed-backdrop');
    const modal = el('div', 'deck-asw deck-ed');
    modal.appendChild(el('div', 'deck-ed-title', tr('deck_autoswitch_title', 'Profili smart')));
    modal.appendChild(el('div', 'deck-ed-hint', tr('deck_autoswitch_hint', "Cambia profilo da solo quando un'app va in primo piano.")));
    // Enable toggle
    const enRow = el('label', 'deck-asw-row deck-asw-enable');
    const enChk = el('input', ''); enChk.type = 'checkbox'; enChk.checked = model.enabled;
    enChk.addEventListener('change', () => { model.enabled = enChk.checked; });
    enRow.appendChild(enChk);
    enRow.appendChild(el('span', '', tr('deck_autoswitch_enable', 'Attiva il cambio automatico')));
    modal.appendChild(enRow);
    // Revert behaviour
    const revRow = el('div', 'deck-asw-row');
    revRow.appendChild(el('span', 'deck-ed-label', tr('deck_autoswitch_revert', 'Quando nessuna regola corrisponde')));
    const revSel = document.createElement('select'); revSel.className = 'deck-ed-input';
    [['default', tr('deck_autoswitch_revert_default', 'Torna al profilo attivo')], ['stay', tr('deck_autoswitch_revert_stay', "Resta sull'ultimo profilo")]].forEach(([v, lab]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = lab; revSel.appendChild(o);
    });
    revSel.value = model.revert;
    revSel.addEventListener('change', () => { model.revert = revSel.value; });
    revRow.appendChild(revSel);
    modal.appendChild(revRow);
    // Rules list
    const rulesHost = el('div', 'deck-asw-rules');
    const profileNames = cfg.profiles.map((p) => p.name);
    // App suggestions (running windows) — best-effort; free-typed exe always works.
    let appOptions = [];
    fetch(deckBase() + '/windows').then((r) => r.json()).then((d) => {
      const seen = new Set();
      appOptions = ((d && d.windows) || []).map((w) => String(w.app || '').toLowerCase().replace(/\.exe$/, ''))
        .filter((p) => p && !seen.has(p) && seen.add(p));
      paintRules();
    }).catch(() => {});
    function paintRules() {
      rulesHost.replaceChildren();
      model.rules.forEach((rule, idx) => {
        const row = el('div', 'deck-asw-rule');
        const exeIn = el('input', 'deck-ed-input'); exeIn.type = 'text'; exeIn.value = rule.exe;
        exeIn.placeholder = tr('deck_autoswitch_exe_ph', 'es. obs64');
        exeIn.maxLength = 60;
        exeIn.setAttribute('list', 'deck-asw-apps');
        exeIn.addEventListener('input', () => { rule.exe = exeIn.value.trim().toLowerCase().replace(/\.exe$/, ''); });
        row.appendChild(exeIn);
        const profSel = document.createElement('select'); profSel.className = 'deck-ed-input';
        profileNames.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; profSel.appendChild(o); });
        if (rule.profile && !profileNames.includes(rule.profile)) {
          const o = document.createElement('option'); o.value = rule.profile; o.textContent = rule.profile; profSel.appendChild(o);
        }
        profSel.value = rule.profile || profileNames[0];
        rule.profile = profSel.value;
        profSel.addEventListener('change', () => { rule.profile = profSel.value; });
        row.appendChild(profSel);
        const rm = el('button', 'deck-pmenu-tool danger', '✕'); rm.type = 'button';
        rm.addEventListener('click', () => { model.rules.splice(idx, 1); paintRules(); });
        row.appendChild(rm);
        rulesHost.appendChild(row);
      });
      // Shared datalist of running apps for the exe inputs.
      let dl = document.getElementById('deck-asw-apps');
      if (!dl) { dl = document.createElement('datalist'); dl.id = 'deck-asw-apps'; document.body.appendChild(dl); }
      dl.replaceChildren();
      appOptions.forEach((p) => { const o = document.createElement('option'); o.value = p; dl.appendChild(o); });
    }
    paintRules();
    modal.appendChild(rulesHost);
    const addRule = el('button', 'deck-pmenu-add'); addRule.type = 'button';
    addRule.textContent = '＋ ' + tr('deck_autoswitch_add', 'Aggiungi regola');
    addRule.addEventListener('click', () => {
      if (model.rules.length >= 16) return;
      model.rules.push({ exe: '', profile: profileNames[0] || '' });
      paintRules();
    });
    modal.appendChild(addRule);
    // Actions
    const actions = el('div', 'deck-ed-actions');
    const cancel = el('button', 'deck-ed-btn', tr('deck_edit_cancel', 'Annulla')); cancel.type = 'button';
    cancel.addEventListener('click', () => backdrop.remove());
    const save = el('button', 'deck-ed-btn primary', tr('deck_edit_save', 'Salva')); save.type = 'button';
    save.addEventListener('click', () => {
      const cur = getConfig(instanceId);
      const next = window.DeckModel.cloneConfig(cur);
      next.autoSwitch = { enabled: model.enabled, revert: model.revert, rules: model.rules };
      saveConfig(instanceId, window.DeckModel.normalizeDeckConfig(next));
      backdrop.remove();
      // Re-evaluate right away against the current foreground app.
      lastForegroundProc = null;
      render(tile, instanceId);
    });
    actions.append(cancel, save);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
  }

  // ── Smart Profiles: foreground-app → profile auto-switch ───────────────
  // Called from main.js on every `status` SSE push with the foreground exe name
  // (lowercased, no ".exe"). Display-only: a match overrides which profile is
  // rendered via a per-instance volatile flag; the durable activeProfile (and
  // the ops outbox) is never touched. A manual profile pick clears the flag.
  let lastForegroundProc = null;
  function onForegroundProcess(proc) {
    const p = String(proc == null ? '' : proc).toLowerCase().replace(/\.exe$/, '');
    if (p === lastForegroundProc) return;   // status pushes every 3s — only act on change
    lastForegroundProc = p;
    let changed = false;
    for (const { instanceId } of deckInstances()) {
      const cfg = getConfig(instanceId);
      const asw = cfg.autoSwitch;
      if (!asw || !asw.enabled || !asw.rules.length) continue;
      const state = navOf(instanceId);
      if (state.editing) continue;   // never yank the deck out from under an edit session
      const rule = p ? asw.rules.find((r) => r.exe === p) : null;
      let next = state.volatileProfile || '';
      if (rule) {
        const prof = cfg.profiles.find((x) => x.name.toLowerCase() === rule.profile.toLowerCase());
        if (prof) next = prof.id;
      } else if (asw.revert !== 'stay') {
        next = '';
      }
      if (next !== (state.volatileProfile || '')) {
        state.volatileProfile = next || undefined;
        state.path = [];
        state.pageIndex = 0;
        changed = true;
      }
    }
    if (changed) renderAll();
  }

  // ── Profile control surface for Xenon AI (voice + chat) ───────────────
  // Every deck tile in the DOM with its per-instance id (the base tile has none;
  // duplicated copies carry data-dashboard-instance="deck~xxxx").
  function deckInstances() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="deck"]'))
      .map((tile) => ({ tile, instanceId: tile.getAttribute('data-dashboard-instance') || 'deck' }));
  }

  // The distinct profile names across all deck instances, each flagged if it's the
  // active profile in any instance. Sent to the AI so it can switch by exact name.
  function listProfiles() {
    const seen = new Map();   // lowercased name -> { name, active }
    for (const { instanceId } of deckInstances()) {
      const cfg = getConfig(instanceId);
      for (const p of cfg.profiles) {
        const isActive = p.id === cfg.activeProfile;
        const existing = seen.get(p.name.toLowerCase());
        if (!existing) seen.set(p.name.toLowerCase(), { name: p.name, active: isActive });
        else if (isActive) existing.active = true;
      }
    }
    return Array.from(seen.values());
  }

  // Switch every deck instance that owns a profile matching `name` — exact
  // (case-insensitive) first, else a unique substring match. Returns a summary
  // the AI relays to the user. Used by ai.js for the switch_deck_profile action.
  function switchProfileByName(name) {
    const want = String(name == null ? '' : name).trim().toLowerCase();
    if (!want) return { ok: false, error: 'no_name' };
    let switched = 0, matchedName = '';
    for (const { tile, instanceId } of deckInstances()) {
      const cfg = getConfig(instanceId);
      const exact = cfg.profiles.find((p) => p.name.toLowerCase() === want);
      const subs = cfg.profiles.filter((p) => p.name.toLowerCase().includes(want));
      const target = exact || (subs.length === 1 ? subs[0] : null);
      if (!target) continue;
      matchedName = target.name;
      navOf(instanceId).volatileProfile = undefined;     // explicit switch overrides auto-switch
      if (target.id === cfg.activeProfile) continue;     // already active here
      saveConfig(instanceId, window.DeckModel.setActiveProfile(cfg, target.id));
      const state = navOf(instanceId);
      state.path = []; state.pageIndex = 0; closeProfileMenu(state, instanceId);
      render(tile, instanceId);
      switched++;
    }
    if (!matchedName) return { ok: false, error: 'not_found', name };
    if (switched > 0) showDeckToast('✦ ' + matchedName);
    return { ok: true, switched, name: matchedName };
  }

  // Genesis: create an AI-composed profile (new keys, grid sized to fit) on the
  // requested deck instance and switch to it. `spec.instanceId` targets the deck
  // tile on the page Genesis just composed (a duplicated copy gets its own id),
  // so the user's already-configured deck on another page is never touched.
  // `spec.keys` are raw key objects already mapped and action-validated by
  // genesis.js; normalizeDeckConfig re-validates everything before persisting.
  function applyGenesisDeck(spec) {
    const M = window.DeckModel;
    if (!M || !spec || !Array.isArray(spec.keys) || !spec.keys.length) return false;
    const instanceId = (typeof spec.instanceId === 'string' && spec.instanceId) ? spec.instanceId : 'deck';
    const rawKeys = spec.keys.slice(0, 32);
    // Grid shape: honour the model's cols×rows when sane, else derive a balanced
    // grid from the key count (4 → 2x2, 6 → 3x2, 8 → 4x2, …).
    const n = rawKeys.length;
    const autoRows = n <= 3 ? 1 : n <= 8 ? 2 : 3;
    const autoCols = Math.ceil(n / autoRows);
    const clampDim = (v, fb) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x >= 1 ? Math.min(8, x) : fb; };
    const wantCols = clampDim(spec.cols, autoCols);
    const wantRows = clampDim(spec.rows, autoRows);
    // Work on this instance's own durable config (never the render-only auto-fit
    // override) and only GROW the grid so existing profiles keep their exact layout.
    let cfg = durableConfig(instanceId);
    cfg = M.reshapeDeckConfig(cfg, Math.max(cfg.cols, wantCols), Math.max(cfg.rows, wantRows), { preserve: true });
    // A pristine deck (no key placed in any profile — e.g. the fresh copy on a
    // Genesis page) gets the AI profile as its ONLY one, instead of keeping an
    // empty "Profile 1" alongside. A configured deck keeps all its profiles.
    const hasAnyKey = cfg.profiles.some(p =>
      (p.root && Array.isArray(p.root.pages) ? p.root.pages : []).some(pg =>
        (Array.isArray(pg.keys) ? pg.keys : []).some(Boolean)));
    let next = M.addProfile(cfg, spec.profile);
    if (!hasAnyKey) {
      const keepId = next.activeProfile;
      next.profiles = next.profiles.filter(p => p.id === keepId);
      next = M.normalizeDeckConfig(next);
      next.activeProfile = keepId;
    }
    const prof = next.profiles.find(p => p.id === next.activeProfile);
    if (!prof) return false;
    const slots = next.cols * next.rows;
    const pages = [];
    for (let i = 0; i < rawKeys.length; i += slots) pages.push({ keys: rawKeys.slice(i, i + slots) });
    prof.root = { pages };
    saveConfig(instanceId, M.normalizeDeckConfig(next));
    const state = navOf(instanceId);
    state.path = []; state.pageIndex = 0;
    renderAll();
    showDeckToast('✦ ' + prof.name);
    return true;
  }

  // AI-composed deck (the configure_deck tool): unlike Genesis' curated enum,
  // this accepts the FULL action catalog — every action re-validated through
  // DeckActions.validateAction, every key through normalizeDeckConfig, states/
  // live/slider/stateStyle through their normalizers. Returns {ok,...} so the
  // AI can relay an honest outcome.
  function applyAiDeck(spec) {
    const A = window.DeckActions;
    const M = window.DeckModel;
    if (!A || !M || !spec || typeof spec !== 'object') return { ok: false, error: 'bad_spec' };
    const keys = [];
    for (const k of (Array.isArray(spec.keys) ? spec.keys.slice(0, 32) : [])) {
      if (!k || typeof k !== 'object') continue;
      const key = { kind: k.kind === 'slider' ? 'slider' : 'action', title: String(k.title || '').slice(0, 40) };
      if (k.icon) key.icon = { type: 'emoji', value: String(k.icon).slice(0, 8) };
      if (k.color) key.bg = String(k.color).slice(0, 9);
      if (key.kind === 'slider') {
        if (!k.slider || typeof k.slider !== 'object') continue;
        key.slider = k.slider;   // normalizeSlider re-validates (invalid → key drops)
      } else {
        const toSteps = (list) => (Array.isArray(list) ? list : (list ? [list] : []))
          .map((a) => ({ action: A.validateAction(a), delayMs: Math.max(0, Math.round(Number(a && a.delayMs) || 0)) }))
          .filter((s) => s.action);
        const trig = {};
        const tap = toSteps(k.actions || k.action);
        const dbl = toSteps(k.double);
        const hold = toSteps(k.hold);
        if (tap.length) trig.tap = A.compactTrigger(tap);
        if (dbl.length) trig.double = A.compactTrigger(dbl);
        if (hold.length) trig.hold = A.compactTrigger(hold);
        if (!Object.keys(trig).length) continue;   // an action key with no valid action is noise
        key.triggers = trig;
        if (k.state && typeof k.state === 'object') key.state = k.state;
        if (k.live && typeof k.live === 'object') key.live = k.live;
        if (k.stateStyle && typeof k.stateStyle === 'object') key.stateStyle = k.stateStyle;
      }
      keys.push(key);
    }
    let applied = false;
    if (keys.length) {
      applied = applyGenesisDeck({
        instanceId: (typeof spec.instance === 'string' && spec.instance) || 'deck',
        profile: String(spec.profileName || 'AI Deck').slice(0, 40),
        cols: spec.cols, rows: spec.rows,
        keys,
      });
    }
    // Optional Smart-Profiles rules ride the same call ("switch to it when OBS
    // is focused"). normalizeAutoSwitch re-validates; display-only at runtime.
    if (spec.autoSwitch && typeof spec.autoSwitch === 'object') {
      const instanceId = (typeof spec.instance === 'string' && spec.instance) || 'deck';
      const next = window.DeckModel.cloneConfig(getConfig(instanceId));
      next.autoSwitch = spec.autoSwitch;
      saveConfig(instanceId, window.DeckModel.normalizeDeckConfig(next));
      lastForegroundProc = null;   // re-evaluate against the current app
      renderAll();
      applied = true;
    }
    return applied ? { ok: true, keys: keys.length } : { ok: false, error: keys.length ? 'apply_failed' : 'no_valid_keys' };
  }

  // Live per-app volume mixer in a touch overlay, opened by an `appMixer` Deck key
  // (Stream-Deck-style fader pad). It reuses the dashboard's app-mixer row builder
  // and per-app handlers (volume.js globals) and keeps its own container, polling
  // /audio while open so the faders track external changes — but skipping a refresh
  // mid-drag (appMixBusy) so it never fights an in-progress gesture. Self-stopping:
  // the poll is cleared on close, keeping it lightweight.
  let deckMixTimer = null;
  function deckMixEsc(e) { if (e.key === 'Escape') closeDeckMixer(); }
  function closeDeckMixer() {
    if (deckMixTimer) { clearInterval(deckMixTimer); deckMixTimer = null; }
    const bd = document.getElementById('deck-mix-backdrop');
    if (bd) bd.remove();
    document.removeEventListener('keydown', deckMixEsc);
  }
  async function renderDeckMixApps() {
    const host = document.getElementById('deck-mix-apps');
    if (!host) return;
    // Don't redraw while the user is dragging a fader (would reset the thumb).
    if (typeof appMixBusy === 'function' && appMixBusy() && host.querySelector('.app-mix-slider')) return;
    let apps = [];
    try {
      const res = await fetch((typeof SERVER !== 'undefined' ? SERVER : '') + '/audio');
      const data = await res.json();
      apps = Array.isArray(data && data.speakerApps) ? data.speakerApps : [];
    } catch { return; }   // offline: keep whatever's shown
    if (!host.isConnected) return;
    if (!apps.length || typeof buildAppMixerRow !== 'function') {
      host.replaceChildren(el('div', 'deck-mix-empty', tr('deck_mix_empty', 'No app is playing audio right now')));
      return;
    }
    // buildAppMixerRow escapes its user-controlled fields (escHtml on name/id);
    // this is the same builder the dashboard's speaker mixer uses.
    host.innerHTML = apps.map(buildAppMixerRow).join('');
  }
  function openDeckMixer() {
    closeDeckMixer();
    const backdrop = el('div', 'deck-mix-backdrop'); backdrop.id = 'deck-mix-backdrop';
    const modal = el('div', 'deck-mix-modal');
    const head = el('div', 'deck-mix-head');
    head.appendChild(el('h3', 'deck-mix-title', tr('deck_mix_title', 'App volume')));
    const x = el('button', 'deck-mix-close', '✕'); x.type = 'button'; x.setAttribute('aria-label', tr('close', 'Close'));
    x.addEventListener('click', closeDeckMixer);
    head.appendChild(x);
    modal.appendChild(head);
    const apps = el('div', 'deck-mix-apps'); apps.id = 'deck-mix-apps';
    apps.appendChild(el('div', 'deck-mix-empty', tr('deck_mix_loading', 'Loading…')));
    modal.appendChild(apps);
    backdrop.appendChild(modal);
    // Swallow the ghost click that opened us: Deck keys fire on pointerup, and the
    // browser then sends a trailing `click` at the same spot — which lands on this
    // freshly-shown backdrop and would close the mixer instantly (so the key looked
    // dead). Ignore backdrop dismissals within a short grace window after opening.
    const openedAt = Date.now();
    backdrop.addEventListener('click', (e) => {
      if (Date.now() - openedAt < 450) return;       // opening ghost click
      if (e.target === backdrop) closeDeckMixer();
    });
    // Delegated row handlers reuse the dashboard's per-app volume/mute logic.
    apps.addEventListener('input', (e) => { const s = e.target.closest('.app-mix-slider'); if (s && typeof handleAppMixInput === 'function') handleAppMixInput(s); });
    apps.addEventListener('click', (e) => { const b = e.target.closest('.app-mix-mute'); if (b && typeof handleAppMixMute === 'function') handleAppMixMute(b); });
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', deckMixEsc);
    renderDeckMixApps();
    deckMixTimer = setInterval(renderDeckMixApps, 2500);
    requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('visible')));
  }

  // Brief glassy toast (shares the OBS toast styling) for AI-driven switches, so
  // a voice/chat profile change is visible even when the deck isn't in focus.
  let deckToastTimer = null;
  function showDeckToast(msg) {
    let toast = document.getElementById('deck-toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'deck-toast'; toast.className = 'deck-toast'; document.body.appendChild(toast); }
    toast.textContent = msg;
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
    if (deckToastTimer) clearTimeout(deckToastTimer);
    deckToastTimer = setTimeout(() => { toast.classList.remove('visible'); }, 1800);
  }

  if (typeof window !== 'undefined') {
    window.Deck = { render, renderAll, refreshStates, setScenePreview, setObsLaunching, updateMedia: applyDeckMedia, listProfiles, switchProfileByName, applyGenesisDeck, forgetInstance, listKeyPresets, saveKeyPreset, deleteKeyPreset, renderKeyPreview, onServerDeckRev, listDeckTargets, listAllDeckProfiles, getProfileTemplate, importSharedProfile, listImportedResources, removeImportedResources, onForegroundProcess, applyAiDeck, independentDecks: true };
    // First paint from the fast local copy, then adopt the server copy (the source
    // of truth — restores keys after a WebView storage wipe). Any outbox entries
    // left from a previous session are flushed right away. Once the layout is up,
    // drop any empty orphaned copy configs left by older removals.
    const bootDeck = () => {
      for (const k of LEGACY_REV_KEYS) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
      migrateDeckLibrary();
      renderAll();
      if (Object.keys(readDirty()).length) queueDeckFlush();
      hydrateDeckFromServer();
      setTimeout(pruneOrphanEmptyConfigs, 4000);
    };
    if (document.readyState !== 'loading') bootDeck();
    else document.addEventListener('DOMContentLoaded', bootDeck);
    window.addEventListener('pagehide', sendDeckBeacon);
  }
})();

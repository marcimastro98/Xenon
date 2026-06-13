'use strict';
// Pure, requireable helpers for the Deck widget. Shared by the client
// (window.DeckModel) and tests (require). No DOM/browser use.

const DECK_MIN = 1;
// Up to 8 keys per axis (Stream Deck XL is 8 wide): a wide deck screen needs more
// than 6 columns to fill edge-to-edge with square caps instead of letterboxing.
const DECK_MAX = 8;

// Target cell footprint (px, including the inter-key gap budget) for each key-size
// preset. Used by gridForSize to decide how many columns/rows fit a given tile so
// the deck shows "more, smaller keys" or "fewer, larger keys" as the user prefers.
const KEY_SIZES = { sm: 56, md: 76, lg: 104 };
const KEY_GAP = 10;

// Per-key tap feedback animations (the visual played when a key fires) and image
// fit modes (how an uploaded picture sits inside the square cap).
const PRESS_FX = ['glow', 'press', 'stay', 'flash', 'off'];
const ICON_FITS = ['cover', 'contain', 'small'];

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampStr(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeKey(raw, cols, rows) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'folder' ? 'folder' : (raw.kind === 'action' ? 'action' : null);
  if (!kind) return null;
  const key = {
    // id assigned once on normalization; re-normalizing the same raw object yields a new id.
    id: clampStr(raw.id, 64) || ('k_' + Math.random().toString(36).slice(2, 8)),
    kind,
    title: clampStr(raw.title, 40),
    icon: normalizeIcon(raw.icon),
    // Tap feedback animation played when the key fires (glow ring by default).
    press: PRESS_FX.includes(raw.press) ? raw.press : 'glow',
  };
  // Accent must be a clean hex colour (it is interpolated into a CSS color-mix()
  // at render time); anything else is dropped so the key simply has no tint.
  if (raw.bg && /^#[0-9a-fA-F]{3,8}$/.test(String(raw.bg).trim())) key.bg = String(raw.bg).trim();
  // Optional colour for the tap-feedback effect (glow / blink / hold tint). Same hex
  // validation as the accent; dropped when absent so the effect uses its default.
  if (raw.pressColor && /^#[0-9a-fA-F]{3,8}$/.test(String(raw.pressColor).trim())) key.pressColor = String(raw.pressColor).trim();
  if (kind === 'folder') {
    key.folder = normalizeFolder(raw.folder, cols, rows);
  } else {
    key.triggers = (raw.triggers && typeof raw.triggers === 'object' && !Array.isArray(raw.triggers))
      ? Object.assign({}, raw.triggers)
      : {};
    if (raw.state && typeof raw.state === 'object' && raw.state.source) {
      key.state = { source: clampStr(raw.state.source, 32) };
      if (raw.state.scene) key.state.scene = clampStr(raw.state.scene, 200);
      if (raw.state.input) key.state.input = clampStr(raw.state.input, 200);
    }
    // Optional LED reaction: light the RGB when this key fires ('press') or while
    // its bound state is active ('state'). Requires a valid hex colour, else dropped.
    if (raw.light && typeof raw.light === 'object'
        && raw.light.color && /^#[0-9a-fA-F]{3,8}$/.test(String(raw.light.color).trim())) {
      key.light = {
        when: raw.light.when === 'state' ? 'state' : 'press',
        color: String(raw.light.color).trim(),
        style: ['solid', 'breathing', 'cycle'].includes(raw.light.style) ? raw.light.style : 'solid',
      };
    }
  }
  return key;
}

// Per-type value limits. An emoji is a handful of code points; a builtin is a
// short library id; an image is a data:/blob:/http(s) URL — a data URL of even a
// small downscaled icon runs to tens of thousands of chars, so it gets a far
// larger cap (clamping to 256 truncated it into a corrupt URL → broken image).
const ICON_MAX = { emoji: 32, builtin: 48, image: 1_500_000 };

function normalizeIcon(raw) {
  const type = raw && (raw.type === 'image' || raw.type === 'builtin') ? raw.type : 'emoji';
  let value = clampStr(raw && raw.value, ICON_MAX[type]);
  // An image value must be a safe, self-contained reference (no javascript:, etc.).
  // Anything else is dropped so the key falls back to its default glyph.
  if (type === 'image' && !/^(data:image\/|blob:|https?:\/\/)/i.test(value)) value = '';
  const icon = { type, value };
  // Image fit: how the picture sits in the cap — 'cover' (full-bleed, default),
  // 'contain' (whole image with padding), or 'small' (compact centred icon).
  if (type === 'image') icon.fit = ICON_FITS.includes(raw && raw.fit) ? raw.fit : 'cover';
  return icon;
}

function emptyPage(slots) {
  return { keys: new Array(slots).fill(null) };
}

function normalizePage(raw, cols, rows) {
  const slots = cols * rows;
  const src = (raw && Array.isArray(raw.keys)) ? raw.keys : [];
  const keys = new Array(slots).fill(null);
  for (let i = 0; i < slots; i++) keys[i] = normalizeKey(src[i], cols, rows);
  return { keys };
}

function normalizeFolder(raw, cols, rows) {
  const slots = cols * rows;
  const src = (raw && Array.isArray(raw.pages) && raw.pages.length) ? raw.pages : [emptyPage(slots)];
  return { pages: src.map(p => normalizePage(p, cols, rows)) };
}

function normalizeProfile(raw, cols, rows, index) {
  const id = clampStr(raw && raw.id, 64) || ('prof_' + index);
  return {
    id,
    name: clampStr(raw && raw.name, 40) || ('Profile ' + (index + 1)),
    root: normalizeFolder(raw && raw.root, cols, rows),
  };
}

function normalizeDeckConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cols = clampInt(src.cols, DECK_MIN, DECK_MAX, 3);
  const rows = clampInt(src.rows, DECK_MIN, DECK_MAX, 2);
  const rawProfiles = Array.isArray(src.profiles) && src.profiles.length ? src.profiles : [null];
  const profiles = rawProfiles.map((p, i) => normalizeProfile(p, cols, rows, i));
  const ids = new Set(profiles.map(p => p.id));
  const activeProfile = ids.has(src.activeProfile) ? src.activeProfile : profiles[0].id;
  // Presentation prefs (additive; older configs default sensibly):
  //  keySize  — visual key footprint preset, also drives auto-fit density
  //  autoFit  — recompute cols/rows from the tile size on resize (on by default)
  //  showMedia— dock the now-playing mini player under the key grid
  const keySize = ['sm', 'md', 'lg'].includes(src.keySize) ? src.keySize : 'md';
  const autoFit = src.autoFit !== false;
  const showMedia = src.showMedia === true;
  return { version: 1, cols, rows, keySize, autoFit, showMedia, profiles, activeProfile };
}

// How many columns/rows of `keySize` keys fit a tile of (width × height) px.
// Clamped to the deck's [1..6] range; falls back to a 3×2 grid for tiny/unknown
// sizes. The +gap maths matches the CSS grid's gap so the fit is honest.
function gridForSize(width, height, keySize) {
  const cell = KEY_SIZES[keySize] || KEY_SIZES.md;
  const w = Number(width), h = Number(height);
  const fit = (px, fallback) => {
    const n = Math.floor((px + KEY_GAP) / (cell + KEY_GAP));
    return Number.isFinite(n) && n >= DECK_MIN ? Math.min(n, DECK_MAX) : fallback;
  };
  let cols = fit(w, 3), rows = fit(h, 2);
  // Square caps letterbox when the grid's column:row ratio doesn't match the screen:
  // the shorter axis sets the cap size and the longer axis is left with empty space.
  // Expand the count on each axis to that square cap size so the caps reach the edges
  // — a wide screen fills with more columns (Stream Deck XL style) instead of a
  // centred block flanked by empty columns.
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    const sq = Math.min((w - (cols - 1) * KEY_GAP) / cols, (h - (rows - 1) * KEY_GAP) / rows);
    if (sq > 0) {
      const fitAt = (px) => Math.max(DECK_MIN, Math.min(DECK_MAX, Math.floor((px + KEY_GAP) / (sq + KEY_GAP))));
      cols = Math.max(cols, fitAt(w));
      rows = Math.max(rows, fitAt(h));
    }
  }
  return { cols, rows };
}

// Walk every page in the config (each profile root + nested folders), calling
// fn(page). Used by the reshape pass below.
function eachPage(cfg, fn) {
  const walk = (folder) => {
    for (const page of folder.pages) {
      fn(page);
      for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) walk(k.folder);
    }
  };
  for (const prof of cfg.profiles) walk(prof.root);
}

// Largest number of placed keys on any single page — the floor below which the
// grid must not shrink, or keys would be lost.
function maxOccupied(cfg) {
  let m = 0;
  eachPage(cfg, (page) => { const n = page.keys.filter(Boolean).length; if (n > m) m = n; });
  return m;
}

// Highest occupied SLOT INDEX + 1 across every page — i.e. the minimum number of
// slots needed to keep every key exactly where the user put it (gaps included).
// Used by { preserve } reshapes so the grid grows to hold a key at, say, slot 7
// instead of repacking it forward.
function maxOccupiedIndex(cfg) {
  let m = 0;
  eachPage(cfg, (page) => {
    for (let i = page.keys.length - 1; i >= 0; i--) {
      if (page.keys[i]) { if (i + 1 > m) m = i + 1; break; }
    }
  });
  return m;
}

// Resize the deck grid to cols×rows without ever dropping a placed key. The grid
// is grown (rows first, then cols, within [1..8]) until it can hold the busiest
// page. Modes:
//  { compact:true }  — keys are packed to the front of each page (no gaps).
//  { preserve:true } — keys keep their EXACT slot (gaps included); the grid grows
//                      to fit the highest occupied index so a key is never repacked.
//                      Used by auto-fit so a transient/smaller measurement can't
//                      compact the user's intentional layout.
//  default           — keys keep their slot unless a genuine shrink would truncate
//                      an occupied one, in which case that page is compacted as a
//                      safe fallback (used by the manual cols/rows steppers).
// Returns a NEW normalized config.
function reshapeDeckConfig(config, cols, rows, opts) {
  const compact = !!(opts && opts.compact);
  const preserve = !!(opts && opts.preserve);
  const cfg = cloneConfig(normalizeDeckConfig(config));
  let c = clampInt(cols, DECK_MIN, DECK_MAX, cfg.cols);
  let r = clampInt(rows, DECK_MIN, DECK_MAX, cfg.rows);
  const need = preserve ? maxOccupiedIndex(cfg) : maxOccupied(cfg);
  while (c * r < need && r < DECK_MAX) r++;
  while (c * r < need && c < DECK_MAX) c++;
  const slots = c * r;
  eachPage(cfg, (page) => {
    let arr = page.keys;
    // Preserve never repacks (the grid was grown to fit every key's index above);
    // otherwise compact on request, or as a fallback when a shrink would truncate.
    if (!preserve && (compact || page.keys.slice(slots).some(Boolean))) arr = page.keys.filter(Boolean);
    const next = new Array(slots).fill(null);
    for (let i = 0; i < arr.length && i < slots; i++) next[i] = arr[i];
    page.keys = next;
  });
  cfg.cols = c;
  cfg.rows = r;
  return normalizeDeckConfig(cfg);
}

// Walk `path` (array of folder key ids) from the active profile root, then pick
// `pageIndex` (clamped). Returns { folder, page, pageIndex, pageCount }.
function resolveView(config, nav) {
  const cfg = config && config.version ? config : normalizeDeckConfig(config);
  const profId = (nav && nav.profileId) || cfg.activeProfile;
  const profile = cfg.profiles.find(p => p.id === profId) || cfg.profiles[0];
  let folder = profile.root;
  const path = Array.isArray(nav && nav.path) ? nav.path : [];
  for (const keyId of path) {
    let next = null;
    for (const page of folder.pages) {
      const found = page.keys.find(k => k && k.kind === 'folder' && k.id === keyId);
      if (found) { next = found.folder; break; }
    }
    if (!next) break;
    folder = next;
  }
  const pageCount = folder.pages.length;
  if (pageCount === 0) return { folder, page: { keys: [] }, pageIndex: 0, pageCount: 0 };
  const pageIndex = clampInt(nav && nav.pageIndex, 0, pageCount - 1, 0);
  return { folder, page: folder.pages[pageIndex], pageIndex, pageCount };
}

function newKeyId() {
  return 'k_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

function newProfileId() {
  return 'prof_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

// Switch the active profile (no-op if the id is unknown). New normalized config.
function setActiveProfile(config, profileId) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  if (cfg.profiles.some(p => p.id === profileId)) cfg.activeProfile = profileId;
  return normalizeDeckConfig(cfg);
}

// Append a fresh, empty profile (one blank page sized to the grid) and make it
// active. `name` is optional; falls back to "Profile N". New normalized config.
function addProfile(config, name) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const id = newProfileId();
  cfg.profiles.push({
    id,
    name: clampStr(name, 40) || ('Profile ' + (cfg.profiles.length + 1)),
    root: { pages: [emptyPage(cfg.cols * cfg.rows)] },
  });
  cfg.activeProfile = id;
  return normalizeDeckConfig(cfg);
}

// Extract a single profile (deep clone) for saving as a reusable preset. Falls
// back to the first profile when the id is unknown.
function getProfile(config, profileId) {
  const cfg = normalizeDeckConfig(config);
  const prof = cfg.profiles.find(p => p.id === profileId) || cfg.profiles[0];
  return cloneConfig(prof);
}

// Append a profile built from a saved preset/template (gets a fresh id, fitted to
// THIS deck's grid). Becomes active. The deck grid is GROWN first if the template
// holds more keys than the current grid can show, so copying a profile from a bigger
// deck (or inserting a richer preset) never silently truncates its keys — the
// reported "8-key profile came in with only 6" loss. New normalized config.
function addProfileFromTemplate(config, profileTemplate) {
  let cfg = cloneConfig(normalizeDeckConfig(config));
  // Measure the template at full size so the grow target reflects every key it holds,
  // independent of this deck's (possibly smaller) current grid.
  const probe = normalizeDeckConfig({ cols: DECK_MAX, rows: DECK_MAX, profiles: [profileTemplate], activeProfile: 'p' });
  const need = maxOccupiedIndex(probe);
  let c = cfg.cols, r = cfg.rows;
  while (c * r < need && r < DECK_MAX) r++;
  while (c * r < need && c < DECK_MAX) c++;
  if (c !== cfg.cols || r !== cfg.rows) cfg = cloneConfig(reshapeDeckConfig(cfg, c, r, { preserve: true }));
  const id = newProfileId();
  const prof = normalizeProfile(Object.assign({}, profileTemplate, { id }), cfg.cols, cfg.rows, cfg.profiles.length);
  cfg.profiles.push(prof);
  cfg.activeProfile = prof.id;
  return normalizeDeckConfig(cfg);
}

// Rename a profile (ignored if the id is unknown or the new name is blank).
function renameProfile(config, profileId, name) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const prof = cfg.profiles.find(p => p.id === profileId);
  const clean = clampStr(name, 40);
  if (prof && clean) prof.name = clean;
  return normalizeDeckConfig(cfg);
}

// Remove a profile, never dropping below one. If the removed profile was active,
// the first remaining profile becomes active. New normalized config.
function removeProfile(config, profileId) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  if (cfg.profiles.length <= 1) return normalizeDeckConfig(cfg);
  const idx = cfg.profiles.findIndex(p => p.id === profileId);
  if (idx === -1) return normalizeDeckConfig(cfg);
  cfg.profiles.splice(idx, 1);
  if (cfg.activeProfile === profileId) cfg.activeProfile = cfg.profiles[0].id;
  return normalizeDeckConfig(cfg);
}

function cloneConfig(config) {
  // structuredClone beats the JSON round-trip on big configs (image icons can
  // reach ~1.5MB per key); keep the JSON fallback for older embedded WebViews.
  return typeof structuredClone === 'function'
    ? structuredClone(config)
    : JSON.parse(JSON.stringify(config));
}

// Walk `path` (folder key ids) in a MUTABLE cloned config; return the folder
// object reached (deepest valid). Caller mutates it in place.
function folderAtPath(cfg, profileId, path) {
  const profile = cfg.profiles.find(p => p.id === profileId) || cfg.profiles[0];
  let folder = profile.root;
  for (const id of (path || [])) {
    let next = null;
    for (const page of folder.pages) {
      const k = page.keys.find(key => key && key.kind === 'folder' && key.id === id);
      if (k) { next = k.folder; break; }
    }
    if (!next) break;
    folder = next;
  }
  return folder;
}

// Set (rawKey) or clear (rawKey=null) the slot at the resolved folder+page.
// Returns a NEW normalized config; the input is not mutated.
function setKeyAt(config, nav, slotIndex, rawKey) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const folder = folderAtPath(cfg, (nav && nav.profileId) || cfg.activeProfile, nav && nav.path);
  const pageIndex = clampInt(nav && nav.pageIndex, 0, folder.pages.length - 1, 0);
  const keys = folder.pages[pageIndex].keys;
  if (slotIndex >= 0 && slotIndex < keys.length) keys[slotIndex] = rawKey || null;
  return normalizeDeckConfig(cfg);
}

// Swap the contents of two slots on the resolved folder+page (used by edit-mode
// drag-to-reorder). Swapping with an empty slot moves the key there. No-op if either
// index is out of range or they're equal. Returns a NEW normalized config.
function swapKeysAt(config, nav, indexA, indexB) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const folder = folderAtPath(cfg, (nav && nav.profileId) || cfg.activeProfile, nav && nav.path);
  const pageIndex = clampInt(nav && nav.pageIndex, 0, folder.pages.length - 1, 0);
  const keys = folder.pages[pageIndex].keys;
  if (indexA >= 0 && indexA < keys.length && indexB >= 0 && indexB < keys.length && indexA !== indexB) {
    const tmp = keys[indexA]; keys[indexA] = keys[indexB]; keys[indexB] = tmp;
  }
  return normalizeDeckConfig(cfg);
}

// Append an empty page to the resolved folder. Returns a NEW normalized config.
function addPageAt(config, nav) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const folder = folderAtPath(cfg, (nav && nav.profileId) || cfg.activeProfile, nav && nav.path);
  folder.pages.push(emptyPage(cfg.cols * cfg.rows));
  return normalizeDeckConfig(cfg);
}

// Remove the page at pageIndex from the resolved folder, keeping at least one.
// Returns a NEW normalized config.
function removePageAt(config, nav, pageIndex) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const folder = folderAtPath(cfg, (nav && nav.profileId) || cfg.activeProfile, nav && nav.path);
  if (folder.pages.length > 1 && pageIndex >= 0 && pageIndex < folder.pages.length) {
    folder.pages.splice(pageIndex, 1);
  }
  return normalizeDeckConfig(cfg);
}

// Live state sources a key can bind to. Booleans (mic/speaker/obsRecording/
// obsStreaming) read a flag from the snapshot; parameterised ones compare a
// stored value (obsScene→scene, obsInputMuted→input) against the snapshot.
const DECK_STATE_SOURCES = ['micMuted', 'speakerMuted', 'obsRecording', 'obsStreaming', 'obsScene', 'obsInputMuted', 'remoteConnected', 'remoteActive'];

function evaluateKeyState(state, snapshot) {
  if (!state || typeof state !== 'object' || !snapshot || typeof snapshot !== 'object') return false;
  switch (state.source) {
    case 'micMuted':      return !!snapshot.micMuted;
    case 'speakerMuted':  return !!snapshot.speakerMuted;
    case 'obsRecording':  return !!snapshot.obsRecording;
    case 'obsStreaming':  return !!snapshot.obsStreaming;
    case 'obsScene':      return !!state.scene && state.scene === snapshot.obsScene;
    case 'obsInputMuted':    return !!(state.input && snapshot.obsMutes && snapshot.obsMutes[state.input]);
    case 'remoteConnected': return !!snapshot.remoteConnected;
    case 'remoteActive':    return !!snapshot.remoteActive;
    default:                return false;
  }
}

if (typeof window !== 'undefined') {
  window.DeckModel = { normalizeDeckConfig, resolveView, setKeyAt, addPageAt, removePageAt, newKeyId, newProfileId, setActiveProfile, addProfile, renameProfile, removeProfile, getProfile, addProfileFromTemplate, cloneConfig, evaluateKeyState, gridForSize, reshapeDeckConfig, swapKeysAt, KEY_SIZES, DECK_STATE_SOURCES, DECK_MIN, DECK_MAX, PRESS_FX, ICON_FITS };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeDeckConfig, resolveView, setKeyAt, addPageAt, removePageAt, newKeyId, newProfileId, setActiveProfile, addProfile, renameProfile, removeProfile, getProfile, addProfileFromTemplate, cloneConfig, evaluateKeyState, gridForSize, reshapeDeckConfig, swapKeysAt, KEY_SIZES, DECK_STATE_SOURCES, DECK_MIN, DECK_MAX, PRESS_FX, ICON_FITS };
}

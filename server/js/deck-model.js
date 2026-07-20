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
// Inter-key gap per key-size preset. MUST mirror `--deck-gap` in DeckPanel.css
// (7/10/13px by data-keysize): gridForSize computes how many caps fit using this
// same gap, so a mismatch makes the JS count disagree with the CSS square-cap
// edge and the grid letterboxes or overflows ("sfasa") at certain tile sizes.
const KEY_GAPS = { sm: 7, md: 10, lg: 13 };

// Per-key tap feedback animations (the visual played when a key fires) and image
// fit modes (how an uploaded picture sits inside the square cap).
const PRESS_FX = ['glow', 'press', 'stay', 'flash', 'off'];
const ICON_FITS = ['cover', 'contain', 'small'];

// Per-key styling enums. First entry is always the default (and is NOT persisted
// on the key — only non-default choices are stored, like pressColor).
const GRAD_DIRS = ['d', 'v', 'r'];                   // gradient direction: diagonal / vertical / radial
const LABEL_POSITIONS = ['bottom', 'top', 'hidden'];  // where the title sits on the cap
const STYLE_SIZES = ['md', 'sm', 'lg'];               // label / icon size presets
const KEY_ANIMS = ['none', 'breathe', 'shift'];       // ambient cap animation
// Deck-level presentation enums (whole-device look).
const CAP_STYLES = ['lcd', 'flat', 'neon', 'glass', 'vivid'];  // key-cap material
const KEY_SHAPES = ['rounded', 'square', 'circle'];   // cap corner shape
const PLATE_STYLES = ['graphite', 'carbon', 'steel', 'midnight', 'none']; // chassis faceplate

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampStr(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// A colour field must be a clean hex (it is interpolated into CSS color-mix()
// at render time); anything else yields '' so the field is simply dropped.
function cleanHex(value) {
  const v = String(value == null ? '' : value).trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '';
}

// Deck decoration image: an inline data: URI (own artwork — the same shape the key
// faces already carry) or a bundled /assets/decor asset. Bounded; anything else →
// '' so the field is simply dropped. Kept as data so it rides the deck config the
// way key images do (no dependency on the layout-scoped tile-asset GC).
const DECK_DECOR_MAX = 1500000;
// svg+xml accepted only as a base64 data: URI painted as a CSS/well image (secure
// static mode — no scripts/fetches), so pasted-SVG decor is safe. Never innerHTML.
const DECK_DECOR_RE = /^(?:data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}|\/assets\/decor\/[A-Za-z0-9._-]+)$/;
function deckDecorSrc(v) {
  const s = String(v == null ? '' : v).trim();
  return (s && s.length <= DECK_DECOR_MAX && DECK_DECOR_RE.test(s)) ? s : '';
}
// A two-stop colour gradient (both stops required) + angle. Carries no bytes, so
// a gradient look is always share-code friendly. Mirrors the tile _tileGrad.
function deckGrad(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c1 = cleanHex(raw.c1), c2 = cleanHex(raw.c2);
  if (!c1 || !c2) return null;
  return { c1, c2, angle: clampInt(raw.angle, 0, 360, 135) };
}
// Free-form background behind the key grid (the "well"): an image, a colour
// gradient, or both (gradient layered over the image), plus fit/dim/blur.
function normalizeDeckWellImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = deckDecorSrc(raw.src);
  const grad = deckGrad(raw.grad);
  if (!src && !grad) return null;
  const out = {
    fit: ['cover', 'contain', 'tile'].includes(raw.fit) ? raw.fit : 'cover',
    dim: clampInt(raw.dim, 0, 85, 30),
    blur: clampInt(raw.blur, 0, 20, 0),
  };
  if (src) out.src = src;
  if (grad) out.grad = grad;
  // Provenance: a look that arrived inside someone else's shared profile is
  // marked so exports can refuse to redistribute it (sticky across edits, like
  // every other imported flag). Must survive normalization or it dies on save.
  if (raw.imported === true) out.imported = true;
  return out;
}
// Styling for the now-playing / volume strip: a custom backdrop image, a colour
// gradient and/or an accent tint. Empty collapses to null.
function normalizeDeckMediaStyle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const src = deckDecorSrc(raw.src);
  if (src) { out.src = src; out.dim = clampInt(raw.dim, 0, 85, 40); }
  const grad = deckGrad(raw.grad);
  if (grad) out.grad = grad;
  const accent = cleanHex(raw.accent);
  if (accent) out.accent = accent;
  if (raw.imported === true) out.imported = true;
  return (out.src || out.grad || out.accent) ? out : null;
}

// Visual presentation that belongs to one profile. Missing fields inherit the
// Deck instance defaults, while an explicit null decoration means "no artwork"
// even when an older instance-level default exists.
function normalizeDeckLook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let seen = false;
  if (CAP_STYLES.includes(raw.capStyle)) { out.capStyle = raw.capStyle; seen = true; }
  if (KEY_SHAPES.includes(raw.keyShape)) { out.keyShape = raw.keyShape; seen = true; }
  if (PLATE_STYLES.includes(raw.plate)) { out.plate = raw.plate; seen = true; }
  if (Object.prototype.hasOwnProperty.call(raw, 'wellImage')) {
    const value = normalizeDeckWellImage(raw.wellImage);
    if (value || raw.wellImage === null) { out.wellImage = value; seen = true; }
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'mediaStyle')) {
    const value = normalizeDeckMediaStyle(raw.mediaStyle);
    if (value || raw.mediaStyle === null) { out.mediaStyle = value; seen = true; }
  }
  return seen ? out : null;
}

// Keep `raw` only when it is one of the allowed NON-DEFAULT choices (list[0] is
// the default and is never persisted — absent means default).
function optionalEnum(raw, list) {
  return (raw !== list[0] && list.includes(raw)) ? raw : '';
}

// Touch-slider targets a slider key can drive. Each maps to one existing
// registry action's absolute mode, so a slider never widens the action surface.
const SLIDER_TARGETS = ['volume', 'appVolume', 'spotifyVolume', 'obsInput', 'haLight', 'discordInput', 'discordOutput'];

function normalizeSlider(raw) {
  if (!raw || typeof raw !== 'object' || !SLIDER_TARGETS.includes(raw.target)) return null;
  const slider = { target: raw.target, orient: raw.orient === 'h' ? 'h' : 'v' };
  if (raw.target === 'appVolume') {
    slider.app = clampStr(raw.app, 120);
    if (!slider.app) return null;
  } else if (raw.target === 'haLight') {
    slider.entity = clampStr(raw.entity, 80);
    if (!slider.entity) return null;
  } else if (raw.target === 'obsInput') {
    slider.source = clampStr(raw.source, 200);
    if (!slider.source) return null;
  }
  return slider;
}

function normalizeKey(raw, cols, rows) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'folder' ? 'folder' : (raw.kind === 'action' ? 'action' : (raw.kind === 'slider' ? 'slider' : null));
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
  const bg = cleanHex(raw.bg);
  if (bg) key.bg = bg;
  // Optional second accent → the cap face becomes a two-colour gradient. Only
  // meaningful alongside a primary accent; the direction defaults to diagonal.
  const bg2 = bg ? cleanHex(raw.bg2) : '';
  if (bg2) {
    key.bg2 = bg2;
    const dir = optionalEnum(raw.bgDir, GRAD_DIRS);
    if (dir) key.bgDir = dir;
  }
  // Optional backdrop picture: a separate layer UNDER the icon/label (unlike an
  // icon of type 'image', which IS the face). `dim` darkens it for legibility.
  if (raw.bgImage && typeof raw.bgImage === 'object') {
    const value = clampStr(raw.bgImage.value, ICON_MAX.image);
    if (/^(data:image\/|blob:|https?:\/\/)/i.test(value)) {
      // dim = legibility scrim (0–85%); blur = backdrop softening in px (0–20).
      key.bgImage = { value, dim: clampInt(raw.bgImage.dim, 0, 85, 35), blur: clampInt(raw.bgImage.blur, 0, 20, 0) };
    }
  }
  // Optional icon / label styling (absent = theme defaults).
  const iconColor = cleanHex(raw.iconColor);
  if (iconColor) key.iconColor = iconColor;
  const labelColor = cleanHex(raw.labelColor);
  if (labelColor) key.labelColor = labelColor;
  const labelPos = optionalEnum(raw.labelPos, LABEL_POSITIONS);
  if (labelPos) key.labelPos = labelPos;
  const labelSize = optionalEnum(raw.labelSize, STYLE_SIZES);
  if (labelSize) key.labelSize = labelSize;
  if (raw.labelBold === true) key.labelBold = true;
  const iconSize = optionalEnum(raw.iconSize, STYLE_SIZES);
  if (iconSize) key.iconSize = iconSize;
  // Ambient cap animation (renderer keeps these cheap: opacity/transform layers).
  const anim = optionalEnum(raw.anim, KEY_ANIMS);
  if (anim) key.anim = anim;
  // Optional colour for the tap-feedback effect (glow / blink / hold tint). Same hex
  // validation as the accent; dropped when absent so the effect uses its default.
  const pressColor = cleanHex(raw.pressColor);
  if (pressColor) key.pressColor = pressColor;
  if (kind === 'folder') {
    key.folder = normalizeFolder(raw.folder, cols, rows);
  } else if (kind === 'slider') {
    // A touch fader: continuous control over one target. No triggers/state —
    // the drag itself is the interaction. Invalid target → the key drops.
    key.slider = normalizeSlider(raw.slider);
    if (!key.slider) return null;
  } else {
    key.triggers = (raw.triggers && typeof raw.triggers === 'object' && !Array.isArray(raw.triggers))
      ? Object.assign({}, raw.triggers)
      : {};
    if (raw.state && typeof raw.state === 'object' && raw.state.source) {
      key.state = { source: clampStr(raw.state.source, 32) };
      if (raw.state.scene) key.state.scene = clampStr(raw.state.scene, 200);
      if (raw.state.input) key.state.input = clampStr(raw.state.input, 200);
      // Streamer.bot global binding: the global's name (+ optional value to match).
      if (raw.state.name) key.state.name = clampStr(raw.state.name, 200);
      if (raw.state.value != null) key.state.value = clampStr(raw.state.value, 200);
      // Home Assistant entity binding: the entity id whose live state drives .is-on.
      if (raw.state.entity) key.state.entity = clampStr(raw.state.entity, 80);
    }
    // Optional alternate face while the bound state is ON (a toggle key that
    // changes glyph/label/colour per state). Same caps/validation as the base face.
    if (raw.stateStyle && typeof raw.stateStyle === 'object') {
      const ss = {};
      const ssIconValue = clampStr(raw.stateStyle.icon, ICON_MAX.emoji);
      if (ssIconValue) ss.icon = ssIconValue;                 // emoji/short glyph only
      const ssLabel = clampStr(raw.stateStyle.label, 40);
      if (ssLabel) ss.label = ssLabel;
      const ssColor = cleanHex(raw.stateStyle.color);
      if (ssColor) ss.color = ssColor;
      if (Object.keys(ss).length) key.stateStyle = ss;
    }
    // Optional live value shown ON the key face (a ticking timer countdown, an
    // SDK widget's published state text) — rendered via textContent, never markup.
    if (raw.live && typeof raw.live === 'object' && DECK_LIVE_SOURCES.includes(raw.live.source)) {
      key.live = { source: raw.live.source };
      if (raw.live.name) key.live.name = clampStr(raw.live.name, 200);
    }
    // Optional LED reaction: light the RGB when this key fires ('press') or while
    // its bound state is active ('state'). Requires a valid hex colour, else dropped.
    const lightColor = raw.light && typeof raw.light === 'object' ? cleanHex(raw.light.color) : '';
    if (lightColor) {
      key.light = {
        when: raw.light.when === 'state' ? 'state' : 'press',
        color: lightColor,
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

// A per-profile grid dimension from untrusted/persisted data: a real number is
// clamped into [DECK_MIN..DECK_MAX]; anything else — including null/''/0, which
// Number() coerces to 0 and clampInt would clamp to 1, collapsing the grid —
// falls back instead.
function profileDim(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= DECK_MIN ? Math.min(n, DECK_MAX) : fallback;
}

// Grow a cols×rows shape (rows first, then cols, within [1..8]) until it holds
// `need` slots — the one grow policy shared by load, reshape and template import.
function growToFit(cols, rows, need) {
  let c = cols, r = rows;
  while (c * r < need && r < DECK_MAX) r++;
  while (c * r < need && c < DECK_MAX) c++;
  return { cols: c, rows: r };
}

// Highest occupied slot index + 1 across a RAW (untrusted, not yet normalized)
// folder tree. Used at the load boundary: a profile whose declared shape
// undercounts its content must grow before normalizePage sizes (and would
// otherwise truncate) its pages. Depth-capped against crafted payloads.
function rawMaxOccupiedIndex(rawRoot) {
  let m = 0;
  const walk = (folder, depth) => {
    if (!folder || typeof folder !== 'object' || !Array.isArray(folder.pages) || depth > 8) return;
    for (const page of folder.pages) {
      const keys = (page && Array.isArray(page.keys)) ? page.keys : [];
      for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i]) { if (i + 1 > m) m = i + 1; break; }
      }
      for (const k of keys) if (k && k.kind === 'folder') walk(k.folder, depth + 1);
    }
  };
  walk(rawRoot, 0);
  return Math.min(m, DECK_MAX * DECK_MAX);
}

function normalizeProfile(raw, cols, rows, index) {
  const id = clampStr(raw && raw.id, 64) || ('prof_' + index);
  // Each profile owns its own grid shape. Legacy configs (profiles without
  // cols/rows) inherit the config-level shape, so nothing moves on upgrade.
  // The declared shape is then GROWN to hold the profile's actual content: a
  // stale/corrupt shape must never make normalizeFolder truncate placed keys.
  const declared = growToFit(
    profileDim(raw && raw.cols, cols),
    profileDim(raw && raw.rows, rows),
    rawMaxOccupiedIndex(raw && raw.root),
  );
  const pCols = declared.cols;
  const pRows = declared.rows;
  const prof = {
    id,
    name: clampStr(raw && raw.name, 40) || ('Profile ' + (index + 1)),
    cols: pCols,
    rows: pRows,
    root: normalizeFolder(raw && raw.root, pCols, pRows),
  };
  // Redistribution marker: profiles that arrived via a share code are someone
  // else's work and can't be re-exported. Additive — never set on own profiles;
  // sanitizeDeckProfile strips it on export, so shared codes never carry it.
  if (raw && raw.imported === true) prof.imported = true;
  if (prof.imported && /^xi_[a-z0-9]{8,32}$/.test(String(raw && raw.installId || ''))) {
    prof.installId = String(raw.installId);
  }
  const look = normalizeDeckLook(raw && raw.look);
  if (look) prof.look = look;
  return prof;
}

function normalizeDeckConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  // Config-level cols/rows survive as the LEGACY/default shape: profiles saved
  // before shapes became per-profile carry none of their own and inherit these.
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
  // Instance-level presentation defaults retained for old configs. Profiles can
  // override these fields independently through profile.look.
  //  capStyle — key-cap material (lcd / flat / neon / glass)
  //  keyShape — cap corner shape (rounded / square / circle)
  //  plate    — chassis faceplate finish (graphite / carbon / steel / midnight / none)
  const capStyle = CAP_STYLES.includes(src.capStyle) ? src.capStyle : 'lcd';
  const keyShape = KEY_SHAPES.includes(src.keyShape) ? src.keyShape : 'rounded';
  const plate = PLATE_STYLES.includes(src.plate) ? src.plate : 'graphite';
  // Smart Profiles: auto-switch the DISPLAYED profile to match the app in the
  // foreground. Rules pair a process exe name (lowercased, no ".exe" — the exact
  // shape gamedetect's foreground probe reports) with a profile NAME (names
  // survive share/copy; ids don't). The switch itself is a render-time override
  // that never writes activeProfile — only these rules persist.
  const autoSwitch = normalizeAutoSwitch(src.autoSwitch);
  // Decoration (additive; null = classic look): a free-form picture behind the key
  // grid and optional styling of the now-playing strip.
  let wellImage = normalizeDeckWellImage(src.wellImage);
  let mediaStyle = normalizeDeckMediaStyle(src.mediaStyle);
  // v4.5.2 migration: older profile imports wrote shared artwork onto the whole
  // Deck. Move imported decoration to the active imported profile so the user's
  // existing profiles immediately recover their original appearance.
  const importedTarget = profiles.find((p) => p.id === activeProfile && p.imported === true)
    || profiles.find((p) => p.imported === true);
  if (importedTarget && ((wellImage && wellImage.imported === true) || (mediaStyle && mediaStyle.imported === true))) {
    const look = Object.assign({}, importedTarget.look || {});
    if (wellImage && wellImage.imported === true && !Object.prototype.hasOwnProperty.call(look, 'wellImage')) {
      look.wellImage = wellImage;
      wellImage = null;
    }
    if (mediaStyle && mediaStyle.imported === true && !Object.prototype.hasOwnProperty.call(look, 'mediaStyle')) {
      look.mediaStyle = mediaStyle;
      mediaStyle = null;
    }
    importedTarget.look = normalizeDeckLook(look);
  }
  // Top-level cols/rows mirror the LARGEST profile shape, deliberately NOT the
  // active one: a surface still running the pre-per-profile model sizes EVERY
  // page at this top-level shape, so a mirror smaller than a sibling profile's
  // grid would make that stale client truncate the sibling's keys and sync the
  // loss. The max keeps a down-level reader grow-only — version skew can degrade
  // shapes, never delete keys. New code reads shapes via gridOf(), never these.
  const maxCols = profiles.reduce((m, p) => Math.max(m, p.cols), DECK_MIN);
  const maxRows = profiles.reduce((m, p) => Math.max(m, p.rows), DECK_MIN);
  return { version: 1, cols: maxCols, rows: maxRows, keySize, autoFit, showMedia, capStyle, keyShape, plate, wellImage, mediaStyle, profiles, activeProfile, autoSwitch };
}

function effectiveDeckLook(config, profileId) {
  const cfg = normalizeDeckConfig(config);
  const profile = cfg.profiles.find((p) => p.id === profileId) || cfg.profiles[0];
  const look = (profile && profile.look) || {};
  const own = (field) => Object.prototype.hasOwnProperty.call(look, field);
  return {
    capStyle: own('capStyle') ? look.capStyle : cfg.capStyle,
    keyShape: own('keyShape') ? look.keyShape : cfg.keyShape,
    plate: own('plate') ? look.plate : cfg.plate,
    wellImage: own('wellImage') ? look.wellImage : cfg.wellImage,
    mediaStyle: own('mediaStyle') ? look.mediaStyle : cfg.mediaStyle,
  };
}

// Update one profile's appearance without changing any sibling profile. The
// first edit snapshots inherited defaults so subsequent instance-default changes
// cannot silently alter a profile the user already customized.
function setProfileLook(config, profileId, patch) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const profile = cfg.profiles.find((p) => p.id === profileId) || cfg.profiles[0];
  if (!profile) return normalizeDeckConfig(cfg);
  const merged = Object.assign({}, effectiveDeckLook(cfg, profile.id), patch && typeof patch === 'object' ? patch : {});
  profile.look = normalizeDeckLook(merged);
  return normalizeDeckConfig(cfg);
}

const AUTO_SWITCH_MAX_RULES = 16;
function normalizeAutoSwitch(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rules = [];
  if (Array.isArray(src.rules)) {
    for (const r of src.rules) {
      if (rules.length >= AUTO_SWITCH_MAX_RULES) break;
      const exe = clampStr(r && r.exe, 60).toLowerCase().replace(/\.exe$/, '');
      const profile = clampStr(r && r.profile, 40);
      if (!exe || !profile) continue;
      if (rules.some((x) => x.exe === exe)) continue;   // one rule per app
      rules.push({ exe, profile });
    }
  }
  return {
    enabled: src.enabled === true,
    // 'default' = fall back to the manually-active profile when no rule matches;
    // 'stay' = keep showing the last matched profile until another rule fires.
    revert: src.revert === 'stay' ? 'stay' : 'default',
    rules,
  };
}

// How many columns/rows of `keySize` keys fit a tile of (width × height) px.
// Clamped to the deck's [1..8] range; falls back to a 3×2 grid for tiny/unknown
// sizes. The +gap maths matches the CSS grid's gap so the fit is honest.
function gridForSize(width, height, keySize) {
  const cell = KEY_SIZES[keySize] || KEY_SIZES.md;
  const gap = KEY_GAPS[keySize] || KEY_GAP;
  const w = Number(width), h = Number(height);
  // Half-pixel tolerance: fractional layout sizes (zoom compensation, cqw maths)
  // can land a hair under the exact multiple, which would flap the count by one
  // between resize events even though nothing visibly changed.
  const fit = (px, fallback) => {
    const n = Math.floor((px + gap + 0.5) / (cell + gap));
    return Number.isFinite(n) && n >= DECK_MIN ? Math.min(n, DECK_MAX) : fallback;
  };
  let cols = fit(w, 3), rows = fit(h, 2);
  // Square caps letterbox when the grid's column:row ratio doesn't match the screen:
  // the shorter axis sets the cap size and the longer axis is left with empty space.
  // Expand the count on each axis to that square cap size so the caps reach the edges
  // — a wide screen fills with more columns (Stream Deck XL style) instead of a
  // centred block flanked by empty columns.
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    const sq = Math.min((w - (cols - 1) * gap) / cols, (h - (rows - 1) * gap) / rows);
    if (sq > 0) {
      const fitAt = (px) => Math.max(DECK_MIN, Math.min(DECK_MAX, Math.floor((px + gap + 0.5) / (sq + gap))));
      cols = Math.max(cols, fitAt(w));
      rows = Math.max(rows, fitAt(h));
    }
  }
  return { cols, rows };
}

// Walk every page of ONE folder tree (a profile root + its nested folders),
// calling fn(page). Grid shape is per-profile, so occupancy and reshapes are
// measured per profile — another profile's busy pages must never constrain this one.
function eachFolderPage(folder, fn) {
  for (const page of folder.pages) {
    fn(page);
    for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) eachFolderPage(k.folder, fn);
  }
}

// Largest number of placed keys on any single page of the folder tree — the floor
// below which its grid must not shrink, or keys would be lost.
function maxOccupied(folder) {
  let m = 0;
  eachFolderPage(folder, (page) => { const n = page.keys.filter(Boolean).length; if (n > m) m = n; });
  return m;
}

// Highest occupied SLOT INDEX + 1 across every page of the folder tree — i.e. the
// minimum number of slots needed to keep every key exactly where the user put it
// (gaps included). Used by { preserve } reshapes so the grid grows to hold a key
// at, say, slot 7 instead of repacking it forward.
function maxOccupiedIndex(folder) {
  let m = 0;
  eachFolderPage(folder, (page) => {
    for (let i = page.keys.length - 1; i >= 0; i--) {
      if (page.keys[i]) { if (i + 1 > m) m = i + 1; break; }
    }
  });
  return m;
}

// The ONE profile resolver: requested id → active profile → first. Every
// profile-scoped operation resolves through this so a stale id degrades to the
// same profile everywhere (a read/write pair resolving to DIFFERENT profiles
// would resize a profile the user isn't looking at).
function profileOf(cfg, profileId) {
  return cfg.profiles.find(p => p.id === profileId)
    || cfg.profiles.find(p => p.id === cfg.activeProfile)
    || cfg.profiles[0];
}

// The grid shape shown for `profileId` (falls back to the active profile). This is
// the read path for anything that renders or edits a specific profile's grid.
function gridOf(config, profileId) {
  const cfg = config && config.version ? config : normalizeDeckConfig(config);
  const prof = profileOf(cfg, profileId);
  return { cols: prof.cols, rows: prof.rows };
}

// Resize ONE profile's grid to cols×rows without ever dropping a placed key —
// `opts.profileId` picks the profile (default: the active one); the other
// profiles keep their own shape untouched. The grid is grown (rows first, then
// cols, within [1..8]) until it can hold that profile's busiest page. Modes:
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
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const prof = profileOf(cfg, opts && opts.profileId);
  reshapeProfileInPlace(prof, cols, rows, opts);
  return normalizeDeckConfig(cfg);
}

// The per-profile reshape core (mutates `prof` — callers own the clone).
function reshapeProfileInPlace(prof, cols, rows, opts) {
  const compact = !!(opts && opts.compact);
  const preserve = !!(opts && opts.preserve);
  const need = preserve ? maxOccupiedIndex(prof.root) : maxOccupied(prof.root);
  const { cols: c, rows: r } = growToFit(
    clampInt(cols, DECK_MIN, DECK_MAX, prof.cols),
    clampInt(rows, DECK_MIN, DECK_MAX, prof.rows),
    need,
  );
  const slots = c * r;
  eachFolderPage(prof.root, (page) => {
    let arr = page.keys;
    // Preserve never repacks (the grid was grown to fit every key's index above);
    // otherwise compact on request, or as a fallback when a shrink would truncate.
    if (!preserve && (compact || page.keys.slice(slots).some(Boolean))) arr = page.keys.filter(Boolean);
    const next = new Array(slots).fill(null);
    for (let i = 0; i < arr.length && i < slots; i++) next[i] = arr[i];
    page.keys = next;
  });
  prof.cols = c;
  prof.rows = r;
}

// Auto-fit: steer EVERY profile toward the same cols×rows target (the tile size
// is the same whichever profile is shown), each one growing independently to
// keep its own keys ({ preserve } semantics). ONE clone for the whole pass —
// configs can carry megabytes of image icons, so a per-profile reshapeDeckConfig
// loop would clone the config N times on every resize/fit.
function fitDeckGrids(config, cols, rows) {
  const src = config && config.version ? config : normalizeDeckConfig(config);
  // Steady state (every profile already at the clamped target) skips the clone:
  // this runs on the resize hot path, and normalized profiles always hold their
  // own occupancy, so an at-target shape has nothing left to grow.
  const c = clampInt(cols, DECK_MIN, DECK_MAX, src.cols);
  const r = clampInt(rows, DECK_MIN, DECK_MAX, src.rows);
  if (src.profiles.every(p => p.cols === c && p.rows === r)) return src;
  const cfg = cloneConfig(src);
  for (const prof of cfg.profiles) reshapeProfileInPlace(prof, c, r, { preserve: true });
  return normalizeDeckConfig(cfg);
}

// Fold a display-fitted config's grids back onto the canonical per-profile shapes
// of `prev` (the durable config), { preserve } semantics — used by saveConfig so
// an auto-fit override never drifts the saved grid. Profiles `prev` doesn't know
// (just added on the fitted view) keep the shape they were created with. One clone.
function foldDeckGrids(config, prev) {
  const src = config && config.version ? config : normalizeDeckConfig(config);
  const prevProfiles = (prev && Array.isArray(prev.profiles)) ? prev.profiles : [];
  // Cheap pre-check before the deep clone: folding is the exception (a live
  // display override whose shape actually differs), and this runs on every save.
  const stale = prevProfiles.filter(p => {
    const shown = src.profiles.find(x => x.id === p.id);
    return shown && (shown.cols !== p.cols || shown.rows !== p.rows);
  });
  if (!stale.length) return src;
  const cfg = cloneConfig(src);
  for (const p of stale) {
    const shown = cfg.profiles.find(x => x.id === p.id);
    reshapeProfileInPlace(shown, p.cols, p.rows, { preserve: true });
  }
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

// Append a fresh, empty profile (one blank page, grid shaped like the profile
// you're leaving) and make it active. `name` is optional; falls back to
// "Profile N". New normalized config.
function addProfile(config, name) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const base = profileOf(cfg, cfg.activeProfile);
  const id = newProfileId();
  cfg.profiles.push({
    id,
    name: clampStr(name, 40) || ('Profile ' + (cfg.profiles.length + 1)),
    cols: base.cols,
    rows: base.rows,
    root: { pages: [emptyPage(base.cols * base.rows)] },
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

// Append a profile built from a saved preset/template (fresh id) and make it
// active. Only the NEW profile is sized: it starts from the shape the template
// declares (or the active profile's, for shapeless legacy templates) and is GROWN
// until it holds every key the template carries, so a richer preset never silently
// truncates — the reported "8-key profile came in with only 6" loss. The EXISTING
// profiles are never reshaped: installing a big catalog profile used to reflow
// every other profile's composition, and that coupling is exactly what per-profile
// grids remove. New normalized config.
function addProfileFromTemplate(config, profileTemplate) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const active = profileOf(cfg, cfg.activeProfile);
  const tpl = (profileTemplate && typeof profileTemplate === 'object') ? profileTemplate : {};
  const id = newProfileId();
  // Normalize the template at FULL size first so its own declared (or stale)
  // shape can't truncate keys, then reshape down to the wanted shape through the
  // shared { preserve } core — it grows back as needed to hold every key.
  const prof = normalizeProfile(Object.assign({}, tpl, { id, cols: DECK_MAX, rows: DECK_MAX }), DECK_MAX, DECK_MAX, cfg.profiles.length);
  reshapeProfileInPlace(prof, profileDim(tpl.cols, active.cols), profileDim(tpl.rows, active.rows), { preserve: true });
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
  const profile = profileOf(cfg, profileId);
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

// Move a key from its current slot to the first available slot on a target page.
// Used for drag-and-dropping across pages. Returns a NEW normalized config.
function moveKeyToPage(config, nav, sourceIndex, targetPageIndex) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const folder = folderAtPath(cfg, (nav && nav.profileId) || cfg.activeProfile, nav && nav.path);
  const sourcePageIndex = clampInt(nav && nav.pageIndex, 0, folder.pages.length - 1, 0);
  
  if (sourcePageIndex === targetPageIndex || targetPageIndex < 0 || targetPageIndex >= folder.pages.length) {
    return normalizeDeckConfig(cfg);
  }
  
  const sourceKeys = folder.pages[sourcePageIndex].keys;
  const targetKeys = folder.pages[targetPageIndex].keys;
  
  if (sourceIndex >= 0 && sourceIndex < sourceKeys.length && sourceKeys[sourceIndex]) {
    // Find first empty slot on target page
    let emptySlot = targetKeys.findIndex(k => k === null);
    if (emptySlot === -1) {
      // If full, expand the target page
      emptySlot = targetKeys.length;
      targetKeys.push(null);
    }
    
    // Move key
    targetKeys[emptySlot] = sourceKeys[sourceIndex];
    sourceKeys[sourceIndex] = null;
  }
  return normalizeDeckConfig(cfg);
}

// Append an empty page to the resolved folder, sized to the OWNING profile's
// grid. Returns a NEW normalized config.
function addPageAt(config, nav) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const profile = profileOf(cfg, nav && nav.profileId);
  const folder = folderAtPath(cfg, profile.id, nav && nav.path);
  folder.pages.push(emptyPage(profile.cols * profile.rows));
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

// The per-key visual styling fields, treated as one unit by "copy style" /
// "apply style to page": everything about the LOOK of a cap — never its icon,
// title, actions or bindings.
const KEY_STYLE_FIELDS = ['bg', 'bg2', 'bgDir', 'bgImage', 'iconColor', 'labelColor', 'labelPos', 'labelSize', 'labelBold', 'iconSize', 'anim', 'press', 'pressColor'];

// Extract just the style fields of a key (for the style clipboard).
function keyStyleOf(key) {
  const style = {};
  if (!key || typeof key !== 'object') return style;
  for (const f of KEY_STYLE_FIELDS) if (key[f] !== undefined) style[f] = key[f];
  return style;
}

// Overwrite the style fields of every placed key on the resolved folder+page
// with `style`. Fields absent from `style` are CLEARED — a style is applied as
// a whole look, not merged over leftovers. Returns a NEW normalized config.
function applyStyleToPage(config, nav, style) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const folder = folderAtPath(cfg, (nav && nav.profileId) || cfg.activeProfile, nav && nav.path);
  const pageIndex = clampInt(nav && nav.pageIndex, 0, folder.pages.length - 1, 0);
  const clean = keyStyleOf(style);
  folder.pages[pageIndex].keys.forEach((key) => {
    if (!key) return;
    for (const f of KEY_STYLE_FIELDS) delete key[f];
    Object.assign(key, cloneConfig(clean));
  });
  return normalizeDeckConfig(cfg);
}

// Live state sources a key can bind to. Booleans (mic/speaker/obsRecording/
// obsStreaming) read a flag from the snapshot; parameterised ones compare a
// stored value (obsScene→scene, obsInputMuted→input) against the snapshot.
const DECK_STATE_SOURCES = ['micMuted', 'speakerMuted', 'obsRecording', 'obsStreaming', 'obsScene', 'obsInputMuted', 'remoteConnected', 'remoteActive', 'sbGlobal', 'sdkState', 'discordMuted', 'discordDeafened', 'mediaPlaying', 'spotifyPlaying', 'haEntity', 'timerRunning'];

// HA state strings that read as "on" for an entity binding without an explicit
// value to match — covers switches/lights, covers, media, presence, locks,
// climate and vacuums with one shared, predictable rule.
const HA_ON_STATES = ['on', 'open', 'opening', 'playing', 'home', 'unlocked', 'active', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only', 'cleaning', 'returning'];

// Whether a Streamer.bot global value reads as "on". Booleans/numbers are literal;
// strings are truthy unless they're an explicit off-ish token — so a global set to
// "false"/"0"/"off" reads as OFF, which is what a toggle-mirroring key wants.
function isGlobalTruthy(v) {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off' || s === 'null');
}

// A named-value state binding (Streamer.bot global / SDK widget state): on while
// the named value in `bag` is truthy, or exactly equals state.value when given.
function matchNamedState(state, bag) {
  if (!state.name) return false;
  const v = bag ? bag[state.name] : undefined;
  if (v === undefined) return false;
  if (state.value != null && state.value !== '') return String(v) === String(state.value);
  return isGlobalTruthy(v);
}

// Live-value sources a key face can display (key.live). 'timer' shows a ticking
// countdown from the timers snapshot; 'sdkState' shows the label/value an SDK
// widget published for that state name; 'sensor' shows a live hardware reading
// (temps/load/fan/watts from the system snapshot, or `battery:<device>`).
const DECK_LIVE_SOURCES = ['timer', 'sdkState', 'sensor'];

// The fixed sensor metrics a live key can bind to (live.name). Battery keys
// use the dynamic form 'battery:<device name>' instead.
const DECK_SENSOR_METRICS = ['cpu', 'gpu', 'cpuTemp', 'gpuTemp', 'cpuFan', 'gpuFan', 'cpuWatts', 'gpuWatts', 'totalWatts', 'psuWatts'];

// Project the SSE 'system' payload into the flat bag the 'sensor' live source
// reads (snapshot.sensors). Kept pure so dashboard, Virtual Deck popup and
// tests share one shape. gpuFan carries a unit tag because NVIDIA reports a
// percent where LHM reports RPM.
function sensorsFromSystem(sys) {
  if (!sys || typeof sys !== 'object') return {};
  // Number(null)/Number('') are 0 — an absent reading must stay null, never
  // masquerade as a real 0W/0RPM value.
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const fans = Array.isArray(sys.fans) ? sys.fans : [];
  // kind === 'gpu' is the server's typed discriminator — never match on the
  // display name (a motherboard header can literally be called "GPU").
  const gpuFan = fans.find((f) => f && f.kind === 'gpu');
  const cpuFan = fans.find((f) => f && f.kind !== 'gpu' && Number.isFinite(Number(f.rpm)) && Number(f.rpm) > 0) || fans.find((f) => f && f.kind !== 'gpu');
  const p = (sys.power && typeof sys.power === 'object') ? sys.power : {};
  return {
    cpu: num(sys.cpu),
    gpu: num(sys.gpu),
    cpuTemp: num(sys.cpuTemp),
    gpuTemp: num(sys.gpuTemp),
    cpuFan: cpuFan ? num(cpuFan.rpm) : null,
    gpuFan: gpuFan ? { rpm: num(gpuFan.rpm), pct: num(gpuFan.pct) } : null,
    cpuWatts: num(p.cpu),
    gpuWatts: num(p.gpu),
    totalWatts: num(p.total),
    psuWatts: num(p.psu),
  };
}

// Project the SSE 'battery' device list into the snapshot bag the
// 'battery:<name>' live keys read — lowercased names, like timersByLabel.
function batteriesByName(devices) {
  const byName = {};
  for (const d of (Array.isArray(devices) ? devices : [])) {
    if (!d || !d.name) continue;
    byName[String(d.name).toLowerCase()] = { percent: Number(d.percent), charging: d.charging === true };
  }
  return byName;
}

// RPM reads best short: 860 stays literal, 1240 → '1.2k'.
function formatRpmText(rpm) {
  if (!Number.isFinite(rpm)) return '';
  if (rpm >= 1000) return (Math.round(rpm / 100) / 10) + 'k';
  return String(Math.round(rpm));
}

// One sensor metric → the short text painted on the key face.
function formatSensorText(name, snapshot) {
  const metric = String(name || '');
  if (metric.startsWith('battery:')) {
    const bag = snapshot.batteries || {};
    const entry = bag[metric.slice('battery:'.length).toLowerCase()];
    if (!entry || !Number.isFinite(Number(entry.percent))) return '';
    return (entry.charging ? '⚡' : '') + Math.round(entry.percent) + '%';
  }
  const sensors = snapshot.sensors || {};
  const v = sensors[metric];
  if (metric === 'gpuFan') {
    if (!v || typeof v !== 'object') return '';
    if (Number.isFinite(v.rpm)) return formatRpmText(v.rpm);
    if (Number.isFinite(v.pct)) return Math.round(v.pct) + '%';
    return '';
  }
  if (!Number.isFinite(v)) return '';
  if (metric === 'cpu' || metric === 'gpu') return Math.round(v) + '%';
  if (metric === 'cpuTemp' || metric === 'gpuTemp') return Math.round(v) + '°';
  if (metric === 'cpuFan') return formatRpmText(v);
  return Math.round(v) + 'W';   // cpuWatts / gpuWatts / totalWatts / psuWatts
}

// mm:ss (or h:mm:ss) for a timer snapshot entry. Running timers count down from
// endsAt; paused ones show their frozen remaining seconds.
function formatTimerText(t, now) {
  if (!t) return '';
  const secs = (t.status === 'running' && t.endsAt)
    ? Math.max(0, Math.round((t.endsAt - now) / 1000))
    : Math.max(0, Math.round(t.remainingSecs || 0));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return m + ':' + String(s).padStart(2, '0');
}

// Project the raw /api/timers list into the snapshot shape formatLiveValue and
// the timerRunning state read: { [label]: { status, endsAt | remainingSecs } }.
// endsAt is derived HERE (startedAt + what's left of the duration) so every
// surface (dashboard, Virtual Deck popup) counts down identically.
// Keys are LOWERCASED: the server's timer actions match labels
// case-insensitively, so the snapshot lookups must too or a key bound to
// 'tea' toggles the tile-created timer 'Tea' without ever lighting its face.
function timersByLabel(timers) {
  const byLabel = {};
  for (const tm of (Array.isArray(timers) ? timers : [])) {
    if (!tm || !tm.label) continue;
    const left = Math.max(0, (Number(tm.durationSecs) || 0) - (Number(tm.pausedElapsed) || 0));
    byLabel[String(tm.label).toLowerCase()] = tm.status === 'running'
      ? { status: 'running', endsAt: (Number(tm.startedAt) || Date.now()) + left * 1000 }
      : { status: tm.status, remainingSecs: tm.status === 'done' ? 0 : left };
  }
  return byLabel;
}

// Resolve a key's live binding against the state snapshot → { text, color? }.
// Pure so the renderer's ticker and the tests share one formatter. `now` is
// injectable for tests; the renderer passes Date.now().
function formatLiveValue(live, snapshot, now) {
  if (!live || typeof live !== 'object' || !snapshot || typeof snapshot !== 'object') return { text: '' };
  if (live.source === 'timer') {
    const bag = snapshot.timers || {};
    let entry = live.name ? bag[String(live.name).toLowerCase()] : null;   // bag keys are lowercased
    if (!entry && !live.name) {
      // Unnamed binding: follow the running timer that ends soonest.
      for (const t of Object.values(bag)) {
        if (t && t.status === 'running' && (!entry || (t.endsAt || Infinity) < (entry.endsAt || Infinity))) entry = t;
      }
    }
    return { text: formatTimerText(entry, typeof now === 'number' ? now : Date.now()) };
  }
  if (live.source === 'sdkState') {
    const meta = (snapshot.sdkStateMeta && live.name) ? snapshot.sdkStateMeta[live.name] : null;
    const value = (snapshot.sdkStates && live.name) ? snapshot.sdkStates[live.name] : undefined;
    const text = clampStr((meta && meta.label) || (value != null ? value : ''), 24);
    const out = { text };
    const color = meta && cleanHex(meta.color);
    if (color) out.color = color;
    return out;
  }
  if (live.source === 'sensor') {
    return { text: formatSensorText(live.name, snapshot) };
  }
  return { text: '' };
}

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
    // Named live values keyed by state.name: a Streamer.bot global (via the
    // `streamerbot` SSE event) or a state an SDK widget publishes over the bridge.
    // On while the value is truthy, or (when a value is given) exactly equals it.
    case 'sbGlobal':  return matchNamedState(state, snapshot.sbGlobals);
    case 'sdkState':  return matchNamedState(state, snapshot.sdkStates);
    case 'discordMuted':    return !!snapshot.discordMuted;
    case 'discordDeafened': return !!snapshot.discordDeafened;
    case 'mediaPlaying':    return !!snapshot.mediaPlaying;
    // "Spotify is playing": the media stream is playing AND its source is Spotify.
    case 'spotifyPlaying':  return !!snapshot.mediaPlaying && /spotify/i.test(String(snapshot.mediaSource || ''));
    // Home Assistant entity: on while its live state string reads as "on", or
    // (when state.value is given) exactly equals it — e.g. value "heat".
    case 'haEntity': {
      const entry = (state.entity && snapshot.haStates) ? snapshot.haStates[state.entity] : undefined;
      const v = entry && typeof entry === 'object' ? entry.state : entry;
      if (v == null) return false;
      if (state.value != null && state.value !== '') return String(v) === String(state.value);
      return HA_ON_STATES.includes(String(v).toLowerCase());
    }
    // A timer is counting down: the named one (by label), or any when unnamed.
    case 'timerRunning': {
      const bag = snapshot.timers || {};
      if (state.name) { const t = bag[String(state.name).toLowerCase()]; return !!(t && t.status === 'running'); }   // bag keys are lowercased
      return Object.values(bag).some((t) => t && t.status === 'running');
    }
    default:                return false;
  }
}

const DECK_MODEL_API = { normalizeDeckConfig, normalizeDeckWellImage, normalizeDeckMediaStyle, normalizeDeckLook, effectiveDeckLook, setProfileLook, resolveView, setKeyAt, addPageAt, removePageAt, newKeyId, newProfileId, setActiveProfile, addProfile, renameProfile, removeProfile, getProfile, addProfileFromTemplate, cloneConfig, evaluateKeyState, gridForSize, gridOf, reshapeDeckConfig, fitDeckGrids, foldDeckGrids, swapKeysAt, moveKeyToPage, keyStyleOf, applyStyleToPage, KEY_STYLE_FIELDS, KEY_SIZES, KEY_GAPS, DECK_STATE_SOURCES, DECK_LIVE_SOURCES, DECK_SENSOR_METRICS, SLIDER_TARGETS, formatLiveValue, timersByLabel, sensorsFromSystem, batteriesByName, DECK_MIN, DECK_MAX, PRESS_FX, ICON_FITS, GRAD_DIRS, LABEL_POSITIONS, STYLE_SIZES, KEY_ANIMS, CAP_STYLES, KEY_SHAPES, PLATE_STYLES };
if (typeof window !== 'undefined') {
  window.DeckModel = DECK_MODEL_API;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DECK_MODEL_API;
}

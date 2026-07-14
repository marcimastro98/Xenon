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
const CAP_STYLES = ['lcd', 'flat', 'neon', 'glass', 'vivid'];  // key-cap material ('vivid' = flat, full-saturation accent fill)
const KEY_SHAPES = ['rounded', 'square', 'circle'];   // cap corner shape
const PLATE_STYLES = ['graphite', 'carbon', 'steel', 'midnight', 'none']; // chassis faceplate

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Per-field validators for the deck's look/layout settings. Each takes a raw
// value and a fallback, keeping the value only when it's a valid choice. Shared
// by the profile normalizer, the per-profile settings funnel and the share-code
// sanitizer so every entry point validates identically.
const KEY_SIZE_IDS = ['sm', 'md', 'lg'];
function deckKeySize(v, fb) { return KEY_SIZE_IDS.includes(v) ? v : fb; }
function deckCapStyle(v, fb) { return CAP_STYLES.includes(v) ? v : fb; }
function deckKeyShape(v, fb) { return KEY_SHAPES.includes(v) ? v : fb; }
function deckPlate(v, fb) { return PLATE_STYLES.includes(v) ? v : fb; }
function deckBool(v, fb) { return typeof v === 'boolean' ? v : fb; }
// The hard defaults for a profile's settings — the classic deck (3×2, medium
// LCD caps, no decoration). Used to floor the device-level defaults so a profile
// always resolves every field even when neither it nor the device carries one.
const DECK_SETTING_DEFAULTS = {
  cols: 3, rows: 2, keySize: 'md', autoFit: true, showMedia: false,
  capStyle: 'lcd', keyShape: 'rounded', plate: 'graphite',
  wellImage: null, mediaStyle: null, font: null,
};

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
// Per-Deck embedded typeface: an inline base64 font (name/ext/data) applied ONLY
// to this deck's labels/badges/now-playing (never the global UI). Inert data —
// rendered solely as an @font-face `src` — so validation is ext-allowlist + a
// base64 shape check + a size cap, nothing executable. Rides the deck config the
// same way key/well images do, so it travels through save, share codes and backup.
const DECK_FONT_MAX = 2 * 1024 * 1024;                 // ~1.5 MB font (base64), well under the 4MB per-instance cap
const DECK_FONT_EXTS = ['woff2', 'woff', 'ttf', 'otf'];
const DECK_FONT_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function normalizeDeckFont(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ext = String(raw.ext == null ? '' : raw.ext).trim().toLowerCase();
  const data = String(raw.data == null ? '' : raw.data).trim();
  if (!DECK_FONT_EXTS.includes(ext)) return null;
  if (!data || data.length > DECK_FONT_MAX || !DECK_FONT_B64_RE.test(data)) return null;
  const out = { ext, data };
  const name = clampStr(raw.name, 120);
  if (name) out.name = name;
  // Provenance: a font that arrived inside someone else's shared profile is marked
  // so exports refuse to redistribute it (sticky across edits, like wellImage).
  if (raw.imported === true) out.imported = true;
  return out;
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

// A profile now OWNS its full look + grid. Each field resolves own → device
// `defaults` → hard default, so a legacy profile that carries none of these
// inherits the old device-level values and nothing changes visually on the first
// migrating load. `defaults` is the resolved device-level settings object built
// by normalizeDeckConfig; its pages/folders size to the profile's OWN grid.
function normalizeProfile(raw, defaults, index) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = Object.assign({}, DECK_SETTING_DEFAULTS, defaults || {});
  const cols = clampInt(r.cols, DECK_MIN, DECK_MAX, d.cols);
  const rows = clampInt(r.rows, DECK_MIN, DECK_MAX, d.rows);
  const inherit = (own, dflt) => own || (dflt ? cloneConfig(dflt) : null);
  const prof = {
    id: clampStr(r.id, 64) || ('prof_' + index),
    name: clampStr(r.name, 40) || ('Profile ' + (index + 1)),
    cols, rows,
    keySize: deckKeySize(r.keySize, d.keySize),
    autoFit: deckBool(r.autoFit, d.autoFit),
    showMedia: deckBool(r.showMedia, d.showMedia),
    capStyle: deckCapStyle(r.capStyle, d.capStyle),
    keyShape: deckKeyShape(r.keyShape, d.keyShape),
    plate: deckPlate(r.plate, d.plate),
    wellImage: inherit(normalizeDeckWellImage(r.wellImage), d.wellImage),
    mediaStyle: inherit(normalizeDeckMediaStyle(r.mediaStyle), d.mediaStyle),
    font: inherit(normalizeDeckFont(r.font), d.font),
    root: normalizeFolder(r.root, cols, rows),
  };
  // Redistribution marker: profiles that arrived via a share code are someone
  // else's work and can't be re-exported. Additive — never set on own profiles;
  // sanitizeDeckProfile strips it on export, so shared codes never carry it.
  if (r.imported === true) prof.imported = true;
  return prof;
}

function normalizeDeckConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  // The former device-level look/grid is folded into each profile ONLY when
  // MIGRATING a legacy (pre-v2) config — that one-time inheritance reproduces the
  // look the shared-device deck had, so nothing changes visually on upgrade.
  //
  // For a config that is ALREADY v2 every profile is AUTHORITATIVE: a null
  // wellImage / mediaStyle / font means the user CLEARED it and must NOT be
  // re-pulled from the top-level mirror. (Passing the mirror as defaults on every
  // normalize is what made the "✕ remove background/font" buttons no-ops and made
  // a profile keep re-inheriting another profile's look.)
  const migrating = src.version !== 2;
  const defaults = migrating ? {
    cols: clampInt(src.cols, DECK_MIN, DECK_MAX, 3),
    rows: clampInt(src.rows, DECK_MIN, DECK_MAX, 2),
    keySize: deckKeySize(src.keySize, 'md'),
    autoFit: deckBool(src.autoFit, true),
    showMedia: deckBool(src.showMedia, false),
    capStyle: deckCapStyle(src.capStyle, 'lcd'),
    keyShape: deckKeyShape(src.keyShape, 'rounded'),
    plate: deckPlate(src.plate, 'graphite'),
    wellImage: normalizeDeckWellImage(src.wellImage),
    mediaStyle: normalizeDeckMediaStyle(src.mediaStyle),
    font: normalizeDeckFont(src.font),
  } : null;
  const rawProfiles = Array.isArray(src.profiles) && src.profiles.length ? src.profiles : [null];
  const profiles = rawProfiles.map((p, i) => normalizeProfile(p, defaults, i));
  const ids = new Set(profiles.map(p => p.id));
  const activeProfile = ids.has(src.activeProfile) ? src.activeProfile : profiles[0].id;
  // Smart Profiles: auto-switch the DISPLAYED profile to match the app in the
  // foreground. Rules pair a process exe name (lowercased, no ".exe" — the exact
  // shape gamedetect's foreground probe reports) with a profile NAME (names
  // survive share/copy; ids don't). Device-global — the switch itself is a
  // render-time override that never writes activeProfile.
  const autoSwitch = normalizeAutoSwitch(src.autoSwitch);
  // Top-level look/grid is a MIRROR of the ACTIVE profile — advisory, kept so a
  // not-yet-updated surface (and the legacy migrateStore seed) still reads a
  // coherent value. The app proper always reads the SHOWN profile, never this.
  const act = profiles.find(p => p.id === activeProfile) || profiles[0];
  return {
    version: 2,
    cols: act.cols, rows: act.rows, keySize: act.keySize, autoFit: act.autoFit,
    showMedia: act.showMedia, capStyle: act.capStyle, keyShape: act.keyShape,
    plate: act.plate, wellImage: act.wellImage, mediaStyle: act.mediaStyle, font: act.font,
    profiles, activeProfile, autoSwitch,
  };
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
// Clamped to the deck's [1..6] range; falls back to a 3×2 grid for tiny/unknown
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

// Walk every page in the config (each profile root + nested folders), calling
// fn(page). Used by the reshape pass below.
function eachPageOfProfile(profile, fn) {
  const walk = (folder) => {
    for (const page of folder.pages) {
      fn(page);
      for (const k of page.keys) if (k && k.kind === 'folder' && k.folder) walk(k.folder);
    }
  };
  if (profile && profile.root) walk(profile.root);
}

// Largest number of placed keys on any single page of a profile — the floor
// below which that profile's grid must not shrink, or keys would be lost.
function maxOccupiedOfProfile(profile) {
  let m = 0;
  eachPageOfProfile(profile, (page) => { const n = page.keys.filter(Boolean).length; if (n > m) m = n; });
  return m;
}

// Highest occupied SLOT INDEX + 1 across every page — i.e. the minimum number of
// slots needed to keep every key exactly where the user put it (gaps included).
// Used by { preserve } reshapes so the grid grows to hold a key at, say, slot 7
// instead of repacking it forward.
function maxOccupiedIndexOfProfile(profile) {
  let m = 0;
  eachPageOfProfile(profile, (page) => {
    for (let i = page.keys.length - 1; i >= 0; i--) {
      if (page.keys[i]) { if (i + 1 > m) m = i + 1; break; }
    }
  });
  return m;
}
function maxOccupiedIndex(cfg) {
  let m = 0;
  for (const prof of cfg.profiles) { const n = maxOccupiedIndexOfProfile(prof); if (n > m) m = n; }
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
function reshapeProfile(config, profileId, cols, rows, opts) {
  const compact = !!(opts && opts.compact);
  const preserve = !!(opts && opts.preserve);
  // `pin` names the dimension the USER fixed (a manual stepper): honour it and
  // grow the OTHER axis to fit, so "give me 2 rows" widens the columns instead of
  // silently bouncing the rows back up. Falls back to the pinned axis only if the
  // other maxes out (so a key is still never dropped). Default: rows-then-cols.
  const pin = opts && opts.pin;
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const prof = cfg.profiles.find(p => p.id === profileId) || cfg.profiles[0];
  let c = clampInt(cols, DECK_MIN, DECK_MAX, prof.cols);
  let r = clampInt(rows, DECK_MIN, DECK_MAX, prof.rows);
  const need = preserve ? maxOccupiedIndexOfProfile(prof) : maxOccupiedOfProfile(prof);
  if (pin === 'rows') {
    while (c * r < need && c < DECK_MAX) c++;   // keep rows, widen columns
    while (c * r < need && r < DECK_MAX) r++;   // only if columns maxed out
  } else if (pin === 'cols') {
    while (c * r < need && r < DECK_MAX) r++;   // keep columns, add rows
    while (c * r < need && c < DECK_MAX) c++;
  } else {
    while (c * r < need && r < DECK_MAX) r++;
    while (c * r < need && c < DECK_MAX) c++;
  }
  const slots = c * r;
  eachPageOfProfile(prof, (page) => {
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
  return normalizeDeckConfig(cfg);
}
// Back-compat shim: "the deck grid" now means the ACTIVE profile's grid.
function reshapeDeckConfig(config, cols, rows, opts) {
  const cfg = normalizeDeckConfig(config);
  return reshapeProfile(cfg, cfg.activeProfile, cols, rows, opts);
}
// Apply validated LOOK/PREF fields to one profile. Grid (cols/rows) is NOT set
// here — it must route through reshapeProfile so a shrink can never truncate a
// key. Every field is validated (never spread). Returns a NEW normalized config.
function setProfileSettings(config, profileId, patch) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const prof = cfg.profiles.find(p => p.id === profileId);
  if (!prof || !patch || typeof patch !== 'object') return normalizeDeckConfig(cfg);
  if ('keySize' in patch) prof.keySize = deckKeySize(patch.keySize, prof.keySize);
  if ('autoFit' in patch) prof.autoFit = deckBool(patch.autoFit, prof.autoFit);
  if ('showMedia' in patch) prof.showMedia = deckBool(patch.showMedia, prof.showMedia);
  if ('capStyle' in patch) prof.capStyle = deckCapStyle(patch.capStyle, prof.capStyle);
  if ('keyShape' in patch) prof.keyShape = deckKeyShape(patch.keyShape, prof.keyShape);
  if ('plate' in patch) prof.plate = deckPlate(patch.plate, prof.plate);
  if ('wellImage' in patch) prof.wellImage = normalizeDeckWellImage(patch.wellImage) || null;
  if ('mediaStyle' in patch) prof.mediaStyle = normalizeDeckMediaStyle(patch.mediaStyle) || null;
  if ('font' in patch) prof.font = normalizeDeckFont(patch.font) || null;
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
  // Inherit the ACTIVE profile's grid + look so a new profile matches what you're
  // looking at (not the hard defaults). Decoration is deep-cloned — a copy within
  // the same device is not redistribution, so any `imported` flag rides along.
  const base = cfg.profiles.find(p => p.id === cfg.activeProfile) || cfg.profiles[0];
  cfg.profiles.push({
    id,
    name: clampStr(name, 40) || ('Profile ' + (cfg.profiles.length + 1)),
    cols: base.cols, rows: base.rows, keySize: base.keySize, autoFit: base.autoFit,
    showMedia: base.showMedia, capStyle: base.capStyle, keyShape: base.keyShape, plate: base.plate,
    wellImage: base.wellImage ? cloneConfig(base.wellImage) : null,
    mediaStyle: base.mediaStyle ? cloneConfig(base.mediaStyle) : null,
    font: base.font ? cloneConfig(base.font) : null,
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

// Append a profile built from a saved preset/template (gets a fresh id, fitted to
// THIS deck's grid). Becomes active. The deck grid is GROWN first if the template
// holds more keys than the current grid can show, so copying a profile from a bigger
// deck (or inserting a richer preset) never silently truncates its keys — the
// reported "8-key profile came in with only 6" loss. New normalized config.
function addProfileFromTemplate(config, profileTemplate) {
  const cfg = cloneConfig(normalizeDeckConfig(config));
  const tpl = profileTemplate && typeof profileTemplate === 'object' ? profileTemplate : {};
  // A template carries its settings either FLAT (an in-device profile from a copy)
  // or under `look` (a share code). Read grid + look from whichever is present.
  const look = (tpl.look && typeof tpl.look === 'object') ? tpl.look : tpl;
  const active = cfg.profiles.find(p => p.id === cfg.activeProfile) || cfg.profiles[0];
  // Grid: the template's OWN when it specifies one; else the destination grid,
  // grown to hold every key (backward-compat for old codes without a grid). Sizes
  // ONLY the new profile — other profiles and the device grid are never touched.
  let c = clampInt(look.cols, DECK_MIN, DECK_MAX, 0) || active.cols;
  let r = clampInt(look.rows, DECK_MIN, DECK_MAX, 0) || active.rows;
  const probe = normalizeDeckConfig({ cols: DECK_MAX, rows: DECK_MAX, profiles: [tpl], activeProfile: 'p' });
  const need = maxOccupiedIndex(probe);
  while (c * r < need && r < DECK_MAX) r++;
  while (c * r < need && c < DECK_MAX) c++;
  // Look/pref defaults for the new profile: its own values, else the active
  // profile's (a bare copy shouldn't snap to hard defaults).
  const defaults = {
    cols: c, rows: r,
    keySize: deckKeySize(look.keySize, active.keySize),
    autoFit: deckBool(look.autoFit, active.autoFit),
    showMedia: deckBool(look.showMedia, active.showMedia),
    capStyle: deckCapStyle(look.capStyle, active.capStyle),
    keyShape: deckKeyShape(look.keyShape, active.keyShape),
    plate: deckPlate(look.plate, active.plate),
    wellImage: normalizeDeckWellImage(look.wellImage),
    mediaStyle: normalizeDeckMediaStyle(look.mediaStyle),
    font: normalizeDeckFont(look.font),
  };
  const id = newProfileId();
  const prof = normalizeProfile(Object.assign({}, tpl, { id, cols: c, rows: r }), defaults, cfg.profiles.length);
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
  const profileId = (nav && nav.profileId) || cfg.activeProfile;
  const profile = cfg.profiles.find(p => p.id === profileId) || cfg.profiles[0];
  const folder = folderAtPath(cfg, profileId, nav && nav.path);
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
// widget published for that state name.
const DECK_LIVE_SOURCES = ['timer', 'sdkState'];

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

const DECK_MODEL_API = { normalizeDeckConfig, normalizeDeckWellImage, normalizeDeckMediaStyle, normalizeDeckFont, resolveView, setKeyAt, addPageAt, removePageAt, newKeyId, newProfileId, setActiveProfile, addProfile, renameProfile, removeProfile, getProfile, addProfileFromTemplate, cloneConfig, evaluateKeyState, gridForSize, reshapeDeckConfig, reshapeProfile, setProfileSettings, clampInt, swapKeysAt, keyStyleOf, applyStyleToPage, KEY_STYLE_FIELDS, KEY_SIZES, KEY_GAPS, KEY_SIZE_IDS, DECK_STATE_SOURCES, DECK_LIVE_SOURCES, SLIDER_TARGETS, formatLiveValue, timersByLabel, DECK_MIN, DECK_MAX, PRESS_FX, ICON_FITS, GRAD_DIRS, LABEL_POSITIONS, STYLE_SIZES, KEY_ANIMS, CAP_STYLES, KEY_SHAPES, PLATE_STYLES };
if (typeof window !== 'undefined') {
  window.DeckModel = DECK_MODEL_API;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DECK_MODEL_API;
}

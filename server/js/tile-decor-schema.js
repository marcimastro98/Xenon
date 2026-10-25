'use strict';
// Validators for the richer per-tile look: colour, glow and motion on frames and
// overlays, a drawn pattern, a glow, an edge bar, and the widget's own controls
// (buttons, the selected state, text fields). normalizeTileDecor /
// normalizeTileStyle in dashboard-instances.js call these, so this stays the one
// boundary a saved layout, a share code or a Maker export goes through.
//
// Colours are '#rrggbb' or the word 'accent' (follow the tile's accent). Every
// number is clamped and every keyword allowlisted; anything else is dropped.

const TILE_DECOR_ACCENT = 'accent';
const TILE_FRAME_ANIMS = ['pulse'];
const TILE_OVERLAY_ANIMS = ['float', 'sway', 'spin', 'pulse', 'twinkle'];
const TILE_PATTERN_KINDS = ['dots', 'grid', 'lines', 'crosshatch', 'checker', 'scanlines', 'zigzag', 'noise'];
const TILE_PATTERN_FADES = ['top', 'bottom', 'left', 'right', 'center', 'edges'];
const TILE_BAR_SIDES = ['top', 'bottom', 'left', 'right'];
const TILE_BAR_ALIGNS = ['start', 'center', 'end'];
const TILE_CONTROL_VARIANTS = ['filled', 'soft', 'outline', 'ghost'];
const TILE_CONTROL_COLORS = ['bg', 'text', 'border', 'hover', 'activeBg', 'activeText', 'fieldBg', 'fieldText', 'fieldBorder'];

function _hex(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : '';
}
function _color(v) { return v === TILE_DECOR_ACCENT ? TILE_DECOR_ACCENT : _hex(v); }
function _int(v, lo, hi) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n))) : null;
}
// Copy a validated value onto `out`; an empty or null one leaves the key out.
function _put(out, key, value) { if (value != null && value !== '') out[key] = value; }

// Frame: a colour (or two, for a gradient) replacing the art's own, plus opacity,
// glow, an inward offset and a slow motion.
function tileFrameExtras(raw, out) {
  if (!raw || typeof raw !== 'object') return out;
  const tint = _color(raw.tint);
  _put(out, 'tint', tint);
  if (tint) _put(out, 'tint2', _hex(raw.tint2));
  const op = _int(raw.opacity, 0, 100); if (op != null && op < 100) out.opacity = op;
  const glow = _int(raw.glow, 0, 24); if (glow) out.glow = glow;
  const inset = _int(raw.inset, 0, 24); if (inset) out.inset = inset;
  if (TILE_FRAME_ANIMS.includes(raw.anim)) out.anim = raw.anim;
  return out;
}

// Overlay: a colour replacing the picture's own (its shape is kept), a glow in
// that colour or the accent, a soft shadow, a motion, and the layer it sits on.
function tileOverlayExtras(raw, out) {
  if (!raw || typeof raw !== 'object') return out;
  _put(out, 'tint', _color(raw.tint));
  const glow = _int(raw.glow, 0, 24); if (glow) out.glow = glow;
  const shadow = _int(raw.shadow, 0, 24); if (shadow) out.shadow = shadow;
  if (TILE_OVERLAY_ANIMS.includes(raw.anim)) out.anim = raw.anim;
  if (raw.layer === 'behind') out.layer = 'behind';
  return out;
}

// A pattern drawn with CSS gradients (no bytes): behind the widget by default,
// or over it. `fade` softens it towards one side, the centre or the edges.
function normalizeTilePattern(raw) {
  if (!raw || typeof raw !== 'object' || !TILE_PATTERN_KINDS.includes(raw.kind)) return null;
  const out = { kind: raw.kind };
  _put(out, 'color', _color(raw.color));
  _put(out, 'opacity', _int(raw.opacity, 1, 100));
  _put(out, 'size', _int(raw.size, 4, 96));
  _put(out, 'weight', _int(raw.weight, 1, 8));
  const angle = _int(raw.angle, 0, 180); if (angle) out.angle = angle;
  if (TILE_PATTERN_FADES.includes(raw.fade)) out.fade = raw.fade;
  if (raw.layer === 'above') out.layer = 'above';
  return out;
}

// A glow inside the tile's edge and/or around it.
function normalizeTileGlow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inner = _int(raw.inner, 0, 60), outer = _int(raw.outer, 0, 40);
  if (!inner && !outer) return null;
  const out = {};
  _put(out, 'color', _color(raw.color));
  if (inner) out.inner = inner;
  if (outer) out.outer = outer;
  return out;
}

// A coloured bar along one edge of the tile.
function normalizeTileBar(raw) {
  if (!raw || typeof raw !== 'object' || !TILE_BAR_SIDES.includes(raw.side)) return null;
  const out = { side: raw.side };
  _put(out, 'color', _color(raw.color));
  _put(out, 'size', _int(raw.size, 1, 16));
  const len = _int(raw.length, 10, 100); if (len != null && len < 100) out.length = len;
  if (TILE_BAR_ALIGNS.includes(raw.align) && raw.align !== 'center') out.align = raw.align;
  return out;
}

// The widget's own controls. Only what the user set is stored; the renderer
// fills the rest from the theme, so a tile with just a button colour keeps the
// theme's text colour readable on it.
function normalizeTileControls(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (TILE_CONTROL_VARIANTS.includes(raw.variant)) out.variant = raw.variant;
  TILE_CONTROL_COLORS.forEach((k) => _put(out, k, _hex(raw[k])));
  _put(out, 'radius', _int(raw.radius, 0, 40));
  _put(out, 'borderWidth', _int(raw.borderWidth, 0, 4));
  return Object.keys(out).length ? out : null;
}

const _tileDecorSchema = {
  TILE_DECOR_ACCENT, TILE_FRAME_ANIMS, TILE_OVERLAY_ANIMS, TILE_PATTERN_KINDS, TILE_PATTERN_FADES,
  TILE_BAR_SIDES, TILE_BAR_ALIGNS, TILE_CONTROL_VARIANTS, TILE_CONTROL_COLORS,
  tileFrameExtras, tileOverlayExtras, normalizeTilePattern, normalizeTileGlow, normalizeTileBar,
  normalizeTileControls,
};
if (typeof window !== 'undefined') window.TileDecorSchema = _tileDecorSchema;
if (typeof module !== 'undefined' && module.exports) module.exports = _tileDecorSchema;

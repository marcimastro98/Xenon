// The look of a widget's own controls (buttons, tabs, chips, the selected state
// and text fields), from a tile's `style.controls`. applyTileStyle() puts the
// result on the tile as --tb-* properties plus one data-tb-* attribute per part,
// and the rules in styles/tile-controls.css paint only the parts that are set: a tile
// with only a button colour keeps the theme's fields and selected state.
//
// Pure (no DOM) so the tests and the Maker preview read the same mapping.
(() => {
  'use strict';

  const TILE_CONTROL_VARS = [
    '--tb-bg', '--tb-text', '--tb-border', '--tb-hover', '--tb-active-bg', '--tb-active-text',
    '--tb-field-bg', '--tb-field-text', '--tb-field-border', '--tb-radius', '--tb-bw',
  ];
  const TILE_CONTROL_ATTRS = ['bg', 'text', 'border', 'hover', 'active', 'field-bg', 'field-text', 'field-border', 'radius', 'bw'];

  function _palette() {
    return (typeof window !== 'undefined' && window.ThemePalette)
      || (() => { try { return require('./theme-palette.js'); } catch { return null; } })();
  }
  // Black or white, whichever reads better on `hex`.
  function readableOn(hex) {
    const P = _palette();
    if (P && P.bestText) return P.bestText(hex);
    const n = parseInt(String(hex).slice(1), 16);
    const y = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return y > 150 ? '#111111' : '#ffffff';
  }
  const tint = (c, pct) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

  // style.controls → { vars: { '--tb-…': css }, attrs: ['bg', …] }. Absent or
  // empty → nothing, and the widget keeps the theme's controls.
  function resolveTileControls(c) {
    const vars = {};
    if (!c || typeof c !== 'object') return { vars, attrs: [] };
    const variant = c.variant || (c.bg ? 'filled' : '');
    const set = (k, v) => { if (v) vars[k] = v; };
    // The colour a transparent variant is drawn in: the chosen one, else the accent.
    const ink = c.bg || c.border || 'var(--accent)';
    if (variant === 'filled') {
      const bg = c.bg || 'var(--accent)';
      set('--tb-bg', bg);
      set('--tb-text', c.text || (c.bg ? readableOn(c.bg) : 'var(--on-accent)'));
      set('--tb-border', c.border || bg);
      set('--tb-hover', c.hover || `color-mix(in srgb, ${bg} 84%, ${vars['--tb-text']})`);
    } else if (variant === 'soft') {
      set('--tb-bg', tint(ink, 18));
      set('--tb-text', c.text || ink);
      set('--tb-border', c.border || 'transparent');
      set('--tb-hover', c.hover || tint(ink, 30));
    } else if (variant === 'outline') {
      set('--tb-bg', 'transparent');
      set('--tb-text', c.text || ink);
      set('--tb-border', c.border || ink);
      set('--tb-hover', c.hover || tint(ink, 14));
    } else if (variant === 'ghost') {
      set('--tb-bg', 'transparent');
      set('--tb-text', c.text || '');
      set('--tb-border', 'transparent');
      set('--tb-hover', c.hover || tint(c.text || ink, 14));
    } else {
      // No variant: only the colours the user picked replace the theme's.
      set('--tb-text', c.text);
      set('--tb-border', c.border);
      set('--tb-hover', c.hover);
    }
    if (c.activeBg || c.activeText) {
      set('--tb-active-bg', c.activeBg || 'var(--accent)');
      set('--tb-active-text', c.activeText || (c.activeBg ? readableOn(c.activeBg) : 'var(--on-accent)'));
    }
    set('--tb-field-bg', c.fieldBg);
    set('--tb-field-text', c.fieldText);
    set('--tb-field-border', c.fieldBorder);
    if (typeof c.radius === 'number') vars['--tb-radius'] = `${c.radius}px`;
    if (typeof c.borderWidth === 'number') vars['--tb-bw'] = `${c.borderWidth}px`;

    const attrs = [];
    const has = (k) => k in vars;
    if (has('--tb-bg')) attrs.push('bg');
    if (has('--tb-text')) attrs.push('text');
    if (has('--tb-border')) attrs.push('border');
    if (has('--tb-hover')) attrs.push('hover');
    if (has('--tb-active-bg')) attrs.push('active');
    if (has('--tb-field-bg')) attrs.push('field-bg');
    if (has('--tb-field-text')) attrs.push('field-text');
    if (has('--tb-field-border')) attrs.push('field-border');
    if (has('--tb-radius')) attrs.push('radius');
    if (has('--tb-bw')) attrs.push('bw');
    return { vars, attrs };
  }

  // DOM side, used by applyTileStyle(): clear the previous look, then paint.
  function applyTileControls(el, controls) {
    if (!el) return;
    TILE_CONTROL_VARS.forEach((p) => el.style.removeProperty(p));
    TILE_CONTROL_ATTRS.forEach((a) => el.removeAttribute(`data-tb-${a}`));
    const { vars, attrs } = resolveTileControls(controls);
    Object.keys(vars).forEach((k) => el.style.setProperty(k, vars[k]));
    attrs.forEach((a) => el.setAttribute(`data-tb-${a}`, ''));
    el._xenonTileControls = attrs.length ? controls : null;
  }

  // theme.controls for an SDK widget on this tile. CSS variables do not cross
  // into the frame's document, so the values are read back from the tile, where
  // var(--accent) has become a real colour. Only what the tile sets is present;
  // null when it sets nothing. `read(name)` returns a computed custom property.
  const PAYLOAD_KEYS = {
    '--tb-bg': 'bg', '--tb-text': 'text', '--tb-border': 'border', '--tb-hover': 'hover',
    '--tb-active-bg': 'activeBg', '--tb-active-text': 'activeText',
    '--tb-field-bg': 'fieldBg', '--tb-field-text': 'fieldText', '--tb-field-border': 'fieldBorder',
  };
  function controlsPayload(controls, read) {
    const { vars } = resolveTileControls(controls);
    const names = Object.keys(vars);
    if (!names.length) return null;
    const out = { variant: (controls && controls.variant) || (controls && controls.bg ? 'filled' : '') || null };
    names.forEach((name) => {
      const value = String(read(name) || vars[name]).trim();
      if (PAYLOAD_KEYS[name]) out[PAYLOAD_KEYS[name]] = value;
    });
    if (typeof controls.radius === 'number') out.radius = controls.radius;
    if (typeof controls.borderWidth === 'number') out.borderWidth = controls.borderWidth;
    return out;
  }
  function readTileControls(el) {
    if (!el || !el._xenonTileControls) return null;
    const cs = getComputedStyle(el);
    return controlsPayload(el._xenonTileControls, (name) => cs.getPropertyValue(name));
  }

  const _tileControls = {
    TILE_CONTROL_VARS, TILE_CONTROL_ATTRS, readableOn, resolveTileControls, applyTileControls,
    controlsPayload, readTileControls,
  };
  if (typeof window !== 'undefined') window.TileControls = _tileControls;
  if (typeof module !== 'undefined' && module.exports) module.exports = _tileControls;
})();

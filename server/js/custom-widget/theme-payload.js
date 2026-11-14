// What the host tells a widget about the dashboard's look: light or dark, the skin and the look by
// name, the colours as the tile really shows them, and the rest of the theme a widget dresses
// itself with.
'use strict';

(() => {
  // A widget themes itself from `appearance` (light/dark). data-appearance is a
  // pipeline flag, not necessarily the visible surface — an imported theme may
  // pair an old `appearance` hint with a completely different panel colour.
  // Derive appearance from the ACTUAL panel/background luminance so a widget
  // always matches the surface it sits on under any skin.
  function surfaceAppearance() {
    try {
      const cs = getComputedStyle(document.documentElement);
      let s = cs.getPropertyValue('--panel-rgb').trim() || cs.getPropertyValue('--bg').trim();
      let r, g, b;
      if (s.charAt(0) === '#') {
        const h = s.length === 4 ? s.slice(1).replace(/./g, (c) => c + c) : s.slice(1);
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
      } else {
        const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/);
        if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
      }
      if (r == null || Number.isNaN(r)) return document.documentElement.getAttribute('data-appearance') || 'dark';
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? 'light' : 'dark';
    } catch { return document.documentElement.getAttribute('data-appearance') || 'dark'; }
  }

  // Which SKIN the dashboard is wearing: 'glass' or 'retro'. Liquid Glass and Classic
  // both answer 'glass': they share one shape language, and a widget written before
  // Liquid Glass must not fall through a check it has never heard of. The palette alone
  // cannot carry this: the Pixel Retro skin differs from them in shape language
  // (square corners, hard edges, no translucency), not only in colour,
  // so a widget following the palette faithfully still looked like a glass tile
  // sitting in a pixel dashboard. Read-only, no permission: it says nothing about
  // the user and grants nothing.
  function skinMode() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    return hs.styleMode === 'retro' ? 'retro' : 'glass';
  }

  // theme change animates), and a registered colour computes to rgb(...), not
  // the hex it was set as. normalizeHex only reads hex, so a tile's own accent
  // or background fell back to the global one before reaching the widget.
  // Turned back into #rrggbb here; anything else passes through unchanged.
  // A see-through colour is laid over `under` (a #rrggbb) when one is given: on
  // Liquid Glass a tile's line, cards and keys are white or black at 8-16%
  // (liquid-tiles.css), and with the alpha simply dropped a widget drew solid
  // white lines and buttons on every tile.
  function computedHex(value, under) {
    const raw = String(value || '').trim();
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(raw);
    if (!m) return raw;
    const alpha = m[4] == null ? 1 : Math.min(1, parseFloat(m[4]) / (m[5] ? 100 : 1));
    // Fully transparent has no colour to hand over: let the fallback apply.
    if (alpha === 0) return '';
    const base = /^#[0-9a-f]{6}$/i.test(under || '')
      ? [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16))
      : null;
    return '#' + [m[1], m[2], m[3]]
      .map((v, i) => (base && alpha < 1 ? Number(v) * alpha + base[i] * (1 - alpha) : Number(v)))
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('');
  }

  // The dashboard's look by name, which `skin` deliberately folds into two:
  // 'liquid' (Liquid Glass), 'glass' (Classic), 'retro' or 'comic'.
  function lookMode(hs) {
    return ['liquid', 'glass', 'retro', 'comic'].includes(hs.styleMode) ? hs.styleMode : 'glass';
  }

  function themePayload(entry) {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    // Resolved 12h/24h preference (auto/12/24 → boolean) so a widget rendering
    // its own clock — e.g. the Ambient scene's hero time — agrees with the
    // dashboard instead of hard-coding 24h. Sent on init AND on refreshTheme, so
    // toggling the format in Settings updates a live widget without a reload.
    const clock12 = (typeof clockUses12h === 'function') ? clockUses12h() : false;
    // ...and how much of the DATE the user wants spelled out (v4.11.8's Settings
    // → Clock → Date format). Same reason as clock12: a widget that prints a date
    // beside a dashboard set to "Fri 11 Sep" should not be the one thing on
    // screen writing "Friday, 11 September". A NAME, not a formatted string: the
    // widget asks Intl for that shape in its own locale, because slicing a long
    // date apart produces nonsense in ten of the eleven languages Xenon speaks.
    const dateFormat = (typeof clockDateShape === 'function') ? clockDateShape() : 'full';
    let p = (typeof window.getEffectiveThemePalette === 'function')
      ? window.getEffectiveThemePalette()
      : null;
    let overrides = [];
    // The tile's own button/field colours (Widget style → Controls), or null.
    let controls = null;
    // CSS custom properties do not cross an iframe document boundary. Read the
    // final computed tokens from the frame element itself so a custom SDK widget
    // receives the palette of its own tile, including any per-widget override.
    // Service/Ambient frames simply inherit the global tokens through the same
    // path. `_xenonThemeOverrides` is host-only metadata used by generated
    // widgets to preserve an authored accent unless the tile explicitly changes
    // it; third-party widgets may ignore it and consume the effective palette.
    if (entry && entry.frame && window.ThemePalette) {
      try {
        const cs = getComputedStyle(entry.frame);
        const read = (name, fallback, under) => ThemePalette.normalizeHex(computedHex(cs.getPropertyValue(name), under), fallback);
        const num = (name) => { const v = parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v) ? v : null; };
        const base = p || ThemePalette.derive({
          accent: hs.accent, background: hs.background, text: hs.text,
          contrastGuard: hs.contrastGuard,
        }, surfaceAppearance());
        const background = read('--bg', base.background);
        const surface = read('--surface', base.surface, background);
        // Every other role sits on the tile, so a see-through one is laid over it.
        const onTile = (name, fallback) => read(name, fallback, surface);
        const local = {
          tone: ThemePalette.toneFor(surface),
          guard: base.guard,
          background,
          surface,
          surfaceAlt: onTile('--surface-alt', base.surfaceAlt),
          control: onTile('--control-bg', base.control),
          text: onTile('--text', base.text),
          muted: onTile('--muted-text', base.muted),
          dim: onTile('--dim-text', base.dim),
          line: onTile('--line', base.line),
          accent: onTile('--accent', base.accent),
          onAccent: onTile('--on-accent', base.onAccent),
          success: onTile('--color-success', base.success),
          onSuccess: onTile('--on-success', base.onSuccess),
          warning: onTile('--color-warn', base.warning),
          onWarning: onTile('--on-warning', base.onWarning),
          danger: onTile('--color-danger', base.danger),
          onDanger: onTile('--on-danger', base.onDanger),
          info: onTile('--color-info', base.info),
          onInfo: onTile('--on-info', base.onInfo),
          // Panel opacity ("Opacità pannelli"): the nested-card surface already
          // carrying the user's alpha (surfaceAlt at --panel-soft-alpha), plus the
          // raw factor — so a widget can make its own cards follow it like a native
          // tile does. rgba string / 0..1 number; null when unavailable.
          surfaceSoft: (cs.getPropertyValue('--panel-soft').trim() || null),
          panelAlpha: num('--panel-soft-alpha'),
          // The tile's own edge (#153): the colour as the host resolved it (the
          // user's Panel border dial, light tone, Retro's accent, Comic's ink) and
          // the dial's alpha alone. A frame inherits neither from the tile.
          panelBorder: (cs.getPropertyValue('--panel-border').trim() || null),
          panelBorderAlpha: num('--panel-border-alpha'),
        };
        p = local;
        const tile = entry.frame.closest('.grid-stack-item');
        if (tile && Array.isArray(tile._xenonThemeOverrides)) overrides = tile._xenonThemeOverrides.slice();
        if (tile && window.TileControls) controls = window.TileControls.readTileControls(tile);
      } catch { /* detached frame: use the global palette below */ }
    }
    if (p) {
      const palette = {
        background: p.background, surface: p.surface, surfaceAlt: p.surfaceAlt, control: p.control,
        text: p.text, muted: p.muted, dim: p.dim, line: p.line,
        accent: p.accent, onAccent: p.onAccent,
        success: p.success, onSuccess: p.onSuccess,
        warning: p.warning, onWarning: p.onWarning,
        danger: p.danger, onDanger: p.onDanger,
        info: p.info, onInfo: p.onInfo,
        // Optional (present when the tile's tokens were readable): a card surface
        // that follows the user's panel opacity, and the raw 0..1 factor.
        surfaceSoft: p.surfaceSoft || null, panelAlpha: (typeof p.panelAlpha === 'number' ? p.panelAlpha : null),
        // Optional: the tile's edge colour and the user's Panel border alpha.
        panelBorder: p.panelBorder || null, panelBorderAlpha: (typeof p.panelBorderAlpha === 'number' ? p.panelBorderAlpha : null),
      };
      return { appearance: p.tone, skin: skinMode(), look: lookMode(hs), overrides, controls, clock12, dateFormat, ...palette, palette };
    }
    return {
      appearance: surfaceAppearance(),
      skin: skinMode(),
      look: lookMode(hs),
      accent: typeof hs.accent === 'string' ? hs.accent : '#1ed760',
      background: typeof hs.background === 'string' ? hs.background : '#070808',
      text: typeof hs.text === 'string' ? hs.text : '#f0f3f1',
      clock12,
      dateFormat,
    };
  }

  window.CustomWidgetThemePayload = { themePayload };
})();

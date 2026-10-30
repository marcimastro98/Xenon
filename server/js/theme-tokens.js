'use strict';

// The theme as CSS custom properties: the colour roles, the material a tile is
// drawn with (panel opacity, border, shadow, corner radius, glass, skin) and the
// user's typeface. Shared by the dashboard (settings.js applyHubSettings) and
// the light layer page (js/layer-lite.js), so a widget on the desktop wears the
// same tile as on the dashboard. Pure apart from writing to the page it is handed; the
// settings it reads are already normalized (client and server normalize them
// with the same defaults).
(function (root, factory) {
  const palette = root.ThemePalette || (typeof require === 'function' ? require('./theme-palette.js') : null);
  const api = factory(palette);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ThemeTokens = api;
})(typeof window !== 'undefined' ? window : globalThis, function (ThemePalette) {
  function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
  }

  // `resolve(mode)` turns 'auto' into the live OS tone; `dynamicAccent` is the
  // album-art or widget tint in effect, or null.
  function derivePalette(s, { resolve, dynamicAccent = null }) {
    // Safe mode: factory palette, full stop. Derives from STOCK without reading
    // any user colour/variant key, so nothing saved is touched and toggling off
    // re-derives the user's theme unchanged.
    if (s.safeMode === true) {
      const tone = resolve(s.appearance);
      return ThemePalette.derive({ ...ThemePalette.STOCK[tone] }, tone);
    }
    const source = { ...s };
    if (s.appearance === 'auto' && s.autoPalette === true) {
      const stock = ThemePalette.STOCK[resolve('auto')];
      Object.assign(source, stock, {
        mutedText: null, lineColor: null, accentText: null,
        successColor: null, warningColor: null, dangerColor: null, infoColor: null,
      });
      // Accent remains a user preference even while the neutral palette follows
      // Windows; album-art accent may still replace it below.
      source.accent = s.accent;
    }
    // Dual-palette theme: overlay the half matching the resolved tone (on 'auto'
    // that's the live OS tone, so Windows flips repaint through the existing
    // matchMedia / refreshOsTheme listeners and nothing is persisted).
    const variant = s.paletteVariants ? ThemePalette.variantFor(s.paletteVariants, resolve(s.appearance)) : null;
    Object.assign(source, ThemePalette.applyVariant(source, variant));
    if (s.dynamicAlbumTheme !== false && dynamicAccent) source.accent = dynamicAccent;
    // Comic's default material is printed on the Base background. Authors can
    // still separate canvas and paper explicitly with `surface`.
    if (s.styleMode === 'comic' && !source.surface) source.surface = source.background;
    // Retro intentionally owns a fixed CRT palette; expose the same effective
    // colours to SDK widgets instead of leaking the previous skin's palette.
    if (s.styleMode === 'retro') {
      Object.assign(source, {
        background: '#050510', surface: '#0d0e20', surfaceAlt: '#121328', controlColor: '#181a34',
        text: '#e8e8dc', mutedText: '#a9a9c0', lineColor: '#4c4c78', accent: '#f5c518',
      });
    }
    const hint = s.styleMode === 'retro' ? 'dark' : resolve(s.appearance);
    return ThemePalette.derive(source, hint);
  }

  // The tile drop shadow, expressed in terms of --panel-shadow-alpha so the theme
  // editor's "panel shadow" slider and the per-tile one finally reach a rule: the
  // token they both write had no consumer anywhere in the CSS, so neither control
  // changed a pixel. Shared because applyTileStyle() has to re-declare the SAME
  // expression on a tile wrapper — a custom property holding var() is resolved
  // where it is declared, so a tile that set only the alpha would keep
  // inheriting the value :root had already computed.
  const PANEL_DROP_CSS = Object.freeze({
    dark: '0 1px 1px rgba(0,0,0, calc(var(--panel-shadow-alpha) * 0.73)), 0 10px 30px -14px rgba(0,0,0, calc(var(--panel-shadow-alpha) * 2.05))',
    light: '0 1px 2px rgba(20,30,40, calc(var(--panel-shadow-alpha) * 0.5)), 0 10px 30px -16px rgba(20,30,40, calc(var(--panel-shadow-alpha) * 1.4))',
  });

  function applyPalette(root, palette) {
    Object.entries(ThemePalette.cssTokens(palette)).forEach(([key, value]) => root.style.setProperty(key, value));
    root.dataset.appearance = palette.tone;
    root.style.colorScheme = palette.tone;

    // Component-facing semantic material tokens. They are intentionally defined
    // in terms of the palette roles, so every future theme and per-tile override
    // inherits coherent fields, hover states and selected states automatically.
    const semantic = {
      '--surface-raised': 'var(--surface-alt)',
      '--surface-subtle': 'color-mix(in srgb, var(--surface), var(--text) 5%)',
      '--surface-strong': 'color-mix(in srgb, var(--surface), var(--text) 10%)',
      '--hover-bg': 'color-mix(in srgb, var(--surface), var(--text) 7%)',
      '--active-bg': 'color-mix(in srgb, var(--surface), var(--accent) 18%)',
      '--input-bg': 'var(--control-bg)',
      '--divider': 'color-mix(in srgb, var(--line), transparent 28%)',
      '--scrollbar-thumb': 'color-mix(in srgb, var(--text), transparent 76%)',
      '--selection-bg': 'color-mix(in srgb, var(--accent), var(--surface) 76%)',
      '--selection-text': 'var(--text)',
      // A box-shadow, as every `box-shadow: var(--focus-ring)` expects: a bare
      // colour there is invalid and the ring vanished on every themed page.
      '--focus-ring': '0 0 0 2px var(--bg), 0 0 0 4px color-mix(in srgb, var(--accent), transparent 25%)',
      '--floating-ui-bg': 'color-mix(in srgb, var(--surface), transparent 22%)',
      '--floating-ui-border': 'var(--line)',
      '--oled-bg-rgb': ThemePalette.rgb(palette.surface).join(', '),
      '--oled-border': 'var(--line)',
      '--slider-fill': 'var(--accent)',
      '--slider-track': 'var(--control-bg)',
    };
    Object.entries(semantic).forEach(([key, value]) => root.style.setProperty(key, value));

    const light = palette.tone === 'light';
    root.style.setProperty('--glass-bg', light
      ? 'linear-gradient(135deg, color-mix(in srgb, var(--surface) 88%, white), color-mix(in srgb, var(--surface-alt) 82%, transparent))'
      : 'linear-gradient(135deg, color-mix(in srgb, var(--surface) 88%, white 12%), color-mix(in srgb, var(--surface) 96%, transparent) 58%, color-mix(in srgb, var(--surface-alt) 92%, white 8%))');
    root.style.setProperty('--glass-border', light ? 'color-mix(in srgb, var(--line), white 28%)' : 'color-mix(in srgb, var(--line), white 14%)');
    root.style.setProperty('--glass-highlight', light ? 'color-mix(in srgb, var(--surface), white 70%)' : 'rgba(255,255,255,0.38)');
    root.style.setProperty('--glass-sheen', light
      ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface), white 58%), transparent 38%)'
      : 'linear-gradient(180deg, rgba(255,255,255,0.14), transparent 30%)');
    root.style.setProperty('--readability-shadow', light ? 'none' : '0 1px 3px rgba(0,0,0,0.86), 0 0 14px rgba(0,0,0,0.42)');
    root.style.setProperty('--icon-readability-filter', light ? 'none' : 'drop-shadow(0 1px 2px rgba(0,0,0,0.86)) drop-shadow(0 0 8px rgba(0,0,0,0.32))');
    root.style.setProperty('--shadow-sm', light ? '0 1px 2px rgba(20,30,40,0.08)' : '0 1px 2px rgba(0,0,0,0.30)');
    root.style.setProperty('--shadow-md', light ? '0 1px 2px rgba(20,30,40,0.05), 0 8px 22px -6px rgba(20,30,40,0.10)' : '0 1px 2px rgba(0,0,0,0.22), 0 8px 22px -6px rgba(0,0,0,0.38)');
    root.style.setProperty('--shadow-lg', light ? '0 2px 4px rgba(20,30,40,0.05), 0 18px 44px -12px rgba(20,30,40,0.14)' : '0 2px 4px rgba(0,0,0,0.24), 0 18px 44px -12px rgba(0,0,0,0.50)');
    root.style.setProperty('--shadow-xl', light ? '0 3px 6px rgba(20,30,40,0.06), 0 30px 70px -18px rgba(20,30,40,0.18)' : '0 3px 6px rgba(0,0,0,0.26), 0 30px 70px -18px rgba(0,0,0,0.60)');
    root.style.setProperty('--panel-topline', light ? 'color-mix(in srgb, var(--surface), white 72%)' : 'rgba(255,255,255,0.055)');
    root.style.setProperty('--panel-drop', PANEL_DROP_CSS[light ? 'light' : 'dark']);
    return palette;
  }

  // Dashboard style language: skins own geometry/material only. Colour and
  // contrast always flow through ThemePalette; Retro is the sole fixed-palette
  // exception because its identity is a dark CRT.
  // Safe mode neutralizes the skins too (styleMode itself stays saved).
  function applySkin(root, s) {
    const safe = s.safeMode === true;
    const retro = !safe && s.styleMode === 'retro';
    const comic = !safe && s.styleMode === 'comic';
    if (retro) root.dataset.style = 'retro';
    else if (comic) root.dataset.style = 'comic';
    else delete root.dataset.style;
    return { safe, retro, comic };
  }

  function applySurfaceShape(root, s, alternateSkin) {
    const scoped = ['--radius', '--radius-control', '--radius-tile', '--radius-modal', '--glass-blur', '--glass-saturate'];
    if (alternateSkin) { scoped.forEach(prop => root.style.removeProperty(prop)); return; }
    const round = clampNumber(s.uiRoundness, 0, 2, 1);
    [['--radius', 8], ['--radius-control', 10], ['--radius-tile', 16], ['--radius-modal', 20]]
      .forEach(([prop, base]) => root.style.setProperty(prop, `${+(base * round).toFixed(2)}px`));
    root.style.setProperty('--glass-blur', `${Math.round(clampNumber(s.glassBlur, 0, 40, 22))}px`);
    root.style.setProperty('--glass-saturate', `${Math.round(clampNumber(s.glassSaturate, 100, 220, 160))}%`);
  }

  // Panel opacity, border, shadow and highlight, the comic paper, and the
  // corner/glass shape. `skin` is what applySkin() returned.
  function applyMaterial(root, s, palette, skin) {
    const light = palette.tone === 'light';
    const { comic } = skin;
    const panelSoftAlpha = Math.max(0.14, Math.min(1, s.panelAlpha - 0.02));
    // Border/shadow strength are user multipliers (1 = stock look); caps widened so
    // a 2× still fits, but the default value is byte-for-byte the previous formula.
    const borderStrength = clampNumber(s.panelBorderStrength, 0, 2, 1);
    const shadowStrength = clampNumber(s.tileShadowStrength, 0, 2, 0);
    const panelBorderAlpha = Math.min(0.4, (0.045 + (s.panelAlpha * 0.08)) * borderStrength);
    const panelShadowAlpha = Math.min(0.6, (0.05 + (s.panelAlpha * 0.18)) * shadowStrength);
    const panelHighlightAlpha = Math.min(0.07, 0.012 + (s.panelAlpha * 0.04));
    root.style.setProperty('--panel-alpha', (comic ? 1 : s.panelAlpha).toFixed(2));
    root.style.setProperty('--panel-soft-alpha', (comic ? 1 : panelSoftAlpha).toFixed(2));
    root.style.setProperty('--panel-border-alpha', (light ? 0.10 * borderStrength : panelBorderAlpha).toFixed(3));
    root.style.setProperty('--panel-shadow-alpha', (light ? 0.10 * shadowStrength : panelShadowAlpha).toFixed(3));
    root.style.setProperty('--panel-highlight-alpha', light ? '0.55' : panelHighlightAlpha.toFixed(3));
    // Comic is opaque paper by default; the palette engine already maps its
    // automatic surface to Base background, while an explicit `surface` wins.
    if (comic) {
      root.style.setProperty('--panel-alpha', '1');
      root.style.setProperty('--panel-soft-alpha', '1');
    }
    // Extended theme tokens — corner radius, glass blur/saturation. Glass-only
    // (the full skins own their geometry/material). Safe mode drops the inline
    // overrides too: stylesheet defaults = factory glass.
    applySurfaceShape(root, s, skin.retro || comic || skin.safe);
    // Borders consume the effective semantic line colour, whether it was picked
    // manually or auto-derived. Retro's !important CRT edge still wins.
    const lineAlpha = light ? (0.10 * borderStrength) : panelBorderAlpha;
    root.style.setProperty('--panel-border', `rgba(${ThemePalette.rgb(palette.line).join(', ')}, ${lineAlpha.toFixed(3)})`);
  }

  // The user's uploaded typeface (`uiFont`). It is bound to one fixed
  // @font-face family; --user-font-family flips global.css onto it, and the
  // retro skin's own pixel fonts still win (they use !important). Only an
  // upload of ours is accepted: the url lands inside a CSS url().
  const USER_FONT_FAMILY = 'XenonUserFont';
  const FONT_URL_RE = /^\/uploads\/[A-Za-z0-9._-]+\.(?:woff2|woff|ttf|otf)$/i;
  const FONT_FORMATS = Object.freeze({ woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' });

  function fontSource(font) {
    if (!font || !font.url) return '';
    const version = String(font.version || '').replace(/[^A-Za-z0-9._-]/g, '');
    return version ? `${font.url}?v=${encodeURIComponent(version)}` : font.url;
  }

  // The dashboard wallpaper's address with its cache-buster. A data URI is
  // self-contained: a `?v=` appended to it would corrupt it.
  function backgroundSource(media) {
    if (!media || typeof media.url !== 'string' || !media.url) return '';
    if (media.url.startsWith('data:')) return media.url;
    return media.version ? `${media.url}?v=${encodeURIComponent(media.version)}` : media.url;
  }

  function applyFont(doc, font) {
    const root = doc.documentElement;
    let styleEl = doc.getElementById('user-font-face');
    if (!font || !FONT_URL_RE.test(String(font.url || ''))) {
      if (styleEl) styleEl.remove();
      root.style.removeProperty('--user-font-family');
      return;
    }
    if (!styleEl) {
      styleEl = doc.createElement('style');
      styleEl.id = 'user-font-face';
      doc.head.appendChild(styleEl);
    }
    const format = FONT_FORMATS[font.url.slice(font.url.lastIndexOf('.') + 1).toLowerCase()];
    styleEl.textContent = `@font-face{font-family:'${USER_FONT_FAMILY}';src:url("${fontSource(font)}") format('${format}');font-display:swap;}`;
    root.style.setProperty('--user-font-family', `'${USER_FONT_FAMILY}'`);
  }

  return Object.freeze({ PANEL_DROP_CSS, derivePalette, applyPalette, applySkin, applyMaterial, fontSource, backgroundSource, applyFont });
});

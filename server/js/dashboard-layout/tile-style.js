// Builds a tile's shape and applies its style and its effects.
'use strict';

// Strip any previously-built shape DOM, tokens and observer registration.
function clearTileShape(el, content) {
  el.removeAttribute('data-tile-shape');
  el.style.removeProperty('--tile-clip');
  el.style.removeProperty('--tile-shape-pad');
  el.style.removeProperty('--tile-shape-stroke');
  if (_tileShapeRO) {
    _tileShapeRO.unobserve(el);
    const wasClipped = tileShapeClipped(el);
    if (wasClipped) _tileShapeRO.unobserve(wasClipped);
  }
  if (el._xenonShapeOwnClip) { el._xenonShapeOwnClip.remove(); delete el._xenonShapeOwnClip; }
  delete el._xenonShapeGeo;
  delete el._xenonShapeClipPath;
  if (content) content.querySelectorAll(':scope > .tile-shape-outline').forEach(n => n.remove());
}

// Build the clip + outline for one tile from its (already-normalized) shape.
function buildTileShape(el, content, shape, borderStrength) {
  const geo = tileShapeGeometry(shape);
  if (!geo || !content) return;
  let clipId = '';
  if (geo.css) {
    // A shape CSS can resolve itself: no clipPath, no per-tile transform, and
    // therefore nothing that can be measured wrong or go stale.
    el.setAttribute('data-tile-shape', geo.fit);
    el.style.setProperty('--tile-clip', geo.css);
  } else {
    if (geo.fit === 'fit') {
      const own = tileShapeMakeClip(`tileshape-fit-${++_tileShapeSeq}`);
      if (!own) return;
      own.firstChild.setAttribute('d', geo.d);
      el._xenonShapeOwnClip = own;
      el._xenonShapeClipPath = own.firstChild;
      clipId = own.id;
    } else {
      clipId = tileShapeSharedClip(geo.d);
    }
    if (!clipId) return;
    el.setAttribute('data-tile-shape', geo.fit);
    el.style.setProperty('--tile-clip', `url(#${clipId})`);
  }
  el.style.setProperty('--tile-shape-stroke',
    String(typeof borderStrength === 'number' ? Math.max(0, borderStrength) : 1));

  // The outline: the same path, stroked, above the decorative overlays so the
  // edge of the tile is never covered by a corner image. preserveAspectRatio
  // mirrors the clip — 'none' stretches, 'meet' keeps the ratio.
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'tile-shape-outline');
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('preserveAspectRatio', geo.fit === 'fit' ? 'xMidYMid meet' : 'none');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', geo.d);
  svg.appendChild(path);
  content.appendChild(svg);

  el._xenonShapeGeo = geo;
  const ro = tileShapeObserver();
  if (ro) {
    ro.observe(el);
    // The panel settles after the item, so this is the observation that gets the
    // final geometry rather than one taken mid-layout.
    const clipped = tileShapeClipped(el);
    if (clipped) ro.observe(clipped);
  }
  measureTileShape(el);
}

// `opts.colorsOnly` repaints the colour tokens WITHOUT tearing down and
// rebuilding the decor layers. Used by the per-track album accent, which fires on
// every song change: rebuilding decor there would re-create image layers and
// restart their effects several times an album, for a repaint that only ever
// touches colours.
function applyTileStyle(el, style, opts) {
  if (!el) return;
  const colorsOnly = !!(opts && opts.colorsOnly);
  delete el._xenonThemeOverrides;
  ['--bg', '--surface', '--surface-alt', '--surface-raised', '--surface-subtle', '--surface-strong',
    '--control-bg', '--input-bg', '--hover-bg', '--active-bg', '--selection-bg', '--selection-text',
    '--surface-rgb', '--surface-alt-rgb', '--control-rgb', '--accent', '--green', '--accent-rgb',
    '--panel-rgb', '--panel-soft-rgb', '--panel-alpha', '--text', '--text-muted', '--text-dim',
    '--muted-text', '--dim-text', '--line', '--line-rgb', '--border', '--divider', '--on-accent',
    '--color-success', '--color-warn', '--color-danger', '--color-info',
    '--success-rgb', '--warning-rgb', '--danger-rgb', '--info-rgb',
    '--success-bg', '--warning-bg', '--danger-bg', '--info-bg',
    '--on-success', '--on-warning', '--on-danger', '--on-info', '--red', '--amber', '--cyan',
    '--panel', '--panel-soft', '--panel-border', '--glass-bg', '--glass-border',
    '--oled-bg-rgb', '--oled-border', '--slider-fill', '--slider-track',
    '--tile-font', '--radius', '--radius-control', '--radius-tile', '--radius-modal',
    '--glass-blur', '--glass-saturate', '--panel-border-alpha', '--panel-shadow-alpha',
    '--panel-drop']
    .forEach(p => el.style.removeProperty(p));
  const content = el.querySelector(':scope > .grid-stack-item-content');
  // Decor and shape layers are managed DOM, torn down and rebuilt every repaint.
  if (!colorsOnly) { clearTileDecor(el, content); clearTileShape(el, content); }
  // Some tile content roots re-declare --text locally under the Light theme (the
  // "dark island" readability fix on .media-panel / .deck-root), which would
  // defeat a value merely inherited from the wrapper. Mirror ONLY --text onto
  // those roots as an inline value (inline wins over the stylesheet); accent /
  // panel stay on the wrapper so per-track album-art accent isn't disturbed.
  // Decor layers are excluded — they never carry widget text.
  const contentRoots = content
    ? Array.from(content.children).filter(c => !(c.classList
      && (c.classList.contains('tile-decor-bg') || c.classList.contains('tile-decor-frame')
        || c.classList.contains('tile-decor-overlays') || c.classList.contains('tile-decor-above')
        || c.classList.contains('tile-shape-outline'))))
    : [];
  // The widget's own root (panel/dashboard-widget) — where a panel gradient paints.
  const panelRoots = contentRoots.filter(c => /(?:^|\s)(?:panel|dashboard-widget)(?:\s|$)/.test(c.className || ''));
  contentRoots.forEach(r => ['--text', '--muted-text', '--dim-text', '--on-accent'].forEach(p => r.style.removeProperty(p)));
  // Clear any inline panel gradient from a previous paint (only ever set by us).
  panelRoots.forEach(r => r.style.removeProperty('background-image'));
  // Decor (images + effects) applies independently of the colour-token mode, so a
  // tile can carry a dragon overlay while still following the global theme colours.
  if (style && style.decor && !colorsOnly) buildTileDecor(el, content, style.decor);
  // The non-colour half — opacity, radius, glass, border, shadow, shape — is
  // orthogonal to the colour-token override, exactly like decor: a tile can be a
  // transparent hexagon while still following the global theme's colours. These
  // used to sit BELOW the mode gate, so a style carrying them without
  // mode:'custom' (a shared code, a generated pack) stored values that were
  // never applied to anything.
  const hasEffects = applyTileEffects(el, content, style, colorsOnly);
  if (!style || style.mode !== 'custom') {
    if (hasEffects || (style && style.decor)) { el.setAttribute('data-tile-style', 'custom'); return; }
    el.removeAttribute('data-tile-style');
    return;
  }
  el.setAttribute('data-tile-style', 'custom');
  el._xenonThemeOverrides = [
    'accent', 'panel', 'surfaceAlt', 'controlColor', 'text', 'mutedText',
    'lineColor', 'accentText', 'successColor', 'warningColor',
    'dangerColor', 'infoColor',
  ].filter(key => !!style[key]);
  const globalPalette = (typeof window.getEffectiveThemePalette === 'function')
    ? window.getEffectiveThemePalette()
    : null;
  if (globalPalette && window.ThemePalette) {
    const tilePalette = ThemePalette.derive({
      background: globalPalette.background,
      surface: style.panel || globalPalette.surface,
      surfaceAlt: style.surfaceAlt || globalPalette.surfaceAlt,
      controlColor: style.controlColor || globalPalette.control,
      accent: style.accent || globalPalette.accent,
      text: style.text || globalPalette.text,
      mutedText: style.mutedText || globalPalette.muted,
      lineColor: style.lineColor || globalPalette.line,
      accentText: style.accentText || globalPalette.onAccent,
      successColor: style.successColor || globalPalette.success,
      warningColor: style.warningColor || globalPalette.warning,
      dangerColor: style.dangerColor || globalPalette.danger,
      infoColor: style.infoColor || globalPalette.info,
      contrastGuard: typeof style.contrastGuard === 'boolean' ? style.contrastGuard : globalPalette.guard,
    }, globalPalette.tone);
    Object.entries(ThemePalette.cssTokens(tilePalette)).forEach(([key, value]) => el.style.setProperty(key, value));
    const material = {
      '--surface-raised': 'var(--surface-alt)',
      '--surface-subtle': 'color-mix(in srgb, var(--surface), var(--text) 5%)',
      '--surface-strong': 'color-mix(in srgb, var(--surface), var(--text) 10%)',
      '--hover-bg': 'color-mix(in srgb, var(--surface), var(--text) 7%)',
      '--active-bg': 'color-mix(in srgb, var(--surface), var(--accent) 18%)',
      '--input-bg': 'var(--control-bg)',
      '--divider': 'color-mix(in srgb, var(--line), transparent 28%)',
      '--selection-bg': 'color-mix(in srgb, var(--accent), var(--surface) 76%)',
      '--selection-text': 'var(--text)',
      // These aliases must be rebuilt at tile scope. Inheriting their root
      // computed values would leave a custom widget painted with global colours.
      '--panel': 'rgba(var(--panel-rgb), var(--panel-alpha))',
      '--panel-soft': 'rgba(var(--panel-soft-rgb), var(--panel-soft-alpha))',
      '--panel-border': 'rgba(var(--line-rgb), var(--panel-border-alpha))',
      '--glass-bg': 'linear-gradient(135deg, color-mix(in srgb, var(--surface) 90%, white), var(--surface) 58%, var(--surface-alt))',
      '--glass-border': 'var(--line)',
      '--oled-bg-rgb': 'var(--surface-rgb)',
      '--oled-border': 'var(--line)',
      '--slider-fill': 'var(--accent)',
      '--slider-track': 'var(--control-bg)',
    };
    Object.entries(material).forEach(([key, value]) => el.style.setProperty(key, value));
  }
  // Panel background as a two-colour gradient (overrides the flat panel colour).
  // Set inline on the widget's own root(s) so it never clobbers a widget that uses
  // its own background-image when no gradient is chosen.
  // With a background picture the fill lives on the decor layer, under the art.
  const pg = tileGradCss(style.panelGrad);
  const bgLayer = content && content.querySelector(':scope > .tile-decor-bg');
  if (pg && bgLayer) bgLayer.style.backgroundImage = pg;
  else if (pg) panelRoots.forEach(r => r.style.setProperty('background-image', pg));
  if (style.text) {
    const effectiveText = el.style.getPropertyValue('--text') || style.text;
    contentRoots.forEach(r => r.style.setProperty('--text', effectiveText));
  }
  if (style.font && TILE_FONT_STACKS[style.font]) el.style.setProperty('--tile-font', TILE_FONT_STACKS[style.font]);
  // Extended per-tile tokens, mirroring the global theme editor at tile scope.
  // Scoped to this wrapper's subtree via var() lazy substitution.
  if (style.mutedText) {
    const effectiveMuted = el.style.getPropertyValue('--muted-text') || style.mutedText;
    contentRoots.forEach(r => r.style.setProperty('--muted-text', effectiveMuted));
  }
  if (style.accentText) {
    const effectiveOnAccent = el.style.getPropertyValue('--on-accent') || style.accentText;
    contentRoots.forEach(r => r.style.setProperty('--on-accent', effectiveOnAccent));
  }
}

// The non-colour half of a tile's style: opacity, corner radius, glass, border,
// shadow and shape. Returns true when the tile carries any of it, which is what
// lets a tile that follows the theme's colours still count as styled.
//
// Several of these have to RE-DECLARE the token that consumes them, not only the
// input: a custom property whose value contains var() is resolved on the element
// that declares it, so a tile setting --panel-alpha alone keeps inheriting the
// --panel string :root already computed. That is why panel opacity, the border
// and the drop shadow each write their derived token here too.
function applyTileEffects(el, content, style, colorsOnly) {
  el.removeAttribute('data-tile-glass');
  el.removeAttribute('data-tile-plain');
  el.removeAttribute('data-tile-thin');
  el.removeAttribute('data-tile-shadow');
  let any = false;
  if (style) any = applyTileTokens(el, style);
  if (tileTakesStyleGlass(el, style)) el.setAttribute('data-tile-glass', '');
  // The widget's own buttons, tabs and fields (tile-controls.js).
  if (window.TileControls) window.TileControls.applyTileControls(el, style && style.controls);
  if (style && style.controls) any = true;
  // A tab group's own tab colours (dashboard-tabgroups.js).
  if (window.DashboardTabGroups) window.DashboardTabGroups.paintGroupTabs(el, style && style.tabs);
  if (style && style.tabs) any = true;
  // A widget PACKAGE may declare the silhouette of its own tile. It is consulted
  // only when the tile carries no shape of its own: the package proposes, the
  // user's style editor disposes. It deliberately does NOT make the tile count
  // as styled — a tile is not styled by the user because the widget in it has a
  // shape.
  const shape = (style && style.shape) || packageShapeFor(el);
  if (shape && !colorsOnly) buildTileShape(el, content, shape, style && style.borderStrength);
  if (style && style.shape) any = true;
  return any;
}
// The RESOLVED silhouette of the tile a node sits in (the user's per-tile shape
// first, a package's proposal second), or null. Exposed on window so
// custom-widget.js can hand a guest its safe area without keeping a second copy
// of the resolution rules.
function tileShapeInfoOf(node) {
  const wrap = (node && node.closest) ? node.closest('.grid-stack-item') : null;
  const geo = wrap && wrap._xenonShapeGeo;
  return geo ? { d: geo.d, fit: geo.fit, safe: { ...geo.safe } } : null;
}
function packageShapeFor(el) {
  const id = (el && el.getAttribute) ? el.getAttribute('gs-id') : '';
  if (!id || !window.CustomWidget || typeof window.CustomWidget.shapeFor !== 'function') return null;
  try { return window.CustomWidget.shapeFor(id) || null; } catch { return null; }
}
// Liquid Glass puts glass on every dashboard tile. A tile that asked for no blur, or
// for no panel at all, stays as asked; an ambient scene is not a dashboard tile, and
// blurring a backdrop that animates would be paid on every frame.
function tileTakesStyleGlass(el, style) {
  return document.documentElement.dataset.style === 'liquid'
    && el.hasAttribute('gs-id')
    && !el.hasAttribute('data-tile-plain')
    && !(style && style.glassBlur === 0);
}
// Under this a panel only reads because the blur behind it evens the picture out. With
// the blur off (low power, reduced transparency) DashboardGrid.css lifts it to this.
const TILE_THIN_BELOW = 0.86;

// A tile's decoration above its content, and the outline of a shaped tile: its geometry, the shared
// clip paths and measuring them.
'use strict';

// Over the widget, under the frame: a pattern set to "above", the inner glow and
// the edge bar. The outer glow is a shadow on the tile itself.
function buildTileAbove(el, content, decor) {
  const TDL = window.TileDecorLayers;
  if (!TDL) return;
  const parts = [
    decor.pattern && decor.pattern.layer === 'above' ? TDL.buildPatternLayer(decor.pattern) : null,
    TDL.buildGlowLayer(decor.glow),
    TDL.buildBarLayer(decor.bar),
  ].filter(Boolean);
  if (decor.glow && decor.glow.outer) {
    el.setAttribute('data-tile-glow-outer', '');
    el.style.setProperty('--tile-glow-outer', `${decor.glow.outer}px`);
    el.style.setProperty('--tile-glow-c', TDL.decorColorCss(decor.glow.color, 'var(--accent)'));
  }
  if (!parts.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'tile-decor-above';
  wrap.setAttribute('aria-hidden', 'true');
  parts.forEach(p => wrap.appendChild(p));
  content.appendChild(wrap);
}
// Build the decor layers for one tile from its (already-normalized) decor object.
function buildTileDecor(el, content, decor) {
  if (!content || !decor) return;
  el.setAttribute('data-tile-decor', '');
  buildTileFill(el, content, decor);
  buildTileAbove(el, content, decor);
  // Ornamental frame — a 9-slice border-image so corners stay crisp on any tile
  // aspect ratio (curated art authors its border band at 1/3 of the viewBox).
  const frameSrc = tileFrameSrc(decor.frame);
  if (frameSrc && window.TileDecorLayers) {
    const built = window.TileDecorLayers.buildFrameLayer(decor.frame, frameSrc, cssUrl, tileFrameRepeat(decor.frame));
    content.appendChild(built.node);
    // Inset the widget content so it doesn't collide with the frame band.
    content.style.setProperty('--tile-frame-inset', `${Math.round(built.width * 0.6) + (decor.frame.inset || 0)}px`);
  }
  // Decorative overlays — non-interactive, above the content.
  const above = buildTileOverlays(decor, false);
  if (above) content.appendChild(above);
}

// ── Per-tile SHAPE (the silhouette) ─────────────────────────────────────────
// A shape is ONE SVG path drawn in a unit square, and it reaches the tile twice:
// as a <clipPath clipPathUnits="objectBoundingBox"> in a shared sprite, which is
// what actually cuts the tile, and as an inline <svg> that strokes the same path
// to redraw the border the clip just removed.
//
// clipPath rather than the CSS shape() function on purpose: shape() does not
// exist in Safari, and a paired phone IS Safari — a shape that silently stayed
// rectangular on one engine is exactly the "looks alive, does nothing" failure
// this codebase spends its effort avoiding. objectBoundingBox units also mean
// one string clips a 2×2 tile and a 12×4 one, so a resize can't break it.
const TILE_SHAPE_DEFAULT_INSET = 6;    // % for a hand-written path with no `inset`
const TILE_SHAPE_DEFS_MAX = 48;        // sprite entries before unreferenced ones are swept

// Resolve a normalized shape to what the renderer needs: the path, the safe
// inset in percent, and whether it stretches with the tile or keeps its ratio.
// `inset` ADDS to a curated preset's own safe rectangle (extra breathing room)
// and IS the safe rectangle for a hand-written path, where nothing else knows.
function tileShapeGeometry(shape) {
  if (!shape) return null;
  const TSP = (typeof window !== 'undefined' && window.TileShapePresets) || null;
  const d = shape.preset ? (TSP ? TSP.tileShapePath(shape.preset) : '') : (shape.path || '');
  if (!d) return null;
  const base = (shape.preset && TSP && TSP.tileShapeSafe(shape.preset))
    || { t: 0, r: 0, b: 0, l: 0 };
  const extra = (typeof shape.inset === 'number')
    ? shape.inset
    : (shape.preset ? 0 : TILE_SHAPE_DEFAULT_INSET);
  const safe = { t: base.t + extra, r: base.r + extra, b: base.b + extra, l: base.l + extra };
  const fit = shape.fit === 'fit' ? 'fit' : 'stretch';
  // A CIRCLE asked to keep its proportions is the one silhouette CSS can express
  // exactly, and it should never go through the measured transform below.
  // `circle(closest-side)` is resolved by the engine against the CLIPPED box on
  // every frame: it cannot be computed from a stale geometry, cannot be measured
  // at the wrong moment, cannot be left behind when a tile resizes, and needs no
  // JavaScript at all. Everything that went wrong with round widgets went wrong
  // in the measurement, not in the shape — a tile carried `scale(0.2308 1)` for a
  // box that wanted `scale(1 0.0747)` and stayed an oval for good.
  // Supported everywhere the dashboard runs, Safari included, unlike shape().
  const css = (fit === 'fit' && isCirclePath(d)) ? 'circle(closest-side at 50% 50%)' : '';
  return { d, safe, fit, css };
}
// The circle, however it arrived: the curated preset and the hand-written path a
// package uses when it wants the circle WITHOUT the preset's 15% safe border.
// Compared on normalized whitespace so formatting cannot defeat it.
const TILE_CIRCLE_D =
  'M 0.5 0 C 0.776 0 1 0.224 1 0.5 C 1 0.776 0.776 1 0.5 1 C 0.224 1 0 0.776 0 0.5 C 0 0.224 0.224 0 0.5 0 Z';
function isCirclePath(d) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return norm(d) === norm(TILE_CIRCLE_D);
}

function tileShapeDefs() {
  return document.getElementById('tile-shape-defs');
}
function tileShapeMakeClip(id) {
  const defs = tileShapeDefs();
  if (!defs) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const cp = document.createElementNS(NS, 'clipPath');
  cp.setAttribute('id', id);
  cp.setAttribute('clipPathUnits', 'objectBoundingBox');
  cp.appendChild(document.createElementNS(NS, 'path'));
  defs.appendChild(cp);
  return cp;
}
// Identical shapes share one def, so twenty hexagon tiles cost one clipPath.
// The map is the key, not a hash of the path: a hash collision would hand a tile
// somebody else's silhouette.
const _tileShapeClipIds = new Map();
let _tileShapeSeq = 0;
function tileShapeSharedClip(d) {
  let id = _tileShapeClipIds.get(d);
  if (id && document.getElementById(id)) return id;
  const defs = tileShapeDefs();
  if (!defs) return '';
  if (defs.childElementCount >= TILE_SHAPE_DEFS_MAX) sweepTileShapeDefs();
  id = `tileshape-${++_tileShapeSeq}`;
  const cp = tileShapeMakeClip(id);
  if (!cp) return '';
  cp.firstChild.setAttribute('d', d);
  _tileShapeClipIds.set(d, id);
  return id;
}
// Editing a path in the style editor mints a def per keystroke, so the sprite is
// swept of anything no tile points at any more. The reference is the inline
// `--tile-clip` value, which is why the closing paren is part of the match.
function sweepTileShapeDefs() {
  const defs = tileShapeDefs();
  if (!defs) return;
  Array.from(defs.children).forEach((cp) => {
    const id = cp.id;
    if (!id) return;
    if (!document.querySelector(`[style*="#${id})"]`)) {
      cp.remove();
      for (const [k, v] of _tileShapeClipIds) if (v === id) _tileShapeClipIds.delete(k);
    }
  });
}

// The safe inset is a PERCENTAGE of the tile, and it is applied as a transparent
// border-width — the one property here that does not erase the padding every
// widget root declares for itself — which takes lengths, not percentages. So the
// two have to be reconciled against a measured box. ONE observer for the whole
// dashboard; tiles join and leave it as they gain and lose a shape.
// OBSERVE THE BOX THAT IS MEASURED, not only the grid item around it.
// objectBoundingBox resolves the clip against the CLIPPED element
// (.panel/.dashboard-widget), and GridStack sizes the item first and lets the
// panel settle after, so a measurement taken on the item's resize can land on a
// geometry that is still moving — and then never be revisited, because the item
// does not resize again. That is how a silhouette ended up with
// `scale(0.2308 1)` on a tile whose panel wanted `scale(1 0.0747)`: an oval, off
// by a factor of four, permanent. Watching the panel as well means the last word
// always belongs to the box the clip is actually resolved against.
let _tileShapeRO = null;
function tileShapeObserver() {
  if (!_tileShapeRO && typeof ResizeObserver === 'function') {
    _tileShapeRO = new ResizeObserver((entries) => {
      const items = new Set();
      entries.forEach((e) => {
        const item = e.target.closest ? e.target.closest('.grid-stack-item') : null;
        if (item) items.add(item);
      });
      items.forEach(measureTileShape);
    });
  }
  return _tileShapeRO;
}
// The clipped box for a grid item: the element --tile-clip is applied to.
function tileShapeClipped(el) {
  return el.querySelector(
    ':scope > .grid-stack-item-content > .panel, :scope > .grid-stack-item-content > .dashboard-widget');
}
// A tile on a PARKED pager page has `content-visibility: hidden` over it, so its
// descendants skip layout and the box it reports is whatever the collapsed
// column happens to be — not the box it will have when its page is shown. The
// clipPath transform below is written from that box, and once written it is
// never revisited: the observer only fires on a size CHANGE, and a page coming
// back does not always produce one. So a shape measured while parked keeps a
// silhouette scaled for a box that never existed. Measured on a real install: a
// circle on a 3-instrument page carried `scale(0.3333 1)` — squashed to a third
// of its width — so every round widget on that page rendered as an OVAL, with
// the tile's own card filling the difference. That is the ring people kept
// reporting: white while the card was light, black once the widgets started
// painting their own background.
// Refusing to measure is always right here, because the geometry is corrected
// the moment the page is shown (see the page-change hook below) and a stale
// transform is strictly worse than none.
function tileShapeLaidOut(el) {
  const page = el.closest ? el.closest('.pager-page') : null;
  if (page && page.classList.contains('is-parked')) return false;
  return el.clientWidth > 0 && el.clientHeight > 0;
}
// Refusing to measure has to come with retrying, or the tile is left with NO
// transform — and objectBoundingBox units then stretch the silhouette to the
// tile's aspect ratio, which is the same oval by another route. Bounded, per
// element, and cleared the moment one measurement lands.
const TILE_SHAPE_RETRY_FRAMES = 180;   // ~3s at 60fps
const _tileShapeTries = new WeakMap();
function measureTileShape(el) {
  const geo = el && el._xenonShapeGeo;
  if (!geo) return;
  if (!tileShapeLaidOut(el)) {
    const tries = (_tileShapeTries.get(el) || 0) + 1;
    if (tries <= TILE_SHAPE_RETRY_FRAMES) {
      _tileShapeTries.set(el, tries);
      requestAnimationFrame(() => measureTileShape(el));
    }
    return;
  }
  _tileShapeTries.delete(el);
  const w = el.clientWidth || 0;
  const h = el.clientHeight || 0;
  const px = (v, base) => `${Math.max(0, Math.round(base * v / 100))}px`;
  el.style.setProperty('--tile-shape-pad',
    `${px(geo.safe.t, h)} ${px(geo.safe.r, w)} ${px(geo.safe.b, h)} ${px(geo.safe.l, w)}`);
  // 'fit' keeps the silhouette's proportions instead of stretching it, which
  // objectBoundingBox units cannot do on their own: the path is scaled into a
  // centred square. Such a tile owns its clipPath (the transform is per-tile),
  // so it is updated in place rather than deduplicated.
  const node = el._xenonShapeClipPath;
  if (!node) return;
  // MEASURE THE ELEMENT THE CLIP IS ON, not the grid item around it.
  // objectBoundingBox resolves against the box of the CLIPPED element, and the
  // clip is applied to .panel/.dashboard-widget, which is inset from the grid
  // item by the tile gap. Measured on a real install: item 105x1232, panel
  // 91x1174 — two different aspect ratios, so a transform computed from the item
  // squeezed the silhouette by the wrong factor and left an OVAL a few percent
  // out. That is small enough to look like a rendering artefact and big enough
  // to show a band all the way round, which is exactly how it was reported.
  const clipped = tileShapeClipped(el);
  const cw = (clipped && clipped.clientWidth) || w;
  const ch = (clipped && clipped.clientHeight) || h;
  const sx = cw >= ch ? ch / cw : 1;
  const sy = ch > cw ? cw / ch : 1;
  node.setAttribute('transform',
    `translate(${((1 - sx) / 2).toFixed(4)} ${((1 - sy) / 2).toFixed(4)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)})`);
}
// The other half of the rule above: whatever could not be measured while its
// page was parked is measured when the page is shown. Cheap — it walks only the
// tiles that carry a shape, and each one writes at most two attributes.
function remeasureTileShapes() {
  document.querySelectorAll('.grid-stack-item[data-tile-shape]').forEach((el) => {
    // A fresh retry window per page change: the event fires while the arriving
    // page is still parked, so the first attempt always fails and the retries
    // are what actually catch it once the pager unparks.
    _tileShapeTries.delete(el);
    measureTileShape(el);
  });
}

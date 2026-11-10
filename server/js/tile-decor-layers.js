'use strict';
// The richer decor layers of a tile (buildTileDecor in dashboard-layout.js):
// tinted frames, overlays with colour, glow and motion, a drawn pattern, an
// inner/outer glow and an edge bar. Values arrive already normalized
// (tile-decor-schema.js); the string builders are pure so tests can read them.
//
// Paint cost: a glow is a drop-shadow filter, so it always sits on the INNERMOST
// element and any motion on the element around it. The filtered art is then
// rasterised once into the moving layer instead of re-blurred on every frame
// (see "Never put a filter on an element whose geometry animates" in the
// rendering invariants).

const _b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s).toString('base64'));
// Grain: white pixels whose alpha is the noise, used as a mask over the colour.
const TILE_DECOR_NOISE_URL = 'data:image/svg+xml;base64,' + _b64(
  '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/>'
  + '<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.4 0 0 0 -.45"/></filter><rect width="180" height="180" filter="url(#n)"/></svg>');

// 'accent' follows the tile's accent token; a hex is used as is.
function decorColorCss(c, fallback) {
  if (c === 'accent') return 'var(--accent)';
  return c || fallback;
}

// A pattern kind → the background of its ink layer. `C` is a CSS colour.
function tilePatternCss(p) {
  const C = 'var(--tile-pattern-c)';
  const w = p.weight || 1;
  const s = p.size || 16;
  const a = p.angle || 0;
  switch (p.kind) {
    case 'dots': return { image: `radial-gradient(circle, ${C} ${w}px, transparent ${w + 0.6}px)`, size: `${s}px ${s}px` };
    case 'grid': return { image: `linear-gradient(${C} ${w}px, transparent ${w}px), linear-gradient(90deg, ${C} ${w}px, transparent ${w}px)`, size: `${s}px ${s}px` };
    case 'lines': return { image: `repeating-linear-gradient(${a}deg, ${C} 0 ${w}px, transparent ${w}px ${s}px)` };
    case 'crosshatch': return {
      image: `repeating-linear-gradient(${a + 45}deg, ${C} 0 ${w}px, transparent ${w}px ${s}px), repeating-linear-gradient(${a - 45}deg, ${C} 0 ${w}px, transparent ${w}px ${s}px)`,
    };
    case 'checker': return { image: `conic-gradient(${C} 25%, transparent 0 50%, ${C} 0 75%, transparent 0)`, size: `${s}px ${s}px` };
    case 'scanlines': return { image: `repeating-linear-gradient(0deg, ${C} 0 ${w}px, transparent ${w}px ${w * 3}px)` };
    case 'zigzag': {
      const h = s / 2;
      return {
        image: `linear-gradient(135deg, ${C} 25%, transparent 25%), linear-gradient(225deg, ${C} 25%, transparent 25%), linear-gradient(315deg, ${C} 25%, transparent 25%), linear-gradient(45deg, ${C} 25%, transparent 25%)`,
        size: `${s}px ${s}px`, position: `-${h}px 0, -${h}px 0, 0 0, 0 0`,
      };
    }
    case 'noise': return { mask: `url("${TILE_DECOR_NOISE_URL}")`, fill: C };
    default: return null;
  }
}

// Where a pattern fades out: the mask on its wrapper.
function tilePatternFadeMask(fade) {
  switch (fade) {
    case 'top': return 'linear-gradient(to top, #000 15%, transparent)';
    case 'bottom': return 'linear-gradient(to bottom, #000 15%, transparent)';
    case 'left': return 'linear-gradient(to left, #000 15%, transparent)';
    case 'right': return 'linear-gradient(to right, #000 15%, transparent)';
    case 'center': return 'radial-gradient(ellipse at center, #000 10%, transparent 75%)';
    case 'edges': return 'radial-gradient(ellipse at center, transparent 30%, #000 100%)';
    default: return '';
  }
}

function setMask(node, value) {
  node.style.setProperty('-webkit-mask-image', value);
  node.style.setProperty('mask-image', value);
}

function buildPatternLayer(p) {
  const css = tilePatternCss(p);
  if (!css) return null;
  const wrap = document.createElement('div');
  wrap.className = 'tile-decor-pattern';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.setProperty('--tile-pattern-c', decorColorCss(p.color, 'var(--text)'));
  wrap.style.opacity = String((p.opacity || 20) / 100);
  const fade = tilePatternFadeMask(p.fade);
  if (fade) setMask(wrap, fade);
  const ink = document.createElement('div');
  ink.className = 'tile-decor-pattern-ink';
  if (css.mask) { setMask(ink, css.mask); ink.style.backgroundColor = css.fill; } else {
    ink.style.backgroundImage = css.image;
    if (css.size) ink.style.backgroundSize = css.size;
    if (css.position) ink.style.backgroundPosition = css.position;
  }
  wrap.appendChild(ink);
  return wrap;
}

function buildGlowLayer(glow) {
  if (!glow || !glow.inner) return null;
  const n = document.createElement('div');
  n.className = 'tile-decor-glow';
  n.setAttribute('aria-hidden', 'true');
  n.style.boxShadow = `inset 0 0 ${glow.inner}px ${Math.round(glow.inner / 4)}px ${decorColorCss(glow.color, 'var(--accent)')}`;
  return n;
}

function buildBarLayer(bar) {
  if (!bar) return null;
  const n = document.createElement('div');
  n.className = `tile-decor-bar is-${bar.side}`;
  n.setAttribute('aria-hidden', 'true');
  n.style.setProperty('--tile-bar-c', decorColorCss(bar.color, 'var(--accent)'));
  n.style.setProperty('--tile-bar-size', `${bar.size || 4}px`);
  n.style.setProperty('--tile-bar-len', `${bar.length || 100}%`);
  n.dataset.align = bar.align || 'center';
  return n;
}

// Frame: motion wrapper > glow (filter) > ink (the art, or the art's shape filled
// with the chosen colour through a 9-slice mask).
function buildFrameLayer(frame, src, cssUrl, repeatMode) {
  const w = (typeof frame.width === 'number' && frame.width > 0) ? frame.width : 16;
  const outer = document.createElement('div');
  outer.className = 'tile-decor-frame';
  outer.setAttribute('aria-hidden', 'true');
  if (frame.inset) outer.style.inset = `${frame.inset}px`;
  if (frame.anim) outer.dataset.anim = frame.anim;
  const glow = document.createElement('div');
  glow.className = 'tile-decor-frame-glow';
  // On the inner layer: the pulse animates the outer one's opacity.
  if (typeof frame.opacity === 'number') glow.style.opacity = String(frame.opacity / 100);
  if (frame.glow) glow.style.filter = `drop-shadow(0 0 ${frame.glow}px ${decorColorCss(frame.tint, 'var(--accent)')})`;
  const ink = document.createElement('div');
  ink.className = 'tile-decor-frame-ink';
  // Dashes and dots repeat along an edge; stretched, they would smear.
  const repeat = repeatMode === 'round' ? 'round' : 'stretch';
  const tinted = !!frame.tint && tileMaskBoxSupported();
  if (tinted) {
    const c1 = decorColorCss(frame.tint);
    ink.style.background = frame.tint2 ? `linear-gradient(135deg, ${c1}, ${frame.tint2})` : c1;
    ink.style.setProperty('-webkit-mask-box-image', `${cssUrl(src)} 33% / ${w}px ${repeat}`);
    ink.classList.add('is-tinted');
  } else {
    ink.style.borderImageSource = cssUrl(src);
    ink.style.borderWidth = `${w}px`;
    ink.style.borderImageRepeat = repeat;
  }
  glow.appendChild(ink);
  outer.appendChild(glow);
  return { node: outer, width: w };
}

// The 9-slice mask that recolours a frame exists in Chromium (WebView2, Chrome)
// and WebKit (Safari, the macOS app, WebKitGTK on Linux). Elsewhere the frame
// keeps its own colours rather than turning into a solid block.
let _maskBox = null;
function tileMaskBoxSupported() {
  if (_maskBox == null) {
    _maskBox = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('-webkit-mask-box-image', 'url("x.svg") 33% stretch');
  }
  return _maskBox;
}

// Overlay: position + fixed transform > motion > art. A tinted overlay is a box
// filled with the colour and cut to the picture's shape; the hidden <img> inside
// gives it the picture's proportions.
function buildOverlayNode(ov, src, cssUrl, anchorCss) {
  const pos = document.createElement('div');
  pos.className = 'tile-decor-overlay';
  pos.style.width = `${ov.size || 40}%`;
  const tf = [];
  if (typeof ov.x === 'number' && typeof ov.y === 'number') {
    pos.style.left = `${ov.x}%`;
    pos.style.top = `${ov.y}%`;
    tf.push('translate(-50%, -50%)');
  } else {
    const a = anchorCss[ov.anchor] || anchorCss['bottom-right'];
    ['top', 'right', 'bottom', 'left'].forEach((p) => { if (a[p] != null) pos.style[p] = a[p]; });
    if (a.tx || a.ty) tf.push(`translate(${a.tx || '0'}, ${a.ty || '0'})`);
  }
  if (ov.flip) tf.push('scaleX(-1)');
  if (typeof ov.rotate === 'number' && ov.rotate) tf.push(`rotate(${ov.rotate}deg)`);
  if (tf.length) pos.style.transform = tf.join(' ');
  if (typeof ov.opacity === 'number') pos.style.opacity = String(ov.opacity / 100);

  const motion = document.createElement('div');
  motion.className = 'tile-decor-ov-motion';
  if (ov.anim) motion.dataset.anim = ov.anim;

  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = src;
  let art = img;
  if (ov.tint) {
    art = document.createElement('div');
    art.className = 'tile-decor-ov-ink';
    art.style.backgroundColor = decorColorCss(ov.tint);
    setMask(art, cssUrl(src));
    img.className = 'tile-decor-ov-sizer';
    art.appendChild(img);
  } else {
    img.className = 'tile-decor-ov-img';
  }
  const filters = [];
  if (ov.shadow) filters.push(`drop-shadow(0 ${Math.round(ov.shadow / 3)}px ${ov.shadow}px rgba(0, 0, 0, 0.45))`);
  if (ov.glow) filters.push(`drop-shadow(0 0 ${ov.glow}px ${decorColorCss(ov.tint, 'var(--accent)')})`);
  if (filters.length) art.style.filter = filters.join(' ');
  motion.appendChild(art);
  pos.appendChild(motion);
  return pos;
}

const _tileDecorLayers = {
  decorColorCss, tilePatternCss, tilePatternFadeMask, buildPatternLayer, buildGlowLayer, buildBarLayer,
  buildFrameLayer, buildOverlayNode, tileMaskBoxSupported,
};
if (typeof window !== 'undefined') window.TileDecorLayers = _tileDecorLayers;
if (typeof module !== 'undefined' && module.exports) module.exports = _tileDecorLayers;

'use strict';
// Native canvas Ambient scene — the drawing parts the renderer composes.
//
// js/ambient-canvas.js owns the scene (mount, the 1 s tick, touch); this file
// holds the pieces that have nothing to do with the loop: the background layer
// (colour, gradient, picture, the dashboard wallpaper, slow motion), the
// fields every element can carry (opacity, size, entrance and loop animation),
// the analog clock face and the bar/ring gauges. Pure DOM builders, no timers,
// no listeners: whatever moves does so in CSS (AmbientCanvas.css), gated there
// on the freeze classes and on reduced motion.

(function () {
  if (typeof window === 'undefined') return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function svg(tag, attrs) {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  const gradientCss = (g) => (window.AmbientScene && AmbientScene.gradientCss ? AmbientScene.gradientCss(g) : '');

  // ── background ──────────────────────────────────────────────────────────
  // The dashboard's own wallpaper on this PC ({ src, video }), or null.
  function wallpaper() {
    const media = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.backgroundMedia : null;
    // ThemeTokens, not settings.js: the desktop scene page (scene.html) has no settings code.
    const tokens = window.ThemeTokens;
    if (!media || !tokens || typeof tokens.backgroundSource !== 'function') return null;
    const src = tokens.backgroundSource(media);
    if (!src) return null;
    return { src, video: /^video\//.test(String(media.type || '')) };
  }
  function fallbackCss(bg) {
    if (bg.grad && bg.type !== 'color') return gradientCss(bg.grad);
    return bg.color || '#05060a';
  }
  // Dedicated layer so dim/blur affect only the backdrop, never the elements
  // on top. opts.still: a preview (import thumbnail, the editor's list) never
  // starts a video, it shows the colour behind it.
  function buildBg(bg, opts) {
    const b = (bg && typeof bg === 'object') ? bg : {};
    const layer = el('div', 'ac-bg');
    let video = null;
    if (b.type === 'image' && b.url) layer.style.background = `#000 url("${b.url}") center/cover no-repeat`;
    else if (b.type === 'gradient' && b.grad) layer.style.background = gradientCss(b.grad);
    else if (b.type === 'wallpaper') {
      const wp = wallpaper();
      layer.style.background = fallbackCss(b);
      if (wp && wp.video && !(opts && opts.still)) {
        video = layer.appendChild(el('video', 'ac-bg-media'));
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute('aria-hidden', 'true');
        video.src = wp.src;
      } else if (wp && !wp.video) {
        const img = layer.appendChild(el('img', 'ac-bg-media'));
        img.alt = '';
        img.decoding = 'async';
        img.src = wp.src;
      }
    } else layer.style.background = b.color || '#05060a';
    const dim = Number(b.dim) > 0 ? Number(b.dim) : 0;
    const blur = Number(b.blur) > 0 ? Number(b.blur) : 0;
    if (blur) layer.style.filter = `blur(${blur}px)`;
    if (dim) { layer.classList.add('has-dim'); layer.style.setProperty('--ac-bg-dim', (dim / 100).toFixed(2)); }
    if (b.motion) layer.dataset.motion = b.motion;
    return { layer, video };
  }
  // The scene's video follows the wallpaper's rule: still while the dashboard
  // holds its own (an overlay, a game, Performance mode) or the page is hidden.
  function syncVideo(video) {
    if (!video) return;
    const held = document.hidden || (typeof backgroundVideoHeld === 'function' && backgroundVideoHeld());
    if (held) { if (!video.paused) video.pause(); return; }
    if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
  }

  // ── fields every element can carry ──────────────────────────────────────
  // Opacity and the entrance sit on the content layer, the loop on the body
  // inside it, so the three never fight over one element's opacity/transform.
  function decorate(wrap, content, body, comp) {
    if (comp.opacity != null) content.style.opacity = String(comp.opacity / 100);
    if (comp.scale != null) wrap.style.setProperty('--ac-scale', String(comp.scale / 100));
    const a = comp.anim;
    if (!a) return;
    wrap.style.setProperty('--ac-speed', String(a.speed || 1));
    wrap.style.setProperty('--ac-delay', (a.delay || 0) + 's');
    if (a.in && a.in !== 'none') { content.dataset.acIn = a.in; content.classList.add('ac-anim-in'); }
    if (a.loop && a.loop !== 'none') body.dataset.acLoop = a.loop;
  }
  // Play the entrance again (a page that comes back into view).
  function replayIn(item) {
    const content = item.el.firstElementChild;
    if (!content || !content.classList.contains('ac-anim-in')) return;
    content.classList.remove('ac-anim-in');
    void content.offsetWidth;   // restart the CSS animation
    content.classList.add('ac-anim-in');
  }

  // ── analog clock ────────────────────────────────────────────────────────
  function buildAnalog(body, props) {
    const face = svg('svg', { viewBox: '0 0 100 100', class: 'ac-analog', 'aria-hidden': 'true' });
    face.appendChild(svg('circle', { cx: 50, cy: 50, r: 47, class: 'ac-analog-rim' }));
    if (props.marks) {
      for (let i = 0; i < 12; i++) {
        const long = i % 3 === 0;
        face.appendChild(svg('line', { x1: 50, y1: 6, x2: 50, y2: long ? 14 : 10, class: 'ac-analog-mark' + (long ? ' is-hour' : ''), transform: `rotate(${i * 30} 50 50)` }));
      }
    }
    face.appendChild(svg('line', { x1: 50, y1: 54, x2: 50, y2: 27, class: 'ac-analog-h' }));
    face.appendChild(svg('line', { x1: 50, y1: 56, x2: 50, y2: 14, class: 'ac-analog-m' }));
    if (props.seconds) face.appendChild(svg('line', { x1: 50, y1: 60, x2: 50, y2: 10, class: 'ac-analog-s' }));
    face.appendChild(svg('circle', { cx: 50, cy: 50, r: 2.4, class: 'ac-analog-hub' }));
    body.appendChild(face);
  }
  function updateAnalog(item, now) {
    const secs = !!item.comp.props.seconds;
    const s = now.getSeconds(), m = now.getMinutes(), h = now.getHours() % 12;
    const sig = h + ':' + m + (secs ? ':' + s : '');
    if (sig === item.sig) return sig;
    const turn = (sel, deg) => { const n = item.body.querySelector(sel); if (n) n.setAttribute('transform', `rotate(${deg} 50 50)`); };
    turn('.ac-analog-h', h * 30 + m / 2);
    turn('.ac-analog-m', m * 6 + (secs ? s / 10 : 0));
    if (secs) turn('.ac-analog-s', s * 6);
    return sig;
  }

  // ── bar and ring gauges (System element) ───────────────────────────────
  const RING_LEN = 2 * Math.PI * 42;
  function buildGauge(row, style) {
    if (style === 'bars') {
      row.appendChild(el('span', 'ac-gauge-bar')).appendChild(el('span', 'ac-gauge-fill'));
    } else if (style === 'rings') {
      const ring = svg('svg', { viewBox: '0 0 100 100', class: 'ac-gauge-ring', 'aria-hidden': 'true' });
      ring.appendChild(svg('circle', { cx: 50, cy: 50, r: 42, class: 'ac-gauge-track' }));
      ring.appendChild(svg('circle', { cx: 50, cy: 50, r: 42, class: 'ac-gauge-arc', 'stroke-dasharray': `0 ${RING_LEN}`, transform: 'rotate(-90 50 50)' }));
      row.prepend(ring);
    }
  }
  function setGauge(row, pct) {
    const v = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    const fill = row.querySelector('.ac-gauge-fill');
    if (fill) fill.style.width = v + '%';
    const arc = row.querySelector('.ac-gauge-arc');
    if (arc) arc.setAttribute('stroke-dasharray', `${(RING_LEN * v / 100).toFixed(1)} ${RING_LEN.toFixed(1)}`);
  }

  // ── small helpers the type renderers share ──────────────────────────────
  // A data-* switch the CSS reads (alignment, layout), set only when not the default.
  function flag(node, name, value, fallback) {
    if (value != null && value !== fallback) node.dataset[name] = String(value);
  }
  function shapeCss(box, p) {
    const fill = p.grad ? gradientCss(p.grad) : (p.color || '#1b2030');
    if (p.kind === 'ring') {
      box.style.background = 'transparent';
      box.style.border = `${Math.max(2, p.borderWidth || 0)}px solid ${p.borderColor || p.color || '#1b2030'}`;
      box.style.borderRadius = '50%';
    } else {
      box.style.background = fill;
      if (p.kind === 'ellipse') box.style.borderRadius = '50%';
      else if (p.kind === 'pill') box.style.borderRadius = '9999px';
      else if (p.kind !== 'line' && p.radius) box.style.borderRadius = p.radius + 'px';
      if (p.borderColor && p.borderWidth) box.style.border = `${p.borderWidth}px solid ${p.borderColor}`;
    }
    if (p.blur) box.style.filter = `blur(${p.blur}px)`;
  }
  function weatherGlyph(data) {
    const glyphs = window.WeatherGlyphs;
    if (!glyphs || !data || !data.ok) return '';
    const state = typeof classifyWeatherState === 'function' ? classifyWeatherState(data) : 'state-cloud';
    const name = typeof weatherStateIcon === 'function' ? weatherStateIcon(state) : 'cloud';
    return glyphs[name] || glyphs.cloud || '';
  }

  window.AmbientCanvasParts = {
    buildBg, syncVideo, decorate, replayIn,
    buildAnalog, updateAnalog, buildGauge, setGauge,
    flag, shapeCss, weatherGlyph,
  };
})();

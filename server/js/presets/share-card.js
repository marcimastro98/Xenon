'use strict';
// "Share my setup" card — a premium, canvas-composed PNG the user can post
// (Reddit, Discord, TikTok…) to show off their dashboard, with a QR code that
// leads people back to Xenon.
//
// The card is a COMPOSER with an optional capture, never the reverse:
// ShareCardDraw.render() (share-card-draw.js) must produce a complete, postable image with `capture === null`.
// The screenshot is an upgrade to one rect inside a frame that is drawn
// identically either way, which is what makes every fallback below free instead
// of a separate code path that can rot.
//
// QR target ladder (pickQrTarget, pure + node-tested):
//   1. entry published in the community gallery → its public catalog anchor;
//   2. small code (≤ QR_CODE_MAX_BYTES)         → the docs "get" landing with
//      the code in the URL fragment (never touches a server log);
//   3. otherwise → the site root, and the card says the code travels alongside
//      (the share dialog already offers the .json file).
// Never a 127.0.0.1 deep link: a phone can't reach the local dashboard.

const SHARE_SITE_BASE = 'https://xenon-app.com/';
// What a phone can READ off a posted image, not what a QR can hold: a card posted ~1200 px wide
// draws the panel at ~140 px, a phone needs ~3 px per module, so ~47 modules (version 8, ~152
// bytes at level M); 130 leaves room for the URL. A preset code never fits: everything real
// resolves to the catalog entry or the site (~40 characters). A QR nobody can scan is worse than none.
const QR_CODE_MAX_BYTES = 130;

// Two aspect presets and nothing else: the dashboard is 32:9, so a 16:9 card
// framing it as a strip is the "Edge frame" signature BRAND.md already declares
// the public identity, and TikTok/Shorts need a real 9:16 or the platform crops
// the card itself.
const CARD_SIZES = {
  post: { w: 1600, h: 900 },
  story: { w: 1080, h: 1920 },
};

// Two displays count as "the same shape" within half a percent. Tight enough
// that 16:9 and 16:10 never collide, loose enough to absorb the rounding in a
// DPI-virtualised bound (2560x720 reported as 1707x480).
const SCREEN_ASPECT_TOLERANCE = 0.005;

function cardSize(format) {
  return CARD_SIZES[format] || CARD_SIZES.post;
}

function pickQrTarget(opts) {
  const galleryId = opts && typeof opts.galleryId === 'string' ? opts.galleryId.trim() : '';
  const code = opts && typeof opts.code === 'string' ? opts.code : '';
  if (galleryId && /^[a-z0-9][a-z0-9_-]{0,60}$/.test(galleryId)) {
    // The permalink contract lives on the catalog page (docs/catalog/index.html
    // owns the `#<id>` hash); the old `index.html#<id>` spelling is a dead link.
    return { type: 'gallery', url: SHARE_SITE_BASE + 'catalog/#' + galleryId };
  }
  // encodePreset() emits base64url, so anything else is not a share code and has
  // no business being interpolated into a URL fragment: a stray '#' would
  // truncate it, and a pasted link would smuggle its own host into the QR.
  if (code && code.length <= QR_CODE_MAX_BYTES && /^[A-Za-z0-9_-]+$/.test(code)) {
    return { type: 'landing', url: SHARE_SITE_BASE + 'get/#code=' + code };
  }
  // A QR that leads to the site beats blank space, and it is the only rung that
  // exists for a plain "my dashboard" share carrying no preset at all.
  return { type: 'site', url: SHARE_SITE_BASE };
}

// Which enumerated display holds the dashboard, by SHAPE (the v4.4 card's defect): listScreens() and
// gdigrab count real pixels, the browser counts its own scaled ones and can't see the other displays'
// scale, so only the aspect ratio holds in both spaces (3840/2160 === 2560/1440). The single matching
// screen, or null for none or several (two 16:9 monitors): the caller then draws the card instead.
function matchScreen(targetAspect, screens) {
  if (!Number.isFinite(targetAspect) || targetAspect <= 0) return null;
  if (!Array.isArray(screens) || !screens.length) return null;
  let match = null;
  for (let i = 0; i < screens.length; i++) {
    const s = screens[i];
    if (!s) continue;
    const w = Number(s.width);
    const h = Number(s.height);
    if (!(w > 0) || !(h > 0)) continue;              // also rejects NaN
    if (Math.abs(w / h - targetAspect) / targetAspect > SCREEN_ASPECT_TOLERANCE) continue;
    if (match !== null) return null;                 // ambiguous — refuse, don't guess
    match = i;
  }
  return match;
}

// Wrap a preset name to at most `maxLines`, measuring through the injected
// `measure(text) -> width` so the whole thing stays pure and node-testable.
function wrapName(measure, name, maxWidth, maxLines) {
  const maxLn = Math.max(1, Math.floor(maxLines) || 2);
  const text = (name == null ? '' : String(name)).trim() || 'Xenon';
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  let truncated = false;

  const commit = () => { lines.push(line); line = ''; };
  const full = () => lines.length >= maxLn;

  for (let i = 0; i < words.length; i++) {
    if (full()) { truncated = true; break; }
    let rest = words[i];

    // A single word wider than the box is hard-broken across lines. The card
    // this replaces measured such a word, never pushed it, and silently dropped
    // it and everything after it.
    while (measure(rest) > maxWidth && rest.length > 1) {
      if (line) commit();
      if (full()) break;
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
      line = rest.slice(0, cut);
      rest = rest.slice(cut);
      commit();
    }
    if (full()) { truncated = rest.length > 0 || i < words.length - 1; break; }
    if (!rest) continue;

    const probe = line ? line + ' ' + rest : rest;
    if (line && measure(probe) > maxWidth) {
      commit();
      if (full()) { truncated = true; break; }
      line = rest;
    } else {
      line = probe;
    }
  }
  if (line) {
    if (full()) truncated = true;
    else lines.push(line);
  }
  if (!lines.length) return ['Xenon'];

  if (truncated) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && measure(last + '…') > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last.replace(/\s+$/, '') + '…';
  }
  return lines;
}

const blurBoxes = Object.freeze({
  // The privacy blur boxes as safe fractions of the captured plate. Measured from a live getBoundingClientRect()
  // BEFORE the capture, so a layout that moved in between gives a box clamped away, never one outside the plate.
  clamp(rects) {
    if (!Array.isArray(rects)) return [];
    const out = [];
    for (const r of rects) {
      if (!r) continue;
      const x = Number(r.x);
      const y = Number(r.y);
      const w = Number(r.w);
      const h = Number(r.h);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
      if (!(w > 0) || !(h > 0)) continue;
      const x0 = Math.min(Math.max(x, 0), 1);
      const y0 = Math.min(Math.max(y, 0), 1);
      const x1 = Math.min(Math.max(x + w, 0), 1);
      const y1 = Math.min(Math.max(y + h, 0), 1);
      if (x1 - x0 <= 0 || y1 - y0 <= 0) continue;
      // The tile's corner (a fraction of the screen's height), at most half the box's height.
      const corner = Number(r.r);
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, r: corner > 0 && Number.isFinite(corner) ? Math.min(corner, (y1 - y0) / 2) : 0 });
    }
    return out;
  },

  // Did a personal tile move between two measures? A picture taken in between could blur beside it.
  moved(a, b, tol = 0.004) {
    if (a.length !== b.length) return true;
    return a.some((r, i) => ['x', 'y', 'w', 'h'].some((k) => Math.abs(r[k] - b[i][k]) > tol));
  },
});

if (typeof window !== 'undefined') (function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js

  // Brand constants (BRAND.md): the stock colours when a theme value is missing.
  const BRAND_GREEN = '#1ed760';
  const BRAND_INK = '#070808';
  const BRAND_TEXT = '#f0f3f1';
  // Chromium shows "Press Esc to exit full screen" for 3.8 s (ExclusiveAccessBubble::kShowTime)
  // and then fades it: a grab before that has the banner in the picture.
  const FULLSCREEN_BANNER_MS = 4400;
  // server/public/ is a served runtime path on every surface. NEVER docs/images/*:
  // .gitattributes marks it export-ignore, so it is absent for every real user.
  // Relative when SERVER is empty (the static browser demo) so it resolves under
  // /demo/ instead of the site root.
  const LOGO_URL = (typeof SERVER === 'string' && SERVER)
    ? SERVER + '/public/images/logo/logo-mark.png'
    : 'public/images/logo/logo-mark.png';

  // Widgets whose content is inherently personal. Blurring at the WIDGET seam
  // (data-dashboard-widget, which duplication and tab-groups preserve) rather
  // than at guessed inner class names means a refactor inside a widget can never
  // silently stop blurring it.
  const PRIVATE_WIDGETS = ['notes', 'tasks', 'calendar', 'agenda', 'chat', 'claude', 'openaicodex', 'chatgpt',
    'discord', 'notifications', 'search', 'unifi', 'phone', 'transfer', 'browser', 'slideshow', 'smarthome', 'remote', 'screen'];

  let qrLibPromise = null;
  function loadQrLib() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLibPromise) {
      qrLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'js/vendor/qrcode.js';
        s.onload = () => resolve(window.qrcode || null);
        s.onerror = () => { qrLibPromise = null; reject(new Error('qr lib failed to load')); };
        document.head.appendChild(s);
      });
    }
    return qrLibPromise;
  }

  // ── Palette ──────────────────────────────────────────────────────────────
  // Read the RESOLVED semantic palette (which already accounts for the active
  // light/dark half, safe mode and the retro/comic skins) and fall back to the
  // raw author colours, then to the stock defaults. The hex validation is kept
  // from the card this replaces: it is what stops a hand-edited settings value
  // from becoming an arbitrary canvas fillStyle.
  function themeColors() {
    const hex = (v, fb) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : fb;
    let p = null;
    try {
      if (typeof window.getEffectiveThemePalette === 'function') p = window.getEffectiveThemePalette();
    } catch { p = null; }
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    const src = p || hs;
    const background = hex(src.background, BRAND_INK);
    return {
      accent: hex(src.accent, BRAND_GREEN),
      background,
      surface: hex(src.surface, hex(src.surfaceAlt, background)),
      text: hex(src.text, BRAND_TEXT),
      onAccent: hex(src.onAccent, hex(src.accentText, BRAND_INK)),
    };
  }

  // ── Assets the card needs before it can be drawn ─────────────────────────
  const BRAND_FONT_PROBES = ['800 46px "Sofia Sans"', '700 30px "Sofia Sans"', '600 22px "Sofia Sans"', '500 26px "Sofia Sans"'];
  let brandFontPromise = null;
  // BRAND.md: "never a system font as the wordmark." Sofia Sans is self-hosted
  // (styles/fonts.css) but loads lazily, and ctx.font on a weight that has not
  // loaded degrades SILENTLY to Segoe UI — a brand violation invisible to
  // whoever shipped it. When the load
  // fails the card draws the logo mark alone and omits the wordmark text: the
  // mark is the offline-safe wordmark, which matters for a product whose whole
  // promise is that it runs without the internet.
  function ensureBrandFont() {
    if (brandFontPromise) return brandFontPromise;
    brandFontPromise = (async () => {
      if (!document.fonts || typeof document.fonts.load !== 'function') return false;
      try {
        await Promise.all(BRAND_FONT_PROBES.map((f) => document.fonts.load(f)));
        await document.fonts.ready;
        return document.fonts.check('800 46px "Sofia Sans"');
      } catch { return false; }
    })();
    return brandFontPromise;
  }

  let logoPromise = null;
  function loadLogoMark() {
    if (logoPromise) return logoPromise;
    logoPromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = LOGO_URL;
    });
    return logoPromise;
  }

  // The card itself is drawn by presets/share-card-draw.js.
  function drawQr(ctx, qr, x, y, size) { window.ShareCardDraw.drawQr(ctx, qr, x, y, size); }

  // The person's own Bit for the card, once it has hatched: its picture and colours come from the
  // Bit's own card (bit-companion/card.js), the line under it says who it is.
  async function loadBitArt() {
    const bit = window.BitApp?.state();
    const C = window.BitCard;
    if (bit?.hatched !== true || !C?.paint) return null;
    try {
      const tone = C.paint.toneOf(bit);
      const picture = await C.paint.bitPicture(bit, 360, tone.ink);
      if (!picture) return null;
      const code = typeof lang === 'string' ? lang : 'en';
      const say = (k, vars = {}) => String(t(k, k)).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
      const who = C.words(bit, say, (n) => Number(n).toLocaleString(code), () => '', code).big;
      return { picture, tone, line: say('sharecard_bit_line', { name: who }) };
    } catch { return null; }
  }

  // ── Surfaces & capture ───────────────────────────────────────────────────
  function surfaceState() {
    const native = window.__XENON_NATIVE__ === true || window.isTauri === true;
    let framed = false;
    try { framed = window.top !== window.self; } catch { framed = true; }
    let edgePreview = false;
    try { edgePreview = !!(window.EdgePreview && window.EdgePreview.isOn && window.EdgePreview.isOn()); } catch { /* ignore */ }
    const gaming = !!(document.body && document.body.classList.contains('game-mode'));
    return { native, framed, edgePreview, gaming };
  }

  // Which display holds the dashboard, or why we refuse. Never a rectangle from window.screenX/Y:
  // nothing converts between the browser's DPI space and gdigrab's, so the shape is matched (matchScreen).
  async function resolveCaptureTarget() {
    const s = surfaceState();
    // Inside iCUE the frame lives in someone else's window on an unknown
    // display, and screen.* describes iCUE's host monitor. Refuse outright.
    if (s.framed && !s.native) return { ok: false, reason: 'icue' };
    if (s.edgePreview) return { ok: false, reason: 'edgepreview' };
    // gdigrab returns the desktop BEHIND an exclusive-fullscreen game, or black
    // on a protected surface. gamedetect already knows; don't waste the capture.
    if (s.gaming) return { ok: false, reason: 'game' };

    const aspect = (window.screen && window.screen.width > 0 && window.screen.height > 0)
      ? window.screen.width / window.screen.height : 0;
    const payload = await apiJson(SERVER + '/api/screens');
    const list = payload && Array.isArray(payload.screens) ? payload.screens : null;
    if (!list || !list.length) return { ok: false, reason: 'unavailable' };
    const index = matchScreen(aspect, list);
    if (index === null) return { ok: false, reason: 'ambiguous' };
    return { ok: true, index, aspect, native: s.native };
  }

  // Overlays that ARE the thing on screen rather than something covering it —
  // Ambient mode and the lock screen are legitimate looks to show off, so if one
  // is up, that is what the user is sharing.
  const KEEP_VISIBLE = /(^|\s)(ambient-[\w-]*overlay|lockscreen-overlay)(\s|$)/;

  // Everything that must be off the desktop before ffmpeg grabs it: every LIVE `*-overlay`, never a
  // hand-written list (the first one missed Settings, which is always up, and photographed it). The
  // dashboard's own chrome (topbar, tiles, pager) has no such class, so it stays in the shot.
  function collectChrome(overlay) {
    const nodes = [];
    const seen = new Set();
    const push = (n) => { if (n && !seen.has(n)) { seen.add(n); nodes.push(n); } };
    push(overlay);
    document.querySelectorAll('[class*="overlay"]').forEach((n) => {
      const cls = typeof n.className === 'string' ? n.className : '';
      if (!/(^|\s)[\w-]*-overlay(\s|$)/.test(cls) || KEEP_VISIBLE.test(cls)) return;
      const st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      push(n);
    });
    document.querySelectorAll('.xtoast-stack, .xisland, #xenon-home-bar, .edge-preview-chip').forEach(push);
    return nodes;
  }

  // visibility:hidden, NOT display:none and NOT close(). display:none reflows the
  // dashboard underneath (GridStack refits, tickers restart) and we would capture
  // a layout mid-move; close() would destroy the dialog's state. The UI stays
  // hidden for the WHOLE round trip, not just until the paint: gdigrab's first
  // frame lands after device init, which on a cold machine is over a second.
  async function withUiHidden(overlay, fn) {
    const hidden = collectChrome(overlay);
    const prev = hidden.map((n) => n.style.visibility);
    hidden.forEach((n) => { n.style.visibility = 'hidden'; });
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 180));   // DWM settle
      return await fn();
    } finally {
      hidden.forEach((n, i) => { n.style.visibility = prev[i] || ''; });
    }
  }

  // Gate 4: a black frame (exclusive fullscreen, DRM, a display asleep) is a
  // uniform image. Discard rather than post a black rectangle.
  function looksBlank(img) {
    try {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 18;
      const cx = c.getContext('2d', { willReadFrequently: true });
      if (!cx) return false;
      cx.drawImage(img, 0, 0, 32, 18);
      const d = cx.getImageData(0, 0, 32, 18).data;
      let same = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) <= 12) same++;
      }
      return same / (32 * 18) >= 0.98;
    } catch { return false; }
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  // Measure the personal widgets as FRACTIONS of the viewport before anything is
  // hidden. Fractions, not pixels: no DPI, no devicePixelRatio, and correct
  // under window.__pageZoom. Only meaningful when the dashboard fills the
  // captured display — which is the only case capture is permitted in.
  function collectBlurRects() {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (!(vw > 0) || !(vh > 0)) return [];
    const out = [];
    const sel = PRIVATE_WIDGETS.map((k) => '[data-dashboard-widget="' + k + '"]').join(',');
    document.querySelectorAll(sel).forEach((node) => {
      if (node.getAttribute('data-dashboard-hidden') === 'true') return;
      const r = node.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return;
      const corner = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0;
      out.push({ x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh, r: corner / vh });
    });
    return blurBoxes.clamp(out);
  }

  // The tiles once they stop moving: the grid refits 120 ms after a resize, then slides into place.
  async function settledBlurRects() {
    const start = performance.now();
    let last = collectBlurRects();
    let still = start;
    while (performance.now() - still < 400 && performance.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 50));
      const now = collectBlurRects();
      if (blurBoxes.moved(last, now)) { last = now; still = performance.now(); }
    }
    return last;
  }

  // The full capture round trip, with every gate failing CLOSED to the drawn card.
  async function captureMonitor(target, overlay) {
    const ctrl = new AbortController();
    // Independent of the server's 15 s ffmpeg timeout, so the finally in
    // withUiHidden always runs and the dialog can never stay invisible.
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const url = SERVER + '/api/screenshot/monitor?index=' + encodeURIComponent(target.index) + '&max=2560';
      // The blur boxes are measured with the UI hidden, right before the grab, and again after it:
      // a tile that moved in between means the picture can't say where it was.
      let rects = [];
      let moved = false;
      const data = await withUiHidden(overlay, async () => {
        rects = await settledBlurRects();
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        const out = res.ok ? await res.json() : null;
        moved = blurBoxes.moved(rects, collectBlurRects());
        return out;
      });
      if (moved) return { ok: false, reason: 'changed' };
      if (!data || !data.base64 || data.base64.length < 50 || !data.screen) return { ok: false, reason: 'unavailable' };

      // Gate 3a: the display we were given back must still be the shape we asked
      // for — a monitor change mid-capture would otherwise go unnoticed.
      const sw = Number(data.screen.width);
      const sh = Number(data.screen.height);
      if (!(sw > 0) || !(sh > 0)) return { ok: false, reason: 'unavailable' };
      if (Math.abs(sw / sh - target.aspect) / target.aspect > SCREEN_ASPECT_TOLERANCE) {
        return { ok: false, reason: 'changed' };
      }

      const img = await loadImage('data:' + (data.mimeType || 'image/jpeg') + ';base64,' + data.base64);
      if (!img || !img.width || !img.height) return { ok: false, reason: 'unavailable' };
      // Gate 3b: the returned pixels must have the display's shape (the ffmpeg
      // scale filter preserves it; anything else means the grab was mangled).
      if (Math.abs(img.width / img.height - sw / sh) / (sw / sh) > 0.02) {
        return { ok: false, reason: 'changed' };
      }
      if (looksBlank(img)) return { ok: false, reason: 'blank' };
      return { ok: true, img, aspect: img.width / img.height, rects };
    } catch (e) {
      return { ok: false, reason: (e && e.name === 'AbortError') ? 'timeout' : 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── The setup code ───────────────────────────────────────────────────────
  // A "my setup" share carries no preset, so encode the current THEME for the
  // QR: it is the only kind small enough to survive the ~1200-byte ceiling, and
  // it is what someone looking at the picture actually wants. Deliberately
  // WITHOUT the embedded typeface (themeExportData embeds it as base64, tens of
  // KB, which would push every themed setup off the QR) — the font still travels
  // in the .json the share dialog offers.
  function setupThemeCode() {
    try {
      const PS = window.PresetShare;
      if (!PS || typeof PS.currentTheme !== 'function' || typeof PS.encodePreset !== 'function') return '';
      // Redistribution guard: the screenshot is the user's either way, the theme
      // is not. Mirrors exportTheme()'s own refusal.
      if (typeof PS.currentThemeImported === 'function' && PS.currentThemeImported()) return '';
      const name = t('preset_share_theme_name', 'My theme');
      return PS.encodePreset('theme', name, PS.currentTheme(), {});
    } catch { return ''; }
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  let openState = null;

  function close() {
    if (openState && typeof openState.close === 'function') {
      const fn = openState.close;
      openState = null;
      fn();
    }
  }

  const CAPTURE_REASON_KEYS = {
    icue: ['sharecard_capture_icue', 'Inside iCUE the dashboard can’t be captured: this card is drawn instead. Open Xenon in the app or a browser for a real screenshot.'],
    edgepreview: ['sharecard_capture_edgepreview', 'Turn off Edge preview to capture the real dashboard.'],
    game: ['sharecard_capture_game', 'A game is running full screen, so this card is drawn instead.'],
    ambiguous: ['sharecard_capture_ambiguous', 'Xenon can’t tell which of your displays holds the dashboard, so it drew the card instead.'],
    fullscreen: ['sharecard_capture_needs_fullscreen', 'Allow full screen to capture the dashboard.'],
    blank: ['sharecard_capture_unavailable', 'Couldn’t capture the screen, so this card is drawn instead.'],
    changed: ['sharecard_capture_unavailable', 'Couldn’t capture the screen, so this card is drawn instead.'],
    timeout: ['sharecard_capture_unavailable', 'Couldn’t capture the screen, so this card is drawn instead.'],
    unavailable: ['sharecard_capture_unavailable', 'Couldn’t capture the screen, so this card is drawn instead.'],
  };
  function reasonText(reason) {
    const pair = CAPTURE_REASON_KEYS[reason] || CAPTURE_REASON_KEYS.unavailable;
    return t(pair[0], pair[1]);
  }

  function toastMsg(kicker, title, message, type) {
    if (window.XenonToast) XenonToast.show({ type: type || 'info', kicker, title, message, duration: 6000 });
  }

  // opts: { kind?, name?, code?, galleryId?, author?, source? }
  async function open(opts) {
    // The modal chrome, Escape handling and the ambientFreeze token all come
    // from preset-share.js. Without it there is no dialog to put the card in.
    if (!window.PresetShare || typeof PresetShare.buildModal !== 'function') return;
    close();
    const o = opts || {};
    const isSetup = o.source === 'setup' || !o.kind;
    const kind = isSetup ? '' : o.kind;
    const code = typeof o.code === 'string' && o.code ? o.code : (isSetup ? setupThemeCode() : '');
    const name = o.name || (isSetup
      ? t('sharecard_setup_title', 'My setup')
      : t('sharecard_title', 'Share card'));

    const modal = PresetShare.buildModal(
      isSetup ? t('sharecard_setup_title', 'My setup') : t('sharecard_title', 'Share card'),
      () => { openState = null; }
    );
    openState = modal;
    modal.modal.classList.add('sharecard-modal');

    // `galleryId` points the QR at a published catalog entry. Nothing supplies it yet (the app never
    // learns the id a reviewed creation gets); never a paste field again: two link boxes read as two links.
    const target = pickQrTarget({ galleryId: o.galleryId, code });
    const state = {
      format: 'post',
      capture: null,
      captureAspect: viewportAspect(),
      qr: null,
      colors: themeColors(),
      logo: null,
      fontOk: false,
      blur: readPref(BLUR_PREF_KEY),
      blurRects: [],
      withBit: readPref(BIT_PREF_KEY),
      bit: null,
      reason: '',
      busy: false,
    };

    // ── The card first, as big as the dialog allows, then how it looks.
    const preview = el('div', 'sharecard-preview');
    const canvas = document.createElement('canvas');
    canvas.className = 'sharecard-canvas';
    preview.appendChild(canvas);
    modal.body.appendChild(preview);

    const formats = el('div', 'sharecard-formats');
    formats.setAttribute('role', 'group');
    formats.setAttribute('aria-label', t('sharecard_format', 'Format'));
    [['post', t('sharecard_format_post', 'Post 16:9')], ['story', t('sharecard_format_story', 'Story 9:16')]]
      .forEach(([key, label]) => {
        const b = el('button', 'sharecard-format', label);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(key === state.format));
        b.addEventListener('click', () => {
          if (state.format === key) return;
          state.format = key;
          formats.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          paint();
        });
        formats.appendChild(b);
      });
    modal.body.appendChild(formats);

    // ── Its switches: the real screenshot (absent, never broken, when capture is refused), the
    //    blur of personal tiles (with a screenshot only), and the person's own Bit (once hatched).
    const options = el('div', 'sharecard-options');
    const checkRow = (label, checked) => {
      const row = el('label', 'preset-check-row');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'settings-check';
      box.checked = checked;
      row.appendChild(box);
      row.appendChild(el('span', 'preset-check-name', label));
      row.hidden = true;
      options.appendChild(row);
      return [row, box];
    };
    const [shotRow, shotChk] = checkRow(t('sharecard_use_screenshot', 'Use a real screenshot of my dashboard'), false);
    const [blurRow, blurChk] = checkRow(t('sharecard_blur_personal', 'Blur personal details'), state.blur);
    const [bitRow, bitChk] = checkRow(t('sharecard_with_bit', 'Put my Bit on it'), state.withBit);
    modal.body.appendChild(options);

    // ── The link the QR encodes, in plain copyable text.
    // A QR is for a phone camera; posting the card anywhere means writing a
    // comment with a URL in it, and having to scan your own card to find out
    // what it says is absurd. This row is also the only place the destination is
    // legible at all — a QR tells you nothing about where it goes.
    // The label is not decoration: without it this row and the catalog row below
    // are two identical boxes, and nothing says which one is the answer and which
    // one is the question.
    modal.body.appendChild(el('p', 'sharecard-field-label', t('sharecard_link_label', 'Link on this card')));
    const linkRow = el('div', 'sharecard-link');
    const linkField = document.createElement('input');
    linkField.type = 'text';
    linkField.readOnly = true;
    linkField.className = 'sharecard-link-field is-readonly';
    linkField.setAttribute('aria-label', t('sharecard_link_label', 'Link on this card'));
    linkField.addEventListener('focus', () => linkField.select());
    const linkCopy = el('button', 'settings-btn subtle', t('sharecard_copy_link', 'Copy link'));
    linkCopy.type = 'button';
    linkCopy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(linkField.value);
        toastMsg('Xenon', t('sharecard_copied_link', 'Link copied'), '', 'success');
      } catch {
        linkField.select();
        document.execCommand('copy');
      }
    });
    linkRow.appendChild(linkField);
    linkRow.appendChild(linkCopy);
    modal.body.appendChild(linkRow);

    function syncLink() { linkField.value = target.url; }

    const note = el('p', 'sharecard-note');
    note.hidden = true;
    modal.body.appendChild(note);

    function setNote(text) {
      note.textContent = text || '';
      note.hidden = !text;
    }

    function paint() {
      window.ShareCardDraw.render(canvas, {
        format: state.format,
        size: cardSize(state.format),
        name,
        kindLabel: kind ? t('preset_kind_' + kind, kind) : '',
        byline: o.author ? t('gallery_by', 'by') + ' ' + o.author : '',
        wrap: wrapName,
        bit: state.withBit ? state.bit : null,
        colors: state.colors,
        qr: state.qr,
        qrCaption: target.type === 'site'
          ? 'xenon-app.com'
          : t('sharecard_qr_hint', 'Scan to get this look'),
        capture: state.capture,
        captureAspect: state.capture ? state.captureAspect : viewportAspect(),
        blurRects: state.blur ? state.blurRects : [],
        logo: state.logo,
        fontOk: state.fontOk,
        // Only when a code really does travel alongside — i.e. the card was
        // opened from a share dialog, which offers the .json next to it. A "my
        // setup" share has no file to attach, so the line would be a lie.
        note: (!isSetup && code && target.type === 'site')
          ? t('sharecard_code_attached', 'Import code attached alongside this card')
          : '',
      });
    }

    // First paint is the drawn card, immediately — the capture is an upgrade
    // that arrives (or doesn't) afterwards.
    syncLink();
    paint();

    Promise.all([ensureBrandFont(), loadLogoMark()]).then(([fontOk, logo]) => {
      state.fontOk = fontOk;
      state.logo = logo;
      paint();
    });
    loadBitArt().then((bit) => {
      if (!bit || openState !== modal) return;
      state.bit = bit;
      bitRow.hidden = false;
      paint();
    });

    // Rebuilt whenever the target changes (the catalog field), not only at open.
    function buildQr() {
      loadQrLib().then((lib) => {
        if (!lib) return;
        const qr = lib(0, 'M');   // 0 = auto-pick the smallest type that fits
        qr.addData(target.url);
        qr.make();
        state.qr = qr;
        paint();
      }).catch(() => { /* no QR is a card without a QR, not a failure */ });
    }
    buildQr();

    // ── Capture wiring.
    async function runCapture() {
      if (state.busy) return false;
      state.busy = true;
      canvas.classList.add('is-busy');
      let entered = false;
      try {
        const resolved = await resolveCaptureTarget();
        if (!resolved.ok) { state.reason = resolved.reason; return false; }

        // A browser window rarely fills its display, so ask for full screen
        // rather than cropping — that consumes the click we already hold and
        // removes every DIP-to-physical conversion. Native is full screen by
        // construction.
        if (!resolved.native && !document.fullscreenElement) {
          try { await document.documentElement.requestFullscreen(); }
          catch { state.reason = 'fullscreen'; return false; }
          entered = true;
          setNote(t('sharecard_capture_wait', 'Taking the picture as soon as the browser’s full screen notice goes away.'));
          await new Promise((r) => setTimeout(r, FULLSCREEN_BANNER_MS));
          if (!document.fullscreenElement) { state.reason = 'fullscreen'; return false; }
        }
        const shot = await captureMonitor(resolved, modal.overlay);
        if (!shot.ok) { state.reason = shot.reason; return false; }
        state.blurRects = shot.rects;
        state.capture = shot.img;
        state.captureAspect = shot.aspect;
        state.reason = '';
        return true;
      } finally {
        // Leave the browser exactly as it was found — full screen was borrowed
        // for the grab, it is not a mode the user asked to be in.
        if (entered && document.fullscreenElement) {
          try { await document.exitFullscreen(); } catch { /* already gone */ }
        }
        state.busy = false;
        canvas.classList.remove('is-busy');
      }
    }

    shotChk.addEventListener('change', async () => {
      if (!shotChk.checked) { state.capture = null; setNote(''); paint(); return; }
      shotChk.disabled = true;
      const ok = await runCapture();
      shotChk.disabled = false;
      shotChk.checked = ok;
      blurRow.hidden = !ok;
      setNote(ok ? '' : reasonText(state.reason));
      paint();
    });

    blurChk.addEventListener('change', () => {
      state.blur = blurChk.checked;
      writePref(BLUR_PREF_KEY, state.blur);
      paint();
    });
    bitChk.addEventListener('change', () => {
      state.withBit = bitChk.checked;
      writePref(BIT_PREF_KEY, state.withBit);
      paint();
    });

    // Probe once so the checkbox is only offered when it can actually work.
    resolveCaptureTarget().then(async (resolved) => {
      if (!resolved.ok) { setNote(reasonText(resolved.reason)); return; }
      shotRow.hidden = false;
      // Auto-capture only where no user gesture is needed (the kiosk, or a
      // browser already in full screen). Anywhere else the tick IS the gesture
      // that grants full screen, so surprising the user with it is not on.
      if (!resolved.native && !document.fullscreenElement) return;
      shotChk.checked = true;
      const ok = await runCapture();
      shotChk.checked = ok;
      blurRow.hidden = !ok;
      setNote(ok ? '' : reasonText(state.reason));
      paint();
    });

    // ── Actions.
    const row = el('div', 'preset-modal-actions');
    const dl = el('button', 'settings-btn primary', t('sharecard_download', 'Download PNG'));
    dl.type = 'button';
    dl.addEventListener('click', () => {
      // "Save as" where the browser has one (js/save-file.js), else a download.
      const S = window.XenonSaveFile;
      const make = () => new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no_image'))), 'image/png');
      });
      S.save({ name: 'xenon-' + (kind || 'setup') + '-card.png', types: [S.PNG_TYPE], make })
        .catch((e) => toastMsg('Xenon', e && e.message === 'no_image'
          ? t('sharecard_shot_fail', 'Screenshot not available')
          : t('save_file_failed', 'Could not save the file'), '', 'error'));
    });

    if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
      const copy = el('button', 'settings-btn', t('sharecard_copy_image', 'Copy image'));
      copy.type = 'button';
      copy.addEventListener('click', () => {
        // The write runs inside the gesture that approved it — the same rule the
        // SDK clipboard capability follows.
        canvas.toBlob(async (blob) => {
          if (!blob) return;
          try {
            await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
            toastMsg('Xenon', t('sharecard_copied_image', 'Image copied'), '', 'success');
          } catch {
            toastMsg('Xenon', t('sharecard_copy_image_fail', 'Couldn’t copy the image: download it instead.'), '', 'error');
          }
        }, 'image/png');
      });
      row.appendChild(copy);
    }

    if (navigator.canShare) {
      const share = el('button', 'settings-btn', t('sharecard_share', 'Share…'));
      share.type = 'button';
      share.addEventListener('click', () => {
        canvas.toBlob(async (blob) => {
          if (!blob) return;
          const file = new File([blob], 'xenon-card.png', { type: 'image/png' });
          if (navigator.canShare({ files: [file] })) {
            try { await navigator.share({ files: [file], title: 'Xenon' }); } catch { /* user cancelled */ }
          }
        }, 'image/png');
      });
      row.appendChild(share);
    }
    row.appendChild(dl);
    modal.body.appendChild(row);
  }

  function viewportAspect() {
    const w = window.innerWidth || 1600;
    const h = window.innerHeight || 900;
    const a = w / h;
    // Clamp so a freak window shape can't produce a plate nobody would post.
    return Math.min(4.2, Math.max(1.1, a));
  }


  // Both default ON. The blur: the dashboard routinely shows calendar entries, notes, file paths
  // and account names, and posting those is the kind of thing you do once and regret. The Bit:
  // it is theirs, and a card with it says whose setup this is.
  const BLUR_PREF_KEY = 'xenon.sharecard.blur';
  const BIT_PREF_KEY = 'xenon.sharecard.bit';
  function readPref(key) {
    try { return localStorage.getItem(key) !== '0'; } catch { return true; }
  }
  function writePref(key, on) {
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private mode */ }
  }

  window.ShareCard = { open, close, pickQrTarget, loadQrLib, drawQr }; // the last two also make the Bit card (bit-companion/card.js)
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pickQrTarget, matchScreen, wrapName, clampBlurRects: blurBoxes.clamp, blurRectsMoved: blurBoxes.moved, cardSize,
    QR_CODE_MAX_BYTES, SHARE_SITE_BASE, SCREEN_ASPECT_TOLERANCE, CARD_SIZES,
  };
}

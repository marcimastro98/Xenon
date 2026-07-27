'use strict';
// "Share my setup" card — a premium, canvas-composed PNG the user can post
// (Reddit, Discord, TikTok…) to show off their dashboard, with a QR code that
// leads people back to Xenon.
//
// The card is a COMPOSER with an optional capture, never the reverse:
// renderCard() must produce a complete, postable image with `capture === null`.
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
// What a QR can HOLD and what a phone can READ off a posted image are different
// numbers, and the card this replaces used the first one. 1200 bytes needs QR
// version 40 — 177x177 modules. The card's QR panel is ~190 px, so each module
// lands under a single pixel, and the image is downscaled again by whatever
// platform it is posted to: the result is noise, not a code.
//
// Working backwards from the pixels instead: a card posted at ~1200 px wide
// renders the panel at ~140 px, and a phone needs roughly 3 px per module at
// arm's length. That is ~47 modules — QR version 8, about 152 bytes at error
// correction M. 130 leaves room for the URL prefix.
//
// The practical consequence, stated plainly: a preset code never fits. Rung 2
// only ever fires for something very short, and everything real resolves to the
// catalog entry or the site — both around 40 characters, which scan instantly.
// That is the correct trade: a QR nobody can scan is worse than no QR.
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

// Which enumerated display holds the dashboard, by SHAPE.
//
// This is the fix for the defect that killed the v4.4 card. There are two
// incompatible screen coordinate spaces on a Windows box: listScreens() (via
// PowerShell) and ffmpeg/gdigrab are both DPI-UNAWARE and agree with each other
// in virtualised units, while the browser/WebView2 is per-monitor DPI AWARE and
// reports DIPs that cannot be converted into that space — the page cannot see
// the other displays' scale factors, so no correction factor exists. Aspect
// ratio is the only key invariant across both spaces (2560/720 === 1707/480).
//
// Returns the position of the single matching screen, or null when zero or more
// than one match. Two 16:9 monitors is the common ambiguous case and refusing is
// the correct answer: the caller falls back to the drawn card, never to a
// capture of the wrong display.
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

// Normalize the privacy blur boxes to safe fractions of the captured plate.
// They are measured from a live getBoundingClientRect() and turned into
// fractions BEFORE the capture, so a layout that moved in between can only ever
// produce a box that is clamped away, never one painted outside the plate.
function clampBlurRects(rects) {
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
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

if (typeof window !== 'undefined') (function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js

  // Brand constants. BRAND.md locks these for every public surface, INDEPENDENT
  // of the user's in-app accent — the card must stay recognisably Xenon while
  // showing off someone else's palette.
  const BRAND_GREEN = '#1ed760';
  const BRAND_INK = '#070808';
  const BRAND_TEXT = '#f0f3f1';
  const BRAND_MUTED = '#9aa8a1';
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
  const PRIVATE_WIDGETS = ['notes', 'tasks', 'calendar', 'agenda', 'chat', 'claude',
    'discord', 'notifications', 'search', 'unifi'];

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
  const BRAND_FONT_PROBES = ['800 46px Inter', '700 30px Inter', '600 22px Inter', '500 26px Inter'];
  let brandFontPromise = null;
  // BRAND.md: "never a system font as the wordmark." Inter arrives from Google
  // Fonts, and ctx.font on a weight that has not loaded degrades SILENTLY to
  // Segoe UI — a brand violation invisible to whoever shipped it. When the load
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
        return document.fonts.check('800 46px Inter');
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

  // ── Layout ───────────────────────────────────────────────────────────────
  // Capture on top as the hero, metadata in a band underneath. The plate is a
  // BOX the capture is contain-fitted and centred into, so any source aspect
  // from a 32:9 Edge bar to a 16:10 laptop lands well without letterbox bars —
  // a bar reads as a bug, a smaller plate reads as a choice.
  const LAYOUTS = {
    post: {
      plate: { x: 48, y: 44, w: 1504, h: 524 },
      logo: { x: 64, y: 600, s: 52 },
      brand: { x: 128, midY: 626, size: 30 },
      chip: { gap: 16, h: 36, size: 19, pad: 18 },
      name: { x: 64, baseline: 716, lineH: 56, size: 46, maxW: 1150, lines: 2 },
      swatch: { x: 82, cy: 812, r: 17, gap: 46 },
      footer: { x: 64, baseline: 864, size: 22 },
      qr: { x: 1348, y: 592, s: 188 },
      qrCap: { cx: 1442, baseline: 812, size: 20, maxW: 240, align: 'center' },
      note: { x: 64, baseline: 864, size: 20 },
    },
    story: {
      plate: { x: 56, y: 300, w: 968, h: 900 },
      logo: { x: 72, y: 116, s: 76 },
      brand: { x: 168, midY: 154, size: 44 },
      chip: { gap: 22, h: 50, size: 26, pad: 24 },
      name: { x: 72, baseline: 1330, lineH: 84, size: 66, maxW: 936, lines: 2 },
      swatch: { x: 96, cy: 1476, r: 24, gap: 64 },
      footer: { x: 344, baseline: 1740, size: 26 },
      qr: { x: 72, y: 1592, s: 236 },
      qrCap: { x: 344, baseline: 1686, size: 28, maxW: 660, align: 'left' },
      note: { x: 72, baseline: 1852, size: 24 },
    },
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawQr(ctx, qr, x, y, size) {
    const count = qr.getModuleCount();
    const cell = size / count;
    ctx.fillStyle = '#101214';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(x + c * cell, y + r * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }

  // Contain-fit `aspect` inside `box`, centred.
  function fitPlate(box, aspect) {
    const a = (Number.isFinite(aspect) && aspect > 0) ? aspect : 16 / 9;
    let w = box.h * a;
    let h = box.h;
    if (w > box.w) { w = box.w; h = box.w / a; }
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  }

  // The no-capture plate: the user's own background with a stylised silhouette
  // of the 24-column bento grid over it. Same rect, same glow, same stroke as a
  // real capture — the fallback is one branch inside the renderer, not a second
  // card that can rot.
  function drawSilhouette(ctx, r, colors) {
    ctx.save();
    ctx.fillStyle = colors.background;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const rows = [[6, 10, 8], [10, 6, 4, 4], [8, 8, 8]];
    const pad = Math.max(8, Math.round(r.h * 0.06));
    const gap = pad * 0.62;
    const rowH = (r.h - pad * (rows.length + 1)) / rows.length;
    let y = r.y + pad;
    for (const row of rows) {
      const units = row.reduce((a, b) => a + b, 0);
      const avail = r.w - pad * 2 - gap * (row.length - 1);
      let x = r.x + pad;
      for (const span of row) {
        const w = avail * (span / units);
        roundRect(ctx, x, y, w, rowH, Math.min(16, rowH * 0.16));
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = colors.surface;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.accent + '2e';
        ctx.lineWidth = 2;
        ctx.stroke();
        x += w + gap;
      }
      y += rowH + pad;
    }
    ctx.restore();
  }

  // Pixel-blur the personal boxes by round-tripping each region through a tiny
  // offscreen canvas. No CSS filter is involved, so this works identically on a
  // canvas the browser will later hand to toBlob().
  function drawBlurBoxes(ctx, img, plate, rects) {
    for (const b of rects) {
      const sw = b.w * img.width;
      const sh = b.h * img.height;
      if (sw < 2 || sh < 2) continue;
      const small = document.createElement('canvas');
      small.width = Math.max(2, Math.round(sw / 26));
      small.height = Math.max(2, Math.round(sh / 26));
      const sctx = small.getContext('2d');
      if (!sctx) continue;
      sctx.drawImage(img, b.x * img.width, b.y * img.height, sw, sh, 0, 0, small.width, small.height);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(small, 0, 0, small.width, small.height,
        plate.x + b.x * plate.w, plate.y + b.y * plate.h, b.w * plate.w, b.h * plate.h);
      ctx.restore();
    }
  }

  // Compose the card. opts:
  //   { format, kind, name, author?, colors, qr, qrCaption, capture, captureAspect,
  //     blurRects, logo, fontOk, note? }
  function renderCard(canvas, opts) {
    const ctx = canvas.getContext('2d');
    const size = cardSize(opts.format);
    const L = LAYOUTS[opts.format] || LAYOUTS.post;
    const colors = opts.colors;
    const family = opts.fontOk ? 'Inter, sans-serif' : '"Segoe UI", system-ui, sans-serif';
    const font = (weight, px) => weight + ' ' + px + 'px ' + family;

    canvas.width = size.w;
    canvas.height = size.h;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Ground + two brand-green glows. The user's accent appears only in the
    // swatches and the plate's inner stroke.
    ctx.fillStyle = BRAND_INK;
    ctx.fillRect(0, 0, size.w, size.h);
    for (const g of [{ x: 0.18, y: 0.06, r: 0.75, a: '30' }, { x: 0.88, y: 0.96, r: 0.6, a: '1c' }]) {
      const grad = ctx.createRadialGradient(size.w * g.x, size.h * g.y, 0, size.w * g.x, size.h * g.y, size.w * g.r);
      grad.addColorStop(0, BRAND_GREEN + g.a);
      grad.addColorStop(1, BRAND_GREEN + '00');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size.w, size.h);
    }

    // ── The plate. Never dimmed: the v4.4 card dimmed its screenshot because it
    // was a BACKDROP; here it is the subject, and that inversion is most of the
    // redesign.
    const plate = fitPlate(L.plate, opts.captureAspect);
    const radius = Math.min(22, plate.h * 0.06);
    ctx.save();
    ctx.shadowColor = BRAND_GREEN + '45';
    ctx.shadowBlur = 44;
    roundRect(ctx, plate.x, plate.y, plate.w, plate.h, radius);
    ctx.fillStyle = BRAND_INK;
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, plate.x, plate.y, plate.w, plate.h, radius);
    ctx.clip();
    if (opts.capture) {
      ctx.drawImage(opts.capture, plate.x, plate.y, plate.w, plate.h);
      if (opts.blurRects && opts.blurRects.length) drawBlurBoxes(ctx, opts.capture, plate, opts.blurRects);
    } else {
      drawSilhouette(ctx, plate, colors);
    }
    ctx.restore();

    roundRect(ctx, plate.x, plate.y, plate.w, plate.h, radius);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 2;
    ctx.stroke();
    roundRect(ctx, plate.x + 2, plate.y + 2, plate.w - 4, plate.h - 4, Math.max(2, radius - 2));
    ctx.strokeStyle = colors.accent + '3a';
    ctx.lineWidth = 2;
    ctx.stroke();

    // ── Brand row: mark, wordmark, kind chip.
    if (opts.logo) ctx.drawImage(opts.logo, L.logo.x, L.logo.y, L.logo.s, L.logo.s);
    ctx.textBaseline = 'middle';
    let chipX = L.brand.x;
    if (opts.fontOk) {
      ctx.font = font(800, L.brand.size);
      ctx.fillStyle = BRAND_TEXT;
      ctx.fillText('Xenon', L.brand.x, L.brand.midY);
      chipX = L.brand.x + ctx.measureText('Xenon').width + L.chip.gap;
    }
    const kindLabel = String(opts.kind ? t('preset_kind_' + opts.kind, opts.kind) : '').toUpperCase();
    if (kindLabel) {
      ctx.font = font(700, L.chip.size);
      const chipW = ctx.measureText(kindLabel).width + L.chip.pad * 2;
      roundRect(ctx, chipX, L.brand.midY - L.chip.h / 2, chipW, L.chip.h, L.chip.h / 2);
      ctx.fillStyle = colors.accent + '2b';
      ctx.fill();
      ctx.strokeStyle = colors.accent + '70';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = colors.accent;
      ctx.fillText(kindLabel, chipX + L.chip.pad, L.brand.midY + 1);
    }

    // ── Name.
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(800, L.name.size);
    ctx.fillStyle = BRAND_TEXT;
    const lines = wrapName((s) => ctx.measureText(s).width, opts.name, L.name.maxW, L.name.lines);
    lines.forEach((ln, i) => ctx.fillText(ln, L.name.x, L.name.baseline + i * L.name.lineH));

    // ── Palette swatches.
    const swatches = [colors.accent, colors.background, colors.surface, colors.text, colors.onAccent];
    swatches.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(L.swatch.x + i * L.swatch.gap, L.swatch.cy, L.swatch.r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // ── QR + caption.
    if (opts.qr) {
      const pad = Math.round(L.qr.s * 0.1);
      roundRect(ctx, L.qr.x, L.qr.y, L.qr.s, L.qr.s, 18);
      ctx.fillStyle = '#f4f6f5';
      ctx.fill();
      drawQr(ctx, opts.qr, L.qr.x + pad, L.qr.y + pad, L.qr.s - pad * 2);
      if (opts.qrCaption) {
        ctx.font = font(500, L.qrCap.size);
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.textAlign = L.qrCap.align;
        ctx.fillText(opts.qrCaption, L.qrCap.align === 'center' ? L.qrCap.cx : L.qrCap.x,
          L.qrCap.baseline, L.qrCap.maxW);
        ctx.textAlign = 'left';
      }
    }

    // ── Footer, and the "code travels alongside" note when the QR could not
    //    carry it. In `post` both want the same baseline, so the note wins and
    //    the site name rides the QR caption instead.
    ctx.font = font(600, L.footer.size);
    ctx.fillStyle = BRAND_MUTED;
    const byline = opts.author ? ' · ' + t('gallery_by', 'by') + ' ' + opts.author : '';
    if (opts.note) {
      ctx.font = font(500, L.note.size);
      ctx.fillText(opts.note, L.note.x, L.note.baseline, L.name.maxW);
    } else {
      ctx.fillText('xenon-app.com' + byline, L.footer.x, L.footer.baseline, L.name.maxW);
    }
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

  // Decide WHICH display holds the dashboard, or why we refuse.
  //
  // Note what this deliberately does NOT do: compute a rectangle from
  // window.screenX/screenY. The browser is per-monitor DPI aware and
  // /api/screens + gdigrab are not, and no client-side factor converts between
  // the two — mixing them is exactly what made the v4.4 card grab the wrong
  // monitor. window.__pageZoom is irrelevant here for the same reason: nothing
  // is converted, the shape is matched. See matchScreen().
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

  // Everything that must be off the composited desktop before ffmpeg grabs it.
  //
  // Every LIVE overlay counts, not a hand-written list of them. The first version
  // enumerated four selectors and missed the obvious one: "Share my setup" is
  // launched from Settings, so the Settings overlay is always up, and the card
  // photographed the settings panel instead of the dashboard. An allowlist here
  // is wrong by construction — a new dialog added anywhere in the app would
  // silently start appearing in people's screenshots. Matching `*-overlay`
  // inverts that: the dashboard's own chrome (topbar, tiles, pager) carries no
  // such class, so it stays in the shot, which is the whole point.
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
    document.querySelectorAll('.xtoast-stack, #xenon-home-bar, .edge-preview-chip').forEach(push);
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
      out.push({ x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh });
    });
    return clampBlurRects(out);
  }

  // The full capture round trip, with every gate failing CLOSED to the drawn card.
  async function captureMonitor(target, overlay) {
    const ctrl = new AbortController();
    // Independent of the server's 15 s ffmpeg timeout, so the finally in
    // withUiHidden always runs and the dialog can never stay invisible.
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const url = SERVER + '/api/screenshot/monitor?index=' + encodeURIComponent(target.index) + '&max=2560';
      const data = await withUiHidden(overlay, async () => {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) return null;
        return res.json();
      });
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
      return { ok: true, img, aspect: img.width / img.height };
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
    icue: ['sharecard_capture_icue', 'Inside iCUE the dashboard can’t be captured — this card is drawn instead. Open Xenon in the app or a browser for a real screenshot.'],
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

    // `galleryId` can only come from the user: a submission is reviewed by a
    // human on the site, so the app never learns the id its creation was
    // published under. It is offered as a paste field below, and remembered.
    // `galleryId` points the QR at a published catalog entry. Nothing supplies it
    // yet: publishing goes through a human review on the site, so the app never
    // learns the id its creation was given. It stays in the API for the day there
    // IS an automatic source — the submission portal handing the id back, or a
    // share opened on catalog-installed content. It was briefly offered as a
    // paste field and that was a mistake: two link boxes read as two links, and
    // what the field replaced (the site root) is already the right answer for
    // everyone who has not published anything.
    const target = pickQrTarget({ galleryId: o.galleryId, code });
    const state = {
      format: 'post',
      capture: null,
      captureAspect: viewportAspect(),
      qr: null,
      colors: themeColors(),
      logo: null,
      fontOk: false,
      blur: readBlurPref(),
      blurRects: [],
      reason: '',
      busy: false,
    };

    // ── Format chips.
    const formats = el('div', 'sharecard-formats');
    const chips = {};
    [['post', t('sharecard_format_post', 'Post 16:9')], ['story', t('sharecard_format_story', 'Story 9:16')]]
      .forEach(([key, label]) => {
        const b = el('button', 'settings-btn subtle' + (key === state.format ? ' active' : ''), label);
        b.type = 'button';
        b.addEventListener('click', () => {
          if (state.format === key) return;
          state.format = key;
          Object.keys(chips).forEach((k) => chips[k].classList.toggle('active', k === key));
          paint();
        });
        chips[key] = b;
        formats.appendChild(b);
      });
    modal.body.appendChild(formats);

    const canvas = document.createElement('canvas');
    canvas.className = 'sharecard-canvas';
    modal.body.appendChild(canvas);

    // ── "Use a real screenshot". Absent, never broken, when capture is refused.
    const shotRow = el('label', 'preset-check-row');
    const shotChk = document.createElement('input');
    shotChk.type = 'checkbox';
    shotChk.className = 'settings-check';
    shotRow.appendChild(shotChk);
    shotRow.appendChild(el('span', 'preset-check-name', t('sharecard_use_screenshot', 'Use a real screenshot of my dashboard')));
    shotRow.hidden = true;
    modal.body.appendChild(shotRow);

    // ── Privacy blur.
    const blurRow = el('label', 'preset-check-row');
    const blurChk = document.createElement('input');
    blurChk.type = 'checkbox';
    blurChk.className = 'settings-check';
    blurChk.checked = state.blur;
    blurRow.appendChild(blurChk);
    blurRow.appendChild(el('span', 'preset-check-name', t('sharecard_blur_personal', 'Blur personal details')));
    blurRow.hidden = true;
    modal.body.appendChild(blurRow);

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
      renderCard(canvas, {
        format: state.format,
        kind,
        name,
        author: o.author || '',
        colors: state.colors,
        qr: state.qr,
        qrCaption: target.type === 'site'
          ? t('sharecard_qr_site_hint', 'Made with Xenon')
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
          // requestFullscreen resolves before the reflow settles, and the blur
          // boxes are measured against the POST-fullscreen layout.
          await new Promise((r) => setTimeout(r, 260));
        }
        state.blurRects = collectBlurRects();
        const shot = await captureMonitor(resolved, modal.overlay);
        if (!shot.ok) { state.reason = shot.reason; return false; }
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
      writeBlurPref(state.blur);
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
      canvas.toBlob((blob) => {
        if (!blob) { toastMsg('Xenon', t('sharecard_shot_fail', 'Screenshot not available'), '', 'error'); return; }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'xenon-' + (kind || 'setup') + '-card.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
    });
    row.appendChild(dl);

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
            toastMsg('Xenon', t('sharecard_copy_image_fail', 'Couldn’t copy the image — download it instead.'), '', 'error');
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
    modal.body.appendChild(row);
  }

  function viewportAspect() {
    const w = window.innerWidth || 1600;
    const h = window.innerHeight || 900;
    const a = w / h;
    // Clamp so a freak window shape can't produce a plate nobody would post.
    return Math.min(4.2, Math.max(1.1, a));
  }


  const BLUR_PREF_KEY = 'xenon.sharecard.blur';
  function readBlurPref() {
    // Default ON: the dashboard routinely shows calendar entries, notes, file
    // paths and account names, and posting those is the kind of thing you do
    // once and regret.
    try { return localStorage.getItem(BLUR_PREF_KEY) !== '0'; } catch { return true; }
  }
  function writeBlurPref(on) {
    try { localStorage.setItem(BLUR_PREF_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  }

  window.ShareCard = { open, close, pickQrTarget };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pickQrTarget, matchScreen, wrapName, clampBlurRects, cardSize,
    QR_CODE_MAX_BYTES, SHARE_SITE_BASE, SCREEN_ASPECT_TOLERANCE, CARD_SIZES,
  };
}

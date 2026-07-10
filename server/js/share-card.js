'use strict';
// "Share your setup" card — a premium, canvas-composed PNG the user can post
// (Reddit, Discord, …) to show off a theme/package, with a QR code that leads
// people to it.
//
// QR target ladder (pickQrTarget, pure + node-tested):
//   1. entry published in the community gallery → its public gallery anchor;
//   2. small code (≤ QR_CODE_MAX_BYTES)         → the docs "get" landing with
//      the code in the URL fragment (never touches a server log);
//   3. otherwise → no QR — the card says the code travels alongside (the share
//      dialog already offers the .txt/.json file).
// Never a 127.0.0.1 deep link: a phone can't reach the local dashboard.
//
// The optional "real screenshot" variant composites GET /api/screenshot
// (ffmpeg desktop grab — same endpoint the AI vision flow uses) dimmed under
// the glass panel; when ffmpeg is missing the card silently stays swatch-only.
// QR rendering uses the vendored MIT `qrcode-generator` (js/vendor/qrcode.js),
// loaded lazily the first time a card opens.

const SHARE_SITE_BASE = 'https://marcimastro98.github.io/Xenon/';
// v40-L holds ~2953 bytes; URL prefix + fragment overhead leaves plenty of
// headroom at 1200 — codes that fit stay comfortably scannable on a phone.
const QR_CODE_MAX_BYTES = 1200;

function pickQrTarget(opts) {
  const galleryId = opts && typeof opts.galleryId === 'string' ? opts.galleryId.trim() : '';
  const code = opts && typeof opts.code === 'string' ? opts.code : '';
  if (galleryId && /^[a-z0-9][a-z0-9_-]{0,60}$/.test(galleryId)) {
    return { type: 'gallery', url: SHARE_SITE_BASE + 'index.html#' + galleryId };
  }
  if (code && code.length <= QR_CODE_MAX_BYTES) {
    return { type: 'landing', url: SHARE_SITE_BASE + 'get/#code=' + code };
  }
  return null;
}

if (typeof window !== 'undefined') (function () {
  const t = (k, fb) => {
    const v = (typeof window.t === 'function') ? window.t(k) : k;
    return (v === k && fb != null) ? fb : v;
  };
  const el = makeEl; // shared DOM factory from utils.js

  const CARD_W = 1200;
  const CARD_H = 675;

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

  function themeColors() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    const hex = (v, fb) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : fb;
    return {
      accent: hex(hs.accent, '#1ed760'),
      background: hex(hs.background, '#070808'),
      text: hex(hs.text, '#f0f3f1'),
    };
  }

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

  // Compose the card. opts: { kind, name, author?, colors, qr (qrcode instance
  // or null), qrUrl, screenshot (HTMLImageElement or null) }
  function renderCard(canvas, opts) {
    const ctx = canvas.getContext('2d');
    const { accent, background, text } = opts.colors;
    canvas.width = CARD_W;
    canvas.height = CARD_H;

    // Backdrop: theme background (or the real screenshot, dimmed) + accent glow.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    if (opts.screenshot) {
      const img = opts.screenshot;
      const scale = Math.max(CARD_W / img.width, CARD_H / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      ctx.drawImage(img, (CARD_W - dw) / 2, (CARD_H - dh) / 2, dw, dh);
      ctx.fillStyle = 'rgba(0,0,0,0.52)';
      ctx.fillRect(0, 0, CARD_W, CARD_H);
    }
    let glow = ctx.createRadialGradient(CARD_W * 0.18, CARD_H * 0.1, 0, CARD_W * 0.18, CARD_H * 0.1, CARD_W * 0.7);
    glow.addColorStop(0, accent + '3d');
    glow.addColorStop(1, accent + '00');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    glow = ctx.createRadialGradient(CARD_W * 0.9, CARD_H * 0.95, 0, CARD_W * 0.9, CARD_H * 0.95, CARD_W * 0.55);
    glow.addColorStop(0, accent + '24');
    glow.addColorStop(1, accent + '00');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Glass panel (left 2/3).
    const px = 64, py = 96, pw = opts.qr ? 680 : CARD_W - px * 2, ph = CARD_H - py * 2;
    roundRect(ctx, px, py, pw, ph, 28);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Kind chip.
    const kindLabel = t('preset_kind_' + opts.kind, opts.kind).toUpperCase();
    ctx.font = '700 26px Inter, "Segoe UI", sans-serif';
    const chipW = ctx.measureText(kindLabel).width + 44;
    roundRect(ctx, px + 48, py + 52, chipW, 52, 26);
    ctx.fillStyle = accent + '29';
    ctx.fill();
    ctx.strokeStyle = accent + '73';
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.textBaseline = 'middle';
    ctx.fillText(kindLabel, px + 70, py + 80);

    // Name (wraps to two lines max).
    ctx.fillStyle = text;
    ctx.font = '800 72px Inter, "Segoe UI", sans-serif';
    const maxW = pw - 96;
    const words = String(opts.name || 'Xenon').split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const probe = line ? line + ' ' + w : w;
      if (ctx.measureText(probe).width > maxW && line) { lines.push(line); line = w; }
      else line = probe;
      if (lines.length === 2) break;
    }
    if (line && lines.length < 2) lines.push(line);
    lines.forEach((ln, i) => ctx.fillText(ln, px + 48, py + 190 + i * 84));

    // Author.
    if (opts.author) {
      ctx.font = '500 34px Inter, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.fillText(t('gallery_by', 'by') + ' ' + opts.author, px + 48, py + 190 + lines.length * 84 + 10);
    }

    // Theme swatches.
    const swY = py + ph - 92;
    [accent, background, text].forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(px + 72 + i * 66, swY, 22, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // Wordmark.
    ctx.font = '700 30px Inter, "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('✦ Xenon', px + 48 + 3 * 66 + 40, swY);

    // QR panel (right) or "code attached" caption.
    if (opts.qr) {
      const qx = CARD_W - 64 - 336, qy = (CARD_H - 336) / 2;
      roundRect(ctx, qx, qy, 336, 336, 24);
      ctx.fillStyle = '#f4f6f5';
      ctx.fill();
      drawQr(ctx, opts.qr, qx + 28, qy + 28, 280);
      ctx.font = '500 24px Inter, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.textAlign = 'center';
      ctx.fillText(t('sharecard_qr_hint', 'Scan to get this look'), qx + 168, qy + 336 + 36);
      ctx.textAlign = 'left';
    } else {
      ctx.font = '500 26px Inter, "Segoe UI", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(t('sharecard_code_attached', 'Import code attached alongside this card'), px + 48, py + ph + 44);
    }
    ctx.textBaseline = 'alphabetic';
  }

  async function fetchScreenshot() {
    const d = await apiJson('/api/screenshot');   // shared fetch-JSON helper from utils.js
    if (!d || !d.base64 || d.base64.length < 50) return null;
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = 'data:' + (d.mimeType || 'image/jpeg') + ';base64,' + d.base64;
      });
      return img;
    } catch { return null; }
  }

  function close() {
    const bd = document.querySelector('.sharecard-backdrop');
    if (bd) bd.remove();
  }

  // opts: { kind, name, code, galleryId?, author? }
  async function open(opts) {
    if (!opts || !opts.kind) return;
    close();
    const bd = el('div', 'preset-modal-overlay sharecard-backdrop');
    const modal = el('div', 'preset-modal sharecard-modal');
    const head = el('div', 'preset-modal-head');
    head.appendChild(el('h3', 'preset-modal-title', t('sharecard_title', 'Share card')));
    const x = el('button', 'preset-modal-close', '✕');
    x.type = 'button';
    x.addEventListener('click', close);
    head.appendChild(x);
    modal.appendChild(head);

    const canvas = document.createElement('canvas');
    canvas.className = 'sharecard-canvas';
    modal.appendChild(canvas);

    const target = pickQrTarget({ galleryId: opts.galleryId, code: opts.code });
    const state = { screenshot: null, qr: null };

    async function paint() {
      if (target && !state.qr) {
        try {
          const lib = await loadQrLib();
          const qr = lib(0, 'M');   // 0 = auto-pick the smallest type that fits
          qr.addData(target.url);
          qr.make();
          state.qr = qr;
        } catch { state.qr = null; }
      }
      renderCard(canvas, {
        kind: opts.kind,
        name: opts.name || 'Xenon',
        author: opts.author || '',
        colors: themeColors(),
        qr: state.qr,
        screenshot: state.screenshot,
      });
    }

    // "Use real screenshot" toggle — degrades silently when ffmpeg is absent.
    const shotRow = el('label', 'preset-check-row');
    const shotChk = document.createElement('input');
    shotChk.type = 'checkbox';
    shotChk.className = 'settings-check';
    const shotTxt = el('span', 'preset-check-name', t('sharecard_use_screenshot', 'Use a real screenshot as the backdrop'));
    shotRow.appendChild(shotChk); shotRow.appendChild(shotTxt);
    shotChk.addEventListener('change', async () => {
      if (shotChk.checked && !state.screenshot) {
        shotChk.disabled = true;
        state.screenshot = await fetchScreenshot();
        shotChk.disabled = false;
        if (!state.screenshot) {
          shotChk.checked = false;
          if (window.XenonToast) XenonToast.show({ type: 'info', title: t('sharecard_shot_fail', 'Screenshot not available'), message: t('sharecard_shot_fail_hint', 'Capture needs ffmpeg (installed by the one-click installer).') });
          return;
        }
      }
      if (!shotChk.checked) state.screenshot = null;
      paint();
    });
    modal.appendChild(shotRow);

    const row = el('div', 'preset-modal-actions');
    const dl = el('button', 'settings-btn primary', t('sharecard_download', 'Download PNG'));
    dl.type = 'button';
    dl.addEventListener('click', () => {
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'xenon-' + String(opts.kind) + '-card.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }, 'image/png');
    });
    row.appendChild(dl);
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
    modal.appendChild(row);

    bd.appendChild(modal);
    bd.addEventListener('click', (ev) => { if (ev.target === bd) close(); });
    document.body.appendChild(bd);
    paint();
  }

  window.ShareCard = { open, close, pickQrTarget };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pickQrTarget, QR_CODE_MAX_BYTES, SHARE_SITE_BASE };
}

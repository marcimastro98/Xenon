// The picture the Store draws for an entry that ships no screenshot, from the colours the server
// checked.
'use strict';

(() => {
  function catColors(entry) { const p = entry.preview || {}; return { a: p.accent || '#1ed760', b: p.bg || '#0a0f0d', t: p.text || '#e9f2ee' }; }

  function rgbaOf(c, al) { c = String(c || '#888').replace('#', ''); if (c.length === 3) c = c.split('').map((x) => x + x).join(''); if (c.length > 6) c = c.slice(0, 6); const n = parseInt(c, 16) || 0; return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (al == null ? 1 : al) + ')'; }

  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

  function drawPreview(canvas, entry) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 260, h = canvas.clientHeight || 146;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d'); if (!g) return; g.scale(dpr, dpr);
    const { a, b, t } = catColors(entry);
    g.fillStyle = b; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w * 0.72, -h * 0.1, 0, w * 0.72, -h * 0.1, w * 0.9);
    rg.addColorStop(0, rgbaOf(a, 0.2)); rg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = rg; g.fillRect(0, 0, w, h);
    const k = entry.kind;
    if (k === 'bg' || k === 'ambient') {
      for (let i = 0; i < 4; i++) { g.beginPath(); const y = h * (0.35 + i * 0.16); g.moveTo(0, y); for (let x = 0; x <= w; x += 12) g.lineTo(x, y + Math.sin(x * 0.03 + i * 1.3) * (10 - i * 1.5)); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = rgbaOf(a, 0.12 + i * 0.05); g.fill(); }
      if (k === 'ambient') { g.fillStyle = rgbaOf(t, 0.9); g.font = '700 ' + Math.round(h * 0.26) + 'px monospace'; g.textAlign = 'center'; g.fillText('21:48', w / 2, h * 0.54); }
    } else if (k === 'widget') {
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.26;
      g.lineWidth = r * 0.28; g.strokeStyle = rgbaOf(t, 0.14); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = a; g.lineCap = 'round'; g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.35); g.stroke();
      g.fillStyle = rgbaOf(t, 0.9); g.font = '800 ' + Math.round(r * 0.7) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('72', cx, cy + 1);
    } else if (k === 'deck') {
      const cols = 4, rows = 2, pad = w * 0.08, gap = w * 0.03, kw = (w - pad * 2 - gap * (cols - 1)) / cols, kh = kw * 0.86, oy = (h - (kh * rows + gap * (rows - 1))) / 2; let n = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const x = pad + c * (kw + gap), y = oy + r * (kh + gap), lit = (n % 3 === 0); rr(g, x, y, kw, kh, 6); g.fillStyle = lit ? rgbaOf(a, 0.9) : rgbaOf(t, 0.08); g.fill(); g.fillStyle = lit ? rgbaOf(b, 0.85) : rgbaOf(t, 0.5); g.beginPath(); g.arc(x + kw / 2, y + kh / 2, kw * 0.16, 0, Math.PI * 2); g.fill(); n++; }
    } else { // theme / page / bundle → mini dashboard
      const pad = w * 0.07;
      rr(g, pad, h * 0.1, w - pad * 2, h * 0.11, 5); g.fillStyle = rgbaOf(t, 0.08); g.fill();
      rr(g, pad + 6, h * 0.13, w * 0.16, h * 0.05, 3); g.fillStyle = a; g.fill();
      const areaY = h * 0.26, areaH = h * 0.62, gap = w * 0.03, colW = (w - pad * 2 - gap) / 2;
      rr(g, pad, areaY, colW, areaH, 6); g.fillStyle = rgbaOf(t, 0.06); g.fill();
      rr(g, pad + colW * 0.12, areaY + areaH * 0.5, colW * 0.5, h * 0.04, 3); g.fillStyle = rgbaOf(a, 0.8); g.fill();
      rr(g, pad + colW * 0.12, areaY + areaH * 0.66, colW * 0.7, h * 0.03, 3); g.fillStyle = rgbaOf(t, 0.2); g.fill();
      rr(g, pad + colW + gap, areaY, colW, areaH * 0.46, 6); g.fillStyle = rgbaOf(t, 0.06); g.fill();
      rr(g, pad + colW + gap, areaY + areaH * 0.54, colW, areaH * 0.46, 6); g.fillStyle = rgbaOf(a, 0.14); g.fill();
      rr(g, pad + colW + gap + colW * 0.1, areaY + areaH * 0.68, colW * 0.55, h * 0.035, 3); g.fillStyle = rgbaOf(a, 0.85); g.fill();
      if (k === 'bundle') { const ky = h * 0.8, kw = w * 0.1; for (let i = 0; i < 5; i++) { rr(g, pad + i * (kw + w * 0.02), ky, kw, h * 0.11, 4); g.fillStyle = i % 2 ? a : rgbaOf(t, 0.1); g.fill(); } }
    }
  }

  // One picture, always filled. The rest of the shots are on the entry's page.
  function previewCanvas(entry) {
    const cv = document.createElement('canvas'); cv._cgEntry = entry;
    requestAnimationFrame(() => drawPreview(cv, entry));
    return cv;
  }

  window.CommunityGalleryPreview = { drawPreview, previewCanvas };
})();

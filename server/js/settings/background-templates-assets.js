// The ready-made custom backgrounds, and the pictures a custom background may use.
'use strict';

// ── Code-defined animated background (Settings → Sfondo) ──────────────────────
// Starter snippets. Each defines draw(ctx, t, w, h): ctx = 2D context, t =
// seconds elapsed, w/h = viewport size in CSS px. They run inside the sandboxed
// iframe (js/custom-bg.js), never against the real page.
const BG_CUSTOM_TEMPLATES = Object.freeze({
  stars: [
    '// Drifting starfield',
    'const N = 120, stars = [];',
    'for (let i = 0; i < N; i++) stars.push({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() });',
    'function draw(ctx, t, w, h) {',
    '  ctx.clearRect(0, 0, w, h);',
    '  for (const s of stars) {',
    '    const y = (s.y + t * 0.02 * s.z) % 1;',
    '    ctx.globalAlpha = 0.3 + s.z * 0.7;',
    '    ctx.fillStyle = "#9fe8ff";',
    '    ctx.fillRect(s.x * w, y * h, s.z * 2, s.z * 2);',
    '  }',
    '  ctx.globalAlpha = 1;',
    '}',
  ].join('\n'),
  waves: [
    '// Flowing gradient waves',
    'function draw(ctx, t, w, h) {',
    '  const g = ctx.createLinearGradient(0, 0, w, h);',
    '  g.addColorStop(0, "#0b1020");',
    '  g.addColorStop(1, "#101a3a");',
    '  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);',
    '  ctx.strokeStyle = "rgba(120,180,255,0.35)"; ctx.lineWidth = 2;',
    '  for (let k = 0; k < 4; k++) {',
    '    ctx.beginPath();',
    '    for (let x = 0; x <= w; x += 12) {',
    '      const y = h * 0.5 + Math.sin(x * 0.008 + t + k) * (30 + k * 18);',
    '      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);',
    '    }',
    '    ctx.stroke();',
    '  }',
    '}',
  ].join('\n'),
  grid: [
    '// Pulsing neon dots',
    'function draw(ctx, t, w, h) {',
    '  ctx.clearRect(0, 0, w, h);',
    '  const step = 46;',
    '  for (let x = step / 2; x < w; x += step)',
    '    for (let y = step / 2; y < h; y += step) {',
    '      const p = 0.5 + 0.5 * Math.sin(t * 2 + (x + y) * 0.01);',
    '      ctx.fillStyle = "rgba(53,224,142," + (0.15 + p * 0.6) + ")";',
    '      ctx.beginPath(); ctx.arc(x, y, 1.5 + p * 2, 0, 7); ctx.fill();',
    '    }',
    '}',
  ].join('\n'),
  nebula: [
    '// Drifting nebula',
    'const blobs = [];',
    'for (let i = 0; i < 5; i++) blobs.push({ x: Math.random(), y: Math.random(), h: Math.random() * 360, r: 0.3 + Math.random() * 0.3 });',
    'function draw(ctx, t, w, h) {',
    '  ctx.fillStyle = "#05060f"; ctx.fillRect(0, 0, w, h);',
    '  ctx.globalCompositeOperation = "lighter";',
    '  for (const b of blobs) {',
    '    const x = (b.x + Math.sin(t * 0.05 + b.h) * 0.05) * w;',
    '    const y = (b.y + Math.cos(t * 0.04 + b.h) * 0.05) * h;',
    '    const rad = b.r * Math.min(w, h);',
    '    const hue = (b.h + t * 6) % 360;',
    '    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);',
    '    g.addColorStop(0, "hsla(" + hue + ",70%,55%,0.5)");',
    '    g.addColorStop(1, "hsla(" + hue + ",70%,55%,0)");',
    '    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);',
    '  }',
    '  ctx.globalCompositeOperation = "source-over";',
    '}',
  ].join('\n'),
  aurora: [
    '// Aurora bands',
    'function draw(ctx, t, w, h) {',
    '  ctx.fillStyle = "#03040a"; ctx.fillRect(0, 0, w, h);',
    '  ctx.globalCompositeOperation = "lighter";',
    '  for (let k = 0; k < 3; k++) {',
    '    ctx.beginPath(); ctx.moveTo(0, h);',
    '    for (let x = 0; x <= w; x += 16) {',
    '      const y = h * 0.5 + Math.sin(x * 0.004 + t * 0.6 + k * 1.7) * 80 + Math.sin(x * 0.011 + t) * 30 - k * 60;',
    '      ctx.lineTo(x, y);',
    '    }',
    '    ctx.lineTo(w, h); ctx.closePath();',
    '    const g = ctx.createLinearGradient(0, h * 0.2, 0, h);',
    '    g.addColorStop(0, "hsla(" + (120 + k * 60) + ",80%,60%,0.28)");',
    '    g.addColorStop(1, "hsla(" + (120 + k * 60) + ",80%,60%,0)");',
    '    ctx.fillStyle = g; ctx.fill();',
    '  }',
    '  ctx.globalCompositeOperation = "source-over";',
    '}',
  ].join('\n'),
  matrix: [
    '// Matrix rain',
    'let cols = []; const cw = 14;',
    'function draw(ctx, t, w, h) {',
    '  const n = Math.ceil(w / cw);',
    '  if (cols.length !== n) { cols = []; for (let i = 0; i < n; i++) cols[i] = Math.random() * h; }',
    '  ctx.fillStyle = "rgba(0,10,4,0.18)"; ctx.fillRect(0, 0, w, h);',
    '  ctx.fillStyle = "#39ff9c"; ctx.font = cw + "px monospace";',
    '  for (let i = 0; i < n; i++) {',
    '    ctx.fillText(String.fromCharCode(0x30a0 + Math.floor(Math.random() * 96)), i * cw, cols[i]);',
    '    cols[i] = cols[i] > h + Math.random() * 400 ? 0 : cols[i] + cw;',
    '  }',
    '}',
  ].join('\n'),
  confetti: [
    '// Falling confetti',
    'const bits = [];',
    'for (let i = 0; i < 80; i++) bits.push({ x: Math.random(), y: Math.random(), s: 4 + Math.random() * 6, v: 0.05 + Math.random() * 0.12, a: Math.random() * 6, h: Math.random() * 360 });',
    'function draw(ctx, t, w, h) {',
    '  ctx.clearRect(0, 0, w, h);',
    '  for (const b of bits) {',
    '    b.y = (b.y + b.v * 0.02) % 1.1;',
    '    const x = b.x * w + Math.sin(t + b.a) * 12;',
    '    ctx.save(); ctx.translate(x, b.y * h); ctx.rotate(t * 2 + b.a);',
    '    ctx.fillStyle = "hsl(" + b.h + ",80%,60%)";',
    '    ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.5);',
    '    ctx.restore();',
    '  }',
    '}',
  ].join('\n'),
  orbit: [
    '// Orbiting particles',
    'const dots = [];',
    'for (let i = 0; i < 60; i++) dots.push({ r: 0.1 + Math.random() * 0.5, a: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.6, sz: 1 + Math.random() * 2, h: Math.random() * 360 });',
    'function draw(ctx, t, w, h) {',
    '  ctx.fillStyle = "rgba(6,8,16,0.35)"; ctx.fillRect(0, 0, w, h);',
    '  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;',
    '  for (const d of dots) {',
    '    const ang = d.a + t * d.sp;',
    '    const x = cx + Math.cos(ang) * d.r * R;',
    '    const y = cy + Math.sin(ang) * d.r * R * 0.7;',
    '    ctx.fillStyle = "hsla(" + ((d.h + t * 10) % 360) + ",80%,65%,0.9)";',
    '    ctx.beginPath(); ctx.arc(x, y, d.sz, 0, 7); ctx.fill();',
    '  }',
    '}',
  ].join('\n'),
  plasma: [
    '// Plasma field',
    'function draw(ctx, t, w, h) {',
    '  const step = 28;',
    '  for (let x = 0; x < w; x += step)',
    '    for (let y = 0; y < h; y += step) {',
    '      const v = Math.sin(x * 0.01 + t) + Math.sin(y * 0.012 + t * 1.1) + Math.sin((x + y) * 0.008 + t * 0.7);',
    '      ctx.fillStyle = "hsl(" + (((v + 3) / 6 * 120 + 200) % 360) + ",70%,55%)";',
    '      ctx.fillRect(x, y, step, step);',
    '    }',
    '}',
  ].join('\n'),
});

// ── Bundled background images (assets) ────────────────────────────────────────
// Pictures the draw() code can paint (assets.name → drawImage). Stored as data:
// URIs INSIDE bgCustom, so they persist, travel with a shared background code
// and never require the sandbox to touch the network. Caps live in
// normalizeBgAssets; here we pre-check to give a friendly toast instead of a
// silent drop.

// Derive a JS-safe asset key from a filename: "Pixel City 2.png" → "pixel_city_2".
function bgAssetKeyFromFilename(filename, taken) {
  let base = String(filename || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (!/^[a-z]/.test(base)) base = ('img_' + base).slice(0, 24);
  if (!base) base = 'img';
  let key = base, n = 2;
  while (taken.includes(key)) key = (base.slice(0, 21) + '_' + n++);
  return key;
}

// Read the picked file(s) and add each as an asset (input.files → data URIs).
// Every rejection surfaces a toast — the pre-checks mirror EXACTLY what the
// sanitizer enforces (same CustomBg caps + data-URI shape), so nothing the user
// added here can be silently dropped by normalization later.
async function addBgAssetFiles(input) {
  const files = input && input.files ? Array.from(input.files) : [];
  if (input) input.value = '';   // allow re-picking the same file
  if (!files.length || !window.CustomBg) return;
  const current = normalizeBgCustom(hubSettings.bgCustom);
  const assets = { ...current.assets };
  let count = Object.keys(assets).length;
  let total = Object.values(assets).reduce((sum, v) => sum + v.length, 0);
  let added = 0;
  const warn = (titleKey, message) => {
    if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t(titleKey), message: message || '' });
  };
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      warn('settings_bg_asset_invalid', file.name);
      continue;
    }
    if (count >= CustomBg.ASSET_MAX_COUNT) {
      warn('settings_bg_assets_full');
      break;
    }
    const uri = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    // Empty/corrupt reads produce a URI the sanitizer would drop — reject them
    // HERE with a message instead of letting them vanish on normalize.
    if (!uri || !CustomBg.ASSET_DATA_RE.test(uri)) {
      warn('settings_bg_asset_invalid', file.name);
      continue;
    }
    if (uri.length > CustomBg.ASSET_MAX_CHARS || total + uri.length > CustomBg.ASSETS_TOTAL_MAX) {
      warn('settings_bg_asset_too_big', file.name);
      continue;
    }
    assets[bgAssetKeyFromFilename(file.name, Object.keys(assets))] = uri;
    count++; total += uri.length;
    added++;
  }
  if (added) updateBgCustom('assets', assets);
}

function removeBgAsset(key) {
  const current = normalizeBgCustom(hubSettings.bgCustom);
  if (!(key in current.assets)) return;
  const assets = { ...current.assets };
  delete assets[key];
  updateBgCustom('assets', assets);
}

// Render the asset chips (thumbnail + name + size + remove) under the editor.
// Data URIs are trusted here only as <img src> — the key is textContent.
// syncBgFxControls calls this on every settings sync (slider ticks included),
// so an identical asset set must cost nothing: skip when the signature matches.
let bgAssetChipsSig = null;
function renderBgAssetChips() {
  const wrap = $('settings-bgcode-assets');
  if (!wrap) return;
  const cb = normalizeBgCustom(hubSettings.bgCustom);
  const keys = Object.keys(cb.assets);
  const sig = keys.map((k) => k + ':' + cb.assets[k].length).join('|');
  if (sig === bgAssetChipsSig && wrap.childElementCount === keys.length) return;
  bgAssetChipsSig = sig;
  wrap.replaceChildren();
  wrap.hidden = !keys.length;
  keys.forEach((key) => {
    const chip = document.createElement('span');
    chip.className = 'settings-bgasset-chip';
    const img = document.createElement('img');
    img.className = 'settings-bgasset-thumb';
    img.alt = '';
    img.src = cb.assets[key];
    const label = document.createElement('span');
    label.className = 'settings-bgasset-name';
    label.textContent = 'assets.' + key;
    const size = document.createElement('span');
    size.className = 'settings-bgasset-size';
    size.textContent = Math.max(1, Math.round(cb.assets[key].length * 3 / 4 / 1024)) + ' KB';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'settings-bgasset-del';
    del.setAttribute('aria-label', t('settings_bg_asset_remove'));
    del.textContent = '×';
    del.addEventListener('click', () => removeBgAsset(key));
    chip.appendChild(img); chip.appendChild(label); chip.appendChild(size); chip.appendChild(del);
    wrap.appendChild(chip);
  });
}

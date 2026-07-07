'use strict';
// Lighting control tile: drives the whole RGB system (the iCUE bridge plus every
// external provider — WLED, Hue, Nanoleaf, OpenRGB, Yeelight, Home Assistant
// lights, Razer Chroma) the same way Settings → Illuminazione does, but as a
// glanceable dashboard tile. Its signature is a live luminous hero that takes on
// the currently-active colour and breathes only while a dynamic effect is running
// (that infinite keyframe is auto-frozen by ambient-idle.js when nobody's looking,
// so an idle tile costs nothing). Seeds from GET /api/lighting/status and writes
// through the same REST endpoints the settings page uses (/effects, /manual,
// /animation, /device-mode). Renders into .lighting-widget-mount.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;          // shared DOM factory from utils.js
  const api = apiJson;        // shared fetch-JSON helper from utils.js

  // Ambient effect styles (mirrors lighting.js ANIM_STYLES) and the per-device
  // modes (DEVICE_MODES). Labels reuse the shared deck_opt_* strings.
  const STYLES = ['none', 'solid', 'breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'];
  const DYNAMIC = new Set(['breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette']);
  const MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off'];
  // A small curated swatch row for one-tap colours; the picker covers the rest.
  const SWATCHES = ['#ff2b3b', '#ff7a1a', '#ffd23f', '#1ed760', '#19d3da', '#2b6cff', '#7c5cff', '#ffffff'];

  // Only tiles actually placed on a dashboard page (a hidden/never-added widget
  // sits in #widget-pool, outside any .pager-page).
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="lighting"]')).filter(x => x.closest('.pager-page')); }

  const st = { available: null, connected: false, enabled: false, manualColor: '', animation: { style: 'none', color: '#1ed760', palette: [] }, devices: [] };
  let seeded = false;
  let seedInflight = null;
  let lastFetch = 0;
  const REFRESH_MS = 2500;    // re-seed at most this often when the tile re-renders

  // hex "#rrggbb" → "r, g, b" for rgba(); invalid → null.
  function rgbTriple(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    return `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}`;
  }

  // The colour the rig is actually showing right now, in priority order: a manual
  // override wins; else the ambient animation's colour when one is set; else the
  // dashboard accent. Used to tint the hero.
  function activeColor() {
    if (st.manualColor) return st.manualColor;
    const a = st.animation || {};
    if (a.style && a.style !== 'none') {
      if (a.style === 'palette' && Array.isArray(a.palette) && a.palette[0]) return a.palette[0];
      if (a.color) return a.color;
    }
    return '';   // '' → fall back to the CSS accent in paint()
  }

  function post(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  // ── writes ───────────────────────────────────────────────────────────────
  function togglePower() {
    const next = !st.enabled;
    st.enabled = next;                                   // optimistic
    paint();
    post('/api/lighting/effects', { enabled: next }).then(d => { absorb(d); paint(); });
  }
  function setColor(hex) {
    st.manualColor = hex;                                // optimistic (override is top layer)
    paint();
    post('/api/lighting/manual', { color: hex });        // returns {ok} only
  }
  function clearColor() {
    st.manualColor = '';
    paint();
    post('/api/lighting/manual', { clear: true });
  }
  function setStyle(style) {
    st.animation = { ...(st.animation || {}), style };   // optimistic
    paint();
    post('/api/lighting/animation', { style }).then(d => { absorb(d); paint(); });
  }
  function setDeviceMode(id, mode) {
    const dev = st.devices.find(x => x.id === id);
    if (dev) dev.mode = mode;                             // optimistic
    paint();
    post('/api/lighting/device-mode', { id, mode }).then(d => { if (d && d.status) { absorb(d.status); paint(); } });
  }

  // ── skeleton ─────────────────────────────────────────────────────────────
  function ensureSkeleton(mount) {
    if (mount.dataset.lgtBuilt === '1' && mount.firstChild) return;
    mount.dataset.lgtBuilt = '1';
    const wrap = el('div', 'lgt-wrap');

    // Header: title + master power switch.
    const head = el('div', 'lgt-head');
    head.appendChild(el('span', 'lgt-logo', t('layout_widget_lighting', 'Lighting')));
    const power = el('button', 'lgt-power'); power.type = 'button'; power.dataset.role = 'power';
    power.setAttribute('role', 'switch');
    power.append(el('span', 'lgt-power-track'), el('span', 'lgt-power-txt'));
    power.addEventListener('click', togglePower);
    head.appendChild(power);
    wrap.appendChild(head);

    const empty = el('div', 'lgt-empty'); empty.dataset.role = 'empty'; empty.hidden = true;
    wrap.appendChild(empty);

    const body = el('div', 'lgt-body'); body.dataset.role = 'body';

    // Hero: the live luminous field.
    const hero = el('div', 'lgt-hero'); hero.dataset.role = 'hero';
    hero.append(el('span', 'lgt-hero-glow'), el('span', 'lgt-hero-fx'));
    body.appendChild(hero);

    // Colour row: quick swatches + native picker + auto.
    const colors = el('div', 'lgt-colors');
    SWATCHES.forEach(c => {
      const s = el('button', 'lgt-sw'); s.type = 'button'; s.dataset.color = c;
      s.style.setProperty('--sw', c); s.title = c;
      s.addEventListener('click', () => setColor(c));
      colors.appendChild(s);
    });
    const pick = document.createElement('input');
    pick.type = 'color'; pick.className = 'lgt-pick'; pick.value = '#7c5cff';
    pick.addEventListener('input', () => setColor(pick.value));
    colors.appendChild(pick);
    const auto = el('button', 'lgt-auto', t('lgt_auto', 'Auto')); auto.type = 'button';
    auto.addEventListener('click', clearColor);
    colors.appendChild(auto);
    body.appendChild(colors);

    // Effect chips.
    const fx = el('div', 'lgt-fx'); fx.dataset.role = 'fx';
    STYLES.forEach(style => {
      const chip = el('button', 'lgt-chip', t('deck_opt_' + style, style)); chip.type = 'button';
      chip.dataset.style = style;
      chip.addEventListener('click', () => setStyle(style));
      fx.appendChild(chip);
    });
    body.appendChild(fx);

    // Per-device list (only shown when devices exist).
    const devWrap = el('div', 'lgt-devices'); devWrap.dataset.role = 'devices';
    devWrap.append(el('div', 'lgt-devices-h', t('lgt_devices', 'Devices')), el('div', 'lgt-dev-list'));
    body.appendChild(devWrap);

    wrap.appendChild(body);
    mount.replaceChildren(wrap);
  }

  // ── paint ────────────────────────────────────────────────────────────────
  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.lighting-widget-mount');
      if (!mount) return;
      ensureSkeleton(mount);
      const wrap = mount.querySelector('.lgt-wrap');

      const msg = emptyMessage();
      const empty = wrap.querySelector('[data-role="empty"]');
      const body = wrap.querySelector('[data-role="body"]');
      const power = wrap.querySelector('[data-role="power"]');
      if (msg) {
        empty.hidden = false; empty.textContent = msg; body.hidden = true; power.hidden = true;
        return;
      }
      empty.hidden = true; body.hidden = false; power.hidden = false;

      // Master switch.
      power.classList.toggle('is-on', !!st.enabled);
      power.setAttribute('aria-checked', String(!!st.enabled));
      const pTxt = power.querySelector('.lgt-power-txt');
      if (pTxt) pTxt.textContent = st.enabled ? t('lgt_on', 'On') : t('lgt_off', 'Off');

      paintHero(wrap);
      paintChips(wrap);
      paintDevices(wrap);
    });
  }

  function emptyMessage() {
    // Show the controls whenever there's a usable lighting system (the iCUE bridge
    // is available OR at least one external provider device exists). Only a truly
    // empty rig gets the setup hint.
    const hasDevices = (st.devices && st.devices.length);
    if (st.available === false && !hasDevices) return t('lgt_empty', 'Set up lighting in Settings → Illuminazione');
    return '';
  }

  function paintHero(wrap) {
    const hero = wrap.querySelector('[data-role="hero"]');
    if (!hero) return;
    const c = activeColor();
    const rgb = rgbTriple(c);
    if (rgb) hero.style.setProperty('--lgt-rgb', rgb);
    else hero.style.removeProperty('--lgt-rgb');         // → CSS falls back to --accent-rgb
    const style = (st.animation && st.animation.style) || 'none';
    hero.classList.toggle('is-off', !st.enabled);
    hero.classList.toggle('is-dynamic', st.enabled && DYNAMIC.has(style));
    const fx = hero.querySelector('.lgt-hero-fx');
    if (fx) fx.textContent = t('deck_opt_' + style, style);
  }

  function paintChips(wrap) {
    const cur = (st.animation && st.animation.style) || 'none';
    wrap.querySelectorAll('.lgt-chip').forEach(chip => chip.classList.toggle('is-active', chip.dataset.style === cur));
    // Selected swatch highlight.
    wrap.querySelectorAll('.lgt-sw').forEach(sw => sw.classList.toggle('is-active', st.manualColor && sw.dataset.color.toLowerCase() === st.manualColor.toLowerCase()));
  }

  function paintDevices(wrap) {
    const box = wrap.querySelector('[data-role="devices"]');
    const list = wrap.querySelector('.lgt-dev-list');
    if (!box || !list) return;
    const devs = st.devices || [];
    box.hidden = !devs.length;
    if (!devs.length) { list.replaceChildren(); return; }

    const key = devs.map(d => d.id).join('|');
    if (key !== list.dataset.lgtKey || !list.querySelector('.lgt-dev')) {
      list.dataset.lgtKey = key;
      const frag = document.createDocumentFragment();
      devs.forEach(d => frag.appendChild(buildDeviceRow(d)));
      list.replaceChildren(frag);
    }
    devs.forEach(d => {
      const row = list.querySelector(`.lgt-dev[data-id="${cssEsc(d.id)}"]`);
      if (!row) return;
      const sel = row.querySelector('.lgt-mode');
      if (sel && sel.value !== (d.mode || 'follow')) sel.value = d.mode || 'follow';
      const dot = row.querySelector('.lgt-dev-dot');
      if (dot) {
        const rgb = rgbTriple(d.modeColor || activeColor());
        if (rgb) dot.style.setProperty('--lgt-rgb', rgb); else dot.style.removeProperty('--lgt-rgb');
      }
    });
  }

  function buildDeviceRow(d) {
    const row = el('div', 'lgt-dev'); row.dataset.id = d.id;
    row.appendChild(el('span', 'lgt-dev-dot'));
    row.appendChild(el('span', 'lgt-dev-name', d.name || d.id));
    const sel = document.createElement('select'); sel.className = 'lgt-mode';
    MODES.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = t('deck_opt_' + m, m); sel.appendChild(o); });
    sel.value = d.mode || 'follow';
    sel.addEventListener('change', () => setDeviceMode(d.id, sel.value));
    row.appendChild(sel);
    return row;
  }

  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  // ── data flow ────────────────────────────────────────────────────────────
  // Flatten getStatus() into the widget's shape: iCUE devices + every external
  // provider's devices, each carrying its current per-device mode.
  function absorb(d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.available === 'boolean') st.available = d.available;
    if (typeof d.connected === 'boolean') st.connected = d.connected;
    if (typeof d.enabled === 'boolean') st.enabled = d.enabled;
    if (typeof d.manualColor === 'string') st.manualColor = d.manualColor;
    if (d.animation && typeof d.animation === 'object') st.animation = { style: d.animation.style || 'none', color: d.animation.color || '#1ed760', palette: Array.isArray(d.animation.palette) ? d.animation.palette : [] };
    if (Array.isArray(d.devices) || Array.isArray(d.providers)) {
      const out = [];
      (d.devices || []).forEach(dv => out.push({ id: dv.id, name: dv.name || dv.id, mode: dv.mode || 'follow', modeColor: dv.modeColor || '' }));
      (d.providers || []).forEach(p => (p.devices || []).forEach(dv => out.push({ id: dv.id, name: (p.name ? p.name + ' · ' : '') + (dv.name || dv.id), mode: dv.mode || 'follow', modeColor: dv.modeColor || '' })));
      st.devices = out;
    }
  }

  function loadState() {
    if (seedInflight) return seedInflight;
    lastFetch = Date.now();
    seedInflight = api('/api/lighting/status').then(d => { absorb(d); seeded = true; })
      .catch(() => {}).finally(() => { seedInflight = null; });
    return seedInflight;
  }

  function renderWidgets() {
    if (!tiles().length) return;
    paint();                                 // instant paint from cache
    if (!seeded) { loadState().then(paint); return; }
    // Re-showing the tile (or a periodic layout apply) refreshes state, throttled
    // so layout thrash can't spam the endpoint — no background polling loop.
    if (Date.now() - lastFetch > REFRESH_MS) loadState().then(paint);
  }

  window.LightingWidget = { renderWidgets };
})();

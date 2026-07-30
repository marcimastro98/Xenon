'use strict';
// Elgato Wave Link mixer widget — one control surface for both Wave Link 2 and
// Wave Link 3. It renders the normalised model the server publishes (see
// server/actions/wavelink.js): channels, each carrying its levels PER MIX, plus
// the mixes themselves, the effect chain and the physical output.
//
// The mix tabs are the user's OWN mixes on Wave Link 3 (Personal, Stream, Chat,
// or whatever they named them, any number of them) and the two built-in ones on
// Wave Link 2. That is the whole reason the model is mix-shaped: the old widget
// had a hardcoded Stream|Local pair, which on a 3.x mixer would show two tabs
// for a rig that has three and silently omit the third.
//
// Live stereo level meters ride the same SSE frame (3.x only — 2.x has no meter
// API). They are a TRANSITION driven by data, so per the freeze invariant they
// are gated off in CSS whenever the dashboard is frozen, idle, in game mode or
// on the low-power GPU path; a meter that keeps animating under a frosted
// overlay is exactly the always-on motion that costs frames on the Edge.
//
// Fader/mute moves go through the allowlisted /actions/run dispatcher, so the
// widget has no privileges the Deck does not.
(function () {
  const ICONS = {
    on:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg>',
    off:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9v-3a3 3 0 0 1 6 0v5M6 11a6 6 0 0 0 9.3 5M12 17v4M4 4l16 16"/></svg>',
    out:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
    outOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
    swap:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8"/></svg>',
    speaker:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13"/></svg>',
  };

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;          // shared DOM factory from utils.js
  const api = apiJson;        // shared fetch-JSON helper from utils.js

  // Only tiles actually placed on a dashboard page count (a hidden/never-added
  // widget sits in #widget-pool, outside any .pager-page).
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="wavelink"]')).filter(x => x.closest('.pager-page')); }

  const st = {
    enabled: null, connected: false, dialect: 0, version: '',
    channels: [], mixes: [], outputs: { mainId: '', devices: [] }, monitor: null,
    capabilities: {},
  };
  let activeMix = '';         // client-only: which mix the faders edit
  let seeded = false;
  let seedInflight = null;

  // Fader drag guard — Wave Link echoes our own write straight back, so an SSE
  // frame must not snap a slider back mid-drag. Keyed by "scope:id:mix".
  let dragKey = '';
  let dragClearTimer = null;
  const sendTimers = new Map();
  const sendLast = new Map();
  const THROTTLE_MS = 110;

  function dispatch(action) {
    api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) }).catch(() => {});
  }

  // Throttled absolute-volume send with a trailing flush so the resting value lands.
  function sendVolume(action, key) {
    const now = Date.now();
    const last = sendLast.get(key) || 0;
    const fire = () => { sendLast.set(key, Date.now()); dispatch(action); };
    const pending = sendTimers.get(key);
    if (pending) { clearTimeout(pending); sendTimers.delete(key); }
    if (now - last >= THROTTLE_MS) fire();
    else sendTimers.set(key, setTimeout(() => { sendTimers.delete(key); fire(); }, THROTTLE_MS - (now - last)));
  }

  function markDragging(key) {
    dragKey = key;
    if (dragClearTimer) clearTimeout(dragClearTimer);
    dragClearTimer = setTimeout(() => { dragKey = ''; dragClearTimer = null; }, 350);
  }

  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  // Which mix is on screen. Falls back to the second mix (historically "stream")
  // and then the first, so a rig with one mix still shows it.
  function currentMix() {
    const list = st.mixes || [];
    if (!list.length) return null;
    const found = list.find((m) => m.id === activeMix);
    if (found) return found;
    return list[1] || list[0];
  }

  function levelIn(ch, mixId) {
    const m = (ch.mixes || []).find((x) => x.id === mixId);
    return m || null;
  }

  // ── skeleton ───────────────────────────────────────────────────────────────
  function ensureSkeleton(mount) {
    if (mount.dataset.wlBuilt === '2' && mount.firstChild) return;
    mount.dataset.wlBuilt = '2';
    const wrap = el('div', 'wl-wrap');

    const head = el('div', 'wl-head');
    head.appendChild(el('span', 'wl-logo', 'Wave Link'));
    head.appendChild(el('span', 'wl-badge')).dataset.role = 'badge';
    const seg = el('div', 'wl-seg'); seg.dataset.role = 'seg';
    head.appendChild(seg);
    wrap.appendChild(head);

    const empty = el('div', 'wl-empty'); empty.dataset.role = 'empty'; empty.hidden = true;
    wrap.appendChild(empty);

    const body = el('div', 'wl-body'); body.dataset.role = 'body';
    body.appendChild(el('div', 'wl-list'));                 // channel strips

    // The master of whichever mix is selected. On 2.x this is the output mixer.
    const outRow = el('div', 'wl-row wl-row--out'); outRow.dataset.role = 'out';
    const outMute = el('button', 'wl-mute'); outMute.type = 'button';
    outMute.addEventListener('click', () => {
      const mix = currentMix(); if (!mix) return;
      dispatch({ type: 'wlMixMute', mixId: mix.id });
    });
    const outBody = el('div', 'wl-body-col');
    const outName = el('span', 'wl-name'); outName.dataset.role = 'out-name';
    outBody.appendChild(outName);
    const outSlider = document.createElement('input');
    outSlider.type = 'range'; outSlider.min = '0'; outSlider.max = '100'; outSlider.step = '1'; outSlider.className = 'wl-slider';
    const onOut = () => {
      const mix = currentMix(); if (!mix) return;
      const k = 'mix:' + mix.id; markDragging(k);
      const v = Number(outSlider.value); setPct(outRow, v);
      sendVolume({ type: 'wlMixVolume', mixId: mix.id, value: v }, k);
    };
    outSlider.addEventListener('input', onOut); outSlider.addEventListener('change', onOut);
    outBody.appendChild(outSlider);
    outRow.append(outMute, outBody, el('span', 'wl-pct'));
    body.appendChild(outRow);

    // Wave Link 2 only: the monitor A/B switch. Hidden entirely on 3.x, where
    // the mixes ARE the monitoring model and there is nothing to flip.
    const monBtn = el('button', 'wl-monitor'); monBtn.type = 'button'; monBtn.dataset.role = 'monitor';
    monBtn.innerHTML = ICONS.swap; monBtn.append(el('span', 'wl-monitor-lbl'));
    monBtn.addEventListener('click', () => dispatch({ type: 'wlSwitchMonitoring' }));
    body.appendChild(monBtn);

    // Wave Link 3 only: where the main mix physically comes out.
    const outSel = el('div', 'wl-outdev'); outSel.dataset.role = 'outdev'; outSel.hidden = true;
    body.appendChild(outSel);

    wrap.appendChild(body);
    mount.replaceChildren(wrap);
  }

  function setPct(row, v) { const p = row.querySelector('.wl-pct'); if (p) p.textContent = `${Math.round(v)}%`; }

  // ── paint ────────────────────────────────────────────────────────────────
  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.wavelink-widget-mount');
      if (!mount) return;
      ensureSkeleton(mount);
      const wrap = mount.querySelector('.wl-wrap');

      const badge = wrap.querySelector('[data-role="badge"]');
      if (badge) {
        // Say which Wave Link is on the other end. Two protocols wear this name
        // and the controls on offer differ, so naming it is the difference
        // between "why is there no meter" and "ah, Wave Link 2".
        badge.textContent = st.dialect === 3 ? '3' : st.dialect === 2 ? '2' : '';
        badge.hidden = !st.dialect;
        badge.title = st.version || '';
      }

      const empty = wrap.querySelector('[data-role="empty"]');
      const body = wrap.querySelector('[data-role="body"]');
      const msg = emptyMessage();
      if (msg) {
        empty.hidden = false; empty.textContent = msg; body.hidden = true;
        wrap.classList.add('wl-disconnected');
        return;
      }
      empty.hidden = true; body.hidden = false; wrap.classList.remove('wl-disconnected');

      paintTabs(wrap);
      paintChannels(wrap);
      paintMaster(wrap);
      paintMonitor(wrap);
      paintOutputDevices(wrap);
    });
  }

  function emptyMessage() {
    if (st.enabled === false) return t('wl_offline', 'Enable Wave Link in Settings → Streaming');
    if (st.enabled !== null && !st.connected) return t('wl_not_running', 'Wave Link app not running');
    if (st.connected && (!st.channels || !st.channels.length)) return t('wl_no_channels', 'No Wave Link channels');
    if (st.connected && (!st.mixes || !st.mixes.length)) return t('wl_no_mixes', 'No Wave Link mixes');
    return '';
  }

  // The mix tabs ARE the user's mixes. Rebuilt only when the set changes, so a
  // level update never destroys the button someone is about to press.
  function paintTabs(wrap) {
    const seg = wrap.querySelector('[data-role="seg"]');
    if (!seg) return;
    const list = st.mixes || [];
    const key = list.map((m) => m.id + ':' + m.name).join('|');
    if (seg.dataset.wlKey !== key) {
      seg.dataset.wlKey = key;
      const frag = document.createDocumentFragment();
      list.forEach((m) => {
        const b = el('button', 'wl-seg-btn', m.name);
        b.type = 'button'; b.dataset.mixId = m.id; b.title = m.name;
        b.addEventListener('click', () => { if (activeMix !== m.id) { activeMix = m.id; paint(); } });
        frag.appendChild(b);
      });
      seg.replaceChildren(frag);
    }
    const cur = currentMix();
    seg.querySelectorAll('.wl-seg-btn').forEach((b) => b.classList.toggle('is-active', !!cur && b.dataset.mixId === cur.id));
  }

  function paintChannels(wrap) {
    const list = wrap.querySelector('.wl-list');
    if (!list) return;
    const chans = st.channels || [];
    const mix = currentMix();
    const key = chans.map(c => c.id + ':' + (c.effects || []).length).join('|');
    if (key !== list.dataset.wlKey || !list.querySelector('.wl-row')) {
      list.dataset.wlKey = key;
      const frag = document.createDocumentFragment();
      chans.forEach(ch => frag.appendChild(buildChannelRow(ch)));
      list.replaceChildren(frag);
    }
    chans.forEach(ch => {
      const row = list.querySelector(`.wl-row[data-ch-id="${cssEsc(ch.id)}"]`);
      if (!row) return;
      const inMix = mix ? levelIn(ch, mix.id) : null;
      // A channel that is not routed into the selected mix has no fader to
      // show. Saying so beats a dead slider at zero, which reads as broken.
      row.classList.toggle('is-unrouted', !inMix);
      const key2 = 'in:' + ch.id + ':' + (mix ? mix.id : '');
      applyRow(row, key2, inMix ? inMix.muted : false, inMix ? inMix.level : 0, ch.name, ch.available === false);
      paintMeter(row, ch.meter);
      paintEffects(row, ch);
    });
  }

  function buildChannelRow(ch) {
    const row = el('div', 'wl-row'); row.dataset.chId = ch.id;
    const mute = el('button', 'wl-mute'); mute.type = 'button';
    mute.addEventListener('click', () => {
      const mix = currentMix(); if (!mix) return;
      dispatch({ type: 'wlInputMute', mixId: ch.id, mix: mix.id });
    });
    const bodyCol = el('div', 'wl-body-col');

    const nameRow = el('div', 'wl-name-row');
    if (ch.hasIcon) {
      // Wave Link 3 ships a PNG per channel. It is fetched by URL rather than
      // carried in the SSE frame, which fires on every fader move.
      // NOT loading="lazy": the strip is built while its tile can still be off
      // screen (in the widget pool, or on a parked pager page), and a lazy image
      // created there never starts loading and never retries once it is shown —
      // measured, the icon simply never appeared. These are ~900-byte PNGs, a
      // handful at most, so deferring them buys nothing and costs correctness.
      const img = document.createElement('img');
      img.className = 'wl-icon'; img.alt = ''; img.decoding = 'async';
      img.src = '/api/wavelink/icon?id=' + encodeURIComponent(ch.id);
      img.addEventListener('error', () => img.remove());
      nameRow.appendChild(img);
    }
    nameRow.appendChild(el('span', 'wl-name', ch.name));
    bodyCol.appendChild(nameRow);

    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.className = 'wl-slider';
    const onInput = () => {
      const mix = currentMix(); if (!mix) return;
      const k = 'in:' + ch.id + ':' + mix.id; markDragging(k);
      const v = Number(slider.value); setPct(row, v);
      sendVolume({ type: 'wlInputVolume', mixId: ch.id, mix: mix.id, value: v }, k);
    };
    slider.addEventListener('input', onInput); slider.addEventListener('change', onInput);
    bodyCol.appendChild(slider);

    // Stereo meter, painted under the fader. Two bars so a dead channel on one
    // side is visible rather than averaged away.
    const meter = el('div', 'wl-meter'); meter.dataset.role = 'meter'; meter.hidden = true;
    meter.append(el('i', 'wl-meter-l'), el('i', 'wl-meter-r'));
    bodyCol.appendChild(meter);

    const fx = el('div', 'wl-fx'); fx.dataset.role = 'fx'; fx.hidden = true;
    bodyCol.appendChild(fx);

    row.append(mute, bodyCol, el('span', 'wl-pct'));
    return row;
  }

  // Shared update path for a strip (mute icon + fader + pct), leaving the
  // actively-dragged fader untouched so it never fights the echo.
  function applyRow(row, key, muted, vol, name, unavailable) {
    row.classList.toggle('is-muted', !!muted);
    row.classList.toggle('is-unavailable', !!unavailable);
    const btn = row.querySelector('.wl-mute');
    if (btn) btn.innerHTML = muted ? ICONS.off : ICONS.on;
    if (name != null) { const n = row.querySelector('.wl-name'); if (n && n.textContent !== name) n.textContent = name; }
    const v = Number.isFinite(vol) ? vol : 0;
    const slider = row.querySelector('.wl-slider');
    if (slider && key !== dragKey) slider.value = String(v);
    setPct(row, (key === dragKey && slider) ? Number(slider.value) : v);
  }

  // A meter is two custom properties, not two style writes per frame: the bar
  // widths are a CSS transform driven by --l/--r, so the browser interpolates
  // and the JS touches one element.
  function paintMeter(row, meter) {
    const box = row.querySelector('[data-role="meter"]');
    if (!box) return;
    if (!meter || !st.capabilities.meters) { box.hidden = true; return; }
    box.hidden = false;
    box.style.setProperty('--l', String(Math.max(0, Math.min(100, meter[0] || 0))) + '%');
    box.style.setProperty('--r', String(Math.max(0, Math.min(100, meter[1] || 0))) + '%');
  }

  function paintEffects(row, ch) {
    const box = row.querySelector('[data-role="fx"]');
    if (!box) return;
    const effects = (st.capabilities.effects && Array.isArray(ch.effects)) ? ch.effects : [];
    if (!effects.length) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    const key = effects.map((e) => e.id).join('|');
    if (box.dataset.wlKey !== key) {
      box.dataset.wlKey = key;
      const frag = document.createDocumentFragment();
      effects.forEach((e) => {
        const b = el('button', 'wl-fx-pill', e.name);
        b.type = 'button'; b.dataset.fxId = e.id; b.title = e.name;
        b.addEventListener('click', () => dispatch({ type: 'wlEffect', mixId: ch.id, effectId: e.id, mode: 'toggle' }));
        frag.appendChild(b);
      });
      box.replaceChildren(frag);
    }
    effects.forEach((e) => {
      const b = box.querySelector(`.wl-fx-pill[data-fx-id="${cssEsc(e.id)}"]`);
      if (b) b.classList.toggle('is-on', !!e.enabled);
    });
  }

  function paintMaster(wrap) {
    const row = wrap.querySelector('[data-role="out"]');
    if (!row) return;
    const mix = currentMix();
    if (!mix) { row.hidden = true; return; }
    row.hidden = false;
    const nameEl = row.querySelector('[data-role="out-name"]');
    const label = t('wl_mix_master', 'Mix level');
    if (nameEl && nameEl.textContent !== label) nameEl.textContent = label;
    const btn = row.querySelector('.wl-mute');
    row.classList.toggle('is-muted', !!mix.muted);
    if (btn) btn.innerHTML = mix.muted ? ICONS.outOff : ICONS.out;
    const slider = row.querySelector('.wl-slider');
    const key = 'mix:' + mix.id;
    const v = Number.isFinite(mix.level) ? mix.level : 0;
    if (slider && key !== dragKey) slider.value = String(v);
    setPct(row, (key === dragKey && slider) ? Number(slider.value) : v);
  }

  function paintMonitor(wrap) {
    const btn = wrap.querySelector('[data-role="monitor"]');
    if (!btn) return;
    // 3.x has no monitor switch — hide the control rather than offer a button
    // that always answers "unsupported".
    if (!st.capabilities.monitorSwitch) { btn.hidden = true; return; }
    btn.hidden = false;
    const lbl = btn.querySelector('.wl-monitor-lbl');
    const monitoring = (st.monitor && st.monitor.switchState) || '—';
    if (lbl) lbl.textContent = `${t('wl_monitoring', 'Monitoring')}: ${monitoring}`;
  }

  function paintOutputDevices(wrap) {
    const box = wrap.querySelector('[data-role="outdev"]');
    if (!box) return;
    const devices = (st.capabilities.outputDevices && st.outputs && Array.isArray(st.outputs.devices)) ? st.outputs.devices : [];
    if (!devices.length) { box.hidden = true; return; }
    box.hidden = false;
    const key = devices.map((d) => d.id).join('|');
    if (box.dataset.wlKey !== key) {
      box.dataset.wlKey = key;
      const frag = document.createDocumentFragment();
      const head = el('span', 'wl-outdev-lbl');
      head.innerHTML = ICONS.speaker;
      head.append(el('span', '', t('wl_output_device', 'Output')));
      frag.appendChild(head);
      devices.forEach((d) => {
        const b = el('button', 'wl-outdev-pill', d.name);
        b.type = 'button'; b.dataset.devId = d.id; b.title = d.name;
        b.addEventListener('click', () => dispatch({ type: 'wlOutputDevice', deviceId: d.id }));
        frag.appendChild(b);
      });
      box.replaceChildren(frag);
    }
    // Wave Link can report a main output that is not one of the devices it
    // offers (measured on a real 3.2.9). Match on either identifier, and when
    // neither matches leave every pill unlit and SAY so, rather than showing a
    // row of four buttons with nothing selected and no reason given.
    const mainId = st.outputs.mainId || '';
    const mainOut = st.outputs.mainOutputId || '';
    let lit = false;
    box.querySelectorAll('.wl-outdev-pill').forEach((b) => {
      const dev = devices.find((d) => d.id === b.dataset.devId);
      const on = !!dev && (dev.id === mainId || (dev.outputs || []).some((o) => o.id === mainOut));
      b.classList.toggle('is-on', on);
      if (on) lit = true;
    });
    box.classList.toggle('wl-outdev--unknown', !lit);
    box.title = lit ? '' : t('wl_output_elsewhere', 'The main mix is going somewhere Wave Link does not list here');
  }

  // ── data flow ──────────────────────────────────────────────────────────────
  function absorb(d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.enabled === 'boolean') st.enabled = d.enabled;
    if (typeof d.connected === 'boolean') st.connected = d.connected;
    if (Number.isFinite(d.dialect)) st.dialect = d.dialect;
    if (typeof d.version === 'string') st.version = d.version;
    if (Array.isArray(d.channels)) st.channels = d.channels;
    if (Array.isArray(d.mixes)) st.mixes = d.mixes;
    if (d.outputs && typeof d.outputs === 'object') st.outputs = d.outputs;
    if (d.capabilities && typeof d.capabilities === 'object') st.capabilities = d.capabilities;
    st.monitor = (d.monitor && typeof d.monitor === 'object') ? d.monitor : null;
  }

  function loadState() {
    if (seedInflight) return seedInflight;
    seedInflight = api('/api/wavelink/state').then(d => { absorb(d); seeded = true; })
      .catch(() => {}).finally(() => { seedInflight = null; });
    return seedInflight;
  }

  function renderWidgets() {
    if (!tiles().length) return;
    paint();                                 // instant paint from cache
    if (!seeded) loadState().then(paint);
  }

  // SSE `wavelink` frame (relayed from main.js). Meters push a couple of times a
  // second, so skip the paint entirely while the tab is in the background —
  // there is nothing to see and the work is not free.
  function onSSE(d) {
    absorb(d); seeded = true;
    if (document.hidden) return;
    if (tiles().length) paint();
  }

  window.WaveLinkWidget = { renderWidgets, onSSE };
})();

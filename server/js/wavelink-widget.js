'use strict';
// Elgato Wave Link mixer widget: live faders for every Wave Link channel (Mic,
// Game, Chat, Music…) plus the output bus and the monitor A/B switch. It rides
// the same live state the Deck uses — seeded from GET /api/wavelink/state and
// kept current by the `wavelink` SSE event (relayed here from main.js via
// window.WaveLinkWidget.onSSE). Fader/mute moves go through the allowlisted
// /actions/run dispatcher (wlInputVolume / wlInputMute / wlOutputVolume /
// wlOutputMute / wlSwitchMonitoring). Renders into .wavelink-widget-mount.
//
// A segmented Stream|Local control picks WHICH sub-mix the faders edit: the
// stream mix is what viewers hear, the local mix is what you hear — the two
// numbers Wave Link keeps per channel.
(function () {
  const ICONS = {
    micOn:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9v-3a3 3 0 0 1 6 0v5M6 11a6 6 0 0 0 9.3 5M12 17v4M4 4l16 16"/></svg>',
    out:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
    outOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
    swap:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8"/></svg>',
  };

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;          // shared DOM factory from utils.js
  const api = apiJson;        // shared fetch-JSON helper from utils.js

  // Only tiles actually placed on a dashboard page count (a hidden/never-added
  // widget sits in #widget-pool, outside any .pager-page).
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="wavelink"]')).filter(x => x.closest('.pager-page')); }

  const st = { enabled: null, connected: false, inputs: [], output: {}, monitorMix: '', switchState: '', micConnected: false };
  let mix = 'stream';         // client-only: which sub-mix the faders edit
  let seeded = false;
  let seedInflight = null;

  // Fader drag guard — Wave Link echoes our own set as inputMixerChanged, so we
  // must not let an SSE frame snap a slider back mid-drag. Keyed by "mixId:mix".
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

  // ── skeleton ───────────────────────────────────────────────────────────────
  function ensureSkeleton(mount) {
    if (mount.dataset.wlBuilt === '1' && mount.firstChild) return;
    mount.dataset.wlBuilt = '1';
    const wrap = el('div', 'wl-wrap');

    const head = el('div', 'wl-head');
    head.appendChild(el('span', 'wl-logo', 'Wave Link'));
    const seg = el('div', 'wl-seg'); seg.dataset.role = 'seg';
    ['stream', 'local'].forEach(m => {
      const b = el('button', 'wl-seg-btn', t('wl_mix_' + m, m === 'stream' ? 'Stream' : 'Local'));
      b.type = 'button'; b.dataset.mix = m;
      b.addEventListener('click', () => { if (mix !== m) { mix = m; paint(); } });
      seg.appendChild(b);
    });
    head.appendChild(seg);
    wrap.appendChild(head);

    const empty = el('div', 'wl-empty'); empty.dataset.role = 'empty'; empty.hidden = true;
    wrap.appendChild(empty);

    const body = el('div', 'wl-body'); body.dataset.role = 'body';
    body.appendChild(el('div', 'wl-list'));                 // channel faders

    const outRow = el('div', 'wl-row wl-row--out'); outRow.dataset.role = 'out';
    const outMute = el('button', 'wl-mute'); outMute.type = 'button';
    outMute.addEventListener('click', () => dispatch({ type: 'wlOutputMute', mix }));
    const outBody = el('div', 'wl-body-col');
    outBody.appendChild(el('span', 'wl-name', t('wl_output', 'Output')));
    const outSlider = document.createElement('input');
    outSlider.type = 'range'; outSlider.min = '0'; outSlider.max = '100'; outSlider.step = '1'; outSlider.className = 'wl-slider';
    const onOut = () => { const k = 'out:' + mix; markDragging(k); const v = Number(outSlider.value); setPct(outRow, v); sendVolume({ type: 'wlOutputVolume', mix, value: v }, k); };
    outSlider.addEventListener('input', onOut); outSlider.addEventListener('change', onOut);
    outBody.appendChild(outSlider);
    outRow.append(outMute, outBody, el('span', 'wl-pct'));

    const monBtn = el('button', 'wl-monitor'); monBtn.type = 'button'; monBtn.dataset.role = 'monitor';
    monBtn.innerHTML = ICONS.swap; monBtn.append(el('span', 'wl-monitor-lbl'));
    monBtn.addEventListener('click', () => dispatch({ type: 'wlSwitchMonitoring' }));

    body.append(outRow, monBtn);
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

      // Segmented control active state.
      wrap.querySelectorAll('.wl-seg-btn').forEach(b => b.classList.toggle('is-active', b.dataset.mix === mix));

      const empty = wrap.querySelector('[data-role="empty"]');
      const body = wrap.querySelector('[data-role="body"]');
      const msg = emptyMessage();
      if (msg) {
        empty.hidden = false; empty.textContent = msg; body.hidden = true;
        wrap.classList.toggle('wl-disconnected', true);
        return;
      }
      empty.hidden = true; body.hidden = false; wrap.classList.remove('wl-disconnected');

      paintChannels(wrap);
      paintOutput(wrap);
      paintMonitor(wrap);
    });
  }

  function emptyMessage() {
    if (st.enabled === false) return t('wl_offline', 'Enable Wave Link in Settings → Streaming');
    if (st.enabled !== null && !st.connected) return t('wl_not_running', 'Wave Link app not running');
    if (st.connected && (!st.inputs || !st.inputs.length)) return t('wl_no_channels', 'No Wave Link channels');
    return '';
  }

  function paintChannels(wrap) {
    const list = wrap.querySelector('.wl-list');
    if (!list) return;
    const inputs = st.inputs || [];
    const key = inputs.map(c => c.mixId).join('|');
    if (key !== list.dataset.wlKey || !list.querySelector('.wl-row')) {
      list.dataset.wlKey = key;
      const frag = document.createDocumentFragment();
      inputs.forEach(ch => frag.appendChild(buildChannelRow(ch)));
      list.replaceChildren(frag);
    }
    inputs.forEach(ch => {
      const row = list.querySelector(`.wl-row[data-mix-id="${cssEsc(ch.mixId)}"]`);
      if (!row) return;
      const muted = mix === 'local' ? ch.isLocalInMuted : ch.isStreamInMuted;
      const vol = mix === 'local' ? ch.localVolumeIn : ch.streamVolumeIn;
      applyRow(row, 'in:' + ch.mixId + ':' + mix, muted, vol, ch.name, ch.isAvailable === false);
    });
  }

  function buildChannelRow(ch) {
    const row = el('div', 'wl-row'); row.dataset.mixId = ch.mixId;
    const mute = el('button', 'wl-mute'); mute.type = 'button';
    mute.addEventListener('click', () => dispatch({ type: 'wlInputMute', mixId: ch.mixId, mix }));
    const bodyCol = el('div', 'wl-body-col');
    bodyCol.appendChild(el('span', 'wl-name', ch.name));
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1'; slider.className = 'wl-slider';
    const key = 'in:' + ch.mixId + ':';
    const onInput = () => {
      const k = key + mix; markDragging(k);
      const v = Number(slider.value); setPct(row, v);
      sendVolume({ type: 'wlInputVolume', mixId: ch.mixId, mix, value: v }, k);
    };
    slider.addEventListener('input', onInput); slider.addEventListener('change', onInput);
    bodyCol.appendChild(slider);
    row.append(mute, bodyCol, el('span', 'wl-pct'));
    return row;
  }

  // Shared update path for a channel/output row (mute icon + fader + pct), leaving
  // the actively-dragged fader untouched so it never fights the SSE echo.
  function applyRow(row, key, muted, vol, name, unavailable) {
    row.classList.toggle('is-muted', !!muted);
    row.classList.toggle('is-unavailable', !!unavailable);
    const btn = row.querySelector('.wl-mute');
    if (btn) btn.innerHTML = muted ? ICONS.micOff : ICONS.micOn;
    if (name != null) { const n = row.querySelector('.wl-name'); if (n && n.textContent !== name) n.textContent = name; }
    const v = Number.isFinite(vol) ? vol : 0;
    const slider = row.querySelector('.wl-slider');
    if (slider && key !== dragKey) slider.value = String(v);
    setPct(row, (key === dragKey && slider) ? Number(slider.value) : v);
  }

  function paintOutput(wrap) {
    const row = wrap.querySelector('[data-role="out"]');
    if (!row) return;
    const o = st.output || {};
    const muted = mix === 'local' ? o.isLocalOutMuted : o.isStreamOutMuted;
    const vol = mix === 'local' ? o.localVolumeOut : o.streamVolumeOut;
    const btn = row.querySelector('.wl-mute');
    row.classList.toggle('is-muted', !!muted);
    if (btn) btn.innerHTML = muted ? ICONS.outOff : ICONS.out;
    const v = Number.isFinite(vol) ? vol : 0;
    const slider = row.querySelector('.wl-slider');
    const key = 'out:' + mix;
    if (slider && key !== dragKey) slider.value = String(v);
    setPct(row, (key === dragKey && slider) ? Number(slider.value) : v);
  }

  function paintMonitor(wrap) {
    const btn = wrap.querySelector('[data-role="monitor"]');
    if (!btn) return;
    const lbl = btn.querySelector('.wl-monitor-lbl');
    // switchState is Wave Link's own label ("Stream Mix" / "Local Mix"); show what
    // you're monitoring, tap to flip.
    const monitoring = st.switchState || '—';
    if (lbl) lbl.textContent = `${t('wl_monitoring', 'Monitoring')}: ${monitoring}`;
  }

  // ── data flow ──────────────────────────────────────────────────────────────
  function absorb(d) {
    if (!d || typeof d !== 'object') return;
    if (typeof d.enabled === 'boolean') st.enabled = d.enabled;
    if (typeof d.connected === 'boolean') st.connected = d.connected;
    if (Array.isArray(d.inputs)) st.inputs = d.inputs;
    if (d.output && typeof d.output === 'object') st.output = d.output;
    if (typeof d.monitorMix === 'string') st.monitorMix = d.monitorMix;
    if (typeof d.switchState === 'string') st.switchState = d.switchState;
    if (typeof d.micConnected === 'boolean') st.micConnected = d.micConnected;
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

  // SSE `wavelink` frame (relayed from main.js).
  function onSSE(d) { absorb(d); seeded = true; if (tiles().length) paint(); }

  window.WaveLinkWidget = { renderWidgets, onSSE };
})();

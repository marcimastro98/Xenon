'use strict';
// OBS dashboard widget: a unified panel that collects the OBS controls — a live
// program PREVIEW, go-live / end-stream, start / stop recording, and a SCENE
// switcher. State is fed by the same SSE the Deck uses (obs / obs_preview),
// relayed from main.js; actions go through the allowlisted /actions/run
// dispatcher (obsStream / obsRecord / obsScene). Three sections (preview /
// controls / scenes) carry data-system-card so they hide/reorder like the
// System panel cards. Renders into .obs-widget-mount.
(function () {
  const ICONS = {
    golive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    rec: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="m8 3 4 4 4-4"/></svg>',
    micOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 9v-3a3 3 0 0 1 6 0v5M6 11a6 6 0 0 0 9.3 5M12 17v4M4 4l16 16"/></svg>',
  };

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl; // shared DOM factory from utils.js
  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it must NOT
  // probe OBS. Adding the widget makes it live on the next layout pass.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="obs"]')).filter(el => el.closest('.pager-page')); }
  const api = apiJson; // shared fetch-JSON helper from utils.js

  const st = { streaming: false, recording: false, scene: '', mutes: {}, volumes: {}, inputs: [] };
  let previewImg = '';
  let scenes = [];
  // While a fader is being dragged we must NOT let the SSE echo (OBS emits
  // InputVolumeChanged for our own SetInputVolume) snap the slider back mid-drag.
  let dragInput = '';
  let dragClearTimer = null;
  const volSendTimers = new Map();   // inputName -> trailing-send timeout
  const volSendLast = new Map();     // inputName -> last dispatch timestamp
  const VOL_THROTTLE_MS = 110;
  let configured = null;        // null = unknown; true once a host is set in Settings
  let reachable = false;        // true once OBS actually answered (/obs/scenes ok) — covers a blank-host LOCAL OBS
  let scenesLoaded = false;
  let scenesInflight = null;    // dedup concurrent /obs/scenes across multi-pass layout
  let probeInflight = null;     // dedup concurrent /actions/catalog probes

  async function runAction(btn, action) {
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    btn.classList.add(r && r.ok ? 'ok' : 'err');
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1200);
  }

  // Fire-and-forget dispatch for the audio rows (no ok/err button chrome).
  function dispatch(action) {
    api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) }).catch(() => {});
  }

  // Throttle per-input while dragging a fader so we send at most ~1 op / 110ms,
  // always with a trailing send so the final resting value lands.
  function sendVolume(name, value) {
    st.volumes[name] = value;                 // optimistic local echo
    const now = Date.now();
    const last = volSendLast.get(name) || 0;
    const fire = () => { volSendLast.set(name, Date.now()); dispatch({ type: 'obsInputVolume', source: name, value }); };
    const pending = volSendTimers.get(name);
    if (pending) { clearTimeout(pending); volSendTimers.delete(name); }
    if (now - last >= VOL_THROTTLE_MS) { fire(); }
    else { volSendTimers.set(name, setTimeout(() => { volSendTimers.delete(name); fire(); }, VOL_THROTTLE_MS - (now - last))); }
  }

  function markDragging(name) {
    dragInput = name;
    if (dragClearTimer) clearTimeout(dragClearTimer);
    // Hold the guard briefly past the last input so the echoing SSE frames settle.
    dragClearTimer = setTimeout(() => { dragInput = ''; dragClearTimer = null; }, 350);
  }

  function ensureSkeleton(mount) {
    if (mount.dataset.obsBuilt === '1' && mount.firstChild) return;
    mount.dataset.obsBuilt = '1';
    const wrap = el('div', 'obs-wrap');

    const head = el('div', 'obs-head');
    head.appendChild(el('span', 'obs-logo', 'OBS'));
    const pills = el('div', 'obs-pills');
    const live = el('span', 'obs-pill obs-pill-live'); live.append(el('span', 'obs-pill-dot'), el('span', null, 'LIVE'));
    const rec = el('span', 'obs-pill obs-pill-rec'); rec.append(el('span', 'obs-pill-dot'), el('span', null, 'REC'));
    pills.append(live, rec);
    head.appendChild(pills);
    wrap.appendChild(head);

    const cards = el('div', 'obs-cards');

    const preview = el('section', 'obs-card obs-card--preview'); preview.dataset.systemCard = 'preview'; preview.dataset.systemCardGroup = 'obs';
    preview.appendChild(el('div', 'obs-card-label', t('layout_card_preview', 'OBS preview')));
    const pv = el('div', 'obs-preview');
    const pvImg = document.createElement('img'); pvImg.className = 'obs-preview-img'; pvImg.alt = ''; pvImg.hidden = true;
    pv.append(pvImg, el('div', 'obs-preview-empty', t('obs_preview_empty', 'No OBS preview')));
    preview.appendChild(pv);

    const controls = el('section', 'obs-card obs-card--controls'); controls.dataset.systemCard = 'controls'; controls.dataset.systemCardGroup = 'obs';
    controls.appendChild(el('div', 'obs-card-label', t('layout_card_controls', 'Controls')));
    const ctlRow = el('div', 'obs-controls');
    const golive = el('button', 'obs-btn obs-golive');
    golive.append(el('span', 'obs-btn-ico'), el('span', 'obs-btn-lbl'));
    golive.addEventListener('click', () => runAction(golive, { type: 'obsStream', mode: 'toggle' }));
    const record = el('button', 'obs-btn obs-record');
    record.append(el('span', 'obs-btn-ico'), el('span', 'obs-btn-lbl'));
    record.addEventListener('click', () => runAction(record, { type: 'obsRecord', mode: 'toggle' }));
    ctlRow.append(golive, record);
    controls.appendChild(ctlRow);

    const scenesC = el('section', 'obs-card obs-card--scenes'); scenesC.dataset.systemCard = 'scenes'; scenesC.dataset.systemCardGroup = 'obs';
    scenesC.appendChild(el('div', 'obs-card-label', t('layout_card_scenes', 'Scenes')));
    scenesC.appendChild(el('div', 'obs-scene-list'));

    const audioC = el('section', 'obs-card obs-card--audio'); audioC.dataset.systemCard = 'audio'; audioC.dataset.systemCardGroup = 'obs';
    audioC.appendChild(el('div', 'obs-card-label', t('layout_card_audio', 'Audio')));
    audioC.appendChild(el('div', 'obs-audio-list'));

    cards.append(preview, controls, scenesC, audioC);
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  function paint() {
    // "off" only when OBS is neither configured (host in Settings) nor reachable
    // locally — so a blank-host user with OBS running still shows as connected.
    const off = configured === false && !reachable;
    tiles().forEach(tile => {
      const mount = tile.querySelector('.obs-widget-mount');
      if (!mount) return;
      ensureSkeleton(mount);
      mount.querySelector('.obs-wrap').classList.toggle('obs-disconnected', off);

      mount.querySelector('.obs-pill-live').classList.toggle('on', st.streaming);
      mount.querySelector('.obs-pill-rec').classList.toggle('on', st.recording);

      // Preview
      const pvImg = mount.querySelector('.obs-preview-img');
      const pvEmpty = mount.querySelector('.obs-preview-empty');
      if (previewImg) { pvImg.src = previewImg; pvImg.hidden = false; pvEmpty.hidden = true; }
      else { pvImg.removeAttribute('src'); pvImg.hidden = true; pvEmpty.hidden = false; pvEmpty.textContent = off ? t('obs_not_configured', 'Configure OBS in Settings') : t('obs_preview_empty', 'No OBS preview'); }

      // Go live / End stream
      const golive = mount.querySelector('.obs-golive');
      golive.classList.toggle('is-live', st.streaming);
      golive.querySelector('.obs-btn-ico').innerHTML = st.streaming ? ICONS.stop : ICONS.golive;
      golive.querySelector('.obs-btn-lbl').textContent = st.streaming ? t('twitch_endstream', 'End stream') : t('twitch_golive', 'Go live');

      // Record
      const record = mount.querySelector('.obs-record');
      record.classList.toggle('is-rec', st.recording);
      record.querySelector('.obs-btn-ico').innerHTML = st.recording ? ICONS.stop : ICONS.rec;
      record.querySelector('.obs-btn-lbl').textContent = st.recording ? t('obs_rec_stop', 'Stop rec') : t('obs_rec_start', 'Record');

      paintScenes(mount);
      paintAudio(mount);
    });
  }

  // Audio inputs OBS reported (mic, desktop, aux…). Order comes from obsInputs
  // (stable, OBS-reported); fall back to the union of mute/volume keys.
  function audioInputs() {
    if (st.inputs && st.inputs.length) return st.inputs;
    const set = new Set([...Object.keys(st.mutes), ...Object.keys(st.volumes)]);
    return Array.from(set);
  }

  function buildAudioRow(name) {
    const row = el('div', 'obs-audio-row'); row.dataset.input = name;
    const mute = el('button', 'obs-audio-mute'); mute.type = 'button';
    mute.setAttribute('aria-label', t('mic', 'Mic'));
    mute.addEventListener('click', () => { dispatch({ type: 'obsMute', source: name, mode: 'toggle' }); });
    const body = el('div', 'obs-audio-body');
    body.appendChild(el('span', 'obs-audio-name', name));
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.className = 'obs-audio-slider';
    const onInput = () => { markDragging(name); sendVolume(name, Number(slider.value)); updatePct(row, Number(slider.value)); };
    slider.addEventListener('input', onInput);
    slider.addEventListener('change', onInput);
    body.appendChild(slider);
    const pct = el('span', 'obs-audio-pct');
    row.append(mute, body, pct);
    return row;
  }

  function updatePct(row, v) { const p = row.querySelector('.obs-audio-pct'); if (p) p.textContent = `${Math.round(v)}%`; }

  function paintAudio(mount) {
    const list = mount.querySelector('.obs-audio-list');
    if (!list) return;
    const inputs = audioInputs();
    if (!inputs.length) {
      list.dataset.audKey = '';
      const off = configured === false && !reachable;
      list.replaceChildren(el('div', 'obs-audio-empty', off ? t('obs_not_configured', 'Configure OBS in Settings') : t('obs_no_audio', 'No audio inputs')));
      return;
    }
    const key = inputs.join('|');
    if (key !== list.dataset.audKey || !list.querySelector('.obs-audio-row')) {
      list.dataset.audKey = key;
      const frag = document.createDocumentFragment();
      inputs.forEach(name => frag.appendChild(buildAudioRow(name)));
      list.replaceChildren(frag);
    }
    // Update mute state + fader value in place; never touch the fader being dragged.
    inputs.forEach(name => {
      const row = list.querySelector(`.obs-audio-row[data-input="${cssEsc(name)}"]`);
      if (!row) return;
      const muted = !!st.mutes[name];
      row.classList.toggle('is-muted', muted);
      const btn = row.querySelector('.obs-audio-mute');
      if (btn) btn.innerHTML = muted ? ICONS.micOff : ICONS.micOn;
      const vol = Number.isFinite(st.volumes[name]) ? st.volumes[name] : 0;
      const slider = row.querySelector('.obs-audio-slider');
      if (slider && name !== dragInput) { slider.value = String(vol); }
      updatePct(row, name === dragInput && slider ? Number(slider.value) : vol);
    });
  }

  // Escape a value for use inside a CSS attribute selector.
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  function paintScenes(mount) {
    const list = mount.querySelector('.obs-scene-list');
    if (!list) return;
    if (!scenes.length) {
      list.replaceChildren(el('div', 'obs-scene-empty', (configured === false && !reachable) ? t('obs_not_configured', 'Configure OBS in Settings') : t('obs_no_scenes', 'No scenes')));
      return;
    }
    const frag = document.createDocumentFragment();
    scenes.forEach(name => {
      const b = el('button', 'obs-scene', name);
      b.classList.toggle('is-active', name === st.scene);
      b.addEventListener('click', () => runAction(b, { type: 'obsScene', scene: name }));
      frag.appendChild(b);
    });
    list.replaceChildren(frag);
  }

  // A single layout init applies the layout 2–3 times, so renderWidgets can fire
  // these back-to-back before the first fetch resolves. Share the in-flight
  // promise so each endpoint is hit once; the scenesLoaded / configured flags
  // then prevent any further fetches once it settles.
  function loadScenes() {
    if (scenesInflight) return scenesInflight;
    scenesInflight = api('/obs/scenes').then(d => {
      // ok means OBS answered — true even for a blank-host LOCAL OBS. This same
      // probe is what arms the server-side live watch + preview.
      reachable = !!(d && d.ok);
      scenes = (d && Array.isArray(d.scenes)) ? d.scenes : [];
      scenesLoaded = true;
    }).finally(() => { scenesInflight = null; });
    return scenesInflight;
  }

  function probeConfigured() {
    if (probeInflight) return probeInflight;
    probeInflight = api('/actions/catalog').then(d => {
      configured = !!(d && d.capabilities && d.capabilities.obsConfigured);
    }).finally(() => { probeInflight = null; });
    return probeInflight;
  }

  function renderWidgets() {
    if (!tiles().length) return;
    paint();                                   // instant paint from cache
    // The widget is on a page → probe OBS directly. A successful /obs/scenes works
    // for a blank-host LOCAL OBS (127.0.0.1 fallback) AND tells the server to start
    // the live watch + preview. Non-OBS users never add the widget, so this never
    // runs for them and no OBS socket is opened.
    if (configured === null) probeConfigured().then(paint);
    if (!scenesLoaded) loadScenes().then(paint);
  }

  // ── SSE hooks (fed by main.js) ───────────────────────────────────────────
  function onObs(s) {
    if (!s) return;
    if (typeof s.obsStreaming === 'boolean') st.streaming = s.obsStreaming;
    if (typeof s.obsRecording === 'boolean') st.recording = s.obsRecording;
    if (typeof s.obsScene === 'string') st.scene = s.obsScene;
    if (s.obsMutes && typeof s.obsMutes === 'object') st.mutes = s.obsMutes;
    if (s.obsVolumes && typeof s.obsVolumes === 'object') st.volumes = s.obsVolumes;
    if (Array.isArray(s.obsInputs)) st.inputs = s.obsInputs;
    // Receiving OBS state means OBS is reachable; refresh scenes once.
    reachable = true;
    if (configured !== true) { configured = true; if (!scenesLoaded && tiles().length) loadScenes().then(paint); }
    if (tiles().length) paint();
  }
  function onObsPreview(p) { previewImg = (p && p.image) || ''; if (tiles().length) paint(); }

  window.ObsWidget = { renderWidgets, onObs, onObsPreview };
})();

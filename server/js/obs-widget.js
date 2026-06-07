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
  };

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it must NOT
  // probe OBS. Adding the widget makes it live on the next layout pass.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="obs"]')).filter(el => el.closest('.pager-page')); }
  async function api(path, opts) { try { const r = await fetch(path, opts); return await r.json(); } catch { return null; } }

  const st = { streaming: false, recording: false, scene: '' };
  let previewImg = '';
  let scenes = [];
  let configured = null;        // null = unknown, true/false once probed
  let scenesLoaded = false;
  let scenesInflight = null;    // dedup concurrent /obs/scenes across multi-pass layout
  let probeInflight = null;     // dedup concurrent /actions/catalog probes

  async function runAction(btn, action) {
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    btn.classList.add(r && r.ok ? 'ok' : 'err');
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1200);
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

    cards.append(preview, controls, scenesC);
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  function paint() {
    const off = configured === false;
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
    });
  }

  function paintScenes(mount) {
    const list = mount.querySelector('.obs-scene-list');
    if (!list) return;
    if (!scenes.length) {
      list.replaceChildren(el('div', 'obs-scene-empty', configured === false ? t('obs_not_configured', 'Configure OBS in Settings') : t('obs_no_scenes', 'No scenes')));
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
    if (configured === null) probeConfigured().then(() => { paint(); if (configured && !scenesLoaded) loadScenes().then(paint); });
    else if (configured && !scenesLoaded) loadScenes().then(paint);
  }

  // ── SSE hooks (fed by main.js) ───────────────────────────────────────────
  function onObs(s) {
    if (!s) return;
    if (typeof s.obsStreaming === 'boolean') st.streaming = s.obsStreaming;
    if (typeof s.obsRecording === 'boolean') st.recording = s.obsRecording;
    if (typeof s.obsScene === 'string') st.scene = s.obsScene;
    // Receiving OBS state means OBS is reachable; refresh scenes once.
    if (configured !== true) { configured = true; if (!scenesLoaded && tiles().length) loadScenes().then(paint); }
    if (tiles().length) paint();
  }
  function onObsPreview(p) { previewImg = (p && p.image) || ''; if (tiles().length) paint(); }

  window.ObsWidget = { renderWidgets, onObs, onObsPreview };
})();

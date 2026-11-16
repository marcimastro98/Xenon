// The controls a device's panel is built from: icon and pill buttons, an On | Off switch, a slider
// that holds the panel still while it is dragged, and the whole media player (now playing,
// transport, seek, shuffle and repeat, volume, sources, channel).
'use strict';

window.SmartHomeSheetControls = (wrapper) => {
  const { SVG, homeState, callService } = wrapper;

  const { t, fmtNum } = window.SmartHomeStateWords;
  const { FEAT, has } = window.SmartHomeUnits;
  const { el, ctlGroup, chipGroup } = window.SmartHomePieces;

  // ---- control primitives ---------------------------------------------------
  function iconBtn(cls, svgPath, onClick, label) {
    const b = el('button', cls); b.type = 'button';
    b.innerHTML = SVG(svgPath);                         // static, trusted SVG
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function pillBtn(labelText, svgPath, onClick) {
    const b = el('button', 'sh-abtn'); b.type = 'button';
    b.innerHTML = SVG(svgPath);                         // static, trusted SVG
    b.appendChild(el('span', 'sh-abtn-label', labelText));
    b.addEventListener('click', onClick);
    return b;
  }

  function actionPills(pills) {
    const row = el('div', 'sh-abtns');
    pills.forEach((p) => { const b = pillBtn(p.labelText, p.svg, p.onClick); if (p.danger) b.classList.add('sh-abtn--danger'); row.appendChild(b); });
    return ctlGroup(null, row);
  }

  // An On | Off segmented control (uses the domain's own turn_on/turn_off).
  function powerRow(e, on) {
    const seg = el('div', 'sh-seg');
    const mk = (labelKey, active, service) => {
      const b = el('button', 'sh-seg-btn' + (active ? ' is-active' : '')); b.type = 'button';
      b.textContent = t(labelKey);
      b.addEventListener('click', () => callService(e.domain, service, e.id));
      return b;
    };
    seg.append(mk('smarthome_power_on', on, 'turn_on'), mk('smarthome_power_off', !on, 'turn_off'));
    return ctlGroup(null, seg);
  }

  function setRangeFill(input, value, min, max) {
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', Math.max(0, Math.min(100, pct)) + '%');
  }

  // A range slider with a live value bubble. onCommit(value) fires on release.
  function sliderRow(labelText, value, min, max, step, unit, onCommit, rightNode) {
    const g = el('div', 'sh-ctl');
    const head = el('div', 'sh-ctl-head');
    head.appendChild(el('span', 'sh-ctl-label', labelText));
    const out = el('span', 'sh-ctl-val'); out.textContent = fmtNum(value) + (unit || '');
    head.appendChild(out);
    if (rightNode) head.appendChild(rightNode);
    g.appendChild(head);
    const input = el('input', 'sh-range'); input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    setRangeFill(input, value, min, max);
    input.addEventListener('pointerdown', () => { homeState.sheetDragging = true; });
    const end = () => { homeState.sheetDragging = false; };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('input', () => { out.textContent = fmtNum(input.value) + (unit || ''); setRangeFill(input, Number(input.value), min, max); });
    input.addEventListener('change', () => { homeState.sheetDragging = false; onCommit(Number(input.value)); });
    g.appendChild(input);
    return g;
  }

  // ---- per-domain sheet bodies ----------------------------------------------
  function sheetMedia(e, body) {
    const f = e.features || 0;
    const off = ['off', 'standby', 'unavailable', 'unknown', ''].includes(e.state);
    if (e.title) {
      const np = el('div', 'sh-now');
      np.appendChild(el('div', 'sh-now-title', e.title));
      if (e.artist) np.appendChild(el('div', 'sh-now-artist', e.artist));
      body.appendChild(np);
    }
    if (has(f, FEAT.mp.on) || has(f, FEAT.mp.off)) body.appendChild(powerRow(e, !off));
    if (has(f, FEAT.mp.prev) || has(f, FEAT.mp.next) || has(f, FEAT.mp.play) || has(f, FEAT.mp.pause) || has(f, FEAT.mp.stop)) body.appendChild(mediaTransport(e, f));
    if (has(f, FEAT.mp.seek) && Number.isFinite(e.mediaDur) && e.mediaDur > 0) body.appendChild(mediaSeek(e));
    if (has(f, FEAT.mp.shuffle) || has(f, FEAT.mp.repeat)) body.appendChild(mediaShuffleRepeat(e, f));
    if (has(f, FEAT.mp.volSet) || has(f, FEAT.mp.volStep)) body.appendChild(mediaVolume(e, f));
    if (has(f, FEAT.mp.source) && Array.isArray(e.sources) && e.sources.length) body.appendChild(chipGroup(t('smarthome_source'), e.sources, e.source, (s) => callService('media_player', 'select_source', e.id, { source: s })));
    // Direct channel tuning (also the way "back to live TV": tuning switches the TV
    // off any HDMI input onto its tuner). Standard media_player.play_media with a
    // 'channel' type — works on Sony/Samsung/LG/Roku, not a device-specific hack.
    if (has(f, FEAT.mp.playMedia)) body.appendChild(channelRow(e));
    if (has(f, FEAT.mp.sound) && Array.isArray(e.soundModes) && e.soundModes.length) body.appendChild(chipGroup(t('smarthome_sound_mode'), e.soundModes, e.soundMode, (s) => callService('media_player', 'select_sound_mode', e.id, { sound_mode: s })));
  }

  // A channel entry: type a channel number (or, on TVs that support it, a channel/app
  // name) and tune to it. Flashes red if the TV rejects the request.
  function channelRow(e) {
    const g = el('div', 'sh-ctl');
    g.appendChild(el('div', 'sh-ctl-label', t('smarthome_channel')));
    const row = el('div', 'sh-chan');
    const input = el('input', 'sh-chan-input'); input.type = 'text'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.placeholder = t('smarthome_channel_ph');
    const go = el('button', 'sh-chan-go'); go.type = 'button'; go.textContent = t('smarthome_channel_go');
    const tune = async () => {
      const v = String(input.value).trim();
      if (!v) return;
      const r = await callService('media_player', 'play_media', e.id, { media_content_id: v, media_content_type: 'channel' });
      if (r && r.ok === false) { row.classList.remove('fail'); void row.offsetWidth; row.classList.add('fail'); }
      else { input.value = ''; }
    };
    go.addEventListener('click', tune);
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); tune(); } });
    row.append(input, go);
    g.appendChild(row);
    return g;
  }

  function mediaTransport(e, f) {
    const row = el('div', 'sh-transport');
    if (has(f, FEAT.mp.prev)) row.appendChild(iconBtn('sh-tp', '<path d="M18 5v14M8 12l10-7v14z" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_previous_track', e.id), t('tip_prev')));
    const playing = e.state === 'playing';
    row.appendChild(iconBtn('sh-tp sh-tp--main', playing
      ? '<rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>'
      : '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_play_pause', e.id), t('tip_play')));
    if (has(f, FEAT.mp.next)) row.appendChild(iconBtn('sh-tp', '<path d="M6 5v14M16 12L6 5v14z" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_next_track', e.id), t('tip_next')));
    if (has(f, FEAT.mp.stop)) row.appendChild(iconBtn('sh-tp sh-tp--sm', '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>', () => callService('media_player', 'media_stop', e.id), t('smarthome_stop')));
    return ctlGroup(null, row);
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), h = Math.floor(m / 60), ss = String(s % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m % 60).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }

  // A seek bar for media with a known duration (music, movies — not live TV).
  function mediaSeek(e) {
    const dur = Math.max(1, Math.round(e.mediaDur));
    const pos = Math.max(0, Math.min(dur, Math.round(e.mediaPos || 0)));
    const g = el('div', 'sh-ctl');
    const head = el('div', 'sh-ctl-head');
    head.appendChild(el('span', 'sh-ctl-label', t('smarthome_position')));
    const out = el('span', 'sh-ctl-val'); out.textContent = fmtTime(pos) + ' / ' + fmtTime(dur);
    head.appendChild(out);
    g.appendChild(head);
    const input = el('input', 'sh-range'); input.type = 'range'; input.min = '0'; input.max = String(dur); input.step = '1'; input.value = String(pos);
    setRangeFill(input, pos, 0, dur);
    input.addEventListener('pointerdown', () => { homeState.sheetDragging = true; });
    const end = () => { homeState.sheetDragging = false; };
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    input.addEventListener('input', () => { out.textContent = fmtTime(Number(input.value)) + ' / ' + fmtTime(dur); setRangeFill(input, Number(input.value), 0, dur); });
    input.addEventListener('change', () => { homeState.sheetDragging = false; callService('media_player', 'media_seek', e.id, { seek_position: Number(input.value) }); });
    g.appendChild(input);
    return g;
  }

  // Shuffle + repeat toggles (repeat cycles off → all → one).
  function mediaShuffleRepeat(e, f) {
    const row = el('div', 'sh-abtns');
    if (has(f, FEAT.mp.shuffle)) {
      const on = !!e.shuffle;
      const b = pillBtn(t('smarthome_shuffle'), '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>', () => callService('media_player', 'shuffle_set', e.id, { shuffle: !on }));
      if (on) b.classList.add('is-active');
      row.appendChild(b);
    }
    if (has(f, FEAT.mp.repeat)) {
      const mode = e.repeat || 'off';
      const next = mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
      const b = pillBtn(t('smarthome_repeat') + (mode === 'one' ? ' ·1' : mode === 'all' ? ' ·∞' : ''), '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>', () => callService('media_player', 'repeat_set', e.id, { repeat: next }));
      if (mode !== 'off') b.classList.add('is-active');
      row.appendChild(b);
    }
    return ctlGroup(null, row);
  }

  function mediaVolume(e, f) {
    const muted = !!e.muted;
    const muteBtn = has(f, FEAT.mp.volMute)
      ? iconBtn('sh-icobtn' + (muted ? ' is-active' : ''), muted
        ? '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M17 9l4 6M21 9l-4 6"/>'
        : '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/>', () => callService('media_player', 'volume_mute', e.id, { is_volume_muted: !muted }), t('smarthome_mute'))
      : null;
    if (has(f, FEAT.mp.volSet)) {
      const vol = Math.round((Number(e.volume) || 0) * 100);
      return sliderRow(t('smarthome_volume'), vol, 0, 100, 1, '%', (v) => callService('media_player', 'volume_set', e.id, { volume_level: v / 100 }), muteBtn);
    }
    const row = el('div', 'sh-abtns');
    row.appendChild(pillBtn(t('smarthome_volume_down'), '<path d="M5 12h14"/>', () => callService('media_player', 'volume_down', e.id)));
    if (muteBtn) row.appendChild(muteBtn);
    row.appendChild(pillBtn(t('smarthome_volume_up'), '<path d="M12 5v14M5 12h14"/>', () => callService('media_player', 'volume_up', e.id)));
    return ctlGroup(t('smarthome_volume'), row);
  }

  return { iconBtn, pillBtn, actionPills, powerRow, sliderRow, sheetMedia };
};

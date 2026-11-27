// Live controls in Bit's replies. After Bit set the volume, the microphone, the music or a light,
// its reply keeps that control, so the next nudge is a drag instead of another sentence. The
// server says which (server/ai/reply-control-offer.js); they move through the endpoints the
// Volume, Media and Smart Home tiles already use, so a phone gets exactly what those allow it.
// Plain markup with data attributes and events delegated on the document: a chat shown in two
// tiles is a copy of the same HTML (mirrorChatCopies), and every copy follows the live state.
(() => {
  'use strict';

  const KINDS = new Set(['volume', 'mic', 'media', 'light']);
  const LIGHT_RE = /^light\.[a-z0-9_]+$/;
  const MAX = 4;
  // The light watch is per surface (smart-home/routes.js POST /ha/deck-watch): an id of its own,
  // renewed before the server forgets it, and dropped when no light control is in sight.
  const WATCH_ID = 'bitctl' + Math.random().toString(36).slice(2, 10);
  const WATCH_RENEW_MS = 7 * 60 * 1000;
  // The server reads the volume only while something on screen asks (audio/routes.js /audio/watch).
  const TICK_MS = 25 * 1000;
  const VOLUME_SEND_MS = 120;
  const FAILED_MS = 2500;

  const svg = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  const SPEAKER = '<path d="M11 5 6 9H3v6h3l5 4V5Z"/>';
  const MIC = '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>';
  const ICON = {
    volume: [svg(SPEAKER + '<path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'), svg(SPEAKER + '<path d="m16 9 5 6M21 9l-5 6"/>')],
    mic: [svg(MIC), svg(MIC + '<path d="M4 4l16 16"/>')],
    media: [svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/>'), svg('<path d="M8 5v14l11-7Z" fill="currentColor"/>')],
    light: [svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3Z"/>')],
    previous: svg('<path d="M6 5v14M18 5 9 12l9 7Z" fill="currentColor"/>'),
    next: svg('<path d="M18 5v14M6 5l9 7-9 7Z" fill="currentColor"/>'),
  };
  const MAIN_LABEL = { volume: 'vol_mute_tip', mic: 'mic_mute_tip', media: 'tip_play' };
  const NAME = { volume: 'vol_title', mic: 'mic_active', media: 'media_empty_title' };

  let pending = [];
  let tickTimer = null;
  let seenBefore = false;
  let watchSig = '';
  let watchAt = 0;
  let volumeSend = null;
  let held = null; // the slider under a finger: live updates leave it alone

  const say = (key, fallback) => (typeof t === 'function' ? t(key) : fallback || key);
  const base = () => (typeof SERVER === 'string' ? SERVER : '');
  const rowsOf = (kind) => Array.from(document.querySelectorAll('.ai-ctl[data-ctl="' + kind + '"]'));

  // ── The offer: queued by the turn's client actions, taken by the reply's bubble ─────────
  function clean(a) {
    if (!a || !KINDS.has(a.kind)) return null;
    if (a.kind !== 'light') return { kind: a.kind };
    if (!LIGHT_RE.test(String(a.entity || ''))) return null;
    const pct = Number(a.pct);
    return {
      kind: 'light', entity: a.entity, name: String(a.name || '').slice(0, 80) || a.entity,
      dimmable: a.dimmable === true, on: typeof a.on === 'boolean' ? a.on : null,
      pct: Number.isFinite(pct) ? Math.min(100, Math.max(1, Math.round(pct))) : null,
    };
  }

  // The reply is drawn in the same tick as its actions (send-message.js), so a control no bubble
  // took (a voice turn, a stopped one) is dropped right after. Voice has no chat to hold it.
  function queue(args) {
    const c = clean(args);
    if (!c || document.body.classList.contains('ai-voice-mode')) return;
    if (!pending.length) setTimeout(() => { pending = []; }, 0);
    if (pending.length < MAX) pending.push(c);
  }

  function take(bubble) {
    if (!pending.length || !bubble) return;
    const set = el('div', 'ai-ctl-set');
    for (const c of pending) set.appendChild(build(c));
    pending = [];
    bubble.appendChild(set);
    setTimeout(readAll, 0); // once the reply and its mirrors are on the page
    if (!tickTimer) tickTimer = setTimeout(tick, TICK_MS);
  }

  // ── Markup ──────────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = Object.assign(document.createElement(tag), { className: cls || '' });
    if (text != null) n.textContent = text;
    return n;
  }

  function iconButton(cls, act, icon, label) {
    const b = el('button', cls);
    b.type = 'button';
    b.dataset.ctlDo = act;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon; // static, trusted SVG
    return b;
  }

  // [the switch: lit in Bit's colour while on] [name, and the slider under it] [value, or skip buttons]
  function build(c) {
    const row = el('div', 'ai-ctl');
    row.dataset.ctl = c.kind;
    const body = el('div', 'ai-ctl-body');
    const side = el('div', 'ai-ctl-side');
    body.appendChild(el('span', 'ai-ctl-name', c.kind === 'light' ? c.name : say(NAME[c.kind])));
    if (c.kind === 'media') {
      body.appendChild(el('span', 'ai-ctl-sub'));
      side.append(iconButton('', 'previous', ICON.previous, say('tip_prev')), iconButton('', 'next', ICON.next, say('tip_next')));
    }
    const sliding = c.kind === 'volume' || (c.kind === 'light' && c.dimmable);
    if (sliding) {
      const r = Object.assign(el('input', 'ai-ctl-range'), { type: 'range', min: '0', max: '100', step: '1' });
      r.setAttribute('aria-label', say(c.kind === 'volume' ? 'vol_title' : 'smarthome_brightness'));
      body.appendChild(r);
      side.appendChild(el('span', 'ai-ctl-val'));
    }
    row.append(iconButton('ai-ctl-main', 'main', ICON[c.kind].join(''), c.kind === 'light' ? c.name : say(MAIN_LABEL[c.kind])), body, side);
    if (c.kind === 'light') {
      row.dataset.entity = c.entity;
      if (c.on !== null) setState(row, c.on);
      if (sliding && c.pct !== null) setLevel(row, c.on === false ? 0 : c.pct);
    }
    return row;
  }

  // ── Showing a state ─────────────────────────────────────────────────────────
  // The attributes, not only the properties: a mirror copies the HTML.
  function setState(row, on, na) {
    row.dataset.state = na ? 'na' : on ? 'on' : 'off';
    row.querySelector('.ai-ctl-main').setAttribute('aria-pressed', String(row.dataset.ctl === 'volume' || row.dataset.ctl === 'mic' ? !on : !!on));
  }

  function setLevel(row, value, own) {
    const r = row.querySelector('.ai-ctl-range');
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (r && (own || r !== held)) {
      r.setAttribute('value', String(v));
      r.value = String(v);
      r.style.setProperty('--fill', v + '%'); // the filled part of the track: no CSS reads a range's value
    }
    const out = row.querySelector('.ai-ctl-val');
    if (out) out.textContent = v + '%';
  }

  const setName = (row, text, sub) => {
    row.querySelector('.ai-ctl-name').textContent = text;
    const s = row.querySelector('.ai-ctl-sub');
    if (s) s.textContent = sub || '';
  };

  function applyAudio(d) {
    if (!d) return;
    const s = d.speaker;
    for (const row of rowsOf('volume')) {
      if (d.unavailable) { setState(row, false, true); setName(row, say('audio_unavailable_title')); continue; }
      if (!s) continue;
      setState(row, !s.muted);
      setName(row, say('vol_title'));
      if (Number.isFinite(Number(s.volume))) setLevel(row, s.volume);
    }
  }

  function applyMic(muted) {
    for (const row of rowsOf('mic')) { setState(row, !muted); setName(row, say(muted ? 'mic_muted' : 'mic_active')); }
  }

  function applyMedia(d) {
    const active = !!d?.active;
    for (const row of rowsOf('media')) {
      setState(row, active && d.playbackStatus === 'Playing');
      setName(row, active ? (d.title || say('media_unknown_title')) : say('media_empty_title'), active ? d.artist : '');
    }
  }

  function applyLights(states) {
    if (!states || typeof states !== 'object') return;
    for (const row of rowsOf('light')) {
      const st = states[row.dataset.entity];
      if (!st) continue;
      const on = st.state === 'on';
      setState(row, on, st.state === 'unavailable');
      if (row.querySelector('.ai-ctl-range')) setLevel(row, on && Number.isFinite(st.brightness) ? Math.max(1, Math.round(st.brightness / 255 * 100)) : 0);
    }
  }

  // ── Reading and writing, through the tiles' own endpoints ─────────────────────
  async function call(path, body) {
    const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' };
    const res = await fetch(base() + path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false || data?.error) throw new Error(data?.error || 'failed');
    return data;
  }

  const read = (path, apply) => fetch(base() + path).then((r) => r.json()).then(apply).catch(() => {});
  const readAudio = () => read('/audio', applyAudio);

  function readAll() {
    if (rowsOf('volume').length) readAudio();
    if (rowsOf('mic').length) read('/status', (d) => { if (d && typeof d.muted === 'boolean') applyMic(d.muted); });
    if (rowsOf('media').length) read('/media', applyMedia);
    syncWatch(true);
  }

  // It did not work: the row says so for a moment, then shows what is true again.
  function failed(row) {
    row.classList.add('is-failed');
    setName(row, say('ai_deck_failed'));
    setTimeout(() => { row.classList.remove('is-failed'); readAll(); if (row.dataset.ctl === 'light') setName(row, row.querySelector('.ai-ctl-main').getAttribute('aria-label')); }, FAILED_MS);
  }

  const lightRows = (entity) => rowsOf('light').filter((r) => r.dataset.entity === entity);

  function press(row, act) {
    const kind = row.dataset.ctl;
    const on = row.dataset.state === 'on';
    if (kind === 'volume') {
      for (const r of rowsOf('volume')) setState(r, !on);
      call('/speaker/mute').then(() => setTimeout(readAudio, 350), () => { for (const r of rowsOf('volume')) setState(r, on); failed(row); });
    } else if (kind === 'mic') {
      call('/toggle').then((d) => applyMic(!!d.muted), () => failed(row));
    } else if (kind === 'media') {
      const cmd = act === 'main' ? 'playpause' : act;
      call('/media/' + cmd).then(() => setTimeout(() => read('/media', applyMedia), 600), () => failed(row));
    } else if (kind === 'light') {
      const entity = row.dataset.entity;
      for (const r of lightRows(entity)) setState(r, !on);
      call('/api/homeassistant/service', { domain: 'light', service: on ? 'turn_off' : 'turn_on', entityId: entity, data: {} })
        .catch(() => { for (const r of lightRows(entity)) setState(r, on); failed(row); });
    }
  }

  function slide(row, input, commit) {
    const v = Number(input.value);
    setLevel(row, v, true);
    if (row.dataset.ctl === 'volume') {
      clearTimeout(volumeSend);
      volumeSend = setTimeout(() => { call('/volume/set', { level: v }).catch(() => failed(row)); }, commit ? 0 : VOLUME_SEND_MS);
    } else if (row.dataset.ctl === 'light' && commit) {
      const entity = row.dataset.entity;
      call('/api/homeassistant/service', { domain: 'light', service: v > 0 ? 'turn_on' : 'turn_off', entityId: entity, data: v > 0 ? { brightness_pct: v } : {} })
        .then(() => { for (const r of lightRows(entity)) setState(r, v > 0); }, () => failed(row));
    }
  }

  // ── Delegated events: every copy of the chat answers ─────────────────────────
  function rowOf(e, sel) {
    const n = e.target?.closest?.(sel);
    return n ? { n, row: n.closest('.ai-ctl') } : null;
  }

  document.addEventListener('click', (e) => {
    const hit = rowOf(e, 'button[data-ctl-do]');
    if (hit?.row && hit.row.dataset.state !== 'na') press(hit.row, hit.n.dataset.ctlDo);
  });
  document.addEventListener('input', (e) => { const hit = rowOf(e, '.ai-ctl-range'); if (hit) slide(hit.row, hit.n, false); });
  document.addEventListener('change', (e) => { const hit = rowOf(e, '.ai-ctl-range'); if (hit) { held = null; slide(hit.row, hit.n, true); } });
  document.addEventListener('pointerdown', (e) => { const hit = rowOf(e, '.ai-ctl-range'); held = hit ? hit.n : null; });
  for (const end of ['pointerup', 'pointercancel']) document.addEventListener(end, () => { held = null; });

  // ── Keeping them live while they are seen ──────────────────────────────────────
  function inSight(kind) {
    return document.visibilityState === 'visible' && rowsOf(kind).some((r) => r.getClientRects().length > 0);
  }

  function syncWatch(force) {
    const ids = inSight('light') ? Array.from(new Set(rowsOf('light').map((r) => r.dataset.entity))).sort() : [];
    const sig = ids.join(',');
    if (sig === watchSig && !(sig && (force || Date.now() - watchAt >= WATCH_RENEW_MS))) return;
    watchSig = sig;
    watchAt = Date.now();
    call('/ha/deck-watch', { client: WATCH_ID, entities: ids }).catch(() => { watchSig = '?'; });
  }

  // One slow tick while any control exists: the volume asked for while one is seen (and read at
  // once when one comes back into sight), the lights' watch renewed or dropped. No controls, no tick.
  function tick() {
    tickTimer = null;
    syncWatch(false);
    const seen = inSight('volume');
    if (seen && !seenBefore) readAudio();
    else if (seen) fetch(base() + '/audio/watch').catch(() => {});
    seenBefore = seen;
    if (document.querySelector('.ai-ctl')) tickTimer = setTimeout(tick, TICK_MS);
  }

  function on(es, name, apply) {
    es.addEventListener(name, (e) => {
      if (!document.querySelector('.ai-ctl')) return; // nothing to keep live: not even a parse
      try { apply(JSON.parse(e.data)); } catch { /* a broken event changes nothing */ }
    });
  }

  function listen(es) {
    on(es, 'audio', applyAudio);
    on(es, 'status', (d) => { if (d && typeof d.muted === 'boolean') applyMic(d.muted); });
    on(es, 'media', applyMedia);
    on(es, 'ha_states', (d) => applyLights(d?.states));
  }

  window.BitControls = { queue, take, listen };
})();

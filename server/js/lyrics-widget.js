'use strict';
// Lyrics widget (supporter-only): the lyrics of whatever is playing, large,
// over the blurred cover, with a timing nudge for players whose lyrics
// run late. The lyrics themselves are free (the Media tile's button shows them);
// what the pass opens is this tile. Unlock works like Dev cleanup: one redeem
// against the hub, with the saved pass or one typed here, and the generic
// supporter strings are shared with it.
//
// Every instance of the tile (copies included) gets its own LyricsView and
// LyricsCore subscription; nothing is timed or fetched while none is on screen.
(function () {
  const OFFSET_STEP_MS = 100;
  const OFFSET_LIMIT_MS = 3000;
  const NUDGE_SEND_MS = 700;
  // Membership page, counted through the hub (supportUrl in @xenon/core).
  const supportHref = (source) => (window.Xenon && window.Xenon.constants && typeof window.Xenon.constants.supportUrl === 'function')
    ? window.Xenon.constants.supportUrl(source)
    : 'https://www.buymeacoffee.com/marcimastro98/membership';
  // No double quote, backslash or whitespace can leave the url("…") it is
  // written into. Hosts send data: covers (Windows, macOS) or http(s) art URLs
  // (Linux MPRIS); URL-encoded SVG keeps its parentheses, safe inside quotes.
  const SAFE_COVER = /^(?:data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^\s"\\]+|https?:\/\/[^\s"\\]+|\/[^\s"\\]*)$/i;

  const tr = (key, fallback) => {
    const value = typeof window.t === 'function' ? window.t(key) : '';
    return value && value !== key ? value : (fallback != null ? fallback : key);
  };
  const base = () => (typeof SERVER === 'string' ? SERVER : '');
  const uiLangCode = () => (typeof lang === 'string' ? lang : '');

  let unlocked = null;       // null = not asked yet
  let codeSaved = false;
  let codeFormOpen = false;
  let codeDraft = '';
  let unlocking = false;
  let unlockError = '';
  // A trial (feature-unlock.js): the supporter-pass trial, or an old local one
  // still running. trialEndsAt is set only while one runs; trialAvailable when
  // this install never tried the pass; trialUsed once a trial here is over.
  let trialEndsAt = null;
  let trialAvailable = false;
  let trialUsed = false;
  let trialTimer = null;
  const coverOf = new WeakMap();   // panel → the cover it shows
  const instances = new Map();   // mount → { view, unsubscribe, offsetRow, offsetVal, minus, plus }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function btn(cls, label, onClick, disabled) {
    const node = el('button', cls, label);
    node.type = 'button';
    node.disabled = !!disabled;
    node.addEventListener('click', onClick);
    return node;
  }

  async function api(url, body) {
    try {
      const res = await fetch(base() + url, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : { cache: 'no-store' });
      let out = null;
      try { out = await res.json(); } catch { /* empty body */ }
      return out || { ok: false, error: 'http_' + res.status };
    } catch {
      return { ok: false, error: 'offline' };
    }
  }

  // ── unlock ────────────────────────────────────────────────────────────
  const UNLOCK_ERRORS = {
    bad_request: ['devclean_unlock_no_code', 'Inserisci il codice sostenitore qui sotto.'],
    bad_code: ['devclean_unlock_bad_code', 'Il codice salvato non è valido. Inseriscine un altro qui sotto.'],
    expired: ['devclean_unlock_expired', 'Il pass è scaduto. Rinnovalo per sbloccare la funzione.'],
    limit: ['devclean_unlock_limit', 'Il pass è già usato su tre dispositivi.'],
    rate_limited: ['devclean_unlock_rate', 'Troppi tentativi. Riprova tra qualche minuto.'],
    bad_entry: ['devclean_unlock_unavailable', 'Lo sblocco non è ancora attivo sul server dei sostenitori. Riprova più tardi.'],
    trial_used: ['trial_err_used', 'Questo PC ha già usato la sua prova gratuita.'],
  };

  async function loadState() {
    const out = await api('/api/features/lyrics');
    applyStatus(out);
    // During the trial too: a supporter trying the tile keeps it with one tap.
    if (!unlocked || trialEndsAt) {
      const s = await api('/api/community/supporter');
      codeSaved = !!(s && s.saved);
    }
    renderWidgets();
  }

  function applyStatus(out) {
    const ok = !!(out && out.ok);
    unlocked = ok && !!out.unlocked;
    trialEndsAt = ok && Number.isFinite(out.trialEndsAt) ? out.trialEndsAt : null;
    trialAvailable = ok && out.passTrialAvailable === true;
    trialUsed = ok && out.trialEnded === true;
    scheduleTrialEnd();
  }

  // When the week runs out with the tile open, it goes back to the pitch by
  // itself instead of waiting for a reload. One timer, re-armed on every status.
  function scheduleTrialEnd() {
    clearTimeout(trialTimer);
    trialTimer = null;
    if (!trialEndsAt) return;
    const wait = Math.min(2147483647, Math.max(0, trialEndsAt - Date.now()) + 1000);
    trialTimer = setTimeout(() => { trialTimer = null; void loadState(); }, wait);
  }

  // The pass trial starts on the hub's page (email + code); the code then goes
  // in "Ho già un codice" here or in any Store unlock.
  function startTrial() {
    if (window.TrialPass) window.TrialPass.openTry();
  }

  async function unlock() {
    unlocking = true;
    unlockError = '';
    renderAll();
    const out = await api('/api/features/lyrics/unlock', {});
    unlocking = false;
    if (out && out.ok) {
      unlocked = true;
      // A trial code opens the tile until the trial's end, and nothing is owned.
      trialEndsAt = out.passTrial && Number.isFinite(out.trialEndsAt) ? out.trialEndsAt : null;
      trialAvailable = false;
      scheduleTrialEnd();
      renderWidgets();
      if (out.passTrial && window.TrialPass) window.TrialPass.refresh();
      return;
    }
    const err = out && out.error;
    const msg = UNLOCK_ERRORS[err];
    unlockError = msg ? tr(msg[0], msg[1]) : tr('devclean_unlock_network', 'Non riesco a contattare il server dei sostenitori.');
    if (err === 'bad_code' || err === 'bad_request') codeFormOpen = true;
    renderAll();
  }

  async function saveCodeAndUnlock() {
    const code = codeDraft.trim();
    if (!code) return;
    unlocking = true;
    unlockError = '';
    renderAll();
    const out = await api('/api/community/supporter/save', { code });
    if (!out || !out.ok) {
      unlocking = false;
      unlockError = out && out.error === 'bad_code'
        ? tr('devclean_code_format', 'Il codice ha la forma XS-XXXX-XXXX-XXXX. Controllalo nell’email che hai ricevuto.')
        : tr('devclean_unlock_network', 'Non riesco a contattare il server dei sostenitori.');
      renderAll();
      return;
    }
    codeSaved = true;
    codeDraft = '';
    codeFormOpen = false;
    await unlock();
  }

  function renderCodeForm() {
    const form = el('form', 'lyw-code');
    const input = el('input', 'lyw-code-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'XS-XXXX-XXXX-XXXX';
    input.setAttribute('aria-label', tr('devclean_enter_code', 'Inserisci il pass'));
    input.value = codeDraft;
    input.disabled = unlocking;
    input.addEventListener('input', () => { codeDraft = input.value; });
    const submit = el('button', 'lyw-btn is-accent', unlocking
      ? tr('devclean_unlocking', 'Sblocco…') : tr('devclean_code_unlock', 'Salva e sblocca'));
    submit.type = 'submit';
    submit.disabled = unlocking;
    form.append(input, submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); saveCodeAndUnlock(); });
    return form;
  }

  function renderPitch() {
    const box = el('section', 'lyw-pitch');
    box.appendChild(el('span', 'lyw-badge', tr('devclean_supporters', 'Per i sostenitori')));
    box.appendChild(el('p', 'lyw-pitch-lead', tr('lyrics_pitch_lead')));
    box.appendChild(el('p', 'lyw-pitch-desc', tr('lyrics_pitch_desc')));
    const perks = el('ul', 'lyw-perks');
    ['lyrics_perk_offset_song', 'lyrics_perk_translate', 'lyrics_perk_reading', 'lyrics_perk_stage'].forEach((key) => {
      const li = el('li');
      li.append(el('span', 'lyw-tick', '✓'), el('span', '', tr(key)));
      perks.appendChild(li);
    });
    box.appendChild(perks);

    const actions = el('div', 'lyw-actions');
    const busy = unlocking;
    if (codeSaved) {
      actions.appendChild(btn('lyw-btn is-big', unlocking ? tr('devclean_unlocking', 'Sblocco…')
        : tr('devclean_unlock', 'Sblocca con il pass'), unlock, busy));
    } else {
      // A week of the real thing is the best pitch this widget has, so the
      // pass trial leads while this install never had it, joining beside it.
      if (trialAvailable) {
        actions.appendChild(btn('lyw-btn is-big', tr('lyrics_trial_start', 'Prova gratis per 7 giorni'), startTrial, busy));
      }
      const join = el('a', trialAvailable ? 'lyw-btn is-accent' : 'lyw-btn is-big', tr('devclean_join', 'Diventa sostenitore'));
      join.href = supportHref('lyrics');
      join.target = '_blank';
      join.rel = 'noopener noreferrer';
      actions.appendChild(join);
    }
    if (!codeFormOpen) {
      actions.appendChild(btn('lyw-btn is-ghost', codeSaved ? tr('devclean_code_change', 'Usa un altro codice')
        : tr('devclean_code_have', 'Ho già un codice'), () => { codeFormOpen = true; renderAll(); }, busy));
    }
    box.appendChild(actions);
    if (codeFormOpen) box.appendChild(renderCodeForm());
    box.appendChild(el('p', 'lyw-note', pitchNote()));
    if (unlockError) box.appendChild(el('p', 'lyw-error', unlockError));
    return box;
  }

  function pitchNote() {
    if (codeSaved) return tr('devclean_code_saved', 'Su questo PC c’è già un codice sostenitore: sblocca con un tocco.');
    if (trialAvailable) return tr('lyrics_pass_trial_note', 'Una settimana del pass sostenitore, Lyrics compreso: il codice arriva per email. Poi decidi tu.');
    if (trialUsed) return tr('lyrics_trial_ended', 'La settimana di prova è finita. Diventa sostenitore per tenere il widget.');
    return tr('devclean_code_missing', 'Il codice ti arriva per email subito dopo aver sostenuto Xenon.');
  }

  // While a trial runs the tile says until when, with the way to keep it.
  function paintTrial(inst) {
    const on = !!trialEndsAt;
    inst.trialRow.hidden = !on;
    if (!on) return;
    let date = '';
    try {
      date = new Date(trialEndsAt).toLocaleDateString(uiLangCode() || undefined, { day: 'numeric', month: 'long' });
    } catch { date = new Date(trialEndsAt).toLocaleDateString(); }
    inst.trialText.textContent = tr('lyrics_trial_until', 'Prova gratuita fino al {date}').replace('{date}', date);
    // A refused code (ended, wrong) says why, and the way to join comes back.
    if (codeSaved && unlockError) inst.trialText.textContent = unlockError;
    inst.keep.hidden = codeSaved && !unlockError;
    inst.keepUnlock.hidden = !codeSaved || !!unlockError;
    inst.keepUnlock.disabled = unlocking;
  }

  // ── this song's timing ────────────────────────────────────────────────
  // −/+ nudge the song playing now; the server keeps the nudge for that song,
  // added to the global delay (set in the options). Taps are applied at once
  // and sent once they stop, so five quick taps are one request.
  const core = () => window.LyricsCore;
  let sendTimer = null;
  let confirmed = { songKey: '', delta: 0 };

  function songDelta() {
    const s = core().current();
    return Number.isFinite(s.songOffset) ? s.songOffset : 0;
  }
  function nudge(step) {
    const snap = core().current();
    if (!snap.songKey) return;
    if (confirmed.songKey !== snap.songKey) confirmed = { songKey: snap.songKey, delta: songDelta() };
    const global = core().globalOffsetMs();
    const total = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, core().offsetMs() + step));
    const delta = Math.round((total - global) / OFFSET_STEP_MS) * OFFSET_STEP_MS;
    if (delta === songDelta()) return;
    core().setSongOffset(snap.songKey, delta);
    instances.forEach(paintOffset);
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => { sendTimer = null; void sendNudge(snap.songKey, delta); }, NUDGE_SEND_MS);
  }
  async function sendNudge(songKey, delta) {
    const out = await api('/api/lyrics/offset', { key: songKey, ms: delta });
    if (out && out.ok) { confirmed = { songKey, delta }; return; }
    // Not saved (song changed meanwhile, or offline): show what is really kept.
    if (core().current().songKey === songKey) {
      core().setSongOffset(songKey, confirmed.songKey === songKey ? confirmed.delta : 0);
      instances.forEach(paintOffset);
    }
    if (typeof showHubToast === 'function') showHubToast(tr('layout_widget_lyrics', 'Lyrics'), tr('lyrics_offset_not_saved'), '');
  }
  function offsetLabel(ms) {
    const s = (ms / 1000).toLocaleString((typeof lang === 'string' && lang) || undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return (ms > 0 ? '+' : '') + s + ' s';
  }
  function paintOffset(inst) {
    const ms = core().offsetMs();
    const own = songDelta() !== 0;
    inst.offsetVal.textContent = offsetLabel(ms);
    inst.offsetVal.classList.toggle('is-song', own);
    inst.offsetVal.disabled = !own;
    inst.offsetVal.title = own ? tr('lyrics_offset_song_reset') : tr('lyrics_offset');
    inst.minus.disabled = ms <= -OFFSET_LIMIT_MS;
    inst.plus.disabled = ms >= OFFSET_LIMIT_MS;
  }

  // ── translation status ────────────────────────────────────────────────
  const TR_MESSAGES = {
    waiting: 'lyrics_tr_waiting',
    loading: 'lyrics_tr_loading',
    same: 'lyrics_tr_same',
    cap: 'lyrics_tr_cap',
    no_ai: 'lyrics_tr_no_ai',
    no_credits: 'lyrics_tr_no_credits',
    failed: 'lyrics_tr_failed',
    too_long: 'lyrics_tr_too_long',
  };
  const TR_QUIET = new Set(['off', 'idle', 'checking', 'ready']);

  function paintTranslation(inst) {
    const T = window.LyricsTranslation;
    const status = T ? T.status() : 'off';
    const quiet = TR_QUIET.has(status);
    inst.trStat.hidden = quiet;
    if (!quiet) inst.trStat.textContent = tr(TR_MESSAGES[status] || 'lyrics_tr_unavailable');
    inst.view.setExtras(T && (status === 'ready' || status === 'same') ? T.extras() : null);
  }

  // ── unlocked tile ─────────────────────────────────────────────────────
  function buildTile(mount) {
    const head = el('div', 'lyw-head');
    const titles = el('div', 'lyw-titles');
    const title = el('div', 'lyw-title');
    const sub = el('div', 'lyw-sub');
    titles.append(title, sub);
    const offsetRow = el('div', 'lyw-offset');
    offsetRow.setAttribute('role', 'group');
    offsetRow.setAttribute('aria-label', tr('lyrics_offset'));
    const minus = btn('lyw-step', '−', () => nudge(-OFFSET_STEP_MS));
    minus.setAttribute('aria-label', tr('lyrics_offset_later'));
    minus.title = tr('lyrics_offset_later');
    // The value doubles as "forget this song's nudge" once it has one.
    const offsetVal = btn('lyw-offset-val', '', () => nudge(-songDelta()));
    const plus = btn('lyw-step', '+', () => nudge(OFFSET_STEP_MS));
    plus.setAttribute('aria-label', tr('lyrics_offset_earlier'));
    plus.title = tr('lyrics_offset_earlier');
    offsetRow.append(minus, offsetVal, plus);
    // The song's cover beside its name, and the player's own controls: the
    // lyrics are read from a distance, so pausing or skipping must not need a
    // walk to the Media tile.
    const cover = el('img', 'lyw-cover');
    cover.alt = '';
    cover.decoding = 'async';
    cover.hidden = true;
    const transport = el('div', 'lyw-transport-row');
    transport.setAttribute('role', 'group');
    transport.setAttribute('aria-label', tr('tip_play', 'Play/Pause'));
    const prevBtn = transportBtn(GLYPH_PREV, tr('tip_prev', 'Previous'), () => { if (typeof mediaAction === 'function') void mediaAction('previous'); });
    const playBtn = transportBtn(GLYPH_PLAY, tr('tip_play', 'Play/Pause'), () => {
      if (typeof mediaAction !== 'function') return;
      void mediaAction('playpause');
      // mediaAction flips the state before it awaits: repaint the glyph now.
      core().sync();
    });
    const nextBtn = transportBtn(GLYPH_NEXT, tr('tip_next', 'Next'), () => { if (typeof mediaAction === 'function') void mediaAction('next'); });
    transport.append(prevBtn.node, playBtn.node, nextBtn.node);
    const panel = mount.closest('.lyrics-panel');
    const stageBtn = iconBtn('lyw-icon', ICON_STAGE, tr('lyrics_stage'), () => { if (panel && window.LyricsStage) window.LyricsStage.toggle(panel); });
    const optBtn = iconBtn('lyw-icon', ICON_OPTIONS, tr('lyrics_opt_title'), () => toggleOptions(mount));
    head.append(cover, titles, transport, offsetRow, stageBtn, optBtn);
    const trStat = el('p', 'lyw-trstat');
    trStat.hidden = true;
    const trialRow = el('p', 'lyw-trial');
    const trialText = el('span');
    const keep = el('a', '', tr('devclean_join', 'Diventa sostenitore'));
    keep.href = supportHref('lyrics-trial');
    keep.target = '_blank';
    keep.rel = 'noopener noreferrer';
    // A PC that keeps a supporter code unlocks right here instead.
    const keepUnlock = btn('lyw-trial-unlock', tr('devclean_unlock', 'Sblocca con il pass'), () => { void unlock(); });
    trialRow.append(trialText, keep, keepUnlock);
    const body = el('div', 'lyw-body');
    mount.replaceChildren(head, trialRow, trStat, body);
    mount.dataset.lywReady = '1';

    const inst = { lang: uiLangCode(), title, sub, cover, transport, playPath: playBtn.path, offsetRow, offsetVal, minus, plus, trStat, trialRow, trialText, keep, keepUnlock, view: window.LyricsView.create(body) };
    paintTrial(inst);
    const isVisible = () => mount.isConnected && mount.getClientRects().length > 0 && !document.hidden && onVisiblePage(mount);
    inst.unsubscribe = window.LyricsCore.subscribe({
      isVisible,
      render: (snap) => paintTile(mount, inst, snap, isVisible()),
    });
    inst.unlisten = window.LyricsTranslation ? window.LyricsTranslation.subscribe(() => paintTranslation(inst)) : () => {};
    paintOffset(inst);
    paintTranslation(inst);
    return inst;
  }

  function toggleOptions(mount) {
    const O = window.LyricsWidgetOptions;
    if (!O) return;
    if (O.isOpen(mount)) O.close(mount);
    else O.open(mount, () => instances.forEach(paintOffset));
  }

  function paintTile(mount, inst, snap, visible) {
    const m = typeof mediaData === 'object' && mediaData && snap.state !== 'idle' && snap.state !== 'off' ? mediaData : null;
    inst.title.textContent = (m && (typeof cleanTitle === 'function' ? cleanTitle(m.title) : m.title)) || tr('layout_widget_lyrics', 'Lyrics');
    inst.sub.textContent = (m && (m.artist || m.album)) || '';
    inst.sub.hidden = !inst.sub.textContent;
    inst.transport.hidden = !m;
    inst.playPath.setAttribute('d', snap.playing ? GLYPH_PAUSE : GLYPH_PLAY);
    paintHeadCover(inst, m);
    inst.offsetRow.hidden = snap.state !== 'synced';
    paintOffset(inst);
    inst.view.render(snap);
    if (window.LyricsTranslation) window.LyricsTranslation.update(snap, visible);
    paintCover(mount, m);
  }

  // ── icons ─────────────────────────────────────────────────────────────
  const ICON_STAGE = 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5';
  const ICON_OPTIONS = 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4';
  // Transport glyphs are solid shapes, unlike the outline icons above.
  const GLYPH_PREV = 'M6 5h2v14H6zM20 5v14L9 12z';
  const GLYPH_NEXT = 'M16 5h2v14h-2zM4 5v14l11-7z';
  const GLYPH_PLAY = 'M8 5v14l11-7z';
  const GLYPH_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';
  function transportBtn(d, label, onClick) {
    const b = iconBtn('lyw-icon lyw-transport', d, label, onClick);
    return { node: b, path: b.querySelector('path') };
  }
  function iconBtn(cls, d, label, onClick) {
    const b = btn(cls, null, onClick);
    b.setAttribute('aria-label', label);
    b.title = label;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    b.appendChild(svg);
    return b;
  }

  function paintHeadCover(inst, m) {
    const raw = (m && m.thumbnail) || '';
    const src = SAFE_COVER.test(raw) ? raw : '';
    inst.cover.hidden = !src;
    if (inst.cover.getAttribute('src') !== src) { if (src) inst.cover.src = src; else inst.cover.removeAttribute('src'); }
  }

  // The cover, blurred and darkened behind the lyrics like the Media tile's
  // lyrics mode. Only an image the dashboard itself could show is used: the
  // host's data: thumbnail, an http(s) cover, or a path on this server.
  function paintCover(mount, m) {
    const panel = mount.closest('.lyrics-panel');
    if (!panel) return;
    const raw = (m && m.thumbnail) || '';
    const thumb = SAFE_COVER.test(raw) ? raw : '';
    if (coverOf.get(panel) === thumb) return;
    coverOf.set(panel, thumb);
    panel.classList.toggle('has-cover', !!thumb);
    if (thumb) panel.style.setProperty('--lyw-cover', 'url("' + thumb + '")');
    else panel.style.removeProperty('--lyw-cover');
  }

  function release(mount) {
    const inst = instances.get(mount);
    if (!inst) return;
    inst.unsubscribe();
    inst.unlisten();
    inst.view.destroy();
    delete mount.dataset.lywReady;
    const panel = mount.closest('.lyrics-panel');
    if (panel && window.LyricsStage && window.LyricsStage.isStaged(panel)) window.LyricsStage.exit();
    instances.delete(mount);
  }

  function renderAll() {
    for (const mount of [...instances.keys()]) if (!mount.isConnected) release(mount);
    document.querySelectorAll('.lyrics-widget-mount').forEach((mount) => {
      if (!unlocked) {
        release(mount);
        mount.replaceChildren(unlocked === null ? el('p', 'lyw-note', tr('devclean_loading', 'Carico…')) : renderPitch());
        return;
      }
      // The buttons carry their labels from when they were built: a language
      // switch rebuilds the tile.
      const inst = instances.get(mount);
      if (inst && inst.lang !== uiLangCode()) release(mount);
      // A copy is cloned from the primary and arrives with its dead DOM.
      if (!instances.has(mount)) instances.set(mount, buildTile(mount));
      else { paintOffset(instances.get(mount)); paintTrial(instances.get(mount)); }
    });
  }

  // A tile shown later (page turn, tab switch, added from the palette) must
  // start by itself; the tile ships hidden, so the state is asked only once one
  // is laid out.
  const watched = new WeakSet();
  const seen = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(() => { renderWidgets(); if (window.LyricsCore) window.LyricsCore.sync(); }, { threshold: 0.01 })
    : null;

  function renderWidgets() {
    const mounts = document.querySelectorAll('.lyrics-widget-mount');
    if (!mounts.length) { renderAll(); return; }
    if (seen) mounts.forEach((m) => { if (!watched.has(m)) { watched.add(m); seen.observe(m); } });
    const shown = [...mounts].some((m) => m.getClientRects().length > 0);
    if (unlocked === null && shown) { void loadState(); return; }
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderWidgets);
  else renderWidgets();

  window.LyricsWidget = { renderWidgets };
})();

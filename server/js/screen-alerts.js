'use strict';

// The on-screen alerts window of "widgets only" (screen-alerts.html).
//
// With no dashboard window, nothing showed the pop-ups the dashboard shows: a
// saved screenshot or replay, a timer that ended, a Guardian warning, a goal,
// a camera, a Deck shortcut that failed. The shell opens this page in a
// transparent overlay window over the main screen (layers `alerts:` surface,
// js/layers-shell.js) and cuts the window to the cards, so every click outside
// a card goes to whatever is under it.
//
// On macOS and Linux the same window also opens, dashboard or not, for the few
// seconds Bit's vitals popup shows (server/vitals-nag.js): the only window that
// can draw over the user's work there.
//
// The cards are the dashboard's own (toast.js, Toast.css) and say the same
// thing (alert-toasts.js, capture-toast.js, deck-error-text.js). A viewer: it
// reads the settings and never writes them.

// The settings toast.js, audio-feedback.js and capture-toast.js read, as on the
// dashboard. Never saved.
let hubSettings = {};

(function () {
  const SETTINGS_RETRY_MS = 5000;
  const SETTINGS_EVENT_DELAY_MS = 400;
  const OS_THEME_POLL_MS = 5 * 60 * 1000;
  // A card moves in for ~0.5 s (Toast.css): the window is cut again once it settled.
  const SETTLE_MS = 600;
  // Room for the card's shadow around its rectangle, CSS pixels.
  const SHADOW_PAD = 10;

  let osDark = null;
  let settingsTimer = null;
  let gaming = false;
  let gameKnown = false;   // nothing about an update opens before the first status says

  const tt = (key, fallback) => {
    const v = t(key);
    return v && v !== key ? v : fallback;
  };
  const ctx = () => ({ t: tt, hwF: hwTempIsF() });

  // ── What the user chose ────────────────────────────────────────
  const notifications = () => (hubSettings && hubSettings.notifications) || {};
  const onScreen = () => notifications().onScreen !== false;
  // Routine alerts follow the master Notifiche switch, like on the dashboard.
  const popups = () => onScreen() && window.AlertToasts.popupsAllowed(notifications());
  // The window also opens with the dashboard up, for Bit's vitals popup alone
  // (js/layers-shell.js): the dashboard then shows every other alert itself.
  const routine = () => !!window.UsageMode && window.UsageMode.widgetsOnly(hubSettings && hubSettings.usageMode);
  const guardianOn = () => {
    const f = hubSettings && hubSettings.aiFeatures;
    return !!(f && f.enabled === true && f.guardian === true);
  };
  // The hardware unit, as js/system.js hwTempIsF() reads it.
  function hwTempIsF() {
    const hs = hubSettings || {};
    return hs.hwTempUnit === 'f' || hs.hwTempUnit === 'c' ? hs.hwTempUnit === 'f' : hs.tempUnit === 'f';
  }

  function show(toast) {
    return toast && onScreen() && window.XenonToast ? window.XenonToast.show(toast) : 0;
  }

  // ── Theme and language, as the light layer page applies them ───
  function resolveAppearance(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    if (typeof osDark === 'boolean') return osDark ? 'dark' : 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme() {
    const root = document.documentElement;
    const skin = ThemeTokens.applySkin(root, hubSettings);
    const palette = ThemeTokens.derivePalette(hubSettings, { resolve: resolveAppearance });
    ThemeTokens.applyPalette(root, palette);
    ThemeTokens.applyMaterial(root, hubSettings, palette, skin);
    ThemeTokens.applyFont(document, hubSettings.uiFont);
  }

  async function readOsTheme() {
    if (hubSettings.appearance !== 'auto') return;
    try {
      const res = await fetch(SERVER + '/system/theme');
      const data = res.ok ? await res.json() : null;
      if (!data || typeof data.osDark !== 'boolean' || data.osDark === osDark) return;
      osDark = data.osDark;
      applyTheme();
    } catch (e) { /* the media query stays the answer */ }
  }

  // Game mode holds routine cards back (toast.js do-not-disturb), as on the
  // dashboard: the same switch, the same class.
  function applyGameClass() {
    document.body.classList.toggle('game-mode', gaming && hubSettings.gameMode !== false);
  }

  async function loadSettings() {
    try {
      const res = await fetch(SERVER + '/settings', { cache: 'no-store' });
      const data = res.ok ? await res.json() : null;
      if (data && data.settings && typeof data.settings === 'object') return data.settings;
    } catch (e) { /* server restarting: retried below */ }
    return null;
  }

  function apply(next) {
    const langBefore = lang;
    // Bit talks here as the dashboard's transparent voice mode (screen-bit.js):
    // the opaque full room would cover the user's work.
    hubSettings = { ...next, aiVoiceAmbient: true };
    lang = normalizeLangCode(hubSettings.language) || lang;
    // This page holds the languages it was served with (/layer-i18n.js): a
    // language picked since then needs a reload, the server now sends it.
    if (lang !== langBefore && !i18n[lang]) { window.location.reload(); return; }
    document.documentElement.lang = lang;
    applyTheme();
    applyGameClass();
    if (window.AiEdgeGlow) window.AiEdgeGlow.refresh();
  }

  async function refreshSettings() {
    const next = await loadSettings();
    if (!next) { setTimeout(refreshSettings, SETTINGS_RETRY_MS); return; }
    apply(next);
    readOsTheme();
  }

  function onSettingsEvent() {
    if (settingsTimer) return;
    settingsTimer = setTimeout(() => { settingsTimer = null; refreshSettings(); }, SETTINGS_EVENT_DELAY_MS);
  }

  // ── The window follows the cards ───────────────────────────────
  // The shell cuts the window to these rectangles (layers/mod.rs `alert-rects`):
  // no card, no window, and every click goes through.
  const inShell = window.__XENON_LAYER_SHELL__ === true;
  let lastSignal = null;
  let frame = 0;
  let settleTimer = null;
  let loaded = false;

  // The cards that take the screen: pop-ups, an incoming call, Bit talking,
  // the Game Companion. The island counts twice: the card in its slot has the
  // final size from the first frame, so the glass grows inside the cut, and the
  // glass itself is what is left to show while it closes with the card gone.
  const CARDS = '.xtoast-stack > .xtoast:not(.xtoast-out, .xtoast-leaving), .call-overlay > .call-card, body.ai-voice-mode .ai-voice-stage, .gc-overlay:not([hidden]) > .gc-card, .rn-corner, .wn-stage:not([hidden]), .bm-card, .bm-stage, .xisland-slot > *, .xisland-bg';

  function cutBox(card) {
    const r = card.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return '';
    const dpr = window.devicePixelRatio || 1;
    const box = [r.left - SHADOW_PAD, r.top - SHADOW_PAD, r.width + 2 * SHADOW_PAD, r.height + 2 * SHADOW_PAD];
    return box.map((v) => Math.round(v * dpr)).join(',');
  }

  // A card sliding into a gap would be clipped by a cut that waits for it to stop.
  let moving = false;

  function cardRects() {
    const out = [];
    moving = false;
    document.querySelectorAll(CARDS).forEach((card) => {
      if (card.closest('.is-rolling')) return;
      const box = cutBox(card);
      if (!box) return;
      out.push(box);
      if (card.getAnimations && card.getAnimations().some((a) => a.playState === 'running')) moving = true;
    });
    return out.join(';');
  }

  const cutSignal = () => 'xenon-app:alert-rects?d=' + encodeURIComponent(cardRects());
  function signalShell(signal) {
    try { window.location.href = (window.__xenonSignal || String)(signal); } catch (e) { /* not native */ }
  }

  function report() {
    frame = 0;
    const signal = cutSignal();
    if (moving) frame = requestAnimationFrame(report);
    if (signal === lastSignal) return;
    lastSignal = signal;
    signalShell(signal);
  }

  // Windows only, and never for someone who asked for less motion: js/toast.js
  // and js/toast-island.js then leave a card to the shell (js/alert-roll.js).
  const rollsCards = inShell && window.__XENON_ROLL_CARDS__ === true;
  const calm = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (rollsCards) {
    const cards = (el) => (el.matches(CARDS) ? [el] : Array.from(el.querySelectorAll(CARDS)));
    const roll = window.AlertRoll.create({
      rectsOf: (el) => cards(el).map(cutBox).filter(Boolean),
      send: (rects) => {
        lastSignal = cutSignal();
        signalShell(lastSignal + '&roll=' + encodeURIComponent(rects));
      },
      changed: () => scheduleReport(),
    });
    window.XenonAlertRoll = { away: (el) => (calm() ? null : roll.away(el)) };
  }

  // Now, and again once the card has moved in or out.
  function scheduleReport() {
    if (!inShell || !loaded) return;
    if (!frame) frame = requestAnimationFrame(report);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(report, SETTLE_MS);
  }

  function watchCards() {
    new MutationObserver(scheduleReport).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    window.addEventListener('resize', scheduleReport);
    document.addEventListener('transitionend', scheduleReport, true);
    window.XenonNative.afterLoad(() => { loaded = true; scheduleReport(); });
  }

  // ── Alerts ─────────────────────────────────────────────────────
  const parse = (e) => { try { return JSON.parse(e.data); } catch (err) { return null; } };

  function postChime(kind) {
    fetch(SERVER + '/api/chime', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
    }).catch(() => {});
  }

  // Played by the server, once per timer even when a dashboard asks too.
  const chime = () => postChime('wake');

  // This page never gets a click, so its AudioContext stays suspended and the
  // cards' cues (audio-feedback.js) would be silent: the server plays them, as
  // it plays the timer chime (which is why 'timer' is not here).
  const SERVER_CUES = Object.freeze(['notification', 'update', 'warning', 'error']);
  function playCue(type) {
    if (SERVER_CUES.includes(type) && notifSoundsOn()) postChime(type);
  }

  // The call's ring, same cycle as audio-feedback.js setRinging (RING_CYCLE_MS),
  // which call-modal.js asks for on every paint: idempotent the same way.
  const RING_EVERY_MS = 2600;
  let ringTimer = null;
  function ringOnServer(on) {
    if (on && !notifSoundsOn()) return;
    if (on) {
      if (ringTimer) return;
      postChime('ring');
      ringTimer = setInterval(() => postChime('ring'), RING_EVERY_MS);
    } else if (ringTimer) {
      clearInterval(ringTimer);
      ringTimer = null;
    }
  }

  // A calendar reminder rings whatever the Notifiche switches say, like on the
  // dashboard; its own four-burst alarm comes from the server.
  function reminder(d) {
    if (!onScreen()) return;
    if (notifSoundsOn()) postChime('reminder');
    const fmt = new Intl.DateTimeFormat(tt('locale', 'en'), timeParts({ weekday: 'short' }));
    show(AlertToasts.reminder(d, ctx(), (date) => fmt.format(date)));
  }

  // The automatic update's last minute: one card, closed when the countdown
  // ends any other way (cancelled, applying, failed).
  let autoUpdateToastId = 0;
  function autoUpdate(d) {
    if (autoUpdateToastId) window.XenonToast.dismiss(autoUpdateToastId);
    autoUpdateToastId = show(AlertToasts.autoUpdate(d, ctx(), postponeAutoUpdate));
  }
  function postponeAutoUpdate() {
    fetch(SERVER + '/update/auto/postpone', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(() => {});
  }

  // A newer Xenon, with no dashboard to say so: the card opens the dashboard on
  // the update screen (the shell takes that one signal from this window only,
  // layers::spec::dashboard_page). The skip is js/update.js's own key.
  const UPDATE_CHECK_MS = 6 * 3600 * 1000;
  const UPDATE_SKIP_KEY = 'xenon.update.dismissed';
  const bareVersion = (v) => String(v || '').replace(/^v/i, '');
  let updateShownFor = '';
  function skippedVersion() {
    try { return bareVersion(localStorage.getItem(UPDATE_SKIP_KEY)); } catch { return ''; }
  }
  function skipVersion(v) {
    try { localStorage.setItem(UPDATE_SKIP_KEY, v); } catch { /* the card simply returns next launch */ }
  }
  async function checkUpdate() {
    if (!onScreen() || !routine()) return;
    let info = null;
    try {
      const res = await fetch(SERVER + '/update/check');
      info = res.ok ? await res.json() : null;
    } catch { return; }
    const v = info && info.updateAvailable === true ? bareVersion(info.latest) : '';
    if (!v || v === updateShownFor || v === skippedVersion()) return;
    updateShownFor = v;
    show(AlertToasts.updateAvailable(info, ctx(), openUpdate, () => skipVersion(v)));
  }
  const openDashboard = (page) => {
    window.location.href = (window.__xenonSignal || String)('xenon-app:open-dashboard?open=' + page);
  };
  const openUpdate = () => openDashboard('update');
  // The Store is not in this window: "Recharge" opens its Sparks where a hub
  // message opens the Store (js/bit-messages.js), never a browser window here.
  window.CommunityGallery = { openSparks: () => window.BitMessages.openSheet({ open: 'sparks' }) };
  // "Widgets only" means no dashboard: what needs one is a choice, made in the menu.
  const openMode = () => fetch(SERVER + '/screen-menu', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: true, section: 'mode' }),
  }).catch(() => { /* the server is restarting */ });

  function revealBenchmark() {
    fetch(SERVER + '/actions/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'benchmark', mode: 'reveal' }),
    }).catch(() => {});
  }

  // Performance Mode runs in the hidden driver page (js/driver-perf.js) and shows
  // itself here: the suggestion as Bit's question, whose keys answer it, and what an
  // optimize or restore did. One question at a time, and not for long: the game is
  // in front of it, so unlike the dashboard's it cannot just stay.
  const PERF_PROMPT_MS = 20000;
  let closePrompt = null;
  function closePerfPrompt() {
    if (closePrompt) closePrompt();
    closePrompt = null;
  }
  function answerPerf(choice) {
    closePerfPrompt();
    fetch(SERVER + '/api/performance/screen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'answer', choice }),
    }).catch(() => {});
  }
  function askPerf(activity) {
    const parts = onScreen() ? AlertToasts.perfPrompt(activity, ctx(), answerPerf) : null;
    if (!parts) return;
    closePrompt = window.XenonBitCard.ask(parts, {
      bit: window.XenonReleaseNotes.bit,
      lasts: { ms: PERF_PROMPT_MS, over: closePerfPrompt },
    });
  }
  function perfScreen(d) {
    if (d.kind === 'prompt') {
      closePerfPrompt();
      if (d.activity) askPerf(d.activity);
    } else if (d.kind === 'toast') {
      show(AlertToasts.perfNote(d.note, d.tone, ctx()));
    } else if (d.kind === 'answer') {
      closePerfPrompt();   // Bit, or another surface, answered it
    }
  }

  // A Deck key's shortcut reached "talk to Xenon AI": with no dashboard, Bit
  // answers here. The first claim wins (main.js claims the same way).
  function claimDeckStep(d) {
    if (!onScreen() || !window.ScreenBit || !d || !window.ScreenBit.claims(d.action)) return;
    fetch(SERVER + '/deck/shortcut-claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: d.nonce }),
    }).then((r) => (r.ok ? r.json() : null)).then((r) => {
      if (r && r.ok) window.ScreenBit.wake();
    }).catch(() => { /* a dashboard took it, or nobody: the server says so */ });
  }

  // Bit's vitals popup (server/vitals-nag.js): the user turned it on in Bit
  // Vitals, so the Notifiche switches do not hold it. Once per popup, from SSE
  // or from the boot read, whichever comes first.
  let vitalsShown = '';
  function vitalsPopup(d) {
    const card = AlertToasts.vitals(d);
    const id = card && String(d.until) + '|' + card.title;
    if (!card || id === vitalsShown || !window.XenonToast) return;
    vitalsShown = id;
    window.XenonToast.show(card);
  }
  async function readVitalsPopup() {
    try {
      const res = await fetch(SERVER + '/api/vitals/popup', { cache: 'no-store' });
      const body = res.ok ? await res.json() : null;
      if (body && body.popup) vitalsPopup(body.popup);
    } catch (e) { /* none, or the server is restarting: SSE vitals_nag brings the next */ }
  }

  // The menu's window says these itself, on its result line.
  let menuUp = false;
  const unlessMenu = (handle) => (d) => { if (!menuUp) handle(d); };
  const onMenu = (d) => { menuUp = !!d && d.open === true && !d.sheet; };

  async function readMenu() {
    try {
      const res = await fetch(SERVER + '/screen-menu', { cache: 'no-store' });
      if (res.ok) onMenu(await res.json());
    } catch (e) { /* the server is restarting: SSE screen_menu brings the next */ }
  }

  // Every event but Bit's vitals popup and the menu's state is for the window of
  // "widgets only".
  const ALWAYS = Object.freeze({ vitals_nag: vitalsPopup, screen_menu: onMenu });

  const HANDLERS = Object.freeze({
    stocks_alert: (d) => { if (popups()) show(AlertToasts.stocks(d, ctx())); },
    football_alert: (d) => { if (popups()) show(AlertToasts.football(d, ctx())); },
    unifi_event: (d) => { if (popups()) show(AlertToasts.unifi(d, ctx())); },
    guardian_alert: (d) => { if (guardianOn()) show(AlertToasts.guardian(d, ctx())); },
    timer_done: (d) => { if (!onScreen()) return; chime(); show(AlertToasts.timerDone(d && d.label, ctx())); },
    timer_chime: (d) => { if (!onScreen()) return; chime(); show(AlertToasts.timerChime(d && d.label, d && d.every, ctx())); },
    calendar_reminder: reminder,
    update_auto: (d) => {
      autoUpdate(d);
      if (d.phase === 'done' || d.phase === 'failed') window.ScreenRelease.check();
    },
    benchmark: (d) => show(AlertToasts.benchmark(d, ctx(), revealBenchmark)),
    stutter_why: unlessMenu((d) => show(AlertToasts.stutterWhy(d, ctx()))),
    exclusive_hint: (d) => { if (onScreen()) show(AlertToasts.exclusiveHint(d, ctx())); },
    fps_access: (d) => { if (onScreen()) show(AlertToasts.fpsAccess(d, ctx())); },
    deck_shortcut_failed: (d) => show(DeckErrorText.shortcutFailed(d, tt)),
    xenon_menu_failed: unlessMenu((d) => show(DeckErrorText.menuFailed(d, tt))),
    // The whole ringing list (calls.js): an empty one closes the card.
    calls: (d) => { if (window.CallModal) window.CallModal.onCalls(onScreen() ? d : { calls: [] }); },
    capture: unlessMenu((d) => { if (onScreen()) CaptureToast.onCapture(d); }),
    recording: (d) => { if (onScreen()) CaptureToast.onRecording(d); },
    steps: (d) => { if (onScreen()) CaptureToast.onSteps(d); },
    replay: (d) => { if (onScreen()) CaptureToast.onReplay(d); },
    capture_marker: unlessMenu((d) => { if (onScreen()) CaptureToast.onMarker(d); }),
    capture_export: (d) => { if (onScreen()) CaptureToast.onExport(d); },
    // "Hey Xenon": the server arms it here only while this window is on.
    wake: () => { if (onScreen() && window.ScreenBit) window.ScreenBit.wake(); },
    // The voice session's own signals, as main.js relays them to ai.js.
    stt_silence: (d) => { if (typeof window._aiOnSttSilence === 'function') window._aiOnSttSilence(d.id); },
    speak_start: () => { if (typeof window._aiOnSpeakStart === 'function') window._aiOnSpeakStart(); },
    deck_shortcut: claimDeckStep,
    // A Deck key, its shortcut or the voice opened the Game Companion card.
    game_companion: (d) => { if (window.ScreenCompanion) window.ScreenCompanion.open(d); },
    needs_dashboard: () => show(AlertToasts.needsDashboard(ctx(), openMode)),
    perf_screen: perfScreen,
  });

  function onStatus(e) {
    const d = parse(e);
    // Only a full payload says whether a game runs (see main.js).
    if (!d || (d.gaming == null && d.gameRunning == null)) return;
    const wasGaming = gaming;
    const first = !gameKnown;
    gameKnown = true;
    gaming = !!d.gaming;
    applyGameClass();
    if (first || (wasGaming && !gaming)) {
      window.ScreenRelease.check();
      window.BitMessages.check();
    }
  }

  function connect() {
    const es = new EventSource(SERVER + '/sse');
    const listen = (event, handle, always) => {
      es.addEventListener(event, (e) => {
        if (!always && !routine()) return;
        const d = parse(e);
        if (d && typeof d === 'object') { try { handle(d); } catch (err) { /* one bad event never stops the rest */ } }
      });
    };
    for (const [event, handle] of Object.entries(HANDLERS)) listen(event, handle, false);
    for (const [event, handle] of Object.entries(ALWAYS)) listen(event, handle, true);
    es.addEventListener('status', onStatus);
    es.addEventListener('settings', onSettingsEvent);
    // SSE has no replay: a save made while the stream was down is read on reconnect.
    es.addEventListener('open', () => {
      onSettingsEvent();
      window.ScreenRelease.check();
      window.BitMessages.check();
    });
    es.addEventListener('bit-messages', () => window.BitMessages.check());
  }

  async function boot() {
    const first = await loadSettings();
    if (!first) { setTimeout(boot, SETTINGS_RETRY_MS); return; }
    apply(first);
    readOsTheme();
    setInterval(readOsTheme, OS_THEME_POLL_MS);
    if (window.XenonSound) Object.assign(window.XenonSound, { play: playCue, ring: ringOnServer });
    // A call already ringing when this window opened.
    if (window.CallModal && onScreen() && routine()) window.CallModal.seed();
    watchCards();
    connect();
    readVitalsPopup();
    readMenu();
    checkUpdate();
    setInterval(checkUpdate, UPDATE_CHECK_MS);
    window.ScreenRelease.start({
      server: SERVER,
      ready: () => gameKnown && routine() && onScreen() && !document.body.classList.contains('game-mode'),
      tr: (key) => tt(key, key),
      seen: () => ({ whatsNew: hubSettings.whatsNewSeen, notes: hubSettings.releaseNotesSeen, updateFail: hubSettings.updateFailSeen }),
      openUpdate,
      openDashboard,
    });
    window.BitMessages.start({
      ready: () => gameKnown && routine() && onScreen() && !document.body.classList.contains('game-mode'),
      tr: (key) => tt(key, key),
    });
  }

  // screen-bit.js reloads this page to give Bit's memory back, never under a
  // card someone is reading or a call that rings.
  const ALERT_CARDS = '.xtoast-stack > .xtoast, .call-overlay > .call-card, .gc-overlay:not([hidden]) > .gc-card, .rn-corner, .wn-stage, .bm-card, .bm-stage, .xisland-slot > *';
  window.ScreenAlerts = Object.freeze({
    busy: () => [...document.querySelectorAll(ALERT_CARDS)].some((c) => c.getBoundingClientRect().width > 0),
  });

  boot();
})();

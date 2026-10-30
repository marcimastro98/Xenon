'use strict';
// The Deck's live states from the stream: the events main.js hands the
// dashboard deck, for a page that runs deck.js without the dashboard (the
// Virtual Deck popup, a light layer page). attach() adds the listeners to an
// EventSource the page already has.
(function () {
  // Vitals keys (live source 'vitals'): no vitals.js here, so the meters come
  // from the saved settings through the same math (js/vitals-core.js). The
  // settings are read only while a Vitals key is on screen, again after each
  // save, and the Deck repaints only when a whole percent changes.
  const VITALS_EVERY_MS = 5000;
  let vitalsCfg = null;
  let vitalsStale = true;
  let vitalsLoading = false;
  let vitalsSig = '';
  let vitalsTimer = 0;
  const hasVitalsKey = () => Array.from(document.querySelectorAll('[data-live-bound]')).some((n) => n._deckLive && n._deckLive.source === 'vitals');
  const vitalName = (id) => (typeof window.t === 'function' ? window.t('vitals_' + id) : id);
  function pushVitals() {
    if (!window.Deck || !window.VitalsCore || !vitalsCfg) return;
    const snap = window.VitalsCore.snapshot(vitalsCfg, Date.now());
    const vitals = { enabled: snap.enabled, meters: snap.meters.map((m) => ({ id: m.id, percent: m.percent, name: vitalName(m.id) })) };
    const sig = JSON.stringify(vitals);
    if (sig === vitalsSig) return;
    vitalsSig = sig;
    window.Deck.refreshStates({ vitals });
  }
  async function loadVitals() {
    vitalsLoading = true;
    try {
      const res = await fetch((typeof SERVER === 'string' ? SERVER : '') + '/settings', { cache: 'no-store' });
      const data = res.ok ? await res.json() : null;
      if (data && data.settings && typeof data.settings === 'object') {
        vitalsCfg = data.settings.vitals || { enabled: false };
        vitalsStale = false;
      }
    } catch (err) {
      console.warn('[deck-feed] vitals: settings unreadable, retrying', err && err.message);
    } finally {
      vitalsLoading = false;
    }
    pushVitals();
  }
  function vitalsTick() {
    if (!window.VitalsCore || !hasVitalsKey()) return;
    if (vitalsStale) { if (!vitalsLoading) loadVitals(); return; }
    pushVitals();
  }
  function watchVitals(on) {
    on('settings', () => { vitalsStale = true; vitalsTick(); });
    if (!vitalsTimer && window.VitalsCore) vitalsTimer = setInterval(vitalsTick, VITALS_EVERY_MS);
  }

  function attach(es) {
    const on = (name, fn) => es.addEventListener(name, (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      try { fn(d); } catch { /* one bad payload must not kill the stream */ }
    });
    const D = () => window.Deck;
    on('status', (d) => {
      if (D()) D().refreshStates({ micMuted: !!d.muted });
      if (D() && d.process !== undefined && typeof D().onForegroundProcess === 'function') D().onForegroundProcess(d.process);
    });
    on('audio', (d) => {
      if (D() && d && d.speaker && Number.isFinite(Number(d.speaker.volume))) {
        D().refreshStates({ masterVolume: Number(d.speaker.volume), speakerMuted: !!d.speaker.muted });
      }
      if (D() && d && !d.unavailable) D().refreshStates({ outputDevice: (d.speaker && d.speaker.id) || '' });
    });
    on('media', (d) => {
      if (!D()) return;
      D().refreshStates({ mediaPlaying: !!(d && d.active && d.playbackStatus === 'Playing'), mediaSource: (d && d.app) || '' });
      if (typeof D().updateMedia === 'function') D().updateMedia(d);
    });
    on('discord', (d) => {
      if (D()) D().refreshStates({
        discordMuted: !!(d && d.voice && d.voice.mute),
        discordDeafened: !!(d && d.voice && d.voice.deaf),
        discordInputVolume: (d && d.voice && Number.isFinite(d.voice.inputVolume)) ? d.voice.inputVolume : NaN,
        discordOutputVolume: (d && d.voice && Number.isFinite(d.voice.outputVolume)) ? d.voice.outputVolume : NaN,
      });
    });
    on('obs', (d) => { if (D()) D().refreshStates(d); });
    on('obs_preview', (d) => { if (D() && typeof D().setScenePreview === 'function') D().setScenePreview(d); });
    on('obs_launching', (d) => { if (D() && typeof D().setObsLaunching === 'function') D().setObsLaunching(d); });
    on('streamerbot', (d) => { if (D()) D().refreshStates({ sbGlobals: (d && d.globals) || {} }); });
    on('ha_states', (d) => { if (D()) D().refreshStates({ haStates: (d && d.states) || {} }); });
    // Widget-published deck states: the popup hosts no widget frames, so these
    // arrive via the server relay (custom-widget.js POSTs each change to
    // /sdk/deck-states; seeded on connect) — without this listener every
    // sdkState-bound key/face would stay dark here.
    on('sdk_states', (d) => { if (D()) D().refreshStates({ sdkStates: (d && d.states) || {}, sdkStateMeta: (d && d.meta) || {} }); });
    // States any local script set over POST /state/set (seeded on connect).
    on('script_states', (d) => { if (D()) D().refreshStates({ scriptStates: (d && d.states) || {} }); });
    on('timer_update', (d) => {
      if (!D() || !window.DeckModel || !window.DeckModel.timersByLabel) return;
      D().refreshStates({ timers: window.DeckModel.timersByLabel(d.timers) });
    });
    // Live 'sensor' badges (fan RPM / watts / temps / battery %) — same
    // projections main.js feeds the dashboard snapshot.
    on('system', (d) => {
      if (!D() || !window.DeckModel || !window.DeckModel.sensorsFromSystem) return;
      D().refreshStates({ sensors: window.DeckModel.sensorsFromSystem(d) });
    });
    on('battery', (d) => {
      if (!D() || !window.DeckModel || !window.DeckModel.batteriesByName) return;
      D().refreshStates({ batteries: window.DeckModel.batteriesByName((d && d.devices) || []) });
    });
    on('benchmark', (d) => { if (D()) D().refreshStates({ benchmarkRunning: !!(d && d.running) }); });
    on('recording', (d) => { if (D()) D().refreshStates(window.DeckModel.recordingStates(d)); });
    on('steps', (d) => { if (D()) D().refreshStates({ stepsOn: !!(d && d.on) }); });
    on('replay', (d) => { if (D()) D().refreshStates({ replayOn: !!(d && d.on) }); });
    on('deck', (d) => { if (D() && typeof D().onServerDeckRev === 'function') D().onServerDeckRev(d.rev); });
    watchVitals(on);
  }
  window.DeckFeed = Object.freeze({ attach });
})();

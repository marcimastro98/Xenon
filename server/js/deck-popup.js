'use strict';
// Virtual Deck popup bootstrap — a "main.js-lite" for deck-popup.html.
//
// Runs BEFORE deck.js's DOMContentLoaded boot (scripts are synchronous), so it
// can stamp the ?instance= id onto the tile first; then it opens its own SSE
// stream and feeds exactly the events the deck snapshot consumes. View+press
// only: no editor, no layout shell, no settings — key presses go through the
// same POST /actions/run as the dashboard.
(function () {
  // ── Which deck instance to mirror (default: the primary tile) ──
  const params = new URLSearchParams(location.search);
  const instance = (params.get('instance') || '').trim();
  const tile = document.querySelector('[data-dashboard-widget="deck"]');
  if (tile && instance && /^deck(~[a-z0-9]+)?$/.test(instance) && instance !== 'deck') {
    tile.setAttribute('data-dashboard-instance', instance);
  }

  // ── SSE relay → Deck.refreshStates (the exact events main.js forwards) ──
  function connect() {
    const es = new EventSource('/sse');
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
    on('timer_update', (d) => {
      if (!D() || !window.DeckModel || !window.DeckModel.timersByLabel) return;
      D().refreshStates({ timers: window.DeckModel.timersByLabel(d.timers) });
    });
    on('deck', (d) => { if (D() && typeof D().onServerDeckRev === 'function') D().onServerDeckRev(d.rev); });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
    };
  }
  connect();
})();

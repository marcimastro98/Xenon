'use strict';
// What makes the person's own Bit move by itself: moments of the live stream
// (a game starts or ends, the PC runs hot, a new track, a return after a while
// away) and of its life (it hatches, it reaches a new stage). Each goes through
// BitApp's director, which may let it pass, and plays on every own Bit of the
// page: the elements marked data-own-bit (the corner, the clock, the Bit tile).
// No poll and no timer of its own: only what the stream already carries.
(() => {
  const HOT_C = 85;
  const VERY_HOT_C = 92;
  const COOL_C = 78; // under this a hot chip counts as cooled down again
  const AWAY_S = 600; // input idle this long, then back: Bit says welcome back
  const BACK_S = 5;

  const seen = { gaming: null, hot: false, veryHot: false, track: '', away: false };
  let last = null; // the server's previous word on the Bit
  let played = null; // the last clip played, for the SDK `bit` stream: { clip, at }

  const app = () => window.BitApp;
  const hatched = () => !!app()?.state()?.hatched;

  function players() {
    const A = app();
    if (!A || typeof document === 'undefined') return [];
    return [...document.querySelectorAll('[data-own-bit]')].map((host) => A.playerFor(host)).filter(Boolean);
  }

  /** A clip asked for by a moment or by the sheet, on every own Bit of the page. */
  function play(clipId) {
    played = { clip: clipId, at: Date.now() };
    for (const p of players()) p.play(clipId);
  }

  /** Something happened: the director picks the clip, or lets it pass. */
  function react(name) {
    if (!hatched()) return null;
    const A = app();
    const d = A?.director();
    const id = d ? d.react(name, A.context()) : null;
    if (id) play(id);
    return id;
  }

  // After every listener of the same event: the places draw the hatched Bit
  // first (companion.js, tile.js), then it plays.
  function heard(next) {
    const was = last;
    last = next;
    const moment = was?.ok && !was.hatched && next.hatched ? () => play('hatch')
      : was?.hatched && was.stage && next.stage && next.stage !== was.stage ? () => react('stage')
        : null;
    if (moment) queueMicrotask(moment);
  }

  function onStatus(d) {
    if (d.gaming != null || d.gameRunning != null) {
      const gaming = !!d.gaming;
      if (seen.gaming !== null && gaming !== seen.gaming) react(gaming ? 'gameStart' : 'gameEnd');
      seen.gaming = gaming;
    }
    const idle = Number(d.idleSec);
    if (Number.isFinite(idle)) {
      if (idle >= AWAY_S) seen.away = true;
      else if (seen.away && idle <= BACK_S) { seen.away = false; react('welcomeBack'); }
    }
  }

  function onSystem(d) {
    const top = Math.max(Number(d.cpuTemp) || 0, Number(d.gpuTemp) || 0);
    if (top >= VERY_HOT_C && !seen.veryHot) { seen.veryHot = true; seen.hot = true; react('veryHot'); }
    else if (top >= HOT_C && !seen.hot) { seen.hot = true; react(Number(d.gpuTemp) >= HOT_C ? 'gpuHot' : 'cpuHot'); }
    else if (top > 0 && top < COOL_C) { seen.hot = false; seen.veryHot = false; }
  }

  function onMedia(d) {
    const playing = !!(d?.active && d.playbackStatus === 'Playing');
    const track = playing ? `${d.title || ''}\u0000${d.artist || ''}` : '';
    if (track && seen.track && track !== seen.track) react('trackChange');
    if (track) seen.track = track;
  }

  // A data object from the stream, or nothing when the event is broken.
  const guarded = (fn) => (d) => { if (d && typeof d === 'object') fn(d); };

  // The dashboard's live stream (grid/data-stream.js) hands its EventSource here;
  // a layer page feeds the same handlers through the Bit tile (tile.js).
  function listen(es) {
    const on = (name, fn) => es.addEventListener(name, (e) => {
      try { fn(JSON.parse(e.data)); } catch { /* a broken event changes nothing */ }
    });
    on('status', api.onStatus);
    on('system', api.onSystem);
    on('media', api.onMedia);
    on('bit_play', api.onPlay);
  }

  if (typeof addEventListener === 'function') {
    addEventListener('xenon-bit', (e) => { if (e.detail) heard(e.detail); });
  }
  last = app()?.state() || null;

  // A move asked from the chat, a Deck key or a phone (server/bit/actions.js): played as asked, past the hourly cap.
  const onPlay = (d) => { if (typeof d.clip === 'string') play(d.clip); };
  const api = { listen, react, play, lastPlayed: () => played, onStatus: guarded(onStatus), onSystem: guarded(onSystem), onMedia: guarded(onMedia), onPlay: guarded(onPlay) };
  window.BitMoments = api;
})();

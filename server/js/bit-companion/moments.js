'use strict';
// What makes the person's own Bit move by itself, and how much it moves.
// Moments of the live stream: a game starts or ends, the PC runs hot or stutters, a new track, a
// return after a while away, Claude Code or Codex starting, finishing or
// asking, a calendar reminder, an update, a file from the phone, something new from the Store;
// and of its life (it hatches, it reaches a new stage, the first look of the day, its birthday).
// Each goes through BitApp's director, which may let it pass, and plays on every own Bit of the
// page: the elements marked data-own-bit (the corner, the clock, the Bit tile). A moment that
// comes while those Bits can't play (held, hidden, asleep) waits, the last one only, without
// counting against the hourly cap, and plays when one can.
// pace(): how much those Bits move (bitDirector.PACES), which BitApp asks on every change.
// No poll and no timer of its own: only what the stream already carries.
(() => {
  const HOT_C = 85;
  const VERY_HOT_C = 92;
  const COOL_C = 78; // under this a hot chip counts as cooled down again
  const AWAY_S = 600; // input idle this long, then back: Bit says welcome back
  const BACK_S = 5;
  const ASLEEP_S = 300; // input idle this long and Bit falls asleep; at night sooner
  const ASLEEP_NIGHT_S = 60;
  const NIGHT_UNTIL = 6;
  const SLOW = ['ambient-idle', 'low-power-gpu', 'perf-mode'];
  const WAIT_MS = 10 * 60000; // a moment that waited longer is no longer news
  const HELLO_KEY = 'xenon.bit.hello';

  const seen = { gaming: null, hot: false, veryHot: false, track: '', away: false, idleSec: 0, pace: '', greeted: false };
  const agents = { claude: null, codex: null }; // source -> Map(session id -> 'running' | 'idle' | 'asks')
  let shelf = null; // ids of the files that came in from the phone, from the first 'transfer' event on
  let waiting = null; // { name, at }: the last moment that came while no own Bit could play
  let last = null; // the server's previous word on the Bit
  let played = null; // the last clip played, for the SDK `bit` stream: { clip, at }

  const app = () => window.BitApp;
  const hatched = () => !!app()?.state()?.hatched;
  const events = () => window.Xenon?.bitDirector?.EVENTS || {};

  function players() {
    const A = app();
    if (!A || typeof document === 'undefined') return [];
    return [...document.querySelectorAll('[data-own-bit]')].map((host) => A.playerFor(host)).filter(Boolean);
  }

  /** How much the own Bits move now: still under a frosted overlay, game while one runs, asleep
   *  with the person away (not on a phone, which is in someone's hand), slow while the dashboard
   *  rests or saves the GPU (unless it is out for a stroll: stroll.js), else live. */
  function pace(now = new Date()) {
    const c = document.body.classList;
    if (c.contains('overlay-frozen')) return 'still';
    if (c.contains('game-mode')) return 'game';
    const phone = document.documentElement.classList.contains('is-phone');
    if (!phone && seen.idleSec >= (now.getHours() < NIGHT_UNTIL ? ASLEEP_NIGHT_S : ASLEEP_S)) return 'asleep';
    return SLOW.some((name) => c.contains(name)) && !window.BitStroll?.walking() ? 'slow' : 'live';
  }

  /** A clip asked for by a moment or by the sheet, on every own Bit of the page. */
  function play(clipId) {
    played = { clip: clipId, at: Date.now() };
    for (const p of players()) p.play(clipId);
  }

  // Own Bits that can't show it now: held or hidden, or asleep for anything short of important.
  function cantPlay(name) {
    const own = players();
    if (!own.length) return false;
    if (!own.some((p) => p.running)) return true;
    return pace() === 'asleep' && (events()[name]?.priority || 0) < 3;
  }

  /** Something happened: the director picks the clip, or lets it pass. */
  function react(name) {
    if (!hatched()) return null;
    if (cantPlay(name)) { waiting = { name, at: Date.now() }; return null; }
    const A = app();
    const d = A?.director();
    const id = d ? d.react(name, A.context()) : null;
    if (id) { play(id); window.BitStroll?.flourish(name); } // a few moments come with an effect (stroll.js)
    return id;
  }

  /** An own Bit can play again: the moment that waited, if it is still news. */
  function woke() {
    const w = waiting;
    if (!w || cantPlay(w.name)) return false;
    waiting = null;
    return Date.now() - w.at < WAIT_MS && !!react(w.name);
  }

  // The first look of the day, once per browser: a hello, or on its birthday the party.
  function greet() {
    if (seen.greeted || !hatched()) return;
    seen.greeted = true;
    const day = new Date().toDateString();
    try { if (localStorage.getItem(HELLO_KEY) === day) return; localStorage.setItem(HELLO_KEY, day); } catch { return; }
    react(app().context().season === 'birthday' ? 'birthday' : 'hello');
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
      seen.idleSec = idle;
      if (idle >= AWAY_S) seen.away = true;
      else if (seen.away && idle <= BACK_S) { seen.away = false; if (!woke()) react('welcomeBack'); }
    }
    const now = pace();
    if (now !== seen.pace) {
      const wasAsleep = seen.pace === 'asleep';
      seen.pace = now;
      if (app()) app().sweep();
      if (wasAsleep) woke();
    }
    greet();
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

  // Claude Code and Codex sessions (payload.live.sessions of the 'claude' and 'codex' events),
  // read like the Claude tile reads them (claude-widget/topbar.js): only a real change of a
  // session already seen counts, and one killed is no finish. One moment per update, the most
  // telling: a session asking, then one done, then one starting.
  const agentState = (s) => (s.waitFor || s.state === 'waiting' ? 'asks' : s.state === 'running' ? 'running' : 'idle');
  function agentMoment(source, d) {
    const list = Array.isArray(d.live?.sessions) ? d.live.sessions.filter((s) => s && s.id != null) : null;
    if (!list) return;
    const before = agents[source];
    agents[source] = new Map(list.map((s) => [String(s.id), agentState(s)]));
    if (!before) return;
    const moves = new Set();
    for (const s of list) {
      const was = before.get(String(s.id));
      const is = agentState(s);
      if (!was || was === is) continue;
      if (is === 'asks') moves.add('notification');
      else if (is === 'running') moves.add('claudeWorking');
      else if (was === 'running' && !(s.ended && s.endedReason === 'gone')) moves.add('claudeDone');
    }
    const name = ['notification', 'claudeDone', 'claudeWorking'].find((n) => moves.has(n));
    if (name) react(name);
  }

  function onTransfer(d) {
    const ids = (Array.isArray(d.items) ? d.items : []).filter((it) => it && it.direction !== 'out').map((it) => String(it.id));
    const fresh = !!shelf && ids.some((id) => !shelf.has(id));
    shelf = new Set(ids);
    if (fresh) react('download');
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
    on('claude', guarded((d) => agentMoment('claude', d)));
    on('codex', guarded((d) => agentMoment('codex', d)));
    on('calendar_reminder', () => react('calendarSoon'));
    on('update_auto', guarded((d) => { if (d.phase === 'countdown') react('update'); }));
    on('widget_auto_updated', () => react('update'));
    on('transfer', guarded(onTransfer));
    on('stutter_why', () => react('fpsDrop'));
  }

  if (typeof addEventListener === 'function') {
    addEventListener('xenon-bit', (e) => { if (e.detail) heard(e.detail); });
    addEventListener('xenon-content-installed', () => react('storeDrop')); // something new from the Store is in
  }
  last = app()?.state() || null;

  // A move asked from the chat, a Deck key or a phone (server/bit/actions.js): played as asked, past the hourly cap.
  const onPlay = (d) => { if (typeof d.clip === 'string') play(d.clip); };
  const api = {
    listen, react, play, pace, woke, lastPlayed: () => played,
    onStatus: guarded(onStatus), onSystem: guarded(onSystem), onMedia: guarded(onMedia), onPlay: guarded(onPlay),
  };
  window.BitMoments = api;
})();

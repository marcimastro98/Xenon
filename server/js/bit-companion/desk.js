'use strict';
// Bit on the desktop: the person's own Bit standing on the taskbar of a screen, drawn by the
// shell's own small window (apps/native/src-tauri/src/layers/bit_desk.rs), not a webview.
// This page keeps the brain: desk-frames.js turns the clips (and its ways of going and coming) into
// cells, sent a whole clip at a time as `xenon-app:bit-desk?d=<json>`; the shell plays the frames on
// its own timer and moves the window only while Bit walks. It comes in a beam of light, crumbles away
// when turned off, and with desk 'all' it crumbles now and then and comes together on the next screen.
// It shows idle (asleep: sleep), a fidget now and then at the director's pace, every move the
// dashboard's own Bits play (moments.js), a poke when tapped, and every few minutes a short walk
// along the bar and back (not with roam 'stay' or reduced motion). Dropped somewhere along the
// bar it lives there (prefs desk and deskX in bit.json, server/bit/model.js). Sent again every
// 20 s while it is out, so the shell's own timeout (60 s) only fires when this page is gone.
// Loaded by companion.js only in the shell that can draw it (caps().bitDesk), on the main window.
(() => {
  const KEEPALIVE_MS = 20000;
  const SEND_DELAY_MS = 50;
  const CELL = 3; // logical px a cell: about 36 px of Bit at 100%
  const HOME = 0.7; // its place along the bar until dragged: right of the centred icons, left of the tray
  const STROLL_EVERY_MS = [120000, 300000];
  const PAUSE_MS = [5000, 14000]; // it sits this long at the far end
  const REACH = [0.04, 0.12]; // how far it walks, in lengths of the bar
  const SPEED_PX_S = 26; // as stroll.js
  const WALK_GUARD_MS = 90000; // no word from the shell by then: it counts as arrived
  const ONCE_MARGIN_MS = 1000;
  const QUIET_RETRY_MS = 30000; // a pace with no fidgets is asked again after this
  const TRAVEL_EVERY_MS = [600000, 1800000]; // with desk 'all': a hop to the next screen

  let sent = '';
  let monitor = ''; // the screen it stands on, as the shell names them ('' the main one)
  let gone = false; // crumbled away: nothing in its loop until it comes back
  let leaving = 0; // the timer that ends a going
  let out = false; // the shell has Bit on screen
  let timer = 0;
  let keepalive = 0;
  let fidgetTimer = 0;
  let strollTimer = 0;
  let walkTimer = 0;
  let travelTimer = 0;
  let seq = 0; // walks and clips played once share one counter: a new number plays it
  let once = null; // { id, seq, until }: a clip, or { kind, seq, until, cells } a way of going or coming
  let walk = null; // { seq, to, out }
  let sitting = false;
  let dropped = null; // a drop not saved yet: where it stands meanwhile
  let visit = null; // dropped on another screen: there until it goes on (only the main screen's is saved)
  const recent = [];

  const caps = () => window.__XENON_NATIVE_CAPS__ || {};
  const supported = () => window.__XENON_NATIVE__ === true && caps().bitDesk === true
    && !(typeof isLayerPage === 'function' && isLayerPage());
  const engine = () => window.Xenon || {};
  const frames = () => window.BitDeskFrames;
  const app = () => window.BitApp;
  const state = () => app()?.state() || null;
  const prefs = () => state()?.prefs || {};
  const pace = () => window.BitMoments?.pace() || 'live';
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const between = ([lo, hi]) => lo + Math.random() * (hi - lo);
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const screens = () => window.BitDeskScreens;
  const here = () => (prefs().desk === 'all' ? monitor : '');
  // On the main screen the place it was given; on another one beside the clock, or where dropped this visit.
  const home = () => (screens()?.away(here())
    ? visit ?? screens().home(here(), frames().COLS, CELL) ?? HOME
    : dropped ?? (typeof prefs().deskX === 'number' ? prefs().deskX : HOME));
  const wanted = () => supported() && !!state()?.hatched && prefs().desk !== 'off' && !!app()?.personal();

  const playing = () => (once && Date.now() < once.until ? once : null);
  const loopId = () => (walk ? 'walk' : sitting ? 'sit' : pace() === 'asleep' ? 'sleep' : 'idle');

  /** What the shell is asked to show now. */
  function message() {
    if (!wanted() && !leaving) return { on: false };
    const look = app()?.personal();
    const shown = playing();
    const f = look && frames()?.picture({ look, loopId: loopId(), once: shown, gone, reduced: reduced() });
    if (!f) return { on: false };
    const msg = { on: true, monitor: here(), cell: CELL, body: frames().BODY, pal: f.pal, loop: f.loop, home: home() };
    if (f.once) msg.once = { seq: shown.seq, frames: f.once };
    if (walk) msg.walk = { seq: walk.seq, to: walk.to, pxs: SPEED_PX_S };
    return msg;
  }

  function signal(json) {
    // With this launch's nonce, or the shell drops it (native-bridge.js).
    try { window.location.href = (window.__xenonSignal || String)('xenon-app:bit-desk?d=' + encodeURIComponent(json)); } catch { /* not native */ }
  }

  function send(force) {
    timer = 0;
    if (out && !wanted() && !leaving && !gone) return leave(schedule); // turned off: its bits fly off first
    if (gone && !leaving) gone = false; // it went: to another screen, or off (then message() says so)
    if (!out && wanted() && !playing() && !reduced()) once = warp('beam'); // it comes in a beam of light
    let msg;
    try { msg = message(); } catch (err) {
      console.warn('[bit] desktop:', err.message);
      msg = { on: false };
    }
    const json = JSON.stringify(msg);
    if (json === sent && !force) return;
    const was = out;
    sent = json;
    out = msg.on;
    if (out && !keepalive) keepalive = setInterval(() => send(true), KEEPALIVE_MS);
    if (!out) { clearInterval(keepalive); keepalive = 0; }
    if (out || was) signal(json);
  }

  function schedule() {
    if (!timer) timer = setTimeout(() => send(false), SEND_DELAY_MS);
  }

  /** A way of going or coming, played once like a clip. */
  function warp(kind) {
    const n = engine().bitCellsWarp?.KINDS[kind];
    return n ? { kind, seq: ++seq, until: Date.now() + n.n * n.ms } : null;
  }

  /** It crumbles away, then `then` runs (another screen, or off); with reduced motion it just goes. */
  function leave(then) {
    const w = reduced() ? null : warp('crumble');
    once = w;
    gone = true;
    leaving = setTimeout(() => {
      leaving = 0;
      then();
    }, w ? w.until - Date.now() : 0);
    schedule();
  }

  function armTravel() {
    clearTimeout(travelTimer);
    travelTimer = setTimeout(travel, between(TRAVEL_EVERY_MS));
  }

  /** One Bit for every screen: its bits fly off here and come together on the next one (the shell
   *  moves the window when the screen in the message changes). False when it can't: fewer than two
   *  screens to go to (desk-screens.js), not desk 'all', or busy walking or going. */
  function hop() {
    const next = prefs().desk === 'all' ? screens()?.next(monitor) : '';
    if (!next || !out || walk || sitting || leaving || dropped != null) return false;
    leave(() => {
      monitor = next;
      visit = null;
      once = reduced() ? null : warp('assemble');
      armTravel();
      schedule();
    });
    return true;
  }

  function travel() {
    const calm = pace() === 'live' || pace() === 'slow';
    if (!calm || !hop()) armTravel();
  }

  /** A clip once on the desktop, then its loop again. False when it can't (off, walking, too long). */
  function play(id) {
    if (!out || walk || leaving || !frames()?.cellsOf(id, app().personal())) return false;
    const ms = engine().bit.duration(id);
    once = { id, seq: ++seq, until: Date.now() + ms + ONCE_MARGIN_MS };
    recent.push(id);
    if (recent.length > 4) recent.shift();
    schedule();
    return true;
  }

  // Its own fidgets, at the pace of the person's own Bit (bit-director.js idleGap/idleFidget).
  function armFidget() {
    clearTimeout(fidgetTimer);
    const D = engine().bitDirector;
    const rhythm = app()?.director() || D?.CLASSIC;
    const ctx = app()?.context() || {};
    const gap = D && rhythm ? D.idleGap(rhythm, pace(), ctx) : 0;
    fidgetTimer = setTimeout(() => {
      const id = gap && !reduced() ? D.idleFidget(rhythm, ctx, recent) : null;
      if (id) play(id);
      armFidget();
    }, gap || QUIET_RETRY_MS);
  }

  function armStroll() {
    clearTimeout(strollTimer);
    strollTimer = setTimeout(stroll, between(STROLL_EVERY_MS));
  }

  function setWalk(to, isOut) {
    walk = { seq: ++seq, to: clamp01(to), out: isOut };
    clearTimeout(walkTimer);
    walkTimer = setTimeout(arrived, WALK_GUARD_MS);
    schedule();
  }

  // A short way along the bar from its place, at the live or slow pace only.
  function stroll() {
    const calm = pace() === 'live' || pace() === 'slow';
    if (!out || walk || sitting || dropped != null || reduced() || prefs().roam === 'stay' || !calm) return armStroll();
    const from = home();
    const d = between(REACH);
    setWalk(from + d <= 1 && (from - d < 0 || Math.random() < 0.5) ? from + d : from - d, true);
  }

  /** The shell's word: the walk reached its end. Out there it sits a while, then walks back. */
  function arrived() {
    clearTimeout(walkTimer);
    if (!walk) return;
    const wasOut = walk.out;
    walk = null;
    if (wasOut) {
      sitting = true;
      strollTimer = setTimeout(() => { sitting = false; setWalk(home(), false); }, between(PAUSE_MS));
    } else {
      armStroll();
    }
    schedule();
  }

  /** Tapped: a poke (its pocket comes with phase 3 of its plan). */
  function tapped() {
    const pokes = (engine().bit?.POKES || []).filter((id) => id !== recent[recent.length - 1]);
    if (pokes.length) play(pokes[Math.floor(Math.random() * pokes.length)]);
  }

  /** Dropped somewhere along the bar: it lives there, kept in its prefs, or goes back if not kept. */
  async function drop(x) {
    const at = Number(x);
    if (!Number.isFinite(at)) return;
    clearTimeout(walkTimer);
    walk = null;
    sitting = false;
    const spot = clamp01(Math.round(at * 1000) / 1000);
    armStroll();
    if (screens()?.away(here())) {
      visit = spot;
      return schedule();
    }
    dropped = spot;
    schedule();
    try {
      const base = typeof SERVER === 'string' ? SERVER : '';
      const res = await fetch(`${base}/api/bit/prefs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deskX: dropped }) });
      const answer = await res.json().catch(() => null);
      if (!answer?.ok || !answer.bit) throw new Error(answer?.error || `HTTP ${res.status}`);
      app()?.heard(answer.bit);
    } catch (err) {
      console.warn('[bit] its place on the desktop was not saved:', err.message);
    }
    dropped = null;
    schedule();
  }

  function start() {
    addEventListener('xenon-bit', schedule);
    schedule();
    armFidget();
    armStroll();
    armTravel();
  }

  if (supported()) window.XenonNative?.afterLoad(start);

  window.BitDesk = Object.freeze({
    on: () => out,
    play,
    // The shell's words (bit_desk/window_win32.rs tell()).
    tapped,
    dropped: drop,
    arrived,
    hop,
    screens: () => screens()?.list() || [],
  });
})();

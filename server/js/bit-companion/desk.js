'use strict';
// Bit on the desktop: the person's own Bit standing on the taskbar of a screen, drawn by the
// shell's own small window (apps/native/src-tauri/src/layers/bit_desk.rs), not a webview.
// This page keeps the brain: desk-frames.js turns the clips (and its ways of going and coming) into
// cells, sent a whole clip at a time as `xenon-app:bit-desk?d=<json>`; the shell plays the frames on
// its own timer and moves the window only while Bit walks. It comes in a beam of light, crumbles away
// when turned off, and with desk 'all' it crumbles now and then and comes together on the next screen.
// It shows idle (asleep: sleep), a fidget now and then at the director's pace, every move the
// dashboard's own Bits play (moments.js), a poke when tapped, and every few minutes a short walk
// along the bar and back (not with roam 'stay' or reduced motion). Dropped somewhere it lives there:
// along the bar, or still where it was left away from it, on that screen (desk-spot.js). Sent again
// every 20 s while it is out, so the shell's own timeout (60 s) only fires when this page is gone.
// Loaded by companion.js only in the shell that can draw it (caps().bitDesk), on the main window.
(() => {
  const KEEPALIVE_MS = 20000;
  const SEND_DELAY_MS = 50;
  const STROLL_EVERY_MS = [120000, 300000];
  const PAUSE_MS = [5000, 14000]; // it sits this long at the far end
  const REACH = [0.04, 0.12]; // how far it walks, in lengths of the bar
  const SPEED_PX_S = 26; // as stroll.js
  const RIDE_SPEED = 2.2; // on a ride (a worn item of place 'ride') it glides this much faster, as stroll.js
  const WALK_GUARD_MS = 90000; // no word from the shell by then: it counts as arrived
  const ONCE_MARGIN_MS = 1000;
  const QUIET_RETRY_MS = 30000; // a pace with no fidgets is asked again after this
  const TRAVEL_EVERY_MS = [600000, 1800000]; // with desk 'all': a hop to the next screen

  let sent = '';
  let resend = false; // a drop the shell may already show: its place is told again even when unchanged
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
  const spots = () => window.BitDeskSpot;
  const here = () => (prefs().desk === 'all' ? monitor : spots().own());
  const spot = () => spots().place(here(), frames().COLS, spots().cell());
  const still = () => spot().y !== null; // left away from the bar: it stays put
  const wanted = () => supported() && !!state()?.hatched && prefs().desk !== 'off' && !!app()?.personal();

  const playing = () => (once && Date.now() < once.until ? once : null);
  const lookNow = () => window.BitDeskTry?.look() || app()?.personal(); // desk-try.js: ten minutes in something tried on
  const riding = () => (lookNow()?.worn || []).some((w) => w.slot === 'ride');
  const loopId = () => (walk ? 'walk' : sitting ? 'sit' : pace() === 'asleep' ? 'sleep' : 'idle');

  /** What the shell is asked to show now. */
  function message() {
    if (!wanted() && !leaving) return { on: false };
    const look = lookNow();
    const shown = playing();
    const f = look && frames()?.picture({ look, loopId: loopId(), once: shown, gone, reduced: reduced(), sign: window.BitSigns?.kind() });
    if (!f) return { on: false };
    const at = spot();
    const msg = { on: true, monitor: here(), cell: spots().cell(), body: frames().BODY, pal: f.pal, loop: f.loop, home: at.x };
    if (at.y !== null) msg.rise = at.y;
    if (f.once) msg.once = { seq: shown.seq, frames: f.once };
    if (walk) msg.walk = { seq: walk.seq, to: walk.to, pxs: Math.round(SPEED_PX_S * (riding() ? RIDE_SPEED : 1)) };
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
    if (json === sent && !force && !resend) return;
    resend = false;
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
    if (!next || !out || walk || sitting || leaving || spots().busy()) return false;
    leave(() => {
      monitor = next;
      spots().leave();
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
    if (!out || walk || leaving || !frames()?.cellsOf(id, lookNow())) return false;
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
    if (!out || walk || sitting || still() || spots().busy() || reduced() || prefs().roam === 'stay' || !calm) return armStroll();
    const from = spot().x;
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
      strollTimer = setTimeout(() => { sitting = false; setWalk(spot().x, false); }, between(PAUSE_MS));
    } else {
      armStroll();
    }
    schedule();
  }

  /** Tapped: a poke, and what the person chose for a tap (prefs.tap) alone in the Xenon menu's window, where
   *  they are; with no window to show it (the server says 'closed'), on the dashboard. The pocket opens in a
   *  little window of its own just over Bit, where the shell has one (caps.bitPocket, pocket_window.rs). */
  async function tapped() {
    const pokes = (engine().bit?.POKES || []).filter((id) => id !== recent[recent.length - 1]);
    if (pokes.length) play(pokes[Math.floor(Math.random() * pokes.length)]);
    const open = { chat: 'chat', room: 'bitroom' }[prefs().tap] || 'pocket';
    if (open === 'pocket' && caps().bitPocket === true) {
      try { window.location.href = (window.__xenonSignal || String)('xenon-app:bit-pocket'); return; } catch { /* the menu's window, below */ }
    }
    const r = await fetch(SERVER + '/screen-menu', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet: { open } }),
    }).then((res) => res.json()).catch(() => null);
    if (r?.where !== 'screen') window.BitCompanion?.tap(null);
  }

  /** The wheel over it (bit_desk.rs wheel_call): one size up (1) or down (-1), kept in its prefs. */
  function resize(step) {
    if (out && spots().resize(Number(step))) schedule();
  }

  const third = (n) => clamp01(Math.round(n * 1000) / 1000);

  /** Dropped: x along the bar, y how high (-1 on the bar), mx, my the corner of the screen it landed on.
   *  It lives there (desk-spot.js), or goes back where it was when it may not (the dashboard's screen). */
  async function drop(x, y, mx, my) {
    const along = Number(x);
    if (!Number.isFinite(along)) return;
    clearTimeout(walkTimer);
    walk = null;
    sitting = false;
    armStroll();
    const high = Number(y);
    const went = spots().drop(here(), { x: third(along), y: Number.isFinite(high) && high >= 0 ? third(high) : null, mx: Number(mx), my: Number(my) }, prefs().desk === 'all');
    if (went && prefs().desk === 'all') monitor = went.screen;
    resend = true;
    schedule();
    if (!went?.saved) return;
    await went.saved;
    resend = true;
    schedule();
  }

  function start() {
    addEventListener('xenon-bit', schedule);
    addEventListener('xenon-bit-signals', schedule); // a sign in its hand comes or goes (signs.js)
    addEventListener('xenon-bit-desk-try', schedule); // something from the room put on, or its ten minutes over
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
    resize,
    arrived,
    hop,
    screens: () => screens()?.list() || [],
  });
})();

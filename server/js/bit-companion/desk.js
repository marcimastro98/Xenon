'use strict';
// Bit on the desktop: the person's own Bit standing on the taskbar of the main screen, drawn by
// the shell's own small window (apps/native/src-tauri/src/layers/bit_desk.rs), not a webview.
// This page keeps the brain: it renders the clips with the person's own look into cells
// (shared/src/bit-cells.js) and sends them a whole clip at a time as `xenon-app:bit-desk?d=<json>`;
// the shell plays the frames on its own timer and moves the window only while Bit walks.
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
  // One grid for every clip, so a clip never resizes the window: room for what Bit holds up and
  // out, its feet on the bottom rows. BODY rows (from just over its head down) must fit the bar.
  const BOX = { x0: -4, x1: 15, y0: -8, y1: 12, max: 24 };
  const BODY = BOX.y1 + 2;
  const MAX_FRAMES = 24;
  const HOME = 0.7; // its place along the bar until dragged: right of the centred icons, left of the tray
  const STROLL_EVERY_MS = [120000, 300000];
  const PAUSE_MS = [5000, 14000]; // it sits this long at the far end
  const REACH = [0.04, 0.12]; // how far it walks, in lengths of the bar
  const SPEED_PX_S = 26; // as stroll.js
  const WALK_GUARD_MS = 90000; // no word from the shell by then: it counts as arrived
  const ONCE_MARGIN_MS = 1000;
  const QUIET_RETRY_MS = 30000; // a pace with no fidgets is asked again after this

  let sent = '';
  let out = false; // the shell has Bit on screen
  let timer = 0;
  let keepalive = 0;
  let fidgetTimer = 0;
  let strollTimer = 0;
  let walkTimer = 0;
  let seq = 0; // walks and clips played once share one counter: a new number plays it
  let once = null; // { id, seq, until }
  let walk = null; // { seq, to, out }
  let sitting = false;
  let dropped = null; // a drop not saved yet: where it stands meanwhile
  const recent = [];
  const cache = new WeakMap(); // look -> Map(clip id -> cells of each frame)

  const caps = () => window.__XENON_NATIVE_CAPS__ || {};
  const supported = () => window.__XENON_NATIVE__ === true && caps().bitDesk === true
    && !(typeof isLayerPage === 'function' && isLayerPage());
  const engine = () => window.Xenon || {};
  const app = () => window.BitApp;
  const state = () => app()?.state() || null;
  const prefs = () => state()?.prefs || {};
  const pace = () => window.BitMoments?.pace() || 'live';
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const between = ([lo, hi]) => lo + Math.random() * (hi - lo);
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const home = () => dropped ?? (typeof prefs().deskX === 'number' ? prefs().deskX : HOME);
  const wanted = () => supported() && !!state()?.hatched && prefs().desk !== 'off' && !!app()?.personal();

  /** The cells of every frame of a clip in this look, or null for a clip the shell can't take. */
  function cellsOf(id, look) {
    const { bit, bitCells } = engine();
    const clip = bit?.clip(id);
    if (!clip || !bitCells || clip.frames.length > MAX_FRAMES) return null;
    if (!cache.has(look)) cache.set(look, new Map());
    const byClip = cache.get(look);
    if (!byClip.has(id)) byClip.set(id, clip.frames.map((_, i) => bitCells.cells(bit.renderFrame(clip, i, { look }).layers)));
    return { clip, maps: byClip.get(id) };
  }

  const loopId = () => (walk ? 'walk' : sitting ? 'sit' : pace() === 'asleep' ? 'sleep' : 'idle');

  // Frames on the common grid: the loop, then the clip played once when one is on.
  function framesOn(loop, extra) {
    const maps = loop.maps.concat(extra ? extra.maps : []);
    const g = engine().bitCells.grid(maps, BOX);
    if (!g) return null;
    const rows = (clip, from) => clip.frames.map((f, i) => ({ ms: Math.round(f.ms), rows: g.frames[from + i] }));
    const still = reduced() ? 1 : loop.clip.frames.length;
    return { pal: g.palette, loop: rows(loop.clip, 0).slice(0, still), once: extra ? rows(extra.clip, loop.maps.length) : null };
  }

  /** What the shell is asked to show now. */
  function message() {
    if (!wanted()) return { on: false };
    const look = app().personal();
    const loop = cellsOf(loopId(), look) || cellsOf('idle', look);
    if (!loop) return { on: false };
    const extra = once && Date.now() < once.until ? cellsOf(once.id, look) : null;
    const f = framesOn(loop, extra) || framesOn(loop, null);
    if (!f) return { on: false };
    const msg = { on: true, monitor: '', cell: CELL, body: BODY, pal: f.pal, loop: f.loop, home: home() };
    if (f.once) msg.once = { seq: once.seq, frames: f.once };
    if (walk) msg.walk = { seq: walk.seq, to: walk.to, pxs: SPEED_PX_S };
    return msg;
  }

  function signal(json) {
    // With this launch's nonce, or the shell drops it (native-bridge.js).
    try { window.location.href = (window.__xenonSignal || String)('xenon-app:bit-desk?d=' + encodeURIComponent(json)); } catch { /* not native */ }
  }

  function send(force) {
    timer = 0;
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

  /** A clip once on the desktop, then its loop again. False when it can't (off, walking, too long). */
  function play(id) {
    if (!out || walk || !cellsOf(id, app().personal())) return false;
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
    dropped = clamp01(Math.round(at * 1000) / 1000);
    armStroll();
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
  }

  if (supported()) window.XenonNative?.afterLoad(start);

  window.BitDesk = Object.freeze({
    on: () => out,
    play,
    // The shell's words (bit_desk/window_win32.rs tell()).
    tapped,
    dropped: drop,
    arrived,
  });
})();

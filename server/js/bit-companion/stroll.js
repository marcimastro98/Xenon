'use strict';
// The own Bit's corner (companion.js), alive on the screen: every few minutes it strolls along
// the bottom and comes back, and the person can drag it anywhere, where it stays. With roam 'mix'
// some strolls start with a teleport, and a new place set from elsewhere (its room, the phone) is
// reached the same way; a few moments get an effect in place (warp.js does them all).
// All are prefs in bit.json (server/bit/model.js): roam 'mix' | 'walk' | 'stay', warp, and spot {x, y} as
// fractions of the room the screen leaves it (null: its corner). The spot is two CSS variables
// on the root, which BitCompanion.css places the corner with, so a corner drawn again stands in
// the same place and a resized window keeps it in proportion. Not on a phone: there the corner
// sits over the dock and a drag would fight the scroll.
// Walking is a transform on the corner (compositor only) while the player loops the walk clip;
// it starts only at the live or slow pace (moments.js), and while it walks the pace is live.
(() => {
  const EVERY_MS = [120000, 300000];
  const PAUSE_MS = [5000, 14000]; // it sits this long at the far end
  const TURN_MAX_MS = 400; // a turn held back (the Bit stopped meanwhile) is not waited for
  const SPEED_PX_S = 26;
  const REACH_PX = 240; // how far from its place it goes, at most
  const EDGE_PX = 8; // it never walks closer to the screen's edge
  const SNAP_PX = 24; // dropped this near an edge, it sticks to it
  const DRAG_PX = 6; // a press that moves less is a tap: it opens the sheet
  const SPRITE = { w: 64, h: 60, margin: 14 }; // the corner's size and gap (BitCompanion.css)
  const TELEPORT_ODDS = 0.35; // with roam 'mix', this share of strolls goes out in a blink
  const FLOURISH = { hello: 'download', birthday: 'download', veryHot: 'glitch' }; // moments.js

  let timer = 0;
  let walking = null; // { node, x, left } while it strolls
  let drag = null; // { id, btn, x0, y0, moved } while a press on it lasts
  let swallow = false; // the click that ends a drag opens nothing
  let shown = null; // the spot on the page as a key, once placed: a new one comes with an effect
  let warping = false;

  const app = () => window.BitApp;
  const prefs = () => app()?.state()?.prefs || {};
  const corner = () => window.BitCompanion?.spots()?.corner || null;
  const playerOf = (btn) => app()?.playerFor(btn) || null;
  const phone = () => document.documentElement.classList.contains('is-phone');
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const between = ([lo, hi]) => lo + Math.random() * (hi - lo);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const warp = () => window.BitWarp || null;
  const keyOf = (spot) => (spot && !phone() ? `${spot.x},${spot.y}` : '');

  /** Its spot from the prefs onto the page (the corner when none, or on a phone). */
  function place(spot = prefs().spot) {
    shown = keyOf(spot);
    const s = document.documentElement.style;
    if (spot && !phone()) {
      s.setProperty('--bitc-fx', String(spot.x));
      s.setProperty('--bitc-fy', String(spot.y));
    } else {
      s.removeProperty('--bitc-fx');
      s.removeProperty('--bitc-fy');
    }
  }

  function free(btn) {
    const p = playerOf(btn);
    const pace = window.BitMoments?.pace();
    return !!(p?.running && !drag && !phone() && !reduced() && prefs().roam !== 'stay'
      && app()?.state()?.hatched && (pace === 'live' || pace === 'slow'));
  }
  const alive = (btn) => !!walking && corner() === btn && btn.isConnected && free(btn);

  function slide(node, x, ms) {
    node.style.setProperty('--bitc-walk-ms', `${Math.round(ms)}ms`);
    node.style.setProperty('--bitc-walk', `${Math.round(x)}px`);
  }

  // One leg of the walk: it turns if it must, loops the walk clip and slides there.
  async function leg(btn, to) {
    const w = walking;
    const p = playerOf(btn);
    const left = to < w.x;
    if (left !== w.left) {
      w.left = left;
      w.node.classList.toggle('is-left', left);
      await Promise.race([p.play('turn'), wait(TURN_MAX_MS)]);
      if (!alive(btn)) return false;
    }
    p.setMood('walk');
    const ms = (Math.abs(to - w.x) / SPEED_PX_S) * 1000;
    slide(w.node, to, ms);
    w.x = to;
    await wait(ms);
    return alive(btn);
  }

  // One leg in a blink: it leaves where it stands and builds itself again there.
  async function jump(btn, to) {
    const w = walking;
    await warp().move(btn, prefs().warp, () => { if (walking === w) { slide(w.node, to, 0); w.x = to; } });
    return alive(btn);
  }

  // Back where it lives, facing out, at the pace of the page again.
  function home(btn) {
    const w = walking;
    walking = null;
    if (!w) return;
    w.node.classList.remove('is-left');
    if (w.x) slide(w.node, 0, 0);
    const p = playerOf(btn);
    if (p && p.mood !== 'idle') p.setMood('idle');
    app()?.sweep();
  }

  async function stroll() {
    const btn = corner();
    if (!btn || walking || !free(btn)) return;
    const node = btn.parentNode;
    const box = node.getBoundingClientRect();
    const room = { left: Math.min(0, EDGE_PX - box.left), right: Math.max(0, innerWidth - EDGE_PX - box.right) };
    const reach = Math.min(REACH_PX, innerWidth * 0.2);
    const right = Math.random() * (room.right - room.left) < room.right; // more room, more likely
    const far = right ? Math.min(reach, room.right) : Math.max(-reach, room.left);
    if (Math.abs(far) < 24) return;
    walking = { node, x: 0, left: false };
    app()?.sweep(); // walking counts as live (moments.js)
    try {
      const to = far * (0.5 + Math.random() * 0.5);
      const blink = (prefs().roam || 'mix') === 'mix' && warp() && Math.random() < TELEPORT_ODDS;
      if (!(await (blink ? jump(btn, to) : leg(btn, to)))) return;
      playerOf(btn).setMood('sit');
      await wait(between(PAUSE_MS));
      if (alive(btn)) await leg(btn, 0);
    } finally {
      home(btn);
    }
  }

  /** The next stroll, while there is a corner that may walk. */
  function arm() {
    if (!corner() || prefs().roam === 'stay' || phone()) {
      clearTimeout(timer);
      timer = 0;
      return;
    }
    // Already counting down, or out: the corner is drawn again and Bit heard of often, and
    // starting the wait over each time would mean it never walks.
    if (timer || walking) return;
    timer = setTimeout(async () => {
      timer = 0;
      await stroll();
      arm();
    }, between(EVERY_MS));
  }

  /** Its place from the prefs: a new one set elsewhere is reached with an effect, once its room is
   *  closed (it covers the corner); the first, a drag's or one on a phone is simply put. */
  async function settle() {
    const btn = corner();
    if (warping || window.BitSheet?.isOpen()) return;
    if (shown === null || keyOf(prefs().spot) === shown || drag || !btn || !warp()) { place(); return; }
    if (walking) home(btn);
    warping = true;
    try { await warp().move(btn, prefs().warp, () => place()); } finally { warping = false; }
  }

  /** A moment with an effect of its own, on the corner where it stands (moments.js). */
  function flourish(name) {
    const btn = corner();
    if (!FLOURISH[name] || !btn || walking || warping || phone() || !warp()) return;
    warp().move(btn, FLOURISH[name], () => {}, { leave: FLOURISH[name] !== 'download' });
  }

  // ── dragging it somewhere ──
  const snap = (f, room) => (f * room < SNAP_PX ? 0 : (1 - f) * room < SNAP_PX ? 1 : Math.round(f * 1000) / 1000);
  // The spot under the pointer, holding the Bit by its middle.
  function spotAt(x, y) {
    const roomW = Math.max(1, innerWidth - SPRITE.w - 2 * SPRITE.margin);
    const roomH = Math.max(1, innerHeight - SPRITE.h - 2 * SPRITE.margin);
    const fx = clamp01((x - SPRITE.w / 2 - SPRITE.margin) / roomW);
    const fy = clamp01((innerHeight - y - SPRITE.h / 2 - SPRITE.margin) / roomH);
    return { x: snap(fx, roomW), y: snap(fy, roomH) };
  }

  async function save(spot) {
    const was = prefs().spot || null;
    try {
      const base = typeof SERVER === 'string' ? SERVER : '';
      const res = await fetch(`${base}/api/bit/prefs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spot }) });
      const out = await res.json().catch(() => null);
      if (out?.ok && out.bit) { app()?.heard(out.bit); return; }
      throw new Error(out?.error || `HTTP ${res.status}`);
    } catch (err) {
      // Not kept: it goes back where it was, so the screen never shows a place that won't last.
      console.warn('[bit] its place was not saved:', err.message);
      place(was);
    }
  }

  function onDown(e) {
    const btn = e.target.closest?.('.bitc-sprite');
    if (!btn || e.button !== 0 || !e.isPrimary || phone()) return;
    drag = { id: e.pointerId, btn, x0: e.clientX, y0: e.clientY, moved: false };
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_PX) return;
      drag.moved = true;
      if (walking) home(drag.btn);
      drag.btn.setPointerCapture?.(e.pointerId);
      drag.btn.parentNode.classList.add('is-dragging');
    }
    place(spotAt(e.clientX, e.clientY));
  }

  function onUp(e) {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    if (!d.moved) return;
    d.btn.parentNode?.classList.remove('is-dragging');
    if (e.type === 'pointercancel') { place(); return; }
    swallow = true;
    setTimeout(() => { swallow = false; }, 0);
    const spot = spotAt(e.clientX, e.clientY);
    place(spot);
    save(spot);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('click', (e) => {
      if (swallow && e.target.closest?.('.bitc')) { e.stopPropagation(); e.preventDefault(); swallow = false; }
    }, true);
    addEventListener('xenon-bit', () => { settle(); arm(); });
    // A walk is measured on the window it started in: a smaller one could leave Bit off the screen.
    addEventListener('resize', () => { if (walking) home(corner()); });
  }

  window.BitStroll = { arm, place, settle, flourish, walking: () => !!walking };
  if (app()?.state()) { place(); arm(); }
})();

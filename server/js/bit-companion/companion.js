'use strict';
// The person's own Bit on the dashboard (server/bit/, GET /api/bit and the 'bit'
// event, which BitApp passes on as 'xenon-bit'): in the corner, next to the
// clock or both (prefs.place), an egg until it hatches. Tapping it opens its
// pocket (pocket.js), the chat or its room (sheet.js), as the person chose (prefs.tap).
//
// One Bit on screen: with the Vitals' Bit on, that one already stands in these
// places wearing the same look, so this one steps aside; in the clock it shares
// #clock-bit with a folded message, which goes in front (BitCompanion.css).
// Its buttons carry data-own-bit, so it moves with every moment (moments.js). In the shell it
// also brings Bit onto the desktop (desk.js).
(() => {
  let bit = null; // the last answer of the server, through BitApp
  const spots = { corner: null, chip: null }; // each { node, btn, kind } while it stands there

  const app = () => window.BitApp;

  function vitalsBitOn() {
    const v = typeof hubSettings === 'object' && hubSettings ? hubSettings.vitals : null;
    return !!(v && v.enabled !== false && v.pet && v.pet.enabled === true);
  }

  function clockSlot() {
    const noClock = ['topbar-noisland', 'topbar-hidden'].some((name) => document.body.classList.contains(name));
    return noClock ? null : document.getElementById('clock-bit');
  }

  /** Where this Bit stands now: { corner, chip }. */
  function wanted() {
    const none = { corner: false, chip: false };
    if (bit?.ok !== true || !bit.prefs || vitalsBitOn()) return none;
    const place = bit.prefs.place;
    if (place === 'off') return none;
    // The egg waits in one place only: the corner, or the clock when that is all it has.
    if (!bit.hatched) return { corner: place !== 'topbar', chip: place === 'topbar' && !!clockSlot() };
    return { corner: place === 'corner' || place === 'both', chip: (place === 'topbar' || place === 'both') && !!clockSlot() };
  }

  function label() {
    return typeof t === 'function' ? t(bit?.hatched ? 'mybit_open' : 'mybit_egg_label') : 'Bit';
  }

  // In the clock only the small moves that keep inside the pill.
  const CHIP_FIDGETS = ['doubleBlink', 'lookAround', 'antennaSpark'];

  function mountBit(host, calm) {
    const A = app();
    if (!A) return;
    A.mount(host, {
      mood: bit?.hatched ? 'idle' : 'egg',
      fidgets: !bit?.hatched ? false : calm ? CHIP_FIDGETS : true,
      look: () => A.personal(),
    });
  }

  function open(e) {
    if (e) e.stopPropagation();
    tap(e?.currentTarget);
  }

  function button(cls) {
    const btn = makeEl('button', cls);
    btn.type = 'button';
    btn.setAttribute('aria-label', label());
    btn.setAttribute('data-own-bit', '');
    btn.addEventListener('click', open);
    return btn;
  }

  function mountCorner(kind) {
    const node = makeEl('div', 'bitc');
    node.id = 'bit-companion';
    const btn = button('bitc-sprite');
    node.append(btn);
    document.body.append(node);
    mountBit(btn, false);
    spots.corner = { node, btn, kind };
    window.BitStroll?.arm();
    window.BitSigns?.paint();
  }

  // In the clock: a calm Bit between moves, like every other mark of the bar.
  function mountChip(kind) {
    const slot = clockSlot();
    if (!slot) return;
    const btn = button('bitc-chip');
    slot.prepend(btn);
    slot.hidden = false;
    mountBit(btn, true);
    spots.chip = { node: btn, btn, kind };
    reflow();
  }

  function reflow() {
    const bar = window.TopbarMinimal;
    if (bar?.reflowIsland) bar.reflowIsland();
  }

  function unmount(name) {
    const spot = spots[name];
    if (!spot) return;
    const slot = name === 'chip' ? spot.node.parentNode : null;
    spot.node.remove();
    spots[name] = null;
    if (slot && !slot.children.length) { slot.hidden = true; reflow(); }
    if (app()) app().sweep();
  }

  // The egg and the Bit are different players: a hatch draws the places again.
  function sync() {
    const want = wanted();
    const kind = bit?.hatched ? 'bit' : 'egg';
    for (const name of ['corner', 'chip']) {
      const spot = spots[name];
      if (spot && (!want[name] || spot.kind !== kind)) unmount(name);
      if (want[name] && !spots[name]) {
        if (name === 'corner') mountCorner(kind); else mountChip(kind);
      }
    }
    for (const spot of Object.values(spots)) if (spot) spot.btn.setAttribute('aria-label', label());
  }

  // Once it hatched, a closed month (or year) is told once, with its card in the sheet (recap.js), and an
  // unread one goes when its month gives way to the next.
  const WEEK = 7 * 24 * 3600 * 1000;
  let met = false; // this page opened the room by itself
  let filed = null; // the ids last filed from this page
  let setupReady = null; // settles once room-setup.js has run (or failed to load)
  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const num = (n) => Number(n).toLocaleString(typeof lang === 'string' ? lang : 'en');

  function tellRecaps(M) {
    const R = window.BitRecap;
    const recaps = R && bit.prefs?.place !== 'off' ? R.recapsOf(bit) : [];
    const ids = recaps.map(({ rec }) => `bit:recap:${rec.key}`);
    const fresh = Date.now() - Date.parse(bit.born) < WEEK;
    if ((!ids.length && !fresh && filed === null) || filed === ids.join()) return;
    filed = ids.join();
    const body = say('mybit_recap_msg');
    M.file([...recaps.map(({ kind, rec }, i) => ({
      id: ids[i], kind: 'bit', surface: 'dashboard', title: R.words(rec, kind, bit, say, num, typeof lang === 'string' ? lang : 'en').title,
      line: M.firstLine(body), body, action: { type: 'bit', label: say('mybit_recap_open') },
    }))], { bit: ids });
  }

  // Until the egg hatched and its setup is done (room-setup.js), the room opens by itself once each time
  // the page opens, after the first-run choice and anything else on screen: the corner alone is too small
  // to be found. Closed before that, it opens again the next time; never where no Bit is wanted.
  function meetRoom() {
    const waiting = () => bit.hatched !== true || bit.prefs?.setup !== true;
    if (met || bit.prefs?.place === 'off' || !waiting()) return;
    met = true;
    const show = () => { if (waiting() && window.BitSheet && !window.BitSheet.isOpen()) window.BitSheet.open(); };
    const I = window.XenonInterrupts;
    const go = () => (I ? I.whenIdle(show, { priority: I.PRIORITY.message }) : show());
    // A Bit not set up opens on its setup: not before the file that draws it is in (loadSetup).
    if (bit.hatched && !window.BitSetup && setupReady) setupReady.then(go); else go();
  }

  function tellEgg() {
    if (bit?.ok !== true) return;
    meetRoom();
    const M = window.BitMessages;
    if (bit.hatched && M) tellRecaps(M);
  }

  function heard(next) {
    bit = next;
    sync();
    if (bit?.ok === true && bit.prefs?.setup !== true) loadSetup();
    tellEgg();
  }

  // The Vitals' Bit or the bar may change at any time: each status of the live
  // stream (grid/data-stream.js) puts the places right again.
  function listen(es) {
    es.addEventListener('status', () => sync());
  }

  if (typeof addEventListener === 'function') {
    addEventListener('xenon-bit', (e) => { if (e.detail) heard(e.detail); });
  }
  // Scripts only some pages need, added once in this order; the last one's tag comes back.
  function load(srcs) {
    let tag = null;
    for (const src of srcs) {
      tag = document.createElement('script');
      tag.src = src;
      tag.async = false; // in this order
      document.head.append(tag);
    }
    return tag;
  }

  // The guided setup (room-setup.js) is fetched only while it is still due: an egg, or a Bit not set up.
  function loadSetup() {
    if (setupReady) return;
    const tag = load(['js/bit-companion/room-setup.js']);
    setupReady = new Promise((done) => { tag.onload = done; tag.onerror = done; });
  }

  const known = app()?.state();
  if (known) heard(known);

  // Bit on the desktop (desk.js, its pictures desk-frames.js, its screens desk-screens.js, its place desk-spot.js, their cells
  // shared/src/bit-cells*.js) is loaded only where the shell can draw it, so a browser, a phone or a layer
  // page never fetches it.
  function loadDesk() {
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    if (window.__XENON_NATIVE__ !== true || caps.bitDesk !== true || (typeof isLayerPage === 'function' && isLayerPage())) return;
    load(['shared/src/bit-cells.js', 'shared/src/bit-cells-warp.js', 'js/bit-companion/desk-frames.js', 'js/bit-companion/desk-screens.js', 'js/bit-companion/desk-spot.js', 'js/bit-companion/desk.js']);
  }
  loadDesk();

  // The signs over its head (signals.js, signs.js) from the start, with their styles and the pocket's;
  // the pocket itself (pocket.js) the first time it is asked for.
  let pocketReady = null;
  function loadSigns() {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'components/BitPocket/BitPocket.css';
    document.head.append(css);
    load(['js/bit-companion/signals.js', 'js/bit-companion/signs.js']);
  }
  loadSigns();

  /** Its pocket, beside `anchor` or alone in the menu's window (`sheet`). */
  function pocket(o) {
    if (!pocketReady) {
      const tag = load(['js/bit-companion/pocket.js']);
      pocketReady = new Promise((done) => { tag.onload = done; tag.onerror = done; });
    }
    pocketReady.then(() => window.BitPocket?.open(o));
  }

  /** Its room; in the menu's window its Bit may not be read yet, and the room opens once it is. */
  function room() {
    if (window.BitSheet?.open() === false) addEventListener('xenon-bit', () => window.BitSheet?.open(), { once: true });
  }

  /** A tap on one of its Bits: what the person chose (prefs.tap); an egg opens its room, where it hatches. */
  function tap(anchor) {
    const choice = bit?.hatched ? bit.prefs?.tap || 'pocket' : 'room';
    if (choice === 'chat') window.DashboardOpen?.run({ open: 'chat' });
    else if (choice === 'room') room();
    else pocket({ anchor });
  }

  window.BitCompanion = { listen, sync, tap, pocket, room, state: () => bit, spots: () => ({ corner: spots.corner?.btn, chip: spots.chip?.btn }) };
})();

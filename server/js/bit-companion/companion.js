'use strict';
// The person's own Bit on the dashboard (server/bit/, GET /api/bit and the 'bit'
// event, which BitApp passes on as 'xenon-bit'): in the corner, next to the
// clock or both (prefs.place), an egg until it hatches. Tapping it opens its
// sheet (bit-companion/sheet.js).
//
// One Bit on screen: with the Vitals' Bit on, that one already stands in these
// places wearing the same look, so this one steps aside; in the clock it shares
// #clock-bit with a folded message, which goes in front (BitCompanion.css).
// Its buttons carry data-own-bit, so it moves with every moment (moments.js).
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

  function mountBit(host, still) {
    const A = app();
    if (!A) return;
    A.mount(host, {
      mood: bit?.hatched ? 'idle' : 'egg',
      fidgets: !!(bit?.hatched) && !still,
      look: () => A.personal(),
    });
  }

  function open(e) {
    if (e) e.stopPropagation();
    if (window.BitSheet) window.BitSheet.open();
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
  }

  // In the clock: a still Bit between moves, like every other mark of the bar.
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

  // Those who had Xenon before Bit came get one card saying the egg is theirs to hatch (Bit's
  // messages: one a day, covering nothing); a hatch from anywhere takes it back unread.
  // Once it hatched, a closed month (or year) is told once, with its card in the sheet
  // (recap.js), and an unread one goes when its month gives way to the next.
  const WEEK = 7 * 24 * 3600 * 1000;
  let told = false;
  let filed = null; // the recap ids last filed from this page
  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const num = (n) => Number(n).toLocaleString(typeof lang === 'string' ? lang : 'en');

  function tellRecaps(M) {
    const R = window.BitRecap;
    const recaps = R && bit.prefs?.place !== 'off' ? R.recapsOf(bit) : [];
    const ids = recaps.map(({ rec }) => `bit:recap:${rec.key}`);
    const fresh = Date.now() - Date.parse(bit.born) < WEEK;
    if ((!ids.length && !fresh) || filed === ids.join()) return;
    filed = ids.join();
    const body = say('mybit_recap_msg');
    M.file(recaps.map(({ kind, rec }, i) => ({
      id: ids[i], kind: 'bit', surface: 'dashboard', title: R.words(rec, kind, bit, say, num, typeof lang === 'string' ? lang : 'en').title,
      line: M.firstLine(body), body, action: { type: 'bit', label: say('mybit_recap_open') },
    })), { bit: ids });
  }

  // Every egg is met once, on its first day (a new install's, or a founder's right after the
  // update), when the first-run choice and anything else on screen are gone: the corner alone
  // is too small to be found.
  const MET = 'xenon.bit.metEgg';
  function meetEgg() {
    if (told || bit.prefs?.place === 'off' || !(Date.now() - Date.parse(bit.eggAt) < 24 * 3600 * 1000)) return;
    told = true;
    // Kept per egg: a new egg on the same browser (a reinstall) is met again, and the mark is
    // written only once the sheet is really open.
    const show = () => {
      try { if (localStorage.getItem(MET) === bit.eggAt) return; } catch { return; }
      if (bit.hatched || !window.BitSheet?.open()) return;
      try { localStorage.setItem(MET, bit.eggAt); } catch { /* shown; at worst shown again */ }
    };
    const I = window.XenonInterrupts;
    if (I) I.whenIdle(show, { priority: I.PRIORITY.message }); else show();
  }

  function tellEgg() {
    const M = window.BitMessages;
    if (bit?.ok !== true) return;
    if (!bit.hatched) meetEgg();
    if (!bit.hatched && !bit.founder) return;
    if (!M) return;
    if (bit.hatched) { tellRecaps(M); return; }
    if (told || bit.prefs?.place === 'off') return;
    told = true;
    const body = t('mybit_card_text');
    M.file([{
      id: 'bit:hatch', kind: 'bit', surface: 'dashboard', title: t('mybit_card_title'),
      line: M.firstLine(body), body, action: { type: 'bit', label: t('mybit_hatch') },
    }]);
  }

  function heard(next) {
    bit = next;
    sync();
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
  const known = app()?.state();
  if (known) heard(known);

  window.BitCompanion = { listen, sync, state: () => bit, spots: () => ({ corner: spots.corner?.btn, chip: spots.chip?.btn }) };
})();

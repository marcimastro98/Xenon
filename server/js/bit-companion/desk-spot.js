'use strict';
// Bit on the desktop: where it stands. On its own screen (prefs deskScreen, '' the main one) the place the
// person gave it, kept in bit.json (server/bit/prefs.js: deskX along the bar, deskY how high when dropped
// away from it, else on the bar); on a screen it visits with desk 'all', beside the clock or where dropped
// this visit. The shell tells a drop (bit_desk/window_win32.rs): along the bar, how high (-1: on the bar)
// and the top-left corner of the screen it landed on. desk.js asks; this file saves.
(() => {
  const HOME = 0.7; // along the bar until dragged: right of the centred icons, left of the tray

  let pending = null; // { screen, x, y }: a drop on its own screen, not saved yet
  let visit = null; // { screen, x, y }: dropped on a screen it is visiting

  const S = () => window.BitDeskScreens;
  const prefs = () => window.BitApp?.state()?.prefs || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const same = (a, b) => (S() ? S().same(a, b) : (a || '') === (b || ''));

  /** Its own screen: '' the main one, or the one it was dropped on while attached and not the dashboard's. */
  function own() {
    const id = pending ? pending.screen : prefs().deskScreen;
    return typeof id === 'string' && id && S()?.usable(id) && S().away(id) ? id : '';
  }

  /** Where it stands on `here`: x along the bar, y how high (null: on the bar). */
  function place(here, cols, cell) {
    if (same(here, own())) {
      if (pending) return { x: pending.x, y: pending.y };
      return { x: num(prefs().deskX) ?? HOME, y: num(prefs().deskY) };
    }
    if (visit && same(visit.screen, here)) return { x: visit.x, y: visit.y };
    return { x: S()?.home(here, cols, cell) ?? HOME, y: null };
  }

  async function save(spot) {
    const body = { deskX: spot.x, deskY: spot.y, deskScreen: spot.screen };
    try {
      const base = typeof SERVER === 'string' ? SERVER : '';
      const res = await fetch(`${base}/api/bit/prefs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const answer = await res.json().catch(() => null);
      if (!answer?.ok || !answer.bit) throw new Error(answer?.error || `HTTP ${res.status}`);
      window.BitApp?.heard(answer.bit);
    } catch (err) {
      console.warn('[bit] its place on the desktop was not saved:', err.message);
    }
    pending = null;
  }

  /**
   * A drop: { x, y (null on the bar), mx, my (its screen's corner; not numbers: the screen it stood on) }.
   * Its own screen (or any with one Bit on one screen) keeps it; another one with desk 'all' is a visit.
   * The dashboard's screen or one not known undoes it. Returns { screen, saved } or null when undone.
   */
  function drop(here, spot, travelling) {
    const found = Number.isFinite(spot.mx) && Number.isFinite(spot.my) ? S()?.at(spot.mx, spot.my) : here;
    if (found == null || (S() && !S().usable(found))) return null;
    const screen = S() ? S().kept(found) : '';
    if (travelling && !same(screen, own())) {
      visit = { screen: found, x: spot.x, y: spot.y };
      return { screen: found, saved: null };
    }
    pending = { screen, x: spot.x, y: spot.y };
    return { screen: travelling ? found : screen, saved: save(pending) };
  }

  window.BitDeskSpot = Object.freeze({
    own,
    place,
    drop,
    busy: () => !!pending,
    /** Gone on to another screen: a visit's place is not kept. */
    leave: () => { visit = null; },
  });
})();

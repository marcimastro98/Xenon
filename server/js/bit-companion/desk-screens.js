// Bit on the desktop: which screens it goes to with desk 'all', and where it stands on each. desk.js
// asks; the screens come from the shell (XenonNative.displayState(): ids as display_list_json gives
// them, sizes in physical pixels).
(() => {
  'use strict';

  const CLOCK_GAP = 110; // logical px kept free at the right end of another screen's bar, for its clock

  const read = () => window.XenonNative?.displayState?.() || {};
  const all = (state) => (Array.isArray(state.displays) ? state.displays : []);
  const find = (id, state) => all(state).find((d) => String(d.id) === id);

  // The screens the person chose for it (prefs.deskScreens, [] every one).
  const chosen = () => window.BitApp?.state()?.prefs?.deskScreens || [];

  /** Every screen it may stand on, left to right: never the dashboard's own, which has its Bit already
   *  (and a kiosk filling it would hide this one). */
  function usableIds(state = read()) {
    const dashboard = String(state.active || '');
    return all(state).slice().sort((a, b) => a.x - b.x || a.y - b.y).map((d) => String(d.id)).filter((id) => id !== dashboard);
  }

  /** The screens it goes to: those chosen that are still there, or all of them when none is. */
  function list(state = read(), pick = chosen()) {
    const ids = usableIds(state);
    const kept = ids.filter((id) => pick.includes(id));
    return kept.length ? kept : ids;
  }

  /** The screen after `here` ('' = the main one), or '' when fewer than two are left to go to. */
  function next(here, state = read()) {
    const ids = list(state);
    if (ids.length < 2) return '';
    const at = ids.indexOf(here || String(all(state).find((d) => d.primary)?.id));
    return ids[(at + 1) % ids.length];
  }

  /** True on a screen other than the main one (a screen gone counts as the main one: the shell's too). */
  const away = (id, state = read()) => !!id && find(id, state)?.primary === false;

  // '' and a screen gone are the main one, as the shell resolves them (monitor::layer_monitor).
  const resolved = (id, state) => (id && find(id, state) ? id : String(all(state).find((d) => d.primary)?.id ?? ''));

  /** Two names of the same screen. */
  const same = (a, b, state = read()) => resolved(a, state) === resolved(b, state);

  /** The screen whose top-left corner is at x, y (physical pixels, as the shell tells a drop), or null. */
  function at(x, y, state = read()) {
    const d = all(state).find((s) => s.x === x && s.y === y);
    return d ? String(d.id) : null;
  }

  /** Where Bit may stand: any screen but the dashboard's, which has its own Bit. */
  const usable = (id, state = read()) => !state.active || !same(id, String(state.active), state);

  /** '' for the main screen, else the id: how a screen is kept in its prefs (deskScreen). */
  const kept = (id, state = read()) => (away(id, state) ? id : '');

  /** Its place along another screen's bar (0-1), `cols` cells of `cell` logical px wide: just left of
   *  the clock, past the centred icons. The main screen's place is the one it was given (desk.js). */
  function home(id, cols, cell, state = read()) {
    const d = find(id, state);
    const scale = Number(d?.scale) || 1;
    const w = cols * Math.max(1, Math.round(cell * scale));
    const room = Number(d?.width) - w;
    if (!(room > 0)) return null;
    return Math.min(1, Math.max(0, (d.width - CLOCK_GAP * scale - w) / room));
  }

  window.BitDeskScreens = Object.freeze({ list, next, away, home, same, at, usable, kept });
})();

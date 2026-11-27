'use strict';
// Bit on the desktop in its room's drawer (room-panels.js, and the guided setup's, room-setup.js): on one
// screen, travelling across the screens the person picks, or not at all; which screen, how big, and the way
// back to its usual spot. Shown where the shell can draw it (caps.bitDesk), also in the Xenon menu's window,
// where the shell hands the screens over as __XENON_BIT_SCREENS__ (it has no display state of its own); the
// desktop Bit itself is drawn from the main window (desk.js).
(() => {
  const DESKS = ['main', 'all', 'off']; // desk.js
  const DESK_SIZES = ['small', 'medium', 'large']; // desk-spot.js; the mouse wheel over it too

  const shown = () => window.__XENON_NATIVE__ === true && window.__XENON_NATIVE_CAPS__?.bitDesk === true;

  function screenState() {
    const native = window.XenonNative?.displayState?.();
    return native?.displays?.length ? native : window.__XENON_BIT_SCREENS__ || {};
  }

  /** The screens it may stand on, left to right, named: never the dashboard's, which has its own Bit. */
  function screens(h) {
    const state = screenState();
    const all = Array.isArray(state.displays) ? state.displays : [];
    const active = String(state.active || '');
    return all.slice().sort((a, b) => a.x - b.x || a.y - b.y)
      .map((d, i) => ({ id: String(d.id), primary: d.primary === true, name: String(d.label || d.name || h.say('mybit_desk_screen_n', { n: i + 1 })) }))
      .filter((d) => d.id !== active);
  }

  const nameOf = (d, h) => (d.primary ? `${d.name} · ${h.say('surface_primary')}` : d.name);

  // A row of screens: one pressed with desk 'main' (its screen, '' the main one), any number with 'all'
  // ([] every one; the last one left stays on).
  function screenRow(p, list, h, ui) {
    const travel = p.desk === 'all';
    const box = makeEl('div', 'bitc-choice');
    const title = h.say(travel ? 'mybit_desk_screens' : 'mybit_desk_screen');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', title);
    box.append(makeEl('span', 'bitc-choice-title', title));
    const row = makeEl('div', 'bitc-seg');
    const picked = p.deskScreens?.length ? list.filter((d) => p.deskScreens.includes(d.id)).map((d) => d.id) : list.map((d) => d.id);
    const mainId = list.find((d) => d.primary)?.id;
    for (const d of list) {
      const on = travel ? picked.includes(d.id) : (p.deskScreen || mainId) === d.id;
      const btn = makeEl('button', 'bitc-seg-btn', nameOf(d, h));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(on));
      btn.addEventListener('click', () => {
        if (!travel) { ui.setPref({ deskScreen: d.primary ? '' : d.id, deskX: null, deskY: null }, h); return; }
        const next = on ? picked.filter((id) => id !== d.id) : [...picked, d.id];
        if (next.length) ui.setPref({ deskScreens: next.length === list.length ? [] : next }, h);
      }, { signal: h.signal });
      row.append(btn);
    }
    box.append(row);
    return box;
  }

  // Where it lives on the desktop; every screen in turn only with two to go to besides the dashboard's (or
  // when already chosen); dragged anywhere, a way back to its usual spot.
  function where(p, list, h, ui) {
    const options = DESKS.filter((v) => v !== 'all' || list.length > 1 || p.desk === 'all');
    const box = ui.choice(h.say('mybit_place'), 'desk', options, p.desk || 'main', (v) => h.say(`mybit_desk_${v}`), h);
    if (p.desk !== 'all') window.BitPerks?.mark(box.querySelector('[data-value="all"]'), 'allScreens'); // kept if it had it
    const moved = typeof p.deskX === 'number' || typeof p.deskY === 'number' || !!p.deskScreen;
    if (!moved || p.desk === 'off') return box;
    const back = makeEl('button', 'bitc-seg-btn bitc-spot-back', h.say('mybit_desk_reset'));
    back.type = 'button';
    back.addEventListener('click', () => ui.setPref({ deskX: null, deskY: null, deskScreen: '' }, h), { signal: h.signal });
    box.append(back);
    return box;
  }

  /**
   * Its rows under their title, where the shell draws it (on macOS and Linux a Beta, which says how it differs
   * there). A Windows app from before Bit on the desktop (its caps never name bitDesk) says what it takes; a
   * browser, a phone or a PC that cannot draw it, nothing.
   * @param {{ choice: Function, setPref: Function }} ui the drawer's own row and save (room-panels.js)
   */
  function parts(p, h, ui) {
    const line = (key) => makeEl('p', 'bitc-line', h.say(key));
    const ua = String(window.navigator?.userAgent);
    const windows = /Windows/.test(ua);
    if (!shown()) {
      const caps = window.__XENON_NATIVE__ === true ? window.__XENON_NATIVE_CAPS__ || {} : null;
      return caps && windows && !('bitDesk' in caps) ? [line('mybit_desk_needs_app')] : [];
    }
    const list = screens(h);
    const beta = windows ? null : /Macintosh|Mac OS X/.test(ua) ? 'mybit_desk_beta_mac' : 'mybit_desk_beta_linux';
    const on = p.desk !== 'off';
    return [
      makeEl('h3', 'bitc-part-title', h.say('mybit_desk')),
      where(p, list, h, ui),
      ...(on && list.length > 1 ? [screenRow(p, list, h, ui)] : []),
      ...(on ? [ui.choice(h.say('mybit_desk_size'), 'deskSize', DESK_SIZES, p.deskSize || 'medium', (v) => h.say(`mybit_desk_size_${v}`), h)] : []),
      ...(on ? [line('mybit_guide_desk_line')] : []),
      ...(beta ? [line(beta)] : []),
    ];
  }

  window.BitRoomDesk = Object.freeze({ parts, screens });
})();

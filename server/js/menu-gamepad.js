'use strict';

// A game controller drives the Xenon menu (plan item 6: handhelds such as the
// ROG Ally or the Legion Go have no keyboard at hand). Standard mapping of the
// browser's Gamepad API, so it is the same on every OS whose webview has it:
// D-pad or left stick moves to the nearest control in that direction, A presses
// it, B closes, LB/RB change section. Read on animation frames only while a
// controller is connected and the page is shown; nothing runs otherwise.
// Opening the menu from the controller is the shell's (layers/pad.rs), since a
// page in the background is never given controller input.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MenuGamepad = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DEAD = 0.5;           // stick travel that counts as a direction
  const REPEAT_FIRST_MS = 400;
  const REPEAT_EVERY_MS = 130;
  const DIRS = ['up', 'down', 'left', 'right'];
  const PRESSES = ['a', 'b', 'lb', 'rb'];
  // Standard mapping: 0 A, 1 B, 4 LB, 5 RB, 12-15 D-pad up/down/left/right.
  const BUTTON = { a: 0, b: 1, lb: 4, rb: 5, up: 12, down: 13, left: 14, right: 15 };

  const pressed = (gp, i) => !!(gp.buttons && gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.5));

  // One pad's state: { up, down, left, right, a, b, lb, rb }.
  function readPad(gp) {
    const s = {};
    if (!gp) return s;
    const x = (gp.axes && gp.axes[0]) || 0;
    const y = (gp.axes && gp.axes[1]) || 0;
    for (const k of Object.keys(BUTTON)) s[k] = pressed(gp, BUTTON[k]);
    s.up = s.up || y < -DEAD;
    s.down = s.down || y > DEAD;
    s.left = s.left || x < -DEAD;
    s.right = s.right || x > DEAD;
    return s;
  }

  // All connected pads read as one: a handheld's built-in pad and a paired one
  // both work.
  function merge(states) {
    const out = {};
    for (const s of states) for (const k of Object.keys(s)) out[k] = out[k] || s[k];
    return out;
  }

  // What happened since the last frame: presses fire once on the way down;
  // a held direction fires, then repeats after a pause. `memo` keeps the
  // previous state and the next repeat time per direction.
  function step(memo, state, now) {
    const acts = [];
    for (const k of PRESSES) {
      if (state[k] && !memo.prev[k]) acts.push(k);
    }
    for (const d of DIRS) {
      if (!state[d]) { memo.next[d] = 0; continue; }
      if (!memo.prev[d]) { acts.push(d); memo.next[d] = now + REPEAT_FIRST_MS; }
      else if (now >= memo.next[d]) { acts.push(d); memo.next[d] = now + REPEAT_EVERY_MS; }
    }
    memo.prev = state;
    return acts;
  }

  // The rect nearest `from` in direction `dir`, or -1. Only rects whose centre
  // lies that way count; distance along the direction weighs less than the
  // sideways offset, so "down" prefers the control right below.
  function nearest(from, rects, dir) {
    const cx = (r) => r.left + r.width / 2;
    const cy = (r) => r.top + r.height / 2;
    let best = -1;
    let bestScore = Infinity;
    rects.forEach((r, i) => {
      const dx = cx(r) - cx(from);
      const dy = cy(r) - cy(from);
      const along = { up: -dy, down: dy, left: -dx, right: dx }[dir];
      const side = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      if (!(along > 1)) return;
      const score = along + side * 2;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  function focusables(rootEl) {
    return [...rootEl.querySelectorAll('button, input, select, [tabindex="0"]')].filter((n) => {
      if (n.disabled || n.closest('[hidden]')) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  // The section LB (-1) or RB (+1) leads to, from the menu's own nav buttons.
  function nextSection(rootEl, delta) {
    const btns = [...rootEl.querySelectorAll('.xm-nav-btn[data-section]')];
    if (!btns.length) return '';
    const i = btns.findIndex((b) => b.getAttribute('aria-current') === 'true');
    return btns[((i < 0 ? 0 : i) + delta + btns.length) % btns.length].dataset.section;
  }

  // Wires a page. opts: { root, onBack, onSection(delta) }. → detach()
  function attach(win, opts) {
    const nav = win.navigator;
    if (!nav || typeof nav.getGamepads !== 'function') return () => {};
    const rootEl = opts.root;
    const memo = { prev: {}, next: {} };
    let frame = 0;

    const pads = () => [...(nav.getGamepads() || [])].filter((g) => g && g.connected !== false);

    function move(dir) {
      const list = focusables(rootEl);
      if (!list.length) return;
      const doc = rootEl.ownerDocument;
      const cur = doc.activeElement;
      if (!cur || !rootEl.contains(cur) || !list.includes(cur)) { list[0].focus(); return; }
      const i = nearest(cur.getBoundingClientRect(), list.map((n) => n.getBoundingClientRect()), dir);
      if (i < 0) return;
      list[i].focus();
      if (typeof list[i].scrollIntoView === 'function') list[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function act(a) {
      rootEl.classList.add('xm-pad');   // the focus ring shows while the controller drives
      if (DIRS.includes(a)) { move(a); return; }
      const cur = rootEl.ownerDocument.activeElement;
      if (a === 'a') {
        if (cur && rootEl.contains(cur) && typeof cur.click === 'function') cur.click();
        else move('down');
      } else if (a === 'b' && typeof opts.onBack === 'function') opts.onBack();
      else if ((a === 'lb' || a === 'rb') && typeof opts.onSection === 'function') opts.onSection(a === 'lb' ? -1 : 1);
    }

    function tick() {
      frame = 0;
      const list = pads();
      if (!list.length) { memo.prev = {}; return; }   // waits for gamepadconnected
      for (const a of step(memo, merge(list.map(readPad)), Date.now())) act(a);
      if (!win.document.hidden) frame = win.requestAnimationFrame(tick);
    }
    const wake = () => { if (!frame) frame = win.requestAnimationFrame(tick); };
    // Any mouse or touch hands the page back: the ring goes until the pad moves.
    const calm = () => rootEl.classList.remove('xm-pad');

    win.addEventListener('gamepadconnected', wake);
    win.document.addEventListener('visibilitychange', wake);
    rootEl.addEventListener('pointerdown', calm);
    wake();
    return function detach() {
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      win.removeEventListener('gamepadconnected', wake);
      win.document.removeEventListener('visibilitychange', wake);
      rootEl.removeEventListener('pointerdown', calm);
    };
  }

  // B: a key row waiting for keys stops waiting (a pad cannot type a combo,
  // so B is its only way out); otherwise the menu closes.
  function back(view, onBack) {
    if (view.recording()) view.cancelRecording();
    else onBack();
  }

  // The Xenon menu's own wiring (both places): B as above, LB/RB change
  // section and keep the focus on its nav button.
  function forMenu(win, rootEl, view, onBack) {
    return attach(win, {
      root: rootEl,
      onBack: () => back(view, onBack),
      onSection: (delta) => {
        const id = nextSection(rootEl, delta);
        if (!id) return;
        view.show(id);
        const cur = rootEl.querySelector('.xm-nav-btn[aria-current="true"]');
        if (cur) cur.focus();
      },
    });
  }

  return { readPad, merge, step, nearest, nextSection, back, attach, forMenu, REPEAT_FIRST_MS, REPEAT_EVERY_MS };
});

'use strict';
// Approval keys: the small pieces every "something is waiting for your OK" card
// on this dashboard needs, so a new card gets them right the first time.
//
//   ARMING      a card ignores taps for its first moments on screen, so a finger
//               already on its way somewhere else (or the tap that woke the
//               screen) cannot land on Allow as the card appears under it.
//   HOLD        an irreversible request is allowed by holding the key, not by
//               tapping it. A keyboard has no reliable hold, so there it is two
//               presses within three seconds.
//   PRESS GUARD a tap is pointerdown + pointerup on the SAME element; a tile
//               rebuilt by an SSE push between the two never receives its click.
//               While a pointer is down inside the scope, rebuilds wait and run
//               just after the click.
//   SCROLL      a rebuild keeps each scrolling area where the reader left it.
//
// The Claude Code tile grew these first (js/claude-widget.js) and keeps its own
// copies; this file is the shared form for the Codex tile and whatever comes
// next. Pure DOM, no state of its own beyond what each caller creates.
(function () {
  function createArming(armMs, onArmed) {
    const firstSeen = new Map();
    const timers = new Set();
    function isArmed(id) {
      if (!firstSeen.has(id)) firstSeen.set(id, Date.now());
      const left = firstSeen.get(id) + armMs - Date.now();
      if (left <= 0) return true;
      if (!timers.has(id)) {
        timers.add(id);
        setTimeout(() => { timers.delete(id); try { onArmed(); } catch { /* repaint */ } }, left + 30);
      }
      return false;
    }
    // Ids are unique per request; without this the map grows for as long as the
    // page is open.
    function forget(aliveIds) {
      const alive = new Set(aliveIds);
      for (const id of firstSeen.keys()) if (!alive.has(id)) firstSeen.delete(id);
    }
    return { isArmed, forget };
  }

  // `isArmed()` is asked at press time; `onConfirm()` runs after the hold.
  function holdButton({ className, label, pressAgain, holdMs, disabled, isArmed, onConfirm }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    const fill = document.createElement('span');
    fill.className = 'ak-fill';
    b.appendChild(fill);
    const text = document.createElement('span');
    text.className = 'ak-label';
    text.textContent = label;
    b.appendChild(text);
    b.style.setProperty('--ak-hold', holdMs + 'ms');
    b.disabled = !!disabled;
    let timer = 0;
    const stop = () => { clearTimeout(timer); timer = 0; b.classList.remove('is-holding'); };
    b.addEventListener('pointerdown', (e) => {
      if (b.disabled || !isArmed()) return;
      try { b.setPointerCapture(e.pointerId); } catch { /* not every pointer captures */ }
      b.classList.add('is-holding');
      timer = setTimeout(() => { timer = 0; b.classList.remove('is-holding'); onConfirm(); }, holdMs);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('lostpointercapture', stop);
    let keyAt = 0;
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (b.disabled || !isArmed()) return;
      if (Date.now() - keyAt < 3000) { onConfirm(); return; }
      keyAt = Date.now();
      text.textContent = pressAgain;
    });
    return b;
  }

  // `scope` is a selector; `render()` is what runs once the press is over, and
  // only if a rebuild was asked for meanwhile (`defer()`).
  function createPressGuard(scope, render) {
    let pressing = false;
    let deferred = false;
    let timer = 0;
    function release() {
      if (!pressing) return;
      pressing = false;
      clearTimeout(timer);
      if (!deferred) return;
      deferred = false;
      // After the click: it is dispatched after pointerup in the same task.
      setTimeout(render, 40);
    }
    document.addEventListener('pointerdown', (e) => {
      const target = e.target;
      if (!(target && target.closest && target.closest(scope))) return;
      pressing = true;
      clearTimeout(timer);
      // A release we never hear about must not hold rendering back for long.
      timer = setTimeout(release, 2500);
    }, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    return {
      get pressing() { return pressing; },
      defer() { deferred = true; },
    };
  }

  function keepScroll(root, selectors) {
    return selectors.map((sel) => Array.from(root.querySelectorAll(sel), (n) => n.scrollTop));
  }
  function restoreScroll(root, selectors, kept) {
    selectors.forEach((sel, i) => {
      root.querySelectorAll(sel).forEach((n, j) => { if (kept[i] && kept[i][j]) n.scrollTop = kept[i][j]; });
    });
  }

  window.ApprovalKeys = { createArming, holdButton, createPressGuard, keepScroll, restoreScroll };
})();

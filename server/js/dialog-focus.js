// What a window that stops the page does with the keyboard, in one place: the focus goes
// in and comes back, Tab stays inside, Esc closes the window on top and only that one.
// https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
(function () {
  'use strict';

  const TABBABLE = 'a[href], button, input, select, summary, textarea, [tabindex]';
  const held = [];   // the last one is on top: the share windows stack

  // What a shut row hides still has a box, but focus() does nothing there and Tab would
  // stop on the row above for good. Only the row's own head can be reached.
  function shutAway(node) {
    const row = node.closest('details');
    return !!row && !row.open && row.querySelector('summary') !== node;
  }

  function tabbable(root) {
    return [...root.querySelectorAll(TABBABLE)]
      .filter((node) => !node.disabled && node.tabIndex !== -1 && node.offsetParent && !shutAway(node));
  }

  // A layer raised above this window (a permission prompt) keeps its own keys.
  function raisedAbove(root) {
    const active = document.activeElement;
    return !!active && active !== document.body && !root.contains(active);
  }

  function keepInside(e, root) {
    const all = tabbable(root);
    e.preventDefault();
    if (!all.length) return;
    const at = all.indexOf(document.activeElement);
    if (at < 0) all[e.shiftKey ? all.length - 1 : 0].focus();
    else all[(at + (e.shiftKey ? all.length - 1 : 1)) % all.length].focus();
  }

  // Taken on the window, in the capture phase: the page answers Esc on the document in
  // that same phase, and it would close Settings or the Store under this window.
  function onKey(e) {
    const top = held[held.length - 1];
    if (raisedAbove(top.root) || (top.leavesKeys && top.leavesKeys())) return;
    if (e.key === 'Escape') {
      if (top.leavesEsc && top.leavesEsc()) return;
      e.preventDefault();
      e.stopPropagation();
      // A list open inside the window goes first; its own Esc sits below this one.
      const list = top.root.querySelector('.cs-wrap.cs-open');
      if (list) list._csClose();
      else top.onEsc();
    } else if (e.key === 'Tab') keepInside(e, top.root);
  }

  function release(entry) {
    const at = held.indexOf(entry);
    if (at < 0) return;
    const wasTop = at === held.length - 1;
    held.splice(at, 1);
    if (!held.length) window.removeEventListener('keydown', onKey, true);
    if (wasTop && entry.back && entry.back.isConnected) entry.back.focus();
    // Opened from a page with nothing focused, there is no way back, and a window that
    // stays in the page hidden would keep the focus: Enter would press a key nobody sees.
    if (entry.root.contains(document.activeElement)) document.activeElement.blur();
  }

  // Returns what lets go. `start` takes the focus: the window itself when it has no
  // key to offer. The ring is for Tab: these can open with nobody at the keyboard.
  // `leavesEsc` says when something inside answers Esc itself: a search with words in it.
  // `leavesKeys` says when something inside takes every key: a combination being recorded,
  // where Tab and Esc are keys like the others.
  function hold(root, { start = root, onEsc, leavesEsc, leavesKeys }) {
    const entry = { root, onEsc, leavesEsc, leavesKeys, back: document.activeElement };
    if (!held.length) window.addEventListener('keydown', onKey, true);
    held.push(entry);
    start.focus({ focusVisible: false });
    return () => release(entry);
  }

  window.DialogFocus = Object.freeze({ hold });
})();

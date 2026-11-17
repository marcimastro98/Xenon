// What the question about how Xenon is used is drawn from: its words and elements, the mode saved
// today, the screens of this PC, the line under the choices, the last step that has the person press
// the key opening Xenon (js/usage-ask/key-step.js), and the short show of the side buttons.
'use strict';

(() => {
  const TITLE = {
    both: 'usage_ask_both_title', widgets: 'usage_ask_widgets_title', dashboard: 'usage_ask_dash_title', phone: 'usage_ask_phone_title',
  };
  const RAILS_PEEK_MS = 3200;

  const plan = () => window.UsageAskPlan;

  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  const settings = () => (typeof hubSettings === 'object' && hubSettings) || {};
  const current = () => (window.UsageMode ? window.UsageMode.normalize(settings().usageMode) : '');

  // The key that opens Xenon over any app, as stored: 'off' when turned off.
  function menuCombo() {
    const layers = settings().layers || {};
    const combo = typeof layers.menuKey === 'string' && layers.menuKey ? layers.menuKey : 'alt+shift+x';
    return (combo !== 'off' && window.DeckShortcuts?.normalizeShortcut?.(combo)) || combo;
  }

  function displays() {
    const native = window.XenonNative;
    if (!native || typeof native.displayState !== 'function') return [];
    return native.displayState().displays || [];
  }

  function subLine() {
    return el('p', 'ua-sub', tr('usage_ask_sub', 'Change it any time in Xenon or by asking Bit.'));
  }

  // The last step where this app draws Xenon over the screen: the person presses its key.
  // Before anything moves: the dialog is still on the screen they answered on, and "Widgets
  // only" would trade this page for the driver page.
  function keyStep(overlay, answer) {
    const combo = menuCombo();
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    if (answer.phone || caps.menu !== true || combo === 'off' || !window.UsageAskKey) return Promise.resolve('');
    const mac = /Mac/i.test(navigator.platform || '');
    const format = (c) => (window.DeckShortcuts ? window.DeckShortcuts.formatShortcut(c, mac) : c);
    // The picture now shows the answer: its screens are no longer there to tap.
    const left = /** @type {HTMLElement} */ (overlay.querySelector('.ua-left'));
    left.inert = true;
    left.querySelector('.ua-hint').classList.remove('is-on');
    return window.UsageAskKey.run(overlay.querySelector('.ua-right'), { tr, combo, format });
  }

  // With the tour gone from the first run, this is how the side buttons get seen.
  function peekRails() {
    const rails = window.TopbarMinimal;
    if (!rails || typeof rails.peekRails !== 'function') return;
    rails.peekRails(true);
    setTimeout(() => rails.peekRails(false), RAILS_PEEK_MS);
  }

  // "Widgets only" in the app's own window (the splash opens it with shell=main): saving the
  // mode trades this page for the small driver page, which the shell hides (layers-shell.js).
  function leavesForDriver(answer) {
    if (answer.usage !== 'widgets' || answer.phone) return false;
    try { return new URLSearchParams(window.location.search).get('shell') === 'main'; } catch { return false; }
  }

  window.UsageAskPieces = {
    TITLE, plan, tr, el, current, displays, subLine, keyStep, peekRails, leavesForDriver,
  };
})();

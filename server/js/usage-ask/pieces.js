// What the question about how Xenon is used is drawn from: its words and elements, the mode saved
// today, the key of the Xenon menu as text, the screens of this PC, the line under the choices, and
// the short show of the side buttons.
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

  function menuKeyText() {
    const layers = settings().layers || {};
    const combo = typeof layers.menuKey === 'string' && layers.menuKey ? layers.menuKey : 'alt+shift+x';
    return window.DeckShortcuts && typeof window.DeckShortcuts.formatShortcut === 'function'
      ? window.DeckShortcuts.formatShortcut(combo) : combo;
  }

  function displays() {
    const native = window.XenonNative;
    if (!native || typeof native.displayState !== 'function') return [];
    return native.displayState().displays || [];
  }

  function subLine() {
    const sub = el('p', 'ua-sub');
    // The key combination never breaks across lines ("Alt + Shift" / "+ X").
    const [before, after = ''] = tr('usage_ask_sub', 'Change it any time from the Xenon menu ({key}) or by asking Bit.').split('{key}');
    sub.append(el('span', '', before), el('span', 'ua-key', menuKeyText()), el('span', '', after));
    return sub;
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
    TITLE, plan, tr, el, current, displays, subLine, peekRails, leavesForDriver,
  };
})();

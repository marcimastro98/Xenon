'use strict';

// "How do you want to use Xenon?" (plan §20): asked once, in the app that can
// draw widgets on the screen, right after "Where do you want Xenon?" and before
// the tour. Three cards, one choice, written once into `usageMode`
// (js/usage-mode.js); the Xenon menu, Settings and Bit change it later.
//
// '' means "not asked yet" and behaves like the dashboard, so nobody's screen
// changes until they answer, and the card preselected is Dashboard.

(function () {
  const MODES = ['dashboard', 'widgets', 'both'];
  const ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M7 8h4v4H7zM14 8h3M14 11h3M8 20h8"/></svg>',
    widgets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><rect x="14" y="6.5" width="5.5" height="4" rx="1"/><path d="M8 21h8M12 17v4"/></svg>',
    both: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="5" width="13" height="9" rx="1.5"/><rect x="16.5" y="8" width="6" height="11" rx="1.5"/><path d="M5 18h6M8 14v4"/></svg>',
  };
  const BODY = { dashboard: 'usage_ask_dash_body', widgets: 'usage_ask_widgets_body', both: 'usage_ask_both_body' };

  let overlay = null;
  let picked = 'dashboard';
  let onDone = null;

  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  const settings = () => (typeof hubSettings === 'object' && hubSettings) || {};
  const current = () => (window.UsageMode ? window.UsageMode.normalize(settings().usageMode) : '');

  function menuKeyText() {
    const layers = settings().layers || {};
    const combo = typeof layers.menuKey === 'string' && layers.menuKey ? layers.menuKey : 'alt+shift+x';
    return window.DeckShortcuts && typeof window.DeckShortcuts.formatShortcut === 'function'
      ? window.DeckShortcuts.formatShortcut(combo) : combo;
  }

  // Only in the app on this PC, where the widgets can be drawn, and only once.
  function shouldAsk() {
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    if (window.__XENON_NATIVE__ !== true || caps.layers !== true) return false;
    if (current()) return false;
    if (window.__xenonRemote) return false;
    if (typeof isLayerPage === 'function' && isLayerPage()) return false;
    try { if (window.self !== window.top) return false; } catch (e) { return false; }
    return true;
  }

  function close() {
    if (!overlay) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('usage-ask', false);
  }

  function confirm() {
    const value = picked;
    const then = onDone;
    onDone = null;
    close();
    if (typeof updateUsageMode === 'function') updateUsageMode(value);
    if (typeof then === 'function') then(value);
  }

  // Arrows move the choice like any radio group; Enter confirms. No Esc: the
  // question has no "later", and the preselected answer is one tap away.
  function onKey(e) {
    if (!overlay) return;
    const i = MODES.indexOf(picked);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') picked = MODES[(i + 1) % MODES.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') picked = MODES[(i + MODES.length - 1) % MODES.length];
    else if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); confirm(); return; }
    else return;
    e.preventDefault();
    render();
    const on = overlay.querySelector('.ua-card.is-on');
    if (on) on.focus();
  }

  function card(mode) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-card ua-card' + (mode === picked ? ' is-on' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', mode === picked ? 'true' : 'false');
    b.tabIndex = mode === picked ? 0 : -1;
    const head = document.createElement('span');
    head.className = 'sp-card-head';
    head.innerHTML = ICONS[mode];
    const title = document.createElement('b');
    title.textContent = tr('xmenu_mode_' + mode, mode);
    head.appendChild(title);
    const body = document.createElement('span');
    body.className = 'ua-body';
    body.textContent = tr(BODY[mode], '');
    const state = document.createElement('span');
    state.className = 'ua-state';
    state.textContent = mode === picked ? tr('usage_ask_chosen', 'Chosen') : tr('usage_ask_pick', 'Choose');
    b.append(head, body, state);
    b.addEventListener('click', () => {
      picked = mode;
      render();
      const on = overlay && overlay.querySelector('.ua-card.is-on');
      if (on) on.focus();
    });
    b.addEventListener('dblclick', confirm);
    return b;
  }

  function render() {
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement('div');
      overlay.className = 'sp-overlay ua-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey, true);
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze('usage-ask', true);
    }
    const box = document.createElement('div');
    box.className = 'sp-box';
    const h = document.createElement('h2');
    h.id = 'ua-title';
    h.textContent = tr('usage_ask_title', 'How do you want to use Xenon?');
    overlay.setAttribute('aria-labelledby', 'ua-title');
    const sub = document.createElement('p');
    sub.className = 'sp-sub';
    // The key combination never breaks across lines ("Alt + Shift" / "+ X").
    const [before, after = ''] = tr('usage_ask_sub', 'Change it any time from the Xenon menu ({key}) or by asking Bit.').split('{key}');
    const span = (txt, cls) => {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      s.textContent = txt;
      return s;
    };
    sub.append(span(before), span(menuKeyText(), 'ua-key'), span(after));
    const cards = document.createElement('div');
    cards.className = 'sp-cards ua-cards';
    cards.setAttribute('role', 'radiogroup');
    cards.setAttribute('aria-labelledby', 'ua-title');
    MODES.forEach((m) => cards.appendChild(card(m)));
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'settings-btn primary ua-go';
    go.textContent = tr('usage_ask_go', 'Continue');
    go.addEventListener('click', confirm);
    box.append(h, sub, cards, go);
    overlay.replaceChildren(box);
  }

  // `then(mode)` runs after the answer is saved (Settings starts the tour).
  function maybeStart(then) {
    if (overlay || !shouldAsk()) return !!overlay;
    picked = 'dashboard';
    onDone = typeof then === 'function' ? then : null;
    render();
    const on = overlay.querySelector('.ua-card.is-on');
    if (on) on.focus();
    return true;
  }

  window.UsageAsk = { maybeStart, shouldAsk, isOpen: () => !!overlay, close };
})();

// Where the search of Settings takes you: the picks it remembers on this screen, the results view
// switched on and off, and the row a pick lands on.
'use strict';

(() => {
  const { onScreen } = window.SettingsSearchRows;
  const { ROW_SEL, content } = window.SettingsSearchIndexOfRows;

  const RECENT_KEY = 'xeneonedge.settingsSearchRecent.v1';
  const RECENT_MAX = 5;

  const input = () => document.getElementById('settings-search-input');
  const panel = () => document.getElementById('settings-search-results');

  function readRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }

  function pushRecent(id) {
    try {
      const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch { /* private mode, blocked storage: the search still works */ }
  }

  function setSearching(on) {
    const c = content();
    const box = panel();
    if (!c || !box) return;
    c.classList.toggle('is-searching', on);
    box.hidden = !on;
    input()?.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) c.scrollTop = 0;
  }

  // A row behind a switch that is off is not on screen: the switch is the way in.
  // A block names its own; otherwise it is the row before, up through the parents.
  function landing(el) {
    const root = content();
    if (onScreen(el)) return el;
    const gate = el.closest('[data-behind-switch]');
    const named = gate && document.getElementById(gate.dataset.behindSwitch);
    if (named && onScreen(named)) return named.closest(ROW_SEL) || named;
    for (let n = el; n && n !== root; n = n.parentElement) {
      if (onScreen(n)) return n;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
        if (onScreen(s) && (s.matches(ROW_SEL) || s.querySelector(ROW_SEL))) return s;
      }
    }
    return null;
  }

  function reveal(entry, fromKeyboard) {
    if (!entry) return;
    pushRecent(entry.id);
    setSearching(false);
    if (typeof settingsSetCategory === 'function') settingsSetCategory(entry.cat);
    // On a phone the category list may be open over the content: the choice
    // is made, fold it away like a category tap does.
    document.getElementById('settings-nav')?.classList.remove('is-open');
    const target = entry.el && entry.el.isConnected ? entry.el : null;
    if (!target) return;
    const details = target.closest('details');
    if (details && !details.open) details.open = true;
    const el = landing(target);
    if (!el) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // After settingsSetCategory's column packing has placed the cards.
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      el.classList.remove('settings-search-flash');
      void el.offsetWidth;   // restart the animation on a second pick
      el.classList.add('settings-search-flash');
      setTimeout(() => el.classList.remove('settings-search-flash'), 2600);
      if (fromKeyboard) {
        const ctl = el.matches('button, input, select, textarea') ? el : el.querySelector('input:not([type="hidden"]), select, textarea, button');
        if (ctl) { try { ctl.focus({ preventScroll: true }); } catch { /* best effort */ } }
      }
    });
  }

  // A category picked from the sidebar ends the search view.
  function leave() {
    if (content()?.classList.contains('is-searching')) setSearching(false);
  }

  window.SettingsSearchGoing = { input, panel, readRecent, setSearching, reveal, leave };
})();

'use strict';

// One screen of the dashboard alone in the Xenon menu's window (`/?panel=sheet`):
// Settings, the Store, Scintille, the gallery or the chat, opened from the address by
// js/dashboard-open.js, with nothing behind them (components/SheetPage). When the
// screen closes the window goes back to the menu it came from, or away; a screen or a menu section asked
// for elsewhere (a tile's Set up button, Bit, the tray) takes its place.

(function () {
  if (typeof isSheetPage !== 'function' || !isSheetPage()) return;

  const MENU_ADDRESS = '/menu?back=1';
  const SECTION_KEY = 'xenon.menuSection';   // js/screen-menu-page.js reads it back
  const OPEN_GRACE_MS = 1500;   // the screen opens on `load`, the Store after a read
  const SETTLE_MS = 400;        // Settings closing to open the Store is not an end
  const INNER_LAYERS = '.cgal-detail-scrim, .cgal-zoom, .cs-wrap.cs-open, .ai-attach-menu';

  let leaving = false;
  let settle = 0;
  let inner = false;
  let overlays = 0;
  let showAll = false;

  const settingsOpen = () => {
    const el = document.getElementById('settings-overlay');
    return !!el && !el.hidden;
  };
  const voiceOpen = () => {
    const el = document.getElementById('ai-overlay');
    return !!el && !el.hidden;
  };
  const showing = () => !!window.SheetChat || settingsOpen() || !!document.querySelector('.preset-modal-overlay, .wn-stage, #deck-mix-backdrop, #deck-editor-backdrop');

  function go(address) {
    if (leaving) return;
    leaving = true;
    window.location.replace(address);
  }

  // Opened straight from a key, the tray or Bit there is no menu to go back to, and
  // one would land over the game: the window goes first, then its page changes.
  function done() {
    if (leaving) return;
    let section = '';
    try { section = sessionStorage.getItem(SECTION_KEY) || ''; } catch (e) { /* no menu to come back to */ }
    if (section) { go(MENU_ADDRESS); return; }
    fetch(SERVER + '/screen-menu', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: false }),
    }).catch(() => { /* the server is restarting: the shell closes it with the server */ })
      .then(() => go(MENU_ADDRESS));
  }

  function watch() {
    clearTimeout(settle);
    settle = setTimeout(() => { if (!showing()) done(); }, SETTLE_MS);
  }

  // "Show everything" at the end of a shortened list. A class hides the rest, not
  // `hidden`, so the search of Settings still finds it.
  function moreRow(nav) {
    let row = nav.querySelector('.sheet-more');
    if (row) return row;
    row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-nav-btn sheet-more';
    row.dataset.i18n = 'settings_nav_all';
    row.textContent = typeof t === 'function' ? t('settings_nav_all') : 'Show all';
    row.addEventListener('click', () => { showAll = true; applyUsage(); });
    nav.append(row);
    return row;
  }

  const navRow = (el) => ({
    label: el.classList.contains('settings-nav-label'), cat: el.dataset.settingsCat || '', active: el.classList.contains('active'),
  });

  // Someone with no dashboard sees the settings that apply to them (js/sheet-usage.js).
  function applyUsage() {
    const nav = document.getElementById('settings-nav-scroll');
    if (!nav) return;
    const settings = typeof hubSettings === 'object' ? hubSettings : null;
    const hidden = showAll ? [] : SheetUsage.hiddenCategories(settings);
    const more = moreRow(nav);
    const rows = [...nav.children].filter((el) => el !== more);
    const list = rows.map(navRow);
    const off = SheetUsage.navState(list, hidden);
    rows.forEach((el, i) => el.classList.toggle('sheet-off', off[i]));
    more.hidden = hidden.length === 0;
    document.body.classList.toggle('sheet-short', hidden.length > 0);
    if (settingsOpen() && SheetUsage.leavesActive(list, off) && typeof settingsSetCategory === 'function') settingsSetCategory('general');
  }

  // The Store and Settings have no Esc of their own: on the dashboard they are
  // one layer of many, here the only one. What sits above them closes first, so
  // the look is taken before the inner layers' own handlers change it.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    inner = !!document.querySelector(INNER_LAYERS);
    overlays = document.querySelectorAll('.preset-modal-overlay').length;
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || inner) return;
    if (settingsOpen()) {
      if (overlays === 0 && typeof closeSettings === 'function') closeSettings();
    } else if (overlays === 1 && document.querySelector('.cgal-overlay:not(.capg-overlay)') && window.CommunityGallery) {
      window.CommunityGallery.close();
    } else if (overlays === 0 && window.SheetChat) {
      if (!voiceOpen()) done();
      else if (typeof closeAiPanel === 'function') closeAiPanel();
    }
  });

  function onMenu(d) {
    if (!d || d.open !== true) return;   // closed: the shell takes the window away
    const next = d.sheet ? DashboardOpen.sheetAddress(d.sheet) : '';
    if (next) { go(next); return; }
    try { sessionStorage.setItem(SECTION_KEY, d.section || ''); } catch (e) { /* the first section */ }
    go(MENU_ADDRESS);
  }

  window.addEventListener('xenon-menu-changed', applyUsage);
  window.addEventListener('load', () => {
    applyUsage();
    setTimeout(() => {
      applyUsage();
      const el = document.getElementById('settings-overlay');
      const seen = new MutationObserver(watch);
      if (el) seen.observe(el, { attributes: true, attributeFilter: ['hidden'] });
      seen.observe(document.body, { childList: true });
      watch();
    }, OPEN_GRACE_MS);
  }, { once: true });

  window.XenonSheet = Object.freeze({ onMenu, back: done });
})();

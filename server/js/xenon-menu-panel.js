'use strict';

// The Xenon menu inside the dashboard: its sections are pages of Settings, the one
// place called Xenon (the rail is js/xenon-pages.js's). A section is drawn into
// #settings-place by the same view as the menu's own window (js/xenon-menu.js, from
// GET /xenon-menu), with no rail of its own. Opened by the rail, by the "Main screen"
// tile, by SSE `xenon_menu_panel` (the menu asked for where no shell can draw it over
// the screen) and by window.XenonMenuPanel.open(section). Verbs that lead elsewhere
// run here: the gallery opens on this dashboard, Bit wakes here, another page of
// Settings is a step inside the same place.

(function () {
  if (!window.XenonMenuView || !window.XenonPages) return;
  let view = null;
  let refreshTimer = 0;
  const REFRESH_DELAY_MS = 250;
  const box = () => document.getElementById('settings-place');
  const overlay = () => document.getElementById('settings-overlay');
  const isOpen = () => !!view && !!overlay() && !overlay().hidden;

  function openVerb(verb) {
    const [what, cat] = String(verb || '').split(':');
    if (what === 'dashboard' || !window.DashboardOpen) return;
    window.DashboardOpen.run(what === 'macro' ? { open: what, id: cat } : what === 'settings' ? { open: what, cat } : { open: what, kind: cat });
  }

  // A row that closes the menu closes Settings, unless it leads to another of its pages.
  function closeFor(act) {
    if (act && String(act.open || '').startsWith('settings:')) return;
    if (typeof closeSettings === 'function') closeSettings();
  }

  // Gone with its page: the view listens to the keyboard (Ctrl+Z on the screens), and
  // its root tells the cards waiting to show that someone is busy here (interrupt-queue.js).
  function drop() {
    if (!view) return;
    view.destroy();
    view = null;
    box().replaceChildren();
  }

  // Settings shows `cat` (settingsSetCategory): a section of the menu is drawn here,
  // anything else leaves this box out. Alone in the menu's window (a sheet) Settings
  // came from the menu, and the menu's sections go back there.
  function page(cat) {
    const el = box();
    if (!el) return;
    const section = XenonPages.isSection(cat) && !(typeof isSheetPage === 'function' && isSheetPage()) ? cat : '';
    el.dataset.settingsCat = section;
    if (!section) {
      drop();
      if (XenonPages.isSection(cat) && cat !== 'capture' && window.XenonSheet) window.XenonSheet.onMenu({ open: true, section: cat });
      return;
    }
    if (!view) {
      const root = document.createElement('div');
      root.id = 'xm-root';   // the menu's rules that meet a skin's list carry it
      el.replaceChildren(root);
      view = XenonMenuView.create(root, { place: 'dashboard', bare: true, server: SERVER, t, onClose: closeFor, onOpen: openVerb });
      view.load();
    }
    view.show(section);
  }

  function open(section) {
    if (typeof openSettings === 'function') openSettings(XenonPages.pageOf(section) || 'screens');
  }

  function close() {
    if (isOpen() && typeof closeSettings === 'function') closeSettings();
  }

  // Esc leaves a widget's screen first, and is left alone while a key is recorded or
  // a name typed. True when it was taken here and Settings stays.
  function escape() {
    if (!isOpen() || box().hidden) return false;
    return view.holdsEsc() || view.stepBack();
  }

  window.addEventListener('xenon-menu-changed', () => {
    if (!view) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (view) view.load(); }, REFRESH_DELAY_MS);
  });
  // Settings closed: the page goes with it, and opens fresh next time.
  const shade = overlay();
  if (shade && typeof MutationObserver === 'function') {
    new MutationObserver(() => { if (shade.hidden) drop(); }).observe(shade, { attributes: true, attributeFilter: ['hidden'] });
  }

  window.XenonMenuPanel = { open, close, openVerb, isOpen, page, escape };
})();

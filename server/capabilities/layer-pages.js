'use strict';
// Widget pages by voice, Deck key or edit mode: "show my work widgets", "make a
// Games page", "show it when I play", "show Work on desktop 2". The edits are server/layer-pages.js;
// deps are the same as capabilities/layers.js ({ layers: { get, update } }).
const P = require('../layer-pages.js');

const failed = (res) => ({ ok: false, error: (res && res.error) || 'failed', ...(res && res.choices ? { choices: res.choices } : {}) });

async function switchPage(d, action) {
  const res = await d.layers.update((cur) => P.setActivePage(cur, action.page));
  if (!res || res.error) return failed(res);
  return { ok: true, page: res.label };
}

const EDITS = {
  create: (cur, a) => P.addPage(cur, a.name),
  rename: (cur, a) => P.renamePage(cur, a.page, a.name),
  delete: (cur, a) => P.removePage(cur, a.page),
  gaming: (cur, a) => P.setGamingPage(cur, a.page, true),
  notGaming: (cur, a) => P.setGamingPage(cur, a.page, false),
  desktop: (cur, a) => P.setDesktopPage(cur, a.page, a.desktop == null || a.desktop === '' ? 0 : a.desktop),
};

async function editPages(d, action) {
  const editFn = EDITS[action.mode];
  if (!editFn) return { ok: false, error: 'bad_mode' };
  // A page tied to a desktop only where the shell says which desktop is shown.
  // Untying (desktop 0) always works, so a page tied on another computer can be freed.
  const tying = action.mode === 'desktop' && Number(action.desktop || 0) !== 0;
  if (tying && !(d.host && d.host.desks && d.host.desks())) return { ok: false, error: 'no_desktops' };
  const res = await d.layers.update((cur) => editFn(cur, action));
  if (!res || res.error) return failed(res);
  const out = { ok: true, pages: P.describePages(res.layers) };
  if (action.mode === 'delete') { out.deleted = res.label; out.widgetsRemoved = res.removed; }
  if (action.mode === 'desktop') out.desktop = res.desktop;
  const shown = d.host && d.host.shownDesk ? d.host.shownDesk() : null;
  if (shown) out.desktopShown = shown;
  return out;
}

// For edit mode's "Show on a desktop": null where the shell cannot say which desktop is
// shown, else the desktop shown and how many there are (0 until it has said).
function desks(host) {
  if (!(host && host.desks && host.desks())) return null;
  const shown = host.shownDesk ? host.shownDesk() : null;
  return shown || { current: 0, count: 0 };
}

module.exports = { switchPage, editPages, desks };

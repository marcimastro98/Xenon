'use strict';
// The Store as the Xenon menu window shows it (xenon-menu.js, capabilities/layers.js):
// the first picture of each installed widget, and how many things this PC got from
// the Store have a newer version there. The count is the Store's own join
// (packages/core/src/store-updates.js), so the menu and the Store never disagree.
//
// The pictures and the versions come from the kept catalog. A first fetch that is
// slow must not hold the menu back: the cards then show their initials and the
// count is left out until the next opening, never a guessed number.

const MenuWidgets = require('./menu-widgets.js');

// Guarded like community-catalog.js: a checkout whose postinstall has not linked
// server/shared yet must still serve the menu, only without the count.
let storeUpdates = null;
try { storeUpdates = require('./shared/src/store-updates.js'); }
catch { storeUpdates = null; }

const MENU_CATALOG_WAIT_MS = 500;

async function keptCatalog(fetchCatalog) {
  let timer = null;
  const wait = new Promise((done) => { timer = setTimeout(done, MENU_CATALOG_WAIT_MS, null); });
  try {
    const out = await Promise.race([Promise.resolve().then(fetchCatalog).catch(() => null), wait]);
    return out && out.ok && Array.isArray(out.entries) ? out.entries : null;
  } finally {
    clearTimeout(timer);
  }
}

// deps: {
//   catalog()  -> Promise<{ ok, entries }>, the visible catalog (SWR-cached)
//   packages() -> Promise<[{ id, version, catalogVersion }]>, the installed widgets
//   installs   -> hubSettings.contentInstalls, the install receipts
// }
// -> { shots: { [pkgId]: picture }, updates: number | null }; null = not known now.
async function read({ catalog, packages, installs }) {
  const entries = await keptCatalog(catalog);
  if (!entries) return { shots: {}, updates: null };
  const shots = MenuWidgets.storeShots(entries);
  if (!storeUpdates) return { shots, updates: null };
  let list = [];
  try { list = await packages(); } catch { list = []; }
  const index = storeUpdates.buildIndex(list, installs);
  return { shots, updates: storeUpdates.findUpdates(entries, index).length };
}

module.exports = { read, MENU_CATALOG_WAIT_MS };

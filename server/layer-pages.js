'use strict';
// Pages of the widgets on the screen ("Work", "Games"): the edits, all pure.
// The shape and its rules live in js/layers-model.js (normalize); every
// function here takes the stored layers and returns a new object, never
// touching its input. The server runs them under the settings lock.
const L = require('./js/layers-model.js');

const pageId = (random) => 'lp_' + L.newId(random).slice(3);
const cleanName = (raw) => String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, L.PAGE_NAME_MAX);

// What a person (or the AI) calls a page: "Page 2" when it has no name.
function pageLabel(cur, page) {
  return page.name || 'Page ' + (cur.pages.indexOf(page) + 1);
}

// A page by its id, its name, or its number counted from 1.
function findPage(cur, ref) {
  const want = String(ref == null ? '' : ref).trim().toLowerCase();
  if (!want) return null;
  const byId = cur.pages.find((p) => p.id === want);
  if (byId) return byId;
  const byName = cur.pages.find((p) => pageLabel(cur, p).toLowerCase() === want);
  if (byName) return byName;
  const n = /^\d{1,2}$/.test(want) ? Number(want) : 0;
  return n >= 1 && n <= cur.pages.length ? cur.pages[n - 1] : null;
}

const nameTaken = (cur, name, except) => !!name && cur.pages.some((p) => p !== except && p.name.toLowerCase() === name.toLowerCase());
const choices = (cur) => cur.pages.map((p) => pageLabel(cur, p));

// The first new page also makes the page every widget sits on today, so
// nothing moves; the new one is shown, empty, ready to fill.
function addPage(layers, name, random) {
  const cur = L.normalize(layers);
  if (cur.pages.length >= L.MAX_PAGES) return { error: 'too_many_pages' };
  const clean = cleanName(name);
  if (nameTaken(cur, clean)) return { error: 'name_taken' };
  const taken = new Set(cur.pages.map((p) => p.id));
  const fresh = () => { let id = pageId(random); while (taken.has(id)) id = pageId(); taken.add(id); return id; };
  const pages = cur.pages.length ? cur.pages.slice() : [{ id: fresh(), name: '' }];
  const page = { id: fresh(), name: clean };
  pages.push(page);
  return { layers: L.normalize({ ...cur, pages, page: page.id }), page };
}

function renamePage(layers, ref, name) {
  const cur = L.normalize(layers);
  const page = findPage(cur, ref);
  if (!page) return { error: cur.pages.length ? 'unknown_page' : 'no_pages', choices: choices(cur) };
  const clean = cleanName(name);
  if (nameTaken(cur, clean, page)) return { error: 'name_taken' };
  const pages = cur.pages.map((p) => (p === page ? { ...p, name: clean } : p));
  return { layers: L.normalize({ ...cur, pages }), page: { ...page, name: clean } };
}

// Deleting a page deletes the widgets on it; with one page left there are no
// pages at all and every widget is simply on the screen again.
function removePage(layers, ref) {
  const cur = L.normalize(layers);
  const page = findPage(cur, ref);
  if (!page) return { error: cur.pages.length ? 'unknown_page' : 'no_pages', choices: choices(cur) };
  const pages = cur.pages.filter((p) => p !== page);
  const widgets = cur.widgets.filter((w) => w.page !== page.id);
  const next = L.normalize({ ...cur, pages, widgets, page: cur.page === page.id ? pages[0].id : cur.page });
  return { layers: next, removed: cur.widgets.length - widgets.length, label: pageLabel(cur, page) };
}

function setActivePage(layers, ref) {
  const cur = L.normalize(layers);
  if (!cur.pages.length) return { error: 'no_pages' };
  const raw = String(ref == null ? '' : ref).trim().toLowerCase();
  let page;
  if (!raw || raw === 'next') page = cur.pages[(cur.pages.findIndex((p) => p.id === cur.page) + 1) % cur.pages.length];
  else page = findPage(cur, ref);
  if (!page) return { error: 'unknown_page', choices: choices(cur) };
  return { layers: L.normalize({ ...cur, page: page.id }), page, label: pageLabel(cur, page) };
}

// One page at most is the games page; `on` false takes the role away.
function setGamingPage(layers, ref, on) {
  const cur = L.normalize(layers);
  const page = findPage(cur, ref);
  if (!page) return { error: cur.pages.length ? 'unknown_page' : 'no_pages', choices: choices(cur) };
  const pages = cur.pages.map((p) => {
    const { gaming, ...rest } = p;
    // On: this page only. Off: this page loses it, the others keep theirs.
    return (p === page ? on : gaming && !on) ? { ...rest, gaming: true } : rest;
  });
  const next = { ...cur, pages };
  // No games page, nothing to come back from.
  if (!pages.some((p) => p.gaming)) delete next.resume;
  return { layers: L.normalize(next), label: pageLabel(cur, page) };
}

// A page shown while one virtual desktop is (1-9), or on none (0). A desktop
// has one page at most: the page that had it gives it up.
function setDesktopPage(layers, ref, desktop) {
  const cur = L.normalize(layers);
  const page = findPage(cur, ref);
  if (!page) return { error: cur.pages.length ? 'unknown_page' : 'no_pages', choices: choices(cur) };
  const n = Number(desktop);
  if (!Number.isInteger(n) || n < 0 || n > L.MAX_DESKTOP) return { error: 'bad_desktop' };
  const pages = cur.pages.map((p) => {
    const { desktop: had, ...rest } = p;
    if (p === page) return n ? { ...rest, desktop: n } : rest;
    return had && had !== n ? { ...rest, desktop: had } : rest;
  });
  return { layers: L.normalize({ ...cur, pages }), label: pageLabel(cur, page), desktop: n };
}

// A widget changes page alone: it leaves its tabs (they stay on their page).
function moveToPage(layers, widgetId, ref) {
  const cur = L.normalize(layers);
  const page = findPage(cur, ref);
  if (!page) return { error: cur.pages.length ? 'unknown_page' : 'no_pages', choices: choices(cur) };
  const w = cur.widgets.find((x) => x.id === widgetId);
  if (!w) return { error: 'not_found' };
  if (w.page === page.id) return { layers: cur, label: pageLabel(cur, page) };
  const widgets = cur.widgets.map((x) => {
    if (x !== w) return x;
    const { group, active, ...rest } = x;
    return { ...rest, page: page.id };
  });
  return { layers: L.normalize({ ...cur, widgets }), label: pageLabel(cur, page) };
}

// The games page follows the game: shown when one starts, and the page from
// before comes back when it ends, unless the user picked another meanwhile.
// Returns null when nothing changes, so the caller writes only on a change.
function gamePageSwitch(layers, running) {
  const cur = L.normalize(layers);
  const gaming = cur.pages.find((p) => p.gaming);
  if (running) {
    if (!gaming || cur.page === gaming.id || cur.resume) return null;
    return L.normalize({ ...cur, page: gaming.id, resume: cur.page });
  }
  if (!cur.resume) return null;
  const { resume, ...rest } = cur;
  return L.normalize(gaming && cur.page === gaming.id ? { ...rest, page: resume } : rest);
}

// The page of the virtual desktop now shown (`current`, 1-based; 0 = one with
// no number, e.g. a full-screen app's Space). A desktop with a page shows it;
// leaving for a desktop with none brings back the page shown before. The games
// page wins while a game runs. Null when nothing changes.
function deskPageSwitch(layers, current) {
  const cur = L.normalize(layers);
  if (cur.resume) return null;
  const shown = cur.pages.find((p) => p.id === cur.page);
  const bound = current ? cur.pages.find((p) => p.desktop === current) : null;
  if (bound) {
    if (bound === shown) return null;
    const back = shown && !shown.desktop ? shown.id : cur.deskBack;
    return L.normalize({ ...cur, page: bound.id, deskBack: back });
  }
  if (!shown || !shown.desktop || !cur.deskBack) return null;
  const { deskBack, ...rest } = cur;
  return L.normalize({ ...rest, page: deskBack });
}

// The pages as the AI and the list read them.
function describePages(layers) {
  const cur = L.normalize(layers);
  return cur.pages.map((p, i) => ({
    name: pageLabel(cur, p), index: i + 1, active: p.id === cur.page, gaming: !!p.gaming, desktop: p.desktop || 0,
  }));
}

// The games page on the status tick (server.js broadcastStatusNow). Cheap when
// there is nothing to do; writes only on a real switch, re-checked on the
// stored value inside update(), and never two at once.
//   current()     the layers the server holds in memory
//   update(edit)  server.js updateLayersSetting: edit gets the stored layers
function createGamePageSync({ current, update, warn = () => {} }) {
  let busy = false;
  return function sync(running) {
    if (busy) return;
    const layers = current();
    if (!layers || !Array.isArray(layers.pages) || layers.pages.length < 2) return;
    if (!gamePageSwitch(layers, running)) return;
    busy = true;
    Promise.resolve()
      .then(() => update((stored) => {
        const next = gamePageSwitch(stored, running);
        return next ? { layers: next } : { error: 'unchanged' };
      }))
      .catch(() => warn('layers: the games page could not be switched'))
      .finally(() => { busy = false; });
  };
}

// The desktop's page when the shell says another virtual desktop is shown
// (POST /layers/desk). Same rules as the games page: a write only on a real
// switch, re-checked on the stored value, never two at once; the last desktop
// seen while one was being written is applied after it.
function createDeskPageSync({ current, update, warn = () => {} }) {
  let busy = false;
  let next = null;
  const run = (desk) => {
    const layers = current();
    if (!layers || !Array.isArray(layers.pages) || layers.pages.length < 2) return;
    if (!deskPageSwitch(layers, desk)) return;
    busy = true;
    Promise.resolve()
      .then(() => update((stored) => {
        const changed = deskPageSwitch(stored, desk);
        return changed ? { layers: changed } : { error: 'unchanged' };
      }))
      .catch(() => warn('layers: the desktop page could not be switched'))
      .finally(() => {
        busy = false;
        if (next == null) return;
        const later = next;
        next = null;
        run(later);
      });
  };
  return function sync(desk) {
    if (busy) { next = desk; return; }
    run(desk);
  };
}

module.exports = {
  addPage, renamePage, removePage, setActivePage, setGamingPage, setDesktopPage, moveToPage, gamePageSwitch,
  deskPageSwitch, findPage, pageLabel, describePages, createGamePageSync, createDeskPageSync,
};

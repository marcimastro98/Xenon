'use strict';

// Widgets outside the dashboard: on the desktop, in the overlay above games, or
// anchored to another app's window. One owner for the rules: the dashboard
// (window.LayersModel), the server's settings normalizer (require), the
// capability runner and the tests all read this file, so a value accepted in one
// place can never be dropped by the other on the next save.
//
// The default is "off, nothing placed": an existing user sees no new window.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LayersModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // js/layer-tiles.js: required on the server, loaded before this file on a page.
  function tilesTable() {
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') return require('./layer-tiles.js');
    return globalThis.LayerTiles;
  }
  const SURFACES = Object.freeze(['desktop', 'overlay', 'anchor']);
  // Overlay widgets can follow the game: always, only while a game runs, or only
  // while none does (a to-do list that gets out of the way).
  const SHOW = Object.freeze(['always', 'gaming', 'notGaming']);
  // Where Xenon's own surfaces (the AI glow) appear. 'auto' = the second screen
  // when there is one, the main screen otherwise.
  const SCREENS = Object.freeze(['auto', 'main', 'second', 'all']);
  const CORNERS = Object.freeze(['tl', 'tr', 'bl', 'br']);
  const KINDS = Object.freeze(['tile', 'sdk']);
  // Each overlay/desktop surface is ONE window per monitor, so the cap is about
  // what a person can read at once, not memory.
  const MAX_WIDGETS = 24;
  const MIN_FRACTION = 0.02;
  const ANCHOR_MIN_PX = 80;
  const ANCHOR_MAX_PX = 2000;
  const ANCHOR_MAX_OFFSET = 4000;

  // Words the AI and the "place" dialog use, turned into a rectangle. Fractions
  // of the monitor's work area (the screen minus the taskbar).
  const POSITIONS = Object.freeze(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']);
  const SIZES = Object.freeze({ small: [0.14, 0.2], medium: [0.2, 0.3], large: [0.3, 0.45] });
  const MARGIN = 0.02;

  // A screenshot pinned over everything (js/layer-pin.js): a tile named PIN whose
  // instance is the capture's opaque id. Every layer page draws it itself, so it
  // never needs the dashboard, and it is not in the "Add" list (it needs a picture).
  const PIN = 'pin';
  // Its first box: about a third of the screen wide, never taller than this,
  // shaped like the picture on a 16:9 screen (the page then fits it exactly).
  const PIN_W = 0.3;
  const PIN_MAX_H = 0.6;

  const WIDGET_RE = /^[a-z][a-z0-9]{0,31}$/;
  const INSTANCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const ID_RE = /^lw_[a-z0-9]{4,24}$/;
  // Widgets sharing a `group` are tabs of one box, as tab groups on the dashboard.
  const GROUP_RE = /^lt_[a-z0-9]{4,24}$/;
  const MAX_TABS = 8;
  // Pages: sets of widgets the user switches between ("Work", "Games"). One is
  // shown at a time on every surface. Fewer than two is the same as none.
  const PAGE_RE = /^lp_[a-z0-9]{4,24}$/;
  const MAX_PAGES = 8;
  const PAGE_NAME_MAX = 32;
  // Pages can be tied to virtual desktops 1-9 (layers/desks.rs in the shell reads which one is shown).
  const MAX_DESKTOP = 9;
  // A monitor key is whatever the shell reports for a screen; '' = the main one.
  const MONITOR_RE = /^[\x20-\x7e]{1,64}$/;
  // The app a widget follows: an executable name on Windows, an app name on
  // macOS, a WM_CLASS on Linux. Never a path.
  const APP_RE = /^[^\\/:*?"<>|\x00-\x1f]{1,128}$/;

  // A surface can be hidden on its own (the overlay above a game, by a shortcut)
  // while the rest stays: its windows stay open and draw nothing, so it comes
  // back at once. `overlayKey` is that shortcut, 'off' when the user took it away.
  const TOGGLES = Object.freeze(['all', 'overlay', 'desktop']);
  const OVERLAY_KEY = 'ctrl+shift+f9';
  // The Xenon menu over the main screen (server/screen-menu.js). Alt+X alone is
  // refused like every one-modifier letter (it is an app's menu key); this one
  // is free of the system, NVIDIA, Game Bar and AltGr combos (js/deck-shortcuts.js).
  const MENU_KEY = 'alt+shift+x';
  const KEY_RE = /^(?:off|[a-z0-9]{1,5}(?:\+[a-z0-9]{1,5}){1,4})$/;

  const DEFAULTS = Object.freeze({ enabled: false, screens: 'auto', excludeFromCapture: true, hidden: [], overlayKey: OVERLAY_KEY, menuKey: MENU_KEY, menuPad: true, pages: [], page: '', widgets: [] });

  const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const round4 = (v) => Math.round(v * 10000) / 10000;
  const clampInt = (v, lo, hi, dflt) => {
    const n = num(v);
    return Number.isNaN(n) ? dflt : Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

  function normalizeRect(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    let w = num(r.w); let h = num(r.h);
    w = Number.isNaN(w) ? SIZES.medium[0] : Math.min(1, Math.max(MIN_FRACTION, w));
    h = Number.isNaN(h) ? SIZES.medium[1] : Math.min(1, Math.max(MIN_FRACTION, h));
    let x = num(r.x); let y = num(r.y);
    x = Number.isNaN(x) ? 0 : Math.min(1 - w, Math.max(0, x));
    y = Number.isNaN(y) ? 0 : Math.min(1 - h, Math.max(0, y));
    return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
  }

  // Null when there is no usable app to follow: an anchored widget without one is
  // demoted to the desktop by normalizeWidget rather than kept as a dead entry.
  function normalizeAnchor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const app = cleanText(raw.app, 128);
    if (!APP_RE.test(app)) return null;
    return {
      app,
      title: cleanText(raw.title, 128),
      corner: pick(raw.corner, CORNERS, 'tr'),
      dx: clampInt(raw.dx, -ANCHOR_MAX_OFFSET, ANCHOR_MAX_OFFSET, 16),
      dy: clampInt(raw.dy, -ANCHOR_MAX_OFFSET, ANCHOR_MAX_OFFSET, 16),
      w: clampInt(raw.w, ANCHOR_MIN_PX, ANCHOR_MAX_PX, 320),
      h: clampInt(raw.h, ANCHOR_MIN_PX, ANCHOR_MAX_PX, 240),
    };
  }

  function normalizeRef(raw) {
    if (raw.kind === 'sdk') {
      const pkg = String(raw.pkg || '');
      return PKG_RE.test(pkg) ? { kind: 'sdk', pkg } : null;
    }
    const widget = String(raw.widget || '');
    if (!WIDGET_RE.test(widget)) return null;
    const instance = String(raw.instance || '');
    return INSTANCE_RE.test(instance) ? { kind: 'tile', widget, instance } : { kind: 'tile', widget };
  }

  function normalizeWidget(raw) {
    if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.id || ''))) return null;
    const ref = normalizeRef(raw);
    if (!ref) return null;
    const anchor = normalizeAnchor(raw.anchor);
    let surface = pick(raw.surface, SURFACES, 'desktop');
    if (surface === 'anchor' && !anchor) surface = 'desktop';
    const monitor = String(raw.monitor == null ? '' : raw.monitor);
    const opacity = num(raw.opacity);
    const out = {
      id: raw.id,
      ...ref,
      surface,
      monitor: MONITOR_RE.test(monitor) ? monitor : '',
      rect: normalizeRect(raw.rect),
      opacity: Number.isNaN(opacity) ? 1 : Math.round(Math.min(1, Math.max(0.2, opacity)) * 100) / 100,
      show: pick(raw.show, SHOW, 'always'),
    };
    if (anchor) out.anchor = anchor;
    if (PAGE_RE.test(String(raw.page || ''))) out.page = raw.page;
    if (GROUP_RE.test(String(raw.group || ''))) out.group = raw.group;
    if (out.group && raw.active === true) out.active = true;
    return out;
  }

  // { id, name, gaming?, desktop? }: a name may be empty (the UI says "Page 2");
  // one page at most is the one shown while a game runs, and one per virtual
  // desktop is the one shown on it (`desktop`, 1-9).
  function normalizePages(raw) {
    const out = [];
    const seen = new Set();
    const desks = new Set();
    let gaming = false;
    for (const p of Array.isArray(raw) ? raw : []) {
      if (out.length >= MAX_PAGES) break;
      if (!p || typeof p !== 'object' || !PAGE_RE.test(String(p.id || '')) || seen.has(p.id)) continue;
      seen.add(p.id);
      const page = { id: p.id, name: cleanText(p.name, PAGE_NAME_MAX) };
      if (p.gaming === true && !gaming) { gaming = true; page.gaming = true; }
      const desk = Number(p.desktop);
      if (Number.isInteger(desk) && desk >= 1 && desk <= MAX_DESKTOP && !desks.has(desk)) { desks.add(desk); page.desktop = desk; }
      out.push(page);
    }
    return out.length >= 2 ? out : [];
  }

  // Every widget sits on a page once there are pages (the first one when its
  // own is gone), and on none when there are not.
  function settlePages(widgets, pages) {
    const ids = pages.map(p => p.id);
    return widgets.map((w) => {
      const { page, ...rest } = w;
      if (!ids.length) return rest;
      return { ...rest, page: ids.includes(page) ? page : ids[0] };
    });
  }

  // Tabs share a box only on the same surface AND the same page.
  const boxScope = (w) => surfaceKey(w) + '|' + (w.page || '');

  // A tab group is one box: its first member decides where and how it shows,
  // and the others take the same. A member on another surface, an anchored one
  // (each anchored widget is a window of its own), one past MAX_TABS, or the
  // last one left is a plain widget again. At most one tab is `active`.
  function settleGroups(widgets) {
    const lead = new Map();   // group -> first member
    const count = new Map();
    for (const w of widgets) {
      if (!w.group || w.surface === 'anchor') continue;
      const first = lead.get(w.group);
      if (!first) { lead.set(w.group, w); count.set(w.group, 1); continue; }
      if (boxScope(w) === boxScope(first) && count.get(w.group) < MAX_TABS) count.set(w.group, count.get(w.group) + 1);
    }
    const kept = new Map();   // group -> members kept so far
    const activeSeen = new Set();
    return widgets.map((w) => {
      if (!w.group) return w;
      const { group, active, ...plain } = w;
      const first = lead.get(group);
      const n = kept.get(group) || 0;
      if (!first || count.get(group) < 2 || (w !== first && (boxScope(w) !== boxScope(first) || n >= MAX_TABS))) return plain;
      kept.set(group, n + 1);
      const out = { ...plain, group, rect: first.rect, opacity: first.opacity, show: first.show };
      if (active && !activeSeen.has(group)) { activeSeen.add(group); out.active = true; }
      return out;
    });
  }

  function normalize(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const seen = new Set();
    const widgets = [];
    for (const w of Array.isArray(src.widgets) ? src.widgets : []) {
      if (widgets.length >= MAX_WIDGETS) break;
      const n = normalizeWidget(w);
      if (!n || seen.has(n.id)) continue;
      seen.add(n.id);
      widgets.push(n);
    }
    const pages = normalizePages(src.pages);
    const ids = pages.map(p => p.id);
    const out = {
      enabled: src.enabled === true,
      screens: pick(src.screens, SCREENS, 'auto'),
      excludeFromCapture: src.excludeFromCapture !== false,
      hidden: Array.isArray(src.hidden) ? SURFACES.filter(s => src.hidden.includes(s)) : [],
      overlayKey: typeof src.overlayKey === 'string' && KEY_RE.test(src.overlayKey) ? src.overlayKey : OVERLAY_KEY,
      menuKey: typeof src.menuKey === 'string' && KEY_RE.test(src.menuKey) ? src.menuKey : MENU_KEY,
      // Holding the two small middle buttons on a controller (View + Menu, Create + Options) opens the Xenon menu; on unless turned off.
      menuPad: src.menuPad !== false,
      pages,
      page: ids.length ? (ids.includes(src.page) ? src.page : ids[0]) : '',
      widgets: settleGroups(settlePages(widgets, pages)),
    };
    // The page to go back to when the game ends (server-owned, layer-pages.js).
    if (ids.includes(src.resume) && src.resume !== out.page) out.resume = src.resume;
    // The page to go back to on a desktop with no page of its own (server-owned):
    // never a desktop's page, never the one shown.
    const back = pages.find(p => p.id === src.deskBack);
    if (back && !back.desktop && back.id !== out.page) out.deskBack = back.id;
    return out;
  }

  function rectFor(position, size) {
    const [w, h] = SIZES[size] || SIZES.medium;
    return rectAt(position, w, h);
  }

  // A box of w×h (fractions) at a named place on the screen, with a margin.
  function rectAt(position, w, h) {
    const p = POSITIONS.includes(position) ? position : 'top-right';
    const col = p.includes('left') ? 0 : p.includes('right') ? 2 : 1;
    const row = p.startsWith('top') ? 0 : p.startsWith('bottom') ? 2 : 1;
    const along = (slot, span) => (slot === 0 ? MARGIN : slot === 2 ? 1 - span - MARGIN : (1 - span) / 2);
    return normalizeRect({ x: along(col, w), y: along(row, h), w, h });
  }

  function newId(random) {
    const rnd = typeof random === 'function' ? random : Math.random;
    return 'lw_' + Date.now().toString(36).slice(-6) + Math.floor(rnd() * 1e8).toString(36).padStart(4, '0');
  }

  // Pure edits used by the capability runner (AI and Deck) and the editor. Each
  // returns a NEW normalized layers object, or { error } with nothing changed.
  function addWidget(layers, spec, random) {
    const cur = normalize(layers);
    if (cur.widgets.length >= MAX_WIDGETS) return { error: 'too_many' };
    const s = spec && typeof spec === 'object' ? spec : {};
    const surface = pick(s.surface, ['desktop', 'overlay'], 'desktop');
    const widget = normalizeWidget({
      id: newId(random),
      kind: s.kind, widget: s.widget, instance: s.instance, pkg: s.pkg,
      // On the page shown now unless one is named; normalize settles it.
      page: s.page || cur.page,
      surface, monitor: s.monitor,
      rect: s.rect || rectFor(s.position, s.size),
      opacity: s.opacity, show: s.show,
    });
    if (!widget) return { error: 'bad_widget' };
    // Placing a widget is asking to see it: the feature turns itself on, and
    // its surface too if it was hidden.
    const hidden = cur.hidden.filter(s => s !== widget.surface);
    return { layers: { ...cur, enabled: true, hidden, widgets: [...cur.widgets, widget] }, widget };
  }

  // Is this surface drawn now? 'all' asks about the whole feature.
  function surfaceShown(layers, surface) {
    const cur = normalize(layers);
    return cur.enabled && (surface === 'all' || !cur.hidden.includes(surface));
  }

  // Show or hide everything ('all') or one surface ('overlay', 'desktop').
  // mode: 'toggle' (default), 'on', 'off'. Showing one surface while the
  // feature is off shows that surface alone, never the others with it.
  function toggleSurface(layers, surface, mode) {
    const cur = normalize(layers);
    const which = pick(surface, TOGGLES, 'all');
    const show = mode === 'on' ? true : mode === 'off' ? false : !surfaceShown(cur, which);
    let next;
    if (which === 'all') next = show ? { ...cur, enabled: true, hidden: [] } : { ...cur, enabled: false };
    else if (!show) next = { ...cur, hidden: [...new Set([...cur.hidden, which])] };
    else if (cur.enabled) next = { ...cur, hidden: cur.hidden.filter(s => s !== which) };
    else next = { ...cur, enabled: true, hidden: SURFACES.filter(s => s !== which) };
    const out = normalize(next);
    return { layers: out, shown: surfaceShown(out, which) };
  }

  // `target` is a layer id, or a widget name that removes every copy of it.
  function removeWidget(layers, target) {
    const cur = normalize(layers);
    const t = String(target || '');
    const keep = cur.widgets.filter((w) => w.id !== t && w.widget !== t && w.pkg !== t);
    if (keep.length === cur.widgets.length) return { error: 'not_found' };
    // A tab left alone in its group is a plain widget again (settleGroups).
    return { layers: normalize({ ...cur, widgets: keep }), removed: cur.widgets.length - keep.length };
  }

  // The box a pinned picture of width×height pixels starts in, at `position`.
  function pinRect(width, height, position) {
    const ratio = width > 0 && height > 0 ? height / width : 9 / 16;
    let w = PIN_W;
    let h = w * ratio * (16 / 9);
    if (h > PIN_MAX_H) { w *= PIN_MAX_H / h; h = PIN_MAX_H; }
    return rectAt(position || 'center', Math.max(MIN_FRACTION, w), Math.max(MIN_FRACTION, h));
  }

  // A deleted capture takes its pins with it ({ error } when it had none).
  function unpinCapture(layers, captureId) {
    const cur = normalize(layers);
    const keep = cur.widgets.filter((w) => !(isPin(w) && w.instance === captureId));
    if (keep.length === cur.widgets.length) return { error: 'not_found' };
    return { layers: normalize({ ...cur, widgets: keep }), removed: cur.widgets.length - keep.length };
  }

  function updateWidget(layers, id, patch) {
    const cur = normalize(layers);
    const i = cur.widgets.findIndex((w) => w.id === id);
    if (i < 0) return { error: 'not_found' };
    const p = patch && typeof patch === 'object' ? patch : {};
    const merged = normalizeWidget({ ...cur.widgets[i], ...p, id, kind: cur.widgets[i].kind });
    if (!merged) return { error: 'bad_widget' };
    const widgets = cur.widgets.slice();
    widgets[i] = merged;
    const next = normalize({ ...cur, widgets });
    return { layers: next, widget: next.widgets[i] };
  }

  // Put `sourceId` in the same box as `targetId`, as its shown tab. The source
  // takes the target's place; a target without a group starts one.
  function groupWidgets(layers, targetId, sourceId, random) {
    const cur = normalize(layers);
    const target = cur.widgets.find((w) => w.id === targetId);
    const source = cur.widgets.find((w) => w.id === sourceId);
    if (!target || !source) return { error: 'not_found' };
    if (target === source) return { error: 'same_widget' };
    if (target.surface === 'anchor' || source.surface === 'anchor') return { error: 'anchored' };
    const group = target.group || ('lt_' + newId(random).slice(3));
    if (target.group && source.group !== group && cur.widgets.filter((w) => w.group === group).length >= MAX_TABS) return { error: 'too_many_tabs' };
    const widgets = cur.widgets.map((w) => {
      if (w.id === source.id) {
        const { anchor, ...rest } = w;
        return { ...rest, group, active: true, surface: target.surface, monitor: target.monitor, rect: target.rect, page: target.page };
      }
      if (w.id === target.id) return { ...w, group, active: false };
      return w.group === group ? { ...w, active: false } : w;
    });
    // The source goes right after its new box, so the order of the tabs is the order they joined.
    const moved = widgets.find((w) => w.id === source.id);
    const rest = widgets.filter((w) => w.id !== source.id);
    const at = rest.map((w) => w.group === group).lastIndexOf(true);
    rest.splice(at + 1, 0, moved);
    const next = normalize({ ...cur, widgets: rest });
    return { layers: next, widget: next.widgets.find((w) => w.id === source.id) };
  }

  // Take `id` out of its tabs, into a box of its own beside the group's.
  function ungroupWidget(layers, id) {
    const cur = normalize(layers);
    const w = cur.widgets.find((x) => x.id === id);
    if (!w) return { error: 'not_found' };
    if (!w.group) return { error: 'not_grouped' };
    const r = w.rect;
    const x = r.x + r.w + MARGIN + r.w <= 1 ? r.x + r.w + MARGIN : r.x - r.w - MARGIN >= 0 ? r.x - r.w - MARGIN : r.x + MARGIN;
    const widgets = cur.widgets.map((o) => {
      if (o.id !== id) return o;
      const { group, active, ...plain } = o;
      return { ...plain, rect: normalizeRect({ ...r, x }) };
    });
    const next = normalize({ ...cur, widgets });
    return { layers: next, widget: next.widgets.find((o) => o.id === id) };
  }

  // The widgets of one box in tab order, and the one shown. A widget without a
  // group is a box of one.
  function boxes(list) {
    const out = [];
    const byGroup = new Map();
    for (const w of list) {
      const box = w.group && byGroup.get(w.group);
      if (box) { box.members.push(w); if (w.active) box.active = w.id; continue; }
      const next = { key: w.group || w.id, lead: w, members: [w], active: w.id };
      if (w.group) byGroup.set(w.group, next);
      out.push(next);
    }
    return out;
  }

  // The widgets one surface window draws. Anchored widgets each get a window of
  // their own, keyed by layer id; desktop/overlay are grouped per monitor.
  function surfaceKey(w) {
    return w.surface === 'anchor' ? 'anchor:' + w.id : w.surface + ':' + (w.monitor || '');
  }
  function widgetsFor(layers, key) {
    return normalize(layers).widgets.filter((w) => surfaceKey(w) === key);
  }
  // What a surface draws now: its widgets on the page shown. The window itself
  // stays for the other pages (surfaceKeys), so switching is instant.
  function shownFor(layers, key) {
    const cur = normalize(layers);
    // A hidden surface keeps its window and draws nothing (toggleSurface).
    if (cur.hidden.includes(String(key).split(':')[0])) return [];
    return cur.widgets.filter((w) => surfaceKey(w) === key && (!cur.page || w.page === cur.page));
  }
  // Which page a layer window loads: the light one (layer-lite.html) while every
  // widget on the surface is a Store widget or a built-in tile it can carry
  // (js/layer-tiles.js: the server adds that tile's own files), the full
  // dashboard once one is any other tile. The server serves by this and the page
  // reloads by it, so the two can never disagree. A copy of a tile is carried
  // only when the light page can build it (LayerTiles.COPIES).
  const Tiles = tilesTable();
  const LITE_TILES = Tiles.LITE;
  function carried(w) {
    return w.kind === 'tile' && LITE_TILES.includes(w.widget) && (!w.instance || Tiles.COPIES.includes(w.widget));
  }
  const isPin = (w) => w.kind === 'tile' && w.widget === PIN;
  function needsDashboard(layers, key) {
    const cur = normalize(layers);
    return cur.enabled && widgetsFor(cur, key).some((w) => w.kind === 'tile' && !carried(w) && !isPin(w));
  }
  // The built-in tiles a light page for this surface must carry, sorted.
  function liteTilesFor(layers, key) {
    const cur = normalize(layers);
    if (!cur.enabled) return [];
    const names = widgetsFor(cur, key).filter(carried).map((w) => w.widget);
    return [...new Set(names)].sort();
  }
  // The shape of a surface key as a layer window's URL carries it (?layer=).
  const SURFACE_KEY_RE = /^(?:(?:desktop|overlay):[\x20-\x7e]{0,64}|anchor:lw_[a-z0-9]{4,24})$/;
  function isSurfaceKey(key) {
    return typeof key === 'string' && SURFACE_KEY_RE.test(key);
  }
  function surfaceKeys(layers) {
    const cur = normalize(layers);
    if (!cur.enabled) return [];
    return [...new Set(cur.widgets.map(surfaceKey))];
  }

  return Object.freeze({
    SURFACES, SHOW, SCREENS, CORNERS, KINDS, POSITIONS, SIZES, MAX_WIDGETS, MAX_TABS, MAX_PAGES, PAGE_NAME_MAX, MAX_DESKTOP, DEFAULTS,
    TOGGLES, OVERLAY_KEY, MENU_KEY, surfaceShown, toggleSurface,
    normalize, normalizeWidget, rectFor, rectAt, addWidget, removeWidget, updateWidget, groupWidgets, ungroupWidget, boxes,
    surfaceKey, widgetsFor, shownFor, surfaceKeys, isSurfaceKey, needsDashboard, LITE_TILES, liteTilesFor, newId,
    PIN, pinRect, unpinCapture,
  });
});

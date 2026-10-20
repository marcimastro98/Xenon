'use strict';
// The vertical layout: where every tile sits on a screen taller than it is wide.
//
// One dashboard, two arrangements. The tiles, the pages, the tab-groups and
// what each tile shows are shared; only the GEOMETRY differs. A landscape layout
// drawn on a vertical screen is the wrong shape whatever you do to it: stacked,
// every tile keeps a height built for a 720px-tall panel and spreads it over
// 2560; left on the grid, it is a miniature of itself in a narrow strip.
//
// `layout.portrait` holds that second geometry, keyed by the same instance ids
// the grid uses (a widget id, a tab-group id, a copy id):
//   { custom: false }                 nothing stored: generated from the
//                                     landscape layout on every render, so it
//                                     follows the landscape layout until the
//                                     person arranges the vertical one
//   { custom: true, items: {id: {x, y, w, h, page}} }
// The page is stored with the rect only to tell when it went stale: the page a
// tile lives on is the landscape one, always. A tile moved to another page, or
// a tile that is new, is placed again; the rest keep exactly where they were put.
//
// Pure apart from the small runtime at the bottom, and loaded before settings.js
// because both normalizers (client and server) call normalizePortrait.
(function () {
  const COLUMNS = 24;
  // A vertical page is 24 columns by 48 rows: the same resolution in both
  // directions relative to the screen, so dragging and resizing step evenly.
  const PORTRAIT_ROWS = 48;
  // Generated heights, in rows. 6 is ~300px on a vertical Edge, the smallest a
  // tile still reads at; 32 keeps one tile from taking a whole page by itself.
  const MIN_GEN_H = 6;
  const MAX_GEN_H = 32;
  // Stored heights: the grid's own floor (MIN_TILE_H in dashboard-grid.js).
  const MIN_STORED_H = 4;
  const MAX_STORED_H = 200;
  const MAX_STORED_Y = 499;
  const MAX_ITEMS = 256;
  // A landscape tile this narrow (of 24 columns, ~640px on the Edge) may share a
  // band with the next one, but only while half the page is still wide enough
  // to hold a tile. A third of the Edge (8 columns, 850px) is already wider than
  // a whole vertical one, so it gets the full width.
  const HALF_MAX_LANDSCAPE_W = 6;
  const HALF_MIN_PX = 300;
  // A page with little on it grows its tiles to fill, but never past twice the
  // size their shape asks for: an empty band reads better than a blown-up clock.
  const FILL_MAX_GROWTH = 2;
  // The height of the landscape page a layout is drawn for (an Edge minus its
  // top bar): a tile's rows there turn into the pixel height it was given.
  const LANDSCAPE_PAGE_PX = 640;
  // A vertical Edge minus its top bar, for when there is no page to measure.
  const DEFAULT_BOX = { width: 720, height: 2400 };
  // Tap-to-cycle sizes on the vertical grid (the landscape list does not fit it).
  const SIZE_PRESETS = [{ w: 12, h: 8 }, { w: 12, h: 12 }, { w: 24, h: 8 }, { w: 24, h: 12 }, { w: 24, h: 18 }];

  function emptyPortrait() { return { custom: false, items: {} }; }

  function clampInt(value, lo, hi) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  }

  function normalizeItem(value, pageIds) {
    if (!value || typeof value !== 'object') return null;
    const w = clampInt(value.w, 1, COLUMNS);
    const x = clampInt(value.x, 0, COLUMNS - 1);
    const y = clampInt(value.y, 0, MAX_STORED_Y);
    const h = clampInt(value.h, MIN_STORED_H, MAX_STORED_H);
    if (w === null || x === null || y === null || h === null) return null;
    if (typeof value.page !== 'string' || !pageIds.includes(value.page)) return null;
    return { x: Math.min(x, COLUMNS - w), y, w, h, page: value.page };
  }

  // Every id a vertical rect may belong to, taken from the already-normalized
  // layout, so an entry can only ever name a real widget, group or copy.
  function knownIds(layout) {
    const ids = new Set(Object.keys(layout.widgets || {}));
    Object.keys(layout.groups || {}).forEach((id) => ids.add(id));
    (Array.isArray(layout.copies) ? layout.copies : []).forEach((c) => { if (c && c.id) ids.add(c.id); });
    return ids;
  }

  /**
   * The boundary for `layout.portrait`, shared by the client and the server.
   * `layout` must already hold its normalized pages, widgets, groups and copies.
   * Anything that is not an explicit `custom: true` is the generated layout.
   */
  function normalizePortrait(value, layout) {
    const out = emptyPortrait();
    const src = value && typeof value === 'object' ? value : {};
    if (src.custom !== true || !layout) return out;
    out.custom = true;
    const pageIds = (Array.isArray(layout.pages) ? layout.pages : []).map((p) => p.id);
    const known = knownIds(layout);
    const items = src.items && typeof src.items === 'object' ? src.items : {};
    let count = 0;
    for (const id of Object.keys(items)) {
      if (count >= MAX_ITEMS) break;
      if (!known.has(id)) continue;
      const item = normalizeItem(items[id], pageIds);
      if (!item) continue;
      out.items[id] = item;
      count++;
    }
    return out;
  }

  // Lazy, because both helpers live in files that load after this one and the
  // node tests reach them by require.
  function readingOrder(list) {
    const pv = (typeof window !== 'undefined' && window.PhoneView) ? window.PhoneView : require('./phone-view.js');
    return pv.readingOrder(list);
  }

  function firstFreeSlot(occupied, w, h) {
    const dg = (typeof window !== 'undefined' && window.DashboardGrid) ? window.DashboardGrid : require('./dashboard-grid.js');
    return dg.firstFreeSlot(occupied, w, h, COLUMNS);
  }

  function isRenderableCopy(copy) {
    const di = (typeof window !== 'undefined') ? window.DashboardInstances : null;
    return !di || typeof di.isDuplicable !== 'function' || di.isDuplicable(copy.widget);
  }

  // The tiles a page draws, in the same terms as the render pass: standalone
  // visible widgets, tab-groups, and copies that are not inside a group.
  function pageEntries(layout, pageId) {
    const groups = layout.groups || {};
    const grouped = new Set();
    Object.keys(groups).forEach((gid) => ((groups[gid] && groups[gid].members) || []).forEach((m) => grouped.add(m)));
    const out = [];
    Object.keys(layout.widgets || {}).forEach((id) => {
      const w = layout.widgets[id];
      if (w && w.visible && w.page === pageId && !grouped.has(id)) out.push({ id, geom: w });
    });
    Object.keys(groups).forEach((id) => {
      const g = groups[id];
      if (g && g.page === pageId) out.push({ id, geom: g, members: Array.isArray(g.members) ? g.members : [] });
    });
    (Array.isArray(layout.copies) ? layout.copies : []).forEach((c) => {
      if (c && c.page === pageId && !grouped.has(c.id) && isRenderableCopy(c)) out.push({ id: c.id, geom: c });
    });
    return out;
  }

  function geomOf(entry) {
    const g = entry.geom || {};
    return { x: Number(g.x) || 0, y: Number(g.y) || 0, w: Number(g.w) || 8, h: Number(g.h) || 8 };
  }

  function validBox(box) {
    const w = Number(box && box.width);
    const h = Number(box && box.height);
    return (w > 0 && h > 0) ? { width: w, height: h } : DEFAULT_BOX;
  }

  // Height in vertical rows that keeps the pixel height the tile has on the
  // landscape screen. Tile content is laid out for its height (a deck's key
  // rows, a list's lines) and only reflows sideways, so keeping the height and
  // not the shape is what keeps it readable: a narrow tile widened to the full
  // band does not balloon, a wide one does not get squashed.
  function shapedHeight(entry, pageRows, box) {
    const g = geomOf(entry);
    // A landscape page never draws fewer than 8 rows (MIN_FILL_ROWS).
    const rows = Math.max(pageRows, 8);
    const px = g.h / rows * LANDSCAPE_PAGE_PX;
    const rowPx = box.height / PORTRAIT_ROWS;
    return Math.min(MAX_GEN_H, Math.max(MIN_GEN_H, px / rowPx));
  }

  // Round a list of heights so they add up to `total` (largest remainder), each
  // at least MIN_STORED_H.
  function roundToTotal(values, total) {
    const floors = values.map((v) => Math.max(MIN_STORED_H, Math.floor(v)));
    let left = total - floors.reduce((a, b) => a + b, 0);
    const byRemainder = values.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
    for (let k = 0; left > 0 && k < byRemainder.length; k++, left--) floors[byRemainder[k].i]++;
    return floors;
  }

  function landscapeRows(entries) {
    return Math.max(1, ...entries.map((e) => { const g = geomOf(e); return g.y + g.h; }));
  }

  function sortedEntries(entries) {
    return readingOrder(entries.map(geomOf)).map((i) => entries[i]);
  }

  function canHalve(entry, box) {
    return box.width / 2 >= HALF_MIN_PX && geomOf(entry).w <= HALF_MAX_LANDSCAPE_W;
  }

  // The tiles of one page in reading order, as full-width bands; two narrow
  // neighbours share a band. A narrow tile left alone takes the whole band, since
  // half a band of empty grid reads as a hole.
  function bandsFor(entries, box) {
    const bands = [];
    let open = null;
    sortedEntries(entries).forEach((e) => {
      if (open && canHalve(e, box)) { open.push(e); open = null; return; }
      const band = [e];
      bands.push(band);
      open = canHalve(e, box) ? band : null;
    });
    return bands;
  }

  /** A whole page arranged from scratch. Returns {id: {x, y, w, h, page}}. */
  function generatePage(entries, box, pageId) {
    const pageRows = landscapeRows(entries);
    const bands = bandsFor(entries, box).map((members) => {
      const cols = members.length === 2 ? COLUMNS / 2 : COLUMNS;
      const h = Math.max(...members.map((e) => shapedHeight(e, pageRows, box)));
      return { members, cols, h };
    });
    const wanted = bands.reduce((a, b) => a + b.h, 0);
    const scale = Math.min(FILL_MAX_GROWTH, PORTRAIT_ROWS / wanted);
    const scaled = bands.map((b) => b.h * scale);
    // Filling the page exactly when it can; otherwise as close to the shapes as
    // rounding allows (a page holding more than fits grows past 48 rows and the
    // grid shrinks its rows to show it all, as the landscape grid does).
    const total = scale === PORTRAIT_ROWS / wanted ? PORTRAIT_ROWS : Math.round(scaled.reduce((a, b) => a + b, 0));
    const heights = roundToTotal(scaled, Math.max(total, bands.length * MIN_STORED_H));
    const out = {};
    let y = 0;
    bands.forEach((band, i) => {
      band.members.forEach((e, k) => {
        out[e.id] = { x: k * band.cols, y, w: band.cols, h: heights[i], page: pageId };
      });
      y += heights[i];
    });
    return out;
  }

  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // A tab-group the person just made has no vertical rect yet, but one of its
  // members usually had one: the group takes its place instead of jumping to
  // the bottom of the page.
  function inheritedRect(entry, items, pageId) {
    for (const m of entry.members || []) {
      const it = items[m];
      if (it && it.page === pageId) return it;
    }
    return null;
  }

  /** A customized page: stored rects stay, anything new is fitted around them. */
  function completePage(entries, items, box, pageId) {
    const out = {};
    const occupied = [];
    const missing = [];
    sortedEntries(entries).forEach((e) => {
      const it = items[e.id] || inheritedRect(e, items, pageId);
      // An overlap can only come from a stale rect; the later tile yields.
      if (it && it.page === pageId && !occupied.some((o) => intersects(o, it))) {
        const rect = { x: it.x, y: it.y, w: it.w, h: it.h };
        occupied.push(rect);
        out[e.id] = Object.assign({ page: pageId }, rect);
      } else missing.push(e);
    });
    const pageRows = landscapeRows(entries);
    missing.forEach((e) => {
      const w = canHalve(e, box) ? COLUMNS / 2 : COLUMNS;
      const h = Math.round(shapedHeight(e, pageRows, box));
      const slot = firstFreeSlot(occupied, w, h);
      const rect = { x: slot.x, y: slot.y, w, h };
      occupied.push(rect);
      out[e.id] = Object.assign({ page: pageId }, rect);
    });
    return out;
  }

  /**
   * Where every tile goes on a vertical screen of `box` (the page area, in CSS
   * px). Returns {id: {x, y, w, h, page}} for every tile the layout draws.
   */
  function planPortrait(layout, box) {
    const plan = {};
    if (!layout || !Array.isArray(layout.pages)) return plan;
    const b = validBox(box);
    const portrait = layout.portrait && layout.portrait.custom === true ? layout.portrait : null;
    const items = (portrait && portrait.items) || {};
    layout.pages.forEach((p) => {
      const entries = pageEntries(layout, p.id);
      if (!entries.length) return;
      const kept = portrait && entries.some((e) => (items[e.id] || inheritedRect(e, items, p.id) || {}).page === p.id);
      Object.assign(plan, kept ? completePage(entries, items, b, p.id) : generatePage(entries, b, p.id));
    });
    return plan;
  }

  /** Fix the current arrangement in place before the person changes any of it. */
  function materialize(layout, plan) {
    const items = {};
    Object.keys(plan || {}).forEach((id) => { items[id] = Object.assign({}, plan[id]); });
    layout.portrait = { custom: true, items };
    return layout.portrait;
  }

  /** Back to the generated arrangement for one page, or for all of them. */
  function resetPortrait(layout, pageId) {
    const p = layout.portrait;
    if (!p || p.custom !== true) { layout.portrait = emptyPortrait(); return; }
    if (!pageId) { layout.portrait = emptyPortrait(); return; }
    Object.keys(p.items || {}).forEach((id) => { if (p.items[id].page === pageId) delete p.items[id]; });
  }

  /** Rows a page spans in a plan (0 when it holds nothing). */
  function planRowSpan(plan, pageId) {
    let rows = 0;
    Object.keys(plan || {}).forEach((id) => {
      const r = plan[id];
      if (r.page === pageId) rows = Math.max(rows, r.y + r.h);
    });
    return rows;
  }

  function planRects(plan, pageId, exceptId) {
    return Object.keys(plan || {})
      .filter((id) => id !== exceptId && plan[id].page === pageId)
      .map((id) => ({ x: plan[id].x, y: plan[id].y, w: plan[id].w, h: plan[id].h }));
  }

  /** The next tap-to-cycle size for a vertical rect, kept inside the columns. */
  function nextSize(rect) {
    const area = (rect.w || 1) * (rect.h || 1);
    let idx = 0;
    let best = Infinity;
    SIZE_PRESETS.forEach((p, i) => { const d = Math.abs(p.w * p.h - area); if (d < best) { best = d; idx = i; } });
    const next = SIZE_PRESETS[(idx + 1) % SIZE_PRESETS.length];
    return { x: Math.min(rect.x || 0, COLUMNS - next.w), y: rect.y || 0, w: next.w, h: next.h, page: rect.page };
  }

  // ── Runtime (browser) ─────────────────────────────────────────────────────

  function isActive() {
    try {
      return !!(window.PhoneView && typeof window.PhoneView.isPortrait === 'function' && window.PhoneView.isPortrait());
    } catch (e) { return false; }
  }

  // The space a page gets, measured on a page that is on screen. Before the
  // pager exists, the window is the best guess there is.
  function pageBox() {
    const page = Array.from(document.querySelectorAll('.pager-page')).find((p) => p.clientHeight > 0);
    if (page) return { width: page.clientWidth, height: page.clientHeight };
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** The plan for this screen, or null when the screen is not vertical. */
  function activePlan(layout) {
    return isActive() ? planPortrait(layout, pageBox()) : null;
  }

  const api = {
    normalizePortrait, planPortrait, materialize, resetPortrait, planRowSpan, planRects, nextSize,
    emptyPortrait, PORTRAIT_ROWS, COLUMNS, MIN_GEN_H, MAX_GEN_H, HALF_MIN_PX, DEFAULT_BOX,
  };
  if (typeof window !== 'undefined') {
    window.DashboardPortrait = Object.assign({ isActive, activePlan }, api);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

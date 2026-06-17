'use strict';
// GridStack engine for the dashboard. Pure helpers (top) are unit-tested; the
// runtime (below) wraps GridStack and needs the browser.

// Hidden widgets (candidates for the "+" palette).
function availableWidgets(widgets, allIds) {
  return (allIds || []).filter(id => widgets[id] && widgets[id].visible === false);
}

// Widgets the "+" palette can add to a page: those NOT currently placed as a
// standalone tile — i.e. hidden widgets PLUS widgets that live inside a group
// (Playback/Chat by default). Adding a grouped widget extracts it from its
// group. Standalone-visible widgets are already placed, so they're excluded.
function addableWidgetIds(widgets, groups, allIds) {
  const inGroup = (id) => {
    for (const gid of Object.keys(groups || {})) {
      if (((groups[gid] || {}).members || []).includes(id)) return true;
    }
    return false;
  };
  return (allIds || []).filter(id => {
    const w = widgets[id];
    if (!w) return false;
    return w.visible === false || inGroup(id);
  });
}

// Find the first w×h cell (row-major, `columns`-wide) that doesn't overlap any
// occupied rect {x,y,w,h}. Used to place a newly-added widget.
function firstFreeSlot(occupied, w, h, columns) {
  const cols = columns || 12;
  const fits = (x, y) => {
    if (x + w > cols) return false;
    return !occupied.some(o => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y);
  };
  for (let y = 0; y < 500; y++) {
    for (let x = 0; x <= cols - w; x++) {
      if (fits(x, y)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

// ── Runtime (browser) ─────────────────────────────────────────────
const GRID_COLUMNS = 12;
const _grids = new Map();   // pageId → GridStack instance
let _editing = false;
let _suppress = false;      // guard so programmatic placement doesn't trigger persistence
const _lastPointer = { x: 0, y: 0 };  // last pointer position (for drop-target hit-testing)
let _dragHover = null;                // tile currently flagged as a merge target
let _affRAF = 0;                      // rAF handle: throttle "+" refresh to one/frame

// Mount (or re-mount) a GridStack on a page's grid element.
function mountPageGrid(pageId, gridEl) {
  if (!gridEl || typeof GridStack === 'undefined') return null;
  if (_grids.has(pageId)) { try { _grids.get(pageId).destroy(false); } catch (e) { /* ignore */ } _grids.delete(pageId); }
  const grid = GridStack.init({
    column: GRID_COLUMNS, cellHeight: 70, margin: 7, float: true,
    staticGrid: !_editing,
    // Drag ONLY from the dedicated move grip (injected per tile). Using the whole
    // content as the handle made tiles feel un-movable, because their interactive
    // innards (tabs, calendar, chat input) swallowed the drag.
    draggable: { handle: '.gs-move-handle' },
    // Two resize paths coexist: drag the bottom-right corner handle (precise,
    // preferred), OR tap the size-cycle button (reliable on touch). The per-tick
    // 'resize' listener is intentionally NOT subscribed (see below) — calling grid
    // getters inside the active resize loop was what left the drag-resize "stuck".
    resizable: { handles: 'se' },
    disableOneColumnMode: true,
  }, gridEl);
  grid.on('change', () => { if (!_suppress) serialize(); refreshPageAddAffordances(); });
  // While dragging, track the tile whose CENTRE the pointer is over (excluding
  // the dragged one). With float:true GridStack shoves the target out of the way
  // as you hover, so we can't rely on what's under the pointer at release — we
  // capture the hovered target live instead. Dropping over a tile's centre = merge
  // (create a tab); dropping on empty space (or a tile's edge) = plain move.
  grid.on('drag', (ev, el) => {
    // Only DOM hit-testing here (no grid-engine getters) to avoid re-entering
    // GridStack's active drag loop.
    const t = _findHoverTarget(grid, el);
    if (_dragHover && _dragHover !== t) _dragHover.classList.remove('gs-merge-target');
    _dragHover = t;
    if (t) t.classList.add('gs-merge-target');
  });
  grid.on('dragstop', (ev, el) => {
    const target = _dragHover;
    if (target) target.classList.remove('gs-merge-target');
    _dragHover = null;
    refreshPageAddAffordances();
    if (_suppress || typeof getDashboardLayout !== 'function' || !window.DashboardTabGroups || !target || target === el) return;
    const layout = getDashboardLayout();
    const movedId = el.getAttribute('gs-id');
    const targetId = target.getAttribute('gs-id');
    // member-level merge (2A): a group resolves to its first member.
    const targetMember = (layout.groups && layout.groups[targetId]) ? layout.groups[targetId].members[0] : targetId;
    const movedMember = (layout.groups && layout.groups[movedId]) ? layout.groups[movedId].members[0] : movedId;
    if (movedMember && targetMember && movedMember !== targetMember) {
      // Defer: let GridStack finish its own drag-end cleanup before we rebuild
      // the layout, otherwise re-entrancy can corrupt its drag state (→ crash).
      setTimeout(() => window.DashboardTabGroups.mergeOnDrop(movedMember, targetMember), 0);
    }
  });
  _grids.set(pageId, grid);
  return grid;
}

// The grid item whose central 60% the pointer is over (not the dragged one).
function _findHoverTarget(grid, draggedEl) {
  const stack = document.elementsFromPoint(_lastPointer.x, _lastPointer.y);
  for (const node of stack) {
    const gi = node.closest && node.closest('.grid-stack-item');
    if (!gi || gi === draggedEl || !grid.el.contains(gi)) continue;
    const r = gi.getBoundingClientRect();
    const ix = r.width * 0.2, iy = r.height * 0.2;
    const inCentre = _lastPointer.x >= r.left + ix && _lastPointer.x <= r.right - ix &&
                     _lastPointer.y >= r.top + iy && _lastPointer.y <= r.bottom - iy;
    return inCentre ? gi : null;
  }
  return null;
}

// Grip icon (two columns of dots) — the universal "drag me" affordance.
const _MOVE_GRIP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/>' +
  '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
  '<circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>';

const _SIZE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7"/></svg>';

// Tap-to-cycle tile sizes (reliable on touch + mouse, unlike drag-resize).
const _SIZE_PRESETS = [{ w: 3, h: 3 }, { w: 4, h: 4 }, { w: 6, h: 4 }, { w: 8, h: 5 }, { w: 12, h: 4 }];
function cycleTileSize(gsId) {
  if (typeof getDashboardLayout !== 'function') return;
  const layout = getDashboardLayout();
  const obj = (layout.groups && layout.groups[gsId]) ? layout.groups[gsId] : (layout.widgets && layout.widgets[gsId]);
  if (!obj) return;
  const curArea = (obj.w || 1) * (obj.h || 1);
  let idx = 0, best = Infinity;
  _SIZE_PRESETS.forEach((p, i) => { const d = Math.abs(p.w * p.h - curArea); if (d < best) { best = d; idx = i; } });
  const next = _SIZE_PRESETS[(idx + 1) % _SIZE_PRESETS.length];
  obj.w = next.w; obj.h = next.h;
  if ((obj.x || 0) + obj.w > GRID_COLUMNS) obj.x = Math.max(0, GRID_COLUMNS - obj.w);
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// Every live root of a base widget: the primary atom + every clone. They all
// carry data-dashboard-widget="<id>", so one selector returns them all.
function forEachInstance(widgetId, fn) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-dashboard-widget="' + widgetId + '"]').forEach(fn);
}

// Duplicate a placement: add a new copy of its BASE widget at the largest free
// slot on the same page. Works from a primary tile or an existing copy.
// Manually remove a COPY placement (the × on a copy tile). Primary tiles keep
// their own hide control; copies are the ones that otherwise had no delete.
function removePlacement(gsId) {
  if (typeof getDashboardLayout !== 'function') return;
  const layout = getDashboardLayout();
  if (!Array.isArray(layout.copies)) return;
  const i = layout.copies.findIndex(c => c.id === gsId);
  if (i < 0) return;
  const [removed] = layout.copies.splice(i, 1);
  saveDashboardLayout(layout);
  // A removed deck copy's stored config would otherwise linger orphaned in deck.json.
  if (removed && removed.widget === 'deck' && window.Deck && typeof window.Deck.forgetInstance === 'function') {
    window.Deck.forgetInstance(removed.id);
  }
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// Every grid item gets a dedicated move grip (the GridStack drag handle) and a
// tap-to-resize button. Works uniformly for standalone tiles AND tab-groups; the
// grip is the only thing that starts a drag, so the tile content stays interactive.
function ensureTileHandles() {
  if (typeof document === 'undefined') return;
  const layout = (typeof getDashboardLayout === 'function') ? getDashboardLayout() : null;
  const copyIds = new Set((layout && Array.isArray(layout.copies)) ? layout.copies.map(c => c.id) : []);
  document.querySelectorAll('.grid-stack-item > .grid-stack-item-content').forEach(content => {
    if (!content.querySelector(':scope > .gs-move-handle')) {
      const grip = document.createElement('div');
      grip.className = 'gs-move-handle';
      grip.setAttribute('aria-hidden', 'true');
      grip.innerHTML = _MOVE_GRIP_SVG;
      content.appendChild(grip);
    }
    if (!content.querySelector(':scope > .gs-size-cycle')) {
      const item = content.closest('.grid-stack-item');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gs-size-cycle';
      btn.title = 'Ridimensiona';
      btn.setAttribute('aria-label', 'Ridimensiona');
      btn.innerHTML = _SIZE_SVG;
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = item && item.getAttribute('gs-id');
        if (id) cycleTileSize(id);
      });
      content.appendChild(btn);
    }
    // "+ Tab": add another component to THIS tile as a tab (creates a copy of a
    // duplicable component, so it never removes the original).
    if (!content.querySelector(':scope > .gs-add-tab')) {
      const tabItem = content.closest('.grid-stack-item');
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'gs-add-tab';
      tabBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Tab</span>';
      tabBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = tabItem && tabItem.getAttribute('gs-id');
        if (id && window.DashboardPalette) window.DashboardPalette.open(null, tabBtn, { tabTargetMember: _tabTargetMember(id) });
      });
      content.appendChild(tabBtn);
    }
    // "Save preset": store THIS tile (a widget or a whole tab-group) as a reusable
    // template, restorable from the layout dock. Top-left, clear of the other handles.
    // Skipped for a STANDALONE Deck tile: a Deck owns its keys per-instance, so a
    // layout preset (which captures placement only) would restore an EMPTY deck — the
    // Deck's own profile preset is the tool for saving/reusing its keys. A tab-group
    // keeps the button (it's a multi-widget layout template); a deck inside one just
    // restores empty, like any placement preset.
    const saveItem = content.closest('.grid-stack-item');
    const saveGsId = saveItem && saveItem.getAttribute('gs-id');
    const saveIsGroup = !!(saveGsId && layout && layout.groups && layout.groups[saveGsId]);
    const saveIsDeck = !!(saveGsId && !saveIsGroup && window.DashboardInstances
      && window.DashboardInstances.baseWidgetOf(saveGsId) === 'deck');
    if (!saveIsDeck && !content.querySelector(':scope > .gs-save-preset')) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'gs-save-preset';
      const saveLabel = (typeof t === 'function') ? t('preset_save') : 'Save preset';
      saveBtn.title = saveLabel;
      saveBtn.setAttribute('aria-label', saveLabel);
      saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = saveItem && saveItem.getAttribute('gs-id');
        if (id && typeof window.saveTilePreset === 'function') window.saveTilePreset(id);
      });
      content.appendChild(saveBtn);
    }
    // Copy tiles get a delete (×) — they have no other remove control. (Primary
    // tiles keep their own hide control; adding a component is done via the "+".)
    const item = content.closest('.grid-stack-item');
    const gsId = item && item.getAttribute('gs-id');
    if (gsId && copyIds.has(gsId) && !content.querySelector(':scope > .gs-remove')) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'gs-remove';
      rm.title = 'Remove copy';
      rm.setAttribute('aria-label', 'Remove copy');
      rm.textContent = '×';
      rm.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        removePlacement(gsId);
      });
      content.appendChild(rm);
    }
  });
}

// The widget id a "+ Tab" action should merge INTO: a group resolves to its
// first member; a standalone tile is its own widget id.
function _tabTargetMember(gsId) {
  if (typeof getDashboardLayout !== 'function') return gsId;
  const layout = getDashboardLayout();
  if (layout.groups && layout.groups[gsId]) return layout.groups[gsId].members[0];
  return gsId;
}

function setEditing(on) {
  _editing = !!on;
  _grids.forEach(grid => { try { grid.setStatic(!_editing); } catch (e) { /* ignore */ } });
  document.body.classList.toggle('layout-editing', _editing);
}

// Read every grid's item geometry back into the layout and persist.
function serialize() {
  if (typeof getDashboardLayout !== 'function') return;
  const layout = getDashboardLayout();
  _grids.forEach((grid, pageId) => {
    grid.getGridItems().forEach(el => {
      const id = el.getAttribute('gs-id');
      // Group items: write geometry back to layout.groups[id].
      if (id && layout.groups && layout.groups[id]) {
        const gnode = el.gridstackNode || {};
        if (gnode.x != null) layout.groups[id].x = gnode.x;
        if (gnode.y != null) layout.groups[id].y = gnode.y;
        if (gnode.w != null) layout.groups[id].w = gnode.w;
        if (gnode.h != null) layout.groups[id].h = gnode.h;
        layout.groups[id].page = pageId;
        return;
      }
      // Copy placement: write geometry into layout.copies[].
      if (id && Array.isArray(layout.copies)) {
        const copy = layout.copies.find(c => c.id === id);
        if (copy) {
          const gnode = el.gridstackNode || {};
          if (gnode.x != null) copy.x = gnode.x;
          if (gnode.y != null) copy.y = gnode.y;
          if (gnode.w != null) copy.w = gnode.w;
          if (gnode.h != null) copy.h = gnode.h;
          copy.page = pageId;
          return;
        }
      }
      if (!id || !layout.widgets[id]) return;
      const node = el.gridstackNode || {};
      if (node.x != null) layout.widgets[id].x = node.x;
      if (node.y != null) layout.widgets[id].y = node.y;
      if (node.w != null) layout.widgets[id].w = node.w;
      if (node.h != null) layout.widgets[id].h = node.h;
      layout.widgets[id].page = pageId;
    });
  });
  saveDashboardLayout(layout, { status: false });
}

// Place/update one widget item inside its page grid (called by the layout pass).
function applyWidgetGeometry(grid, el, pref) {
  // `el` is the .grid-stack-item wrapper; its gs-id was set when wrapped.
  _suppress = true;
  try {
    if (!el.gridstackNode) grid.makeWidget(el);
    grid.update(el, { x: pref.x, y: pref.y, w: pref.w, h: pref.h });
  } catch (e) { console.error('grid place failed', e); }
  _suppress = false;
}

// Occupied rects on a page: standalone visible widgets + every group. Groups
// MUST be included or a newly-added widget lands at 0,0 on top of a group and
// GridStack's collision resolver shoves tiles around unpredictably.
function pageOccupiedRects(pageId, exceptId, layoutArg) {
  const layout = layoutArg || (typeof getDashboardLayout === 'function' ? getDashboardLayout() : null);
  if (!layout) return [];
  const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(layout.groups, id) : null);
  const rects = [];
  // primary widgets + copies, via the shared placement helper
  const placements = (window.DashboardInstances)
    ? window.DashboardInstances.placementsForPage(layout, pageId)
    : [];
  placements.forEach(p => {
    if (p.instanceId === exceptId) return;
    if (groupOf(p.instanceId)) return;
    rects.push({ x: p.x, y: p.y, w: p.w, h: p.h });
  });
  Object.keys(layout.groups || {}).forEach(gid => {
    const g = layout.groups[gid];
    if (g && g.page === pageId) rects.push({ x: g.x || 0, y: g.y || 0, w: g.w || 1, h: g.h || 1 });
  });
  return rects;
}

// Largest free (unoccupied) cell rectangle on a `columns`×`rows` grid, or null
// when the grid is full. Brute force — the grid is tiny (≤12 cols, ≤~6 rows).
function largestFreeRect(occupied, columns, rows) {
  if (rows < 1 || columns < 1) return null;
  // Defensive clamp: never allocate/scan an oversized grid (guards against a
  // runaway row count freezing the UI).
  rows = Math.min(rows, 64); columns = Math.min(columns, 48);
  const occ = [];
  for (let y = 0; y < rows; y++) occ.push(new Array(columns).fill(false));
  occupied.forEach(r => {
    for (let y = r.y; y < r.y + r.h && y < rows; y++)
      for (let x = r.x; x < r.x + r.w && x < columns; x++)
        if (y >= 0 && x >= 0) occ[y][x] = true;
  });
  const free = (x, y, w, h) => {
    if (x + w > columns || y + h > rows) return false;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (occ[j][i]) return false;
    return true;
  };
  let best = null, bestArea = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    if (occ[y][x]) continue;
    for (let h = 1; y + h <= rows; h++) {
      let maxW = columns - x;
      for (let w = 1; w <= maxW; w++) {
        if (!free(x, y, w, h)) { maxW = w - 1; break; }
        const area = w * h;
        if (area > bestArea) { bestArea = area; best = { x, y, w, h }; }
      }
    }
  }
  return best;
}

// Re-pack every module on a page into a tidy balanced grid: rows of up to 4
// tiles, the 12 columns split evenly per row, 4 grid-rows per band (the same
// proportions as the stock dashboard). Mutates `layout` in place — the caller
// saves. Used by Genesis after composing a page and by the per-page layout
// reset: first-free-slot placement alone leaves fresh pages ragged.
function packPageItems(layout, pageId) {
  const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(layout.groups, id) : null);
  const items = [];
  const widgetIds = (typeof DASHBOARD_WIDGET_IDS !== 'undefined') ? DASHBOARD_WIDGET_IDS : Object.keys(layout.widgets || {});
  widgetIds.forEach(id => {
    const w = layout.widgets[id];
    if (w && w.visible && w.page === pageId && !groupOf(id)) items.push(w);
  });
  Object.keys(layout.groups || {}).forEach(gid => {
    const g = layout.groups[gid];
    if (g && g.page === pageId) items.push(g);
  });
  (Array.isArray(layout.copies) ? layout.copies : []).forEach(c => {
    if (c && c.page === pageId) items.push(c);
  });
  const n = items.length;
  if (!n) return;
  // 1-3 tiles → one row; 4-8 → two rows; 9+ → three rows (max 4 per row).
  const perRow = n <= 3 ? n : (n <= 8 ? Math.ceil(n / 2) : Math.ceil(n / 3));
  const ROW_H = 4;
  items.forEach((item, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = Math.min(perRow, n - row * perRow);
    const base = Math.floor(GRID_COLUMNS / inRow);
    const extra = GRID_COLUMNS % inRow;
    item.w = base + (col < extra ? 1 : 0);
    item.x = col * base + Math.min(col, extra);
    item.y = row * ROW_H;
    item.h = ROW_H;
  });
}

// Where to drop a newly-added widget. Prefer the largest free area WITHIN the
// on-screen rows — the exact region the "+" drop-zone highlights — at the widget's
// default size, so it lands in the visible free space the user is looking at,
// never pushed onto a new row below the fold. Only when that area can't hold it do
// we fall back to first-free-slot (which may add a row; fitGridHeights then
// compresses the page to fit). ≥defH rows so an empty page still gets a full slot.
function placeNewWidget(occupied, defW, defH, pageId) {
  const rows = Math.min(Math.max(pageRowSpan(pageId), defH), 16);
  const rect = largestFreeRect(occupied, GRID_COLUMNS, rows);
  if (rect && rect.w >= Math.min(defW, GRID_COLUMNS) && rect.h >= defH) {
    return { x: rect.x, y: rect.y, w: Math.min(defW, rect.w), h: defH };
  }
  const slot = firstFreeSlot(occupied, defW, defH, GRID_COLUMNS);
  return { x: slot.x, y: slot.y, w: defW, h: defH };
}

function addWidgetToPage(widgetId, pageId) {
  const layout = getDashboardLayout();
  const w = layout.widgets[widgetId];
  if (!w) return;
  const DI = window.DashboardInstances;
  const tg = window.DashboardTabGroups;
  const inGroup = tg ? tg.widgetGroupOf(layout.groups, widgetId) : null;
  // A hub-embedded widget (mic/audio/tasks/...) shows its single live content
  // inside its hub pane while not extracted. It is therefore already on screen:
  // adding it must DUPLICATE (clone) and leave the hub intact, never relocate the
  // singleton out of the hub — which made it vanish from where it was.
  const inHub = !w.visible && !inGroup
    && typeof dashboardWidgetHubPane === 'function' && !!dashboardWidgetHubPane(widgetId);
  const alreadyPlaced = w.visible || !!inGroup || inHub
    || (Array.isArray(layout.copies) && layout.copies.some(c => c.widget === widgetId));
  // DUPLICABLE + already placed → add a COPY (never move/remove the existing one).
  if (DI && DI.isDuplicable(widgetId) && alreadyPlaced) {
    const occupied = pageOccupiedRects(pageId, null, layout);
    const place = placeNewWidget(occupied, w.w || 4, w.h || 3, pageId);
    const existing = new Set([...Object.keys(layout.widgets), ...((layout.copies || []).map(c => c.id))]);
    const id = DI.makeCopyId(widgetId, existing);
    if (!Array.isArray(layout.copies)) layout.copies = [];
    layout.copies.push({ id, widget: widgetId, x: place.x, y: place.y, w: place.w, h: place.h, page: pageId });
    saveDashboardLayout(layout);
    if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
    return;
  }
  // Otherwise (first placement, or a not-yet-duplicable widget): show the single
  // instance here. If it lives in a group, pull it out first.
  if (inGroup && tg && typeof tg.extractMember === 'function') tg.extractMember(layout, inGroup, widgetId);
  const occupied = pageOccupiedRects(pageId, widgetId, layout);
  const place = placeNewWidget(occupied, w.w || 4, w.h || 3, pageId);
  w.visible = true; w.page = pageId; w.x = place.x; w.y = place.y; w.w = place.w; w.h = place.h;
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// Position the per-page "+" affordance over the page's largest free area, so it
// reads as a big Corsair-style "drop zone" even on a partially-filled page. On a
// fully-empty page we clear inline styles and let the CSS centred placeholder
// show; on a full page the "+" is hidden. Called after heights are fitted.
function refreshPageAddAffordances() {
  const editing = typeof document !== 'undefined' && document.body.classList.contains('layout-editing');
  const margin = 7;
  _grids.forEach((grid, pageId) => {
    try {
      const el = grid.el;
      const section = el && el.closest('.pager-page');
      const add = section && section.querySelector('.page-add-widget');
      if (!add) return;
      if (!editing) { add.style.cssText = ''; return; }
      // Read LIVE item geometry from the grid (not the saved layout) so the
      // drop-zone tracks tiles in real time while they're dragged/resized.
      const occupied = [];
      grid.getGridItems().forEach(it => {
        const n = it.gridstackNode;
        if (!n) return;
        occupied.push({ x: n.x || 0, y: n.y || 0, w: n.w || 1, h: n.h || 1 });
      });
      if (!occupied.length) { add.style.cssText = ''; return; } // empty page → CSS placeholder
      // Row count must be STABLE: while dragging, grid.getRow() balloons (the
      // dragged tile floats into phantom rows below), which both sent the "+" to
      // a bogus spot AND made largestFreeRect allocate a huge grid (→ freeze).
      // Use the intended layout rows, capped, so the search stays small and the
      // "+" only ever fills the visible area.
      let rows = pageRowSpan(pageId);
      if (rows < 1) rows = (typeof grid.getRow === 'function' ? grid.getRow() : 0) || 2;
      rows = Math.min(Math.max(rows, 1), 16);
      const rect = largestFreeRect(occupied, GRID_COLUMNS, rows);
      if (!rect) { add.style.display = 'none'; return; }   // page full
      const cw = el.clientWidth / GRID_COLUMNS;
      const ch = (typeof grid.getCellHeight === 'function' ? grid.getCellHeight() : (el.clientHeight / rows));
      add.style.display = 'grid';
      add.style.position = 'absolute';
      add.style.right = 'auto';
      add.style.bottom = 'auto';
      add.style.left = (rect.x * cw + margin) + 'px';
      add.style.top = (rect.y * ch + margin) + 'px';
      add.style.width = Math.max(44, rect.w * cw - 2 * margin) + 'px';
      add.style.height = Math.max(44, rect.h * ch - 2 * margin) + 'px';
    } catch (e) { /* ignore */ }
  });
}

// Throttle the "+" refresh to one run per animation frame — drag/resize fire it
// dozens of times a second, and the layout work shouldn't run on every event.
function scheduleAffordances() {
  if (_affRAF || typeof requestAnimationFrame !== 'function') { if (!_affRAF) refreshPageAddAffordances(); return; }
  _affRAF = requestAnimationFrame(() => { _affRAF = 0; refreshPageAddAffordances(); });
}

// Size each visible grid's cellHeight so its rows fill the page vertically
// (the dashboard is a fixed-height viewport, not a scroll page).
// Row count for a page from the INTENDED layout geometry (visible standalone
// widgets + groups on that page). Using the layout — not grid.getRow() — keeps
// this immune to GridStack's trailing-row quirk and to any transient drift.
function pageRowSpan(pageId) {
  if (typeof getDashboardLayout !== 'function') return 0;
  const layout = getDashboardLayout();
  const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(layout.groups, id) : null);
  let rows = 0;
  Object.keys(layout.widgets || {}).forEach((id) => {
    const w = layout.widgets[id];
    if (!w || !w.visible || w.page !== pageId || groupOf(id)) return;
    rows = Math.max(rows, (w.y || 0) + (w.h || 1));
  });
  Object.keys(layout.groups || {}).forEach((gid) => {
    const g = layout.groups[gid];
    if (!g || g.page !== pageId) return;
    rows = Math.max(rows, (g.y || 0) + (g.h || 1));
  });
  return rows;
}

function fitGridHeights() {
  _grids.forEach((grid, pageId) => {
    try {
      const el = grid.el;
      // Available height = the PAGE container (GridStack sizes el itself to its
      // content, so reading el.clientHeight would be circular).
      // The layout dock is in-flow above the pager, so clientHeight already
      // reflects the available space without any extra reserve needed.
      const parent = el && el.parentElement;
      let avail = parent ? parent.clientHeight : 0;
      if (!avail) return;                              // hidden page → skip
      let rows = pageRowSpan(pageId);
      if (rows < 1) rows = (typeof grid.getRow === 'function' ? grid.getRow() : 0) || 0;
      if (rows < 1) return;
      // GridStack's grid height = rows × cellHeight (the margin lives *inside*
      // each cell as the inter-item gap, it is NOT added on top). So to fill the
      // page exactly, cellHeight = avail / rows — no margin subtraction.
      const ch = Math.max(36, Math.floor(avail / rows));
      // Suppress the 'change' handler: a cellHeight change can reposition nodes
      // and fire 'change' → serialize → save, which previously drifted geometry.
      const wasSuppressed = _suppress;
      _suppress = true;
      try { grid.cellHeight(ch); } finally { _suppress = wasSuppressed; }
    } catch (e) { /* ignore */ }
  });
  refreshPageAddAffordances();   // the "+" drop-zone depends on the fitted cell size
}

if (typeof window !== 'undefined') {
  window.DashboardGrid = { mountPageGrid, setEditing, serialize, applyWidgetGeometry, addWidgetToPage, packPageItems, availableWidgets, addableWidgetIds, firstFreeSlot, largestFreeRect, fitGridHeights, refreshPageAddAffordances, ensureTileHandles, forEachInstance, GRID_COLUMNS, removePlacement, cycleTileSize };
  let _fitT = null;
  window.addEventListener('resize', () => { clearTimeout(_fitT); _fitT = setTimeout(fitGridHeights, 120); });
  // Track the pointer so dragstop can hit-test the drop target (merge → tab).
  const _trackPointer = (e) => { const p = e.touches ? e.touches[0] : e; if (p) { _lastPointer.x = p.clientX; _lastPointer.y = p.clientY; } };
  window.addEventListener('pointermove', _trackPointer, true);
  window.addEventListener('pointerdown', _trackPointer, true);
  window.addEventListener('touchmove', _trackPointer, { capture: true, passive: true });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { availableWidgets, addableWidgetIds, firstFreeSlot, largestFreeRect };
}

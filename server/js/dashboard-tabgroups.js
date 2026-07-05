'use strict';
// Generic tab-groups: a group is one grid tile holding several widget "atoms"
// as tabs. Pure model helpers (top) are unit-tested; runtime DOM is added below.

function rectsOverlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const minArea = Math.min(a.w * a.h, b.w * b.h) || 1;
  return inter / minArea;
}

function widgetGroupOf(groups, widgetId) {
  for (const gid of Object.keys(groups || {})) {
    if (((groups[gid] || {}).members || []).includes(widgetId)) return gid;
  }
  return null;
}

function _makeGroupId() { return 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Merge the dragged widget (aId) onto the target widget (bId). If bId is already
// in a group, aId joins it; otherwise a new group is created at bId's geometry,
// active = bId. Returns the resulting group id (or null on bad input).
function mergeWidgets(layout, aId, bId) {
  if (!layout || aId === bId || !layout.widgets[aId] || !layout.widgets[bId]) return null;
  const groups = layout.groups || (layout.groups = {});
  let gid = widgetGroupOf(groups, bId);
  if (!gid) {
    const b = layout.widgets[bId];
    gid = _makeGroupId();
    groups[gid] = { id: gid, members: [bId], active: bId, x: b.x, y: b.y, w: b.w, h: b.h, page: b.page };
  }
  const prev = widgetGroupOf(groups, aId);
  if (prev && prev !== gid) {
    groups[prev].members = groups[prev].members.filter(m => m !== aId);
    if (groups[prev].members.length <= 1) extractMember(layout, prev, groups[prev].members[0]);
  }
  if (!groups[gid].members.includes(aId)) groups[gid].members.push(aId);
  if (layout.widgets[aId]) layout.widgets[aId].visible = true;
  return gid;
}

// Remove memberId from group gid → standalone visible widget. If the group is
// left with ≤1 member, dissolve it (remaining member takes the group's
// geometry). Returns { extracted, dissolved }.
function extractMember(layout, gid, memberId) {
  const groups = layout.groups || {};
  const g = groups[gid];
  if (!g) return { extracted: false, dissolved: false };
  g.members = g.members.filter(m => m !== memberId);
  if (memberId && layout.widgets[memberId]) {
    layout.widgets[memberId].visible = true;
    layout.widgets[memberId].page = g.page;
  }
  if (g.active === memberId) g.active = g.members[0];
  let dissolved = false;
  if (g.members.length <= 1) {
    const last = g.members[0];
    if (last && layout.widgets[last]) {
      layout.widgets[last].visible = true;
      layout.widgets[last].x = g.x; layout.widgets[last].y = g.y;
      layout.widgets[last].w = g.w; layout.widgets[last].h = g.h; layout.widgets[last].page = g.page;
    }
    delete groups[gid];
    dissolved = true;
  }
  return { extracted: true, dissolved };
}

// ── Runtime (browser) ─────────────────────────────────────────────
// Tab icons reuse the palette's canonical per-widget glyphs (via
// DashboardPalette.iconFor) so EVERY widget's tab shows the same icon it was
// added from — no separate, drift-prone copy. Sized by CSS (.tabgroup-tab-ico).
// Unknown atoms fall back to text only.
function _tabIcon(mid) {
  const svg = (window.DashboardPalette && window.DashboardPalette.iconFor)
    ? window.DashboardPalette.iconFor(mid) : null;
  if (!svg) return null;
  const span = document.createElement('span');
  span.className = 'tabgroup-tab-ico';
  span.innerHTML = svg;   // static, trusted SVG from the palette icon map
  return span;
}

// Build/refresh a group's tab-group tile inside its grid item: a tab bar + the
// active member's content. Member atom DOM is relocated into the group body
// (moved by id → media.js/ai.js bindings survive). `gridItem` = .grid-stack-item.
function renderGroupTile(gridItem, group) {
  const content = gridItem.querySelector(':scope > .grid-stack-item-content') || gridItem;
  let tile = content.querySelector(':scope > .tabgroup');
  if (!tile) {
    tile = document.createElement('section');
    tile.className = 'panel tabgroup dashboard-widget';
    tile.dataset.groupId = group.id;
    const bar = document.createElement('div'); bar.className = 'tabgroup-bar';
    const body = document.createElement('div'); body.className = 'tabgroup-body';
    tile.append(bar, body);
    content.appendChild(tile);
  }
  const bar = tile.querySelector('.tabgroup-bar');
  const body = tile.querySelector('.tabgroup-body');
  bar.replaceChildren();
  group.members.forEach(mid => {
    const base = (window.DashboardInstances) ? window.DashboardInstances.baseWidgetOf(mid) : mid;
    let atom = (mid === base)
      ? document.querySelector('[data-dashboard-widget="' + base + '"]:not([data-dashboard-instance])')
      : document.querySelector('[data-dashboard-instance="' + mid + '"]');
    // A copy member may not have a standalone clone yet (copies render skips
    // grouped copies) — create it on demand so the tab body isn't empty.
    if (!atom && mid !== base && typeof createCopyAtom === 'function') atom = createCopyAtom(base, mid);
    if (atom && atom.parentElement !== body) body.appendChild(atom);
    if (atom) atom.dataset.dashboardHidden = (mid === group.active) ? 'false' : 'true';
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tabgroup-tab' + (mid === group.active ? ' active' : '');
    const icon = _tabIcon(base);
    if (icon) tab.appendChild(icon);
    const label = document.createElement('span');
    label.setAttribute('data-i18n', 'layout_widget_' + base);
    label.textContent = base;
    tab.appendChild(label);
    tab.addEventListener('click', () => setGroupActive(group.id, mid));
    // Edit-mode "×": removes THIS member from the tab group (hidden, restorable
    // via "+"). Replaces the old ⤤ extract glyph, which sat inside the tab and was
    // trivially mis-tapped — making a normal tab tap "separate" the group.
    const rm = document.createElement('span');
    rm.className = 'tabgroup-remove';
    rm.setAttribute('role', 'button');
    rm.setAttribute('aria-label', 'Remove from tab');
    rm.title = 'Remove from tab';
    rm.textContent = '×';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeMemberFromGroup(group.id, mid); });
    tab.appendChild(rm);
    bar.appendChild(tab);
  });
  // The Deck-in-tab chassis mount (DeckPanel.css / themes-retro.css) keys off
  // this class — a plain class toggled here instead of a :has() selector, so
  // tab switches and layout applies never pay :has() invalidation walks.
  tile.classList.toggle('deck-tab-active',
    !!body.querySelector(':scope > .deck-panel:not([data-dashboard-hidden="true"])'));
  if (typeof applyTranslations === 'function') applyTranslations();
  return tile;
}

function setGroupActive(gid, memberId, fromUser = true) {
  const layout = getDashboardLayout();
  const g = layout.groups[gid];
  if (!g || !g.members.includes(memberId)) return;
  let changed = false;
  if (g.active !== memberId) { g.active = memberId; changed = true; }
  // A manual pick locks the tab: persistently disable the playback-driven
  // auto-switch. (A window flag was being lost on the Xeneon WebView, so store
  // it in the layout itself where it survives re-renders, saves and reloads.)
  if (fromUser && g.autoTabByMedia) { g.autoTabByMedia = false; changed = true; window._mediaTabUserPicked = true; }
  if (!changed) return; // nothing changed — avoid churn / re-render loops
  saveDashboardLayout(layout, { status: false });
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// Remove a member from a group. A PRIMARY widget is hidden (restorable via the
// "+" palette); a COPY (a duplicated instance, `base~xxxx`) has no dock entry to
// restore from, so it is deleted outright — otherwise the "×" left an orphan
// standalone copy behind instead of removing the duplicate the user meant to drop.
// If the group is left with ≤1 member it dissolves (the remaining member becomes a
// standalone tile at the group's geometry).
function removeMemberFromGroup(gid, memberId) {
  const layout = getDashboardLayout();
  if (!layout.groups || !layout.groups[gid]) return;
  extractMember(layout, gid, memberId);                 // detach (may dissolve group)
  if (layout.widgets[memberId]) {
    layout.widgets[memberId].visible = false;           // primary → hide (restorable)
  } else if (Array.isArray(layout.copies)) {
    const i = layout.copies.findIndex(c => c && c.id === memberId);
    if (i >= 0) {
      const [removed] = layout.copies.splice(i, 1);     // copy → delete the instance
      if (removed && removed.widget === 'deck' && window.Deck && typeof window.Deck.forgetInstance === 'function') {
        window.Deck.forgetInstance(removed.id);
      }
    }
  }
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

function extractToStandalone(gid, memberId) {
  const layout = getDashboardLayout();
  extractMember(layout, gid, memberId);
  const page = (layout.widgets[memberId] && layout.widgets[memberId].page) || 'dashboard';
  if (window.DashboardGrid) {
    const occ = DASHBOARD_WIDGET_IDS
      .filter(id => id !== memberId && layout.widgets[id].visible && layout.widgets[id].page === page && !widgetGroupOf(layout.groups, id))
      .map(id => ({ x: layout.widgets[id].x, y: layout.widgets[id].y, w: layout.widgets[id].w, h: layout.widgets[id].h }));
    const slot = window.DashboardGrid.firstFreeSlot(occ, layout.widgets[memberId].w || 8, layout.widgets[memberId].h || 6, window.DashboardGrid.GRID_COLUMNS);
    layout.widgets[memberId].x = slot.x; layout.widgets[memberId].y = slot.y;
  }
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// "+ Tab": add `widgetId` as a tab to the tile holding `targetMember`. The target
// tile becomes a tab-group if it isn't one yet.
//  • default      → for a duplicable, visible widget this adds a COPY (the
//                   original placement stays); otherwise it moves the widget in.
//  • opts.move    → ALWAYS move the existing instance into the group (no copy),
//                   even for a duplicable one. `widgetId` may be a primary widget
//                   id OR a copy instance id (`base~xxxx`) already on the page.
function addAsTab(widgetId, targetMember, opts = {}) {
  const layout = getDashboardLayout();
  const DI = window.DashboardInstances;
  const move = !!(opts && opts.move);
  if (!targetMember || widgetId === targetMember) return;
  const groups = layout.groups || (layout.groups = {});
  const targetGeo = layout.widgets[targetMember]
    || (Array.isArray(layout.copies) ? layout.copies.find(c => c.id === targetMember) : null);
  let gid = widgetGroupOf(groups, targetMember);
  if (!gid) {
    const firstPage = (layout.pages && layout.pages[0] && layout.pages[0].id) || 'dashboard';
    const geo = targetGeo || { x: 0, y: 0, w: 8, h: 8, page: firstPage };
    gid = _makeGroupId();
    groups[gid] = { id: gid, members: [targetMember], active: targetMember, x: geo.x || 0, y: geo.y || 0, w: geo.w || 8, h: geo.h || 8, page: geo.page || firstPage };
  }
  const g = groups[gid];
  // Only create a copy when NOT moving and the widget is already a visible
  // standalone tile. Hub-based widgets (tasks, notes, mic, etc.) have their
  // content moved OUT of the data-dashboard-widget element when visible=false, so
  // createCopyAtom would clone an empty shell. Use the move path instead: setting
  // visible=true lets the sync function fill the element before renderGroupTile
  // locates it.
  if (!move && DI && DI.isDuplicable(widgetId) && layout.widgets[widgetId] && layout.widgets[widgetId].visible) {
    const existing = new Set([...Object.keys(layout.widgets), ...((layout.copies || []).map(c => c.id))]);
    const copyId = DI.makeCopyId(widgetId, existing);
    if (!Array.isArray(layout.copies)) layout.copies = [];
    layout.copies.push({ id: copyId, widget: widgetId, x: g.x, y: g.y, w: g.w, h: g.h, page: g.page });
    if (!g.members.includes(copyId)) g.members.push(copyId);
    g.active = copyId;
  } else {
    // Move path: take the EXISTING instance into the group. Detach it from any
    // previous group first (so a move never leaves a duplicate membership).
    const prev = widgetGroupOf(groups, widgetId);
    if (prev && prev !== gid) {
      groups[prev].members = groups[prev].members.filter(m => m !== widgetId);
      if (groups[prev].members.length <= 1) extractMember(layout, prev, groups[prev].members[0]);
    }
    if (layout.widgets[widgetId]) layout.widgets[widgetId].visible = true;
    if (!g.members.includes(widgetId)) g.members.push(widgetId);
    g.active = widgetId;
  }
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
}

// Called by dashboard-grid on dragstop: merge dragged widget onto target.
function mergeOnDrop(draggedWidgetId, targetWidgetId) {
  const layout = getDashboardLayout();
  const gid = mergeWidgets(layout, draggedWidgetId, targetWidgetId);
  if (!gid) return false;
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  return true;
}

if (typeof window !== 'undefined') {
  window.DashboardTabGroups = { renderGroupTile, setGroupActive, extractToStandalone, extractMember, mergeOnDrop, addAsTab, rectsOverlapRatio, widgetGroupOf };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rectsOverlapRatio, widgetGroupOf, mergeWidgets, extractMember };
}

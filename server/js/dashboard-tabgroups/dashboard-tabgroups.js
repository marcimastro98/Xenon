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

// A tab group's own tab colours (style.tabs) → custom properties for ONE tab.
// A background picked without a text colour gets a readable one, so a pick never
// leaves a label unreadable. Pure: the tests and the style editor read it too.
const TAB_COLOR_VARS = { bg: '--tgc-bg', text: '--tgc-text', activeBg: '--tgc-active-bg', activeText: '--tgc-active-text' };
function _readableOn(hex) {
  const P = (typeof window !== 'undefined' && window.ThemePalette) || null;
  if (P && P.bestText) return P.bestText(hex);
  const n = parseInt(String(hex).slice(1), 16);
  const y = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
  return y > 150 ? '#111111' : '#ffffff';
}
function tabColorVars(tabs, mid) {
  const items = tabs && tabs.items;
  const item = items && Object.prototype.hasOwnProperty.call(items, mid) ? items[mid] : null;
  const vars = {};
  if (!item) return vars;
  if (item.bg) vars[TAB_COLOR_VARS.bg] = item.bg;
  if (item.text || item.bg) vars[TAB_COLOR_VARS.text] = item.text || _readableOn(item.bg);
  if (item.activeBg) vars[TAB_COLOR_VARS.activeBg] = item.activeBg;
  if (item.activeText || item.activeBg) vars[TAB_COLOR_VARS.activeText] = item.activeText || _readableOn(item.activeBg);
  return vars;
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
  // Keep the joining primary's own page truthful (= the group's page): while
  // grouped its page field is otherwise never updated, and stale pages are how
  // widgets "teleport" to another page when their group is later removed.
  if (layout.widgets[aId]) {
    layout.widgets[aId].visible = true;
    layout.widgets[aId].page = groups[gid].page;
  }
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

// Reorder a group's tabs. `order` is the ids in their new order (extra ids are
// ignored, missing ones keep their relative position at the end) so a partial or
// stale list can never drop a member. Returns true when the order changed.
function reorderMembers(layout, gid, order) {
  const g = ((layout && layout.groups) || {})[gid];
  if (!g || !Array.isArray(g.members) || !Array.isArray(order)) return false;
  const prev = g.members;
  const next = order.filter((id, i) => prev.includes(id) && order.indexOf(id) === i);
  prev.forEach(id => { if (!next.includes(id)) next.push(id); });
  if (next.length !== prev.length || next.every((id, i) => id === prev[i])) return false;
  g.members = next;
  return true;
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
  // A custom-widget host ALWAYS mints a fresh copy id (see the alwaysCopy note
  // below), so widgetId === targetMember is a real duplicate here, NOT a no-op
  // self-add: it's exactly "+ Tab → Custom widget" on a tile that already shows
  // the custom PRIMARY, because _tabTargetMember resolves a standalone custom (or
  // a group whose first member is the custom primary) to the bare id 'custom'.
  // Guarding it out silently swallowed every such add — the reported "can't add a
  // second custom tab / can't assign it independently". Every non-custom caller
  // already filters widgetId === targetMember out before calling, so scoping the
  // guard to the non-copy paths changes nothing for them.
  const alwaysCopy = !move && widgetId === 'custom';
  if (!targetMember || (!alwaysCopy && widgetId === targetMember)) return null;
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
  let added = widgetId;
  // Only create a copy when NOT moving and the widget is already a visible
  // standalone tile. Hub-based widgets (tasks, notes, mic, etc.) have their
  // content moved OUT of the data-dashboard-widget element when visible=false, so
  // createCopyAtom would clone an empty shell. Use the move path instead: setting
  // visible=true lets the sync function fill the element before renderGroupTile
  // locates it.
  // A custom-widget host is the exception: it ALWAYS copies, even while the base
  // tile is hidden. Which package fills it lives outside the layout
  // (hubSettings.sdkWidgets.assign, keyed by instance id) and every SDK package
  // shares the single widget id 'custom' — so moving the base in would resurrect
  // the package it held last time instead of showing the picker, and would cap a
  // group at one custom tab (an id can only be a member once). Its static shell is
  // an empty mount, so cloning it while hidden is safe. (alwaysCopy is computed
  // above, next to the self-add guard it also governs.)
  if (alwaysCopy || (!move && DI && DI.isDuplicable(widgetId) && layout.widgets[widgetId] && layout.widgets[widgetId].visible)) {
    const existing = new Set([...Object.keys(layout.widgets), ...((layout.copies || []).map(c => c.id))]);
    const copyId = DI.makeCopyId(widgetId, existing);
    if (!Array.isArray(layout.copies)) layout.copies = [];
    layout.copies.push({ id: copyId, widget: widgetId, x: g.x, y: g.y, w: g.w, h: g.h, page: g.page });
    if (!g.members.includes(copyId)) g.members.push(copyId);
    g.active = copyId;
    added = copyId;
  } else {
    // Move path: take the EXISTING instance into the group. Detach it from any
    // previous group first (so a move never leaves a duplicate membership).
    const prev = widgetGroupOf(groups, widgetId);
    if (prev && prev !== gid) {
      groups[prev].members = groups[prev].members.filter(m => m !== widgetId);
      if (groups[prev].members.length <= 1) extractMember(layout, prev, groups[prev].members[0]);
    }
    if (layout.widgets[widgetId]) {
      layout.widgets[widgetId].visible = true;
      layout.widgets[widgetId].page = g.page;   // stale pages "teleport" widgets later
    }
    if (!g.members.includes(widgetId)) g.members.push(widgetId);
    g.active = widgetId;
  }
  saveDashboardLayout(layout);
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  // The member now in the tab: the copy that was minted, or the tile moved in.
  // The "+" panel needs it to hand a Store widget's package to that new tab.
  return added;
}

if (typeof window !== 'undefined') {
  // refreshLabels is called by CustomWidget.renderWidgets(): the package LIST is
  // only half of what a custom tab's label depends on — the other half is which
  // package that tile is ASSIGNED, and assigning one repaints the tile without
  // rebuilding the bar, so the tab kept the generic type name until a reload.
  window.DashboardTabGroups = { renderGroupTile, paintGroupTabs, tabColorVars, setGroupActive, extractToStandalone, extractMember, removeMemberFromGroup, mergeOnDrop, addAsTab, reorderMembers, rectsOverlapRatio, widgetGroupOf, refreshLabels: _refreshGroupLabels };
  // The SDK package list arrives after the first layout pass on a cold reload, so
  // a custom tab first paints with the generic type name — refresh it once names
  // are known (also covers a Rescan swapping which widget a tile hosts).
  window.addEventListener('xenon:sdk-packages', _refreshGroupLabels);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rectsOverlapRatio, widgetGroupOf, mergeWidgets, extractMember, addAsTab, reorderMembers, tabColorVars };
}

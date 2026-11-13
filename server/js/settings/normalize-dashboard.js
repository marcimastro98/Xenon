// Cleans a saved dashboard layout: pages, tiles, their sizes and places, copies, groups and tabs.
'use strict';

function cloneDashboardLayout(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDashboardOrder(value, fallback, maxOrder) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(0, Math.min(maxOrder, numeric));
}

function normalizeDashboardSize(value, allowedSizes, fallback) {
  return allowedSizes.includes(value) ? value : fallback;
}

// Grid geometry for a widget (drag&drop model): {x,y,w,h,visible} in cells.
// Shared per-tile style normalizer (client global / server require of the same
// pure module).
//
// Before DashboardInstances loads — which is the parse-time loadHubSettings(),
// every boot — this must NOT degrade to "no style". That was the same data loss
// as the copies fallback below (GitHub #130: every per-card opacity reset after
// an update): the stripped style is harmless until a server-bound save lands
// before the hydrate, bumps the local rev, and makes the stripped copy win the
// merge. So pass a plain object through untouched; getDashboardLayout()
// normalizes again on every read, and the server on every POST.
function normTileStyle(src) {
  if (typeof DashboardInstances !== 'undefined' && DashboardInstances.normalizeTileStyle) {
    return DashboardInstances.normalizeTileStyle(src);
  }
  return (src && typeof src === 'object' && !Array.isArray(src)) ? src : null;
}

function normalizeDashboardGeom(sourceItem, fallbackItem) {
  const s = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  const intIn = (v, min, max, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb; };
  const out = {
    x: intIn(s.x, 0, DASHBOARD_GRID_COLUMNS - 1, fallbackItem.x),
    y: intIn(s.y, 0, DASHBOARD_GRID_MAX_ROW, fallbackItem.y),
    w: intIn(s.w, 1, DASHBOARD_GRID_COLUMNS, fallbackItem.w),
    h: intIn(s.h, 1, DASHBOARD_GRID_MAX_ROW, fallbackItem.h),
    visible: s.visible === undefined ? fallbackItem.visible : s.visible !== false,
  };
  const style = normTileStyle(s.style);
  if (style) out.style = style;
  return out;
}

function normalizeDashboardItem(sourceItem, fallbackItem, maxOrder, allowedSizes) {
  const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  // A card id with no default entry threw here, and on the CLIENT that is worse
  // than on the server: normalizeSettings runs inside applyHubSettings, which
  // runs on every hydrate and every SSE settings event, so the exception landed
  // before the dashboard had finished setting itself up. Same second fence as
  // the server copy — a normalizer for persisted data must degrade, never take
  // the page down with it.
  const fb = fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : { order: maxOrder, size: null, visible: true };
  return {
    order: normalizeDashboardOrder(source.order, fb.order, maxOrder),
    size: normalizeDashboardSize(source.size, allowedSizes, fb.size),
    visible: source.visible === undefined ? fb.visible : source.visible !== false,
  };
}

function sortDashboardIds(collection) {
  return Object.keys(collection).sort((left, right) => {
    const diff = collection[left].order - collection[right].order;
    return diff || left.localeCompare(right);
  });
}

function reindexDashboardCollection(collection) {
  sortDashboardIds(collection).forEach((id, index) => { collection[id].order = index; });
}

function normalizeCalendarTabs(source) {
  const src = source && typeof source === 'object' ? source : {};
  const srcOrder = Array.isArray(src.order) ? src.order : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.order;
  const order = srcOrder.filter(t => CALENDAR_TAB_IDS.includes(t));
  CALENDAR_TAB_IDS.forEach(t => { if (!order.includes(t)) order.push(t); });
  return {
    order,
    active: ['calendar', 'tasks', 'timer', 'notes'].includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.active,
  };
}

function normalizeMediaView(source) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    active: MEDIA_VIEW_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.mediaView.active,
  };
}

// NB: the page cap (8) is inlined here; the named DASHBOARD_PAGES_MAX const
// lives in dashboard-pages.js — declaring it here too would redeclare it in the
// shared browser global scope and break that script.
function normalizeDashboardPages(value) {
  const seed = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT.pages);
  if (!Array.isArray(value)) return seed;
  const out = [];
  const seen = new Set();
  value.forEach(p => {
    if (!p || typeof p !== 'object') return;
    const id = String(p.id || '').trim().slice(0, 64);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const page = { id, name: String(p.name == null ? '' : p.name).trim().slice(0, 40) };
    if (p.nameKey) page.nameKey = String(p.nameKey).slice(0, 64);
    out.push(page);
  });
  return out.length ? out.slice(0, 8) : seed;
}

// Duplicated-widget placements. DashboardInstances loads AFTER settings.js, so
// the parse-time loadHubSettings() runs with it undefined. Falling back to []
// there was silent data loss, not a safe default: normalizeDashboardGroups drops
// members it can't resolve and DELETES any group left under two, so a tab group
// holding a copy (every SDK-widget tab group — they always join as copies) was
// erased on every boot. The hydrate normally repaired it, but a GridStack mount
// `change` firing first serialized the mutilated layout and bumped `rev`, which
// then won the merge against the server and made the loss permanent.
// So fall back to a bounded RAW passthrough instead — same idiom as
// normalizeAmbientScenes/dashboardPresets. The deep normalize runs on the next
// pass once the module is up, and the grid re-normalizes before building DOM.
function normalizeDashboardCopies(rawCopies, widgets, pageIds) {
  if (typeof DashboardInstances !== 'undefined' && DashboardInstances.normalizeCopies) {
    return DashboardInstances.normalizeCopies(rawCopies, widgets, pageIds);
  }
  if (!Array.isArray(rawCopies)) return [];
  const seen = new Set();
  const out = [];
  rawCopies.forEach(c => {
    if (!c || typeof c !== 'object') return;
    const id = String(c.id || '').trim();
    const widget = String(c.widget || '').trim();
    if (!id || id.indexOf('~') < 0 || seen.has(id)) return;
    if (!widgets || !widgets[widget]) return;
    seen.add(id);
    out.push(c);
  });
  return out.slice(0, 60);
}

function normalizeDashboardGroups(value, widgets, pageIds, copies) {
  const copyIds = new Set((Array.isArray(copies) ? copies : []).map(c => c.id));
  const isInstance = (m) => (widgets && widgets[m]) || copyIds.has(m);
  const out = {};
  const src = value && typeof value === 'object' ? value : {};
  const used = new Set();
  Object.keys(src).forEach(gid => {
    const g = src[gid] && typeof src[gid] === 'object' ? src[gid] : {};
    let members = Array.isArray(g.members) ? g.members.filter(m => isInstance(m) && !used.has(m)) : [];
    members = members.filter((m, i) => members.indexOf(m) === i);
    if (members.length < 2) return;            // a group needs ≥2 members
    members.forEach(m => used.add(m));
    const id = String(gid).slice(0, 64);
    out[id] = {
      id, members,
      active: members.includes(g.active) ? g.active : members[0],
      x: Math.max(0, Math.round(Number(g.x)) || 0),
      y: Math.max(0, Math.round(Number(g.y)) || 0),
      w: Math.max(1, Math.round(Number(g.w)) || 8),
      h: Math.max(1, Math.round(Number(g.h)) || 8),
      page: pageIds.includes(g.page) ? g.page : pageIds[0],
      seeded: g.seeded === true,
      autoTabByMedia: g.autoTabByMedia === true,
    };
    const style = normTileStyle(g.style);
    if (style) out[id].style = style;
  });
  return out;
}

function normalizeDashboardTabs(sourceTabs) {
  const source = sourceTabs && typeof sourceTabs === 'object' ? sourceTabs : {};
  const sourceOrder = Array.isArray(source.order) ? source.order : DEFAULT_DASHBOARD_LAYOUT.tabs.order;
  const order = sourceOrder.filter(tab => DASHBOARD_TAB_IDS.includes(tab));
  DASHBOARD_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: ['main', 'net', 'volume', 'mic'].includes(source.active) ? source.active : DEFAULT_DASHBOARD_LAYOUT.tabs.active,
  };
}

// One-time unit migration: layouts saved before the 24-column grid carry no
// gridCols flag and are in 12-column units — double every geometry (widgets,
// groups, copies) so each tile keeps its exact position and size on the finer
// grid. Idempotent: the flag is stamped on the normalized output, and until the
// layout is re-saved the scaling always re-derives from the raw 12-unit source.
// Mirrors the server normalizer (server.js) — keep both in sync. If the grid
// resolution ever changes again, branch on the STORED gridCols value (absent =
// 12-column) and derive the factor per source unit — never reuse this blanket ×2.
function scaleDashboardLayoutUnits(source) {
  if (Number(source.gridCols) === DASHBOARD_GRID_COLUMNS) return source;
  const scaleBox = (o) => {
    if (!o || typeof o !== 'object') return o;
    const out = Object.assign({}, o);
    ['x', 'y', 'w', 'h'].forEach(k => {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = Math.round(n * 2);
    });
    return out;
  };
  const out = Object.assign({}, source);
  if (source.widgets && typeof source.widgets === 'object') {
    out.widgets = {};
    Object.keys(source.widgets).forEach(id => { out.widgets[id] = scaleBox(source.widgets[id]); });
  }
  if (source.groups && typeof source.groups === 'object') {
    out.groups = {};
    Object.keys(source.groups).forEach(id => { out.groups[id] = scaleBox(source.groups[id]); });
  }
  if (Array.isArray(source.copies)) out.copies = source.copies.map(scaleBox);
  return out;
}

function normalizeDashboardLayout(value) {
  const source = scaleDashboardLayoutUnits(value && typeof value === 'object' ? value : {});
  const layout = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  const sourceWidgets = source.widgets && typeof source.widgets === 'object' ? source.widgets : {};

  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    const fb = DEFAULT_DASHBOARD_LAYOUT.widgets[widgetId];
    const geom = normalizeDashboardGeom(sourceWidgets[widgetId], fb);
    const srcPage = sourceWidgets[widgetId] && sourceWidgets[widgetId].page;
    // Keep ANY saved page id (incl. user-created pages); it's clamped to a real
    // page below against the actual page list. Validating here against the static
    // default ids would wrongly reset widgets added to a user page back to their
    // default page — making "+ add" land on the wrong page.
    geom.page = (typeof srcPage === 'string' && srcPage) ? srcPage : (fb.page || 'dashboard');
    layout.widgets[widgetId] = geom;
  });

  Object.keys(DASHBOARD_CARD_IDS).forEach(groupId => {
    const sourceCards = source.cards && source.cards[groupId] && typeof source.cards[groupId] === 'object'
      ? source.cards[groupId]
      : {};
    DASHBOARD_CARD_IDS[groupId].forEach(cardId => {
      layout.cards[groupId][cardId] = normalizeDashboardItem(
        sourceCards[cardId],
        DEFAULT_DASHBOARD_LAYOUT.cards[groupId][cardId],
        DASHBOARD_CARD_IDS[groupId].length - 1,
        DASHBOARD_CARD_SIZES,
      );
    });
    reindexDashboardCollection(layout.cards[groupId]);
  });

  layout.pages = normalizeDashboardPages(source.pages);
  const pageIds = layout.pages.map(p => p.id);
  const firstPage = pageIds[0];
  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    if (!pageIds.includes(layout.widgets[widgetId].page)) layout.widgets[widgetId].page = firstPage;
  });
  // Extra placements (duplicated widgets). Validated against known widgets/pages.
  layout.copies = normalizeDashboardCopies(source.copies, layout.widgets, pageIds);
  // Fall back to the seeded groups when the source has none, otherwise the
  // welcome media-group is lost. A reset takes today's; a saved layout from
  // before groups existed keeps the chat where its owner always had it.
  layout.groups = normalizeDashboardGroups(
    source.groups !== undefined ? source.groups : (source.widgets ? LEGACY_SEEDED_GROUPS : DEFAULT_DASHBOARD_LAYOUT.groups),
    layout.widgets, pageIds, layout.copies);

  layout.tabs = normalizeDashboardTabs(source.tabs);
  layout.calendarTabs = normalizeCalendarTabs(source.calendarTabs);
  layout.mediaView = normalizeMediaView(source.mediaView);
  layout.topbarHidden = source.topbarHidden === true;
  layout.timerAddCollapsed = source.timerAddCollapsed === true;
  layout.gridCols = DASHBOARD_GRID_COLUMNS;  // units flag — see scaleDashboardLayoutUnits
  // The vertical layout's own geometry; validated against the ids above, so it
  // must stay last. Same rule as the server (js/dashboard-portrait.js, loaded
  // before this file).
  layout.portrait = (typeof DashboardPortrait !== 'undefined')
    ? DashboardPortrait.normalizePortrait(source.portrait, layout)
    : { custom: false, items: {} };
  return layout;
}

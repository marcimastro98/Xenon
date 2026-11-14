// Rebuilds a stored dashboard layout from known keys: the tiles, their places, the tab groups
// and the vertical arrangement.

const {
  DASHBOARD_WIDGET_IDS, DASHBOARD_CARD_IDS, DASHBOARD_CARD_SIZES, DASHBOARD_GRID_COLUMNS,
  DASHBOARD_GRID_MAX_ROW, DEFAULT_DASHBOARD_LAYOUT,
} = require('./layout-defaults.js');
const {
  LEGACY_SEEDED_GROUPS, cloneDashboardLayout, DASHBOARD_GEOM_FALLBACK, normalizeDashboardItem,
  reindexDashboardCollection, normalizeDashboardTabs, normalizeCalendarTabs, normalizeMediaView,
} = require('./layout-normalize-parts.js');
const { scaleDashboardLayoutUnits } = require('./layout-unit-migration.js');
const { normalizeDashboardPages } = require('./pages-normalize.js');
const DashboardInstances = require('../js/dashboard-instances.js');
const DashboardPortrait = require('../js/dashboard-portrait.js');

function normalizeDashboardGeom(sourceItem, fallbackItem) {
  const s = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  const fb = fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : DASHBOARD_GEOM_FALLBACK;
  const intIn = (v, min, max, dfl) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dfl; };
  const out = {
    x: intIn(s.x, 0, DASHBOARD_GRID_COLUMNS - 1, fb.x),
    y: intIn(s.y, 0, DASHBOARD_GRID_MAX_ROW, fb.y),
    w: intIn(s.w, 1, DASHBOARD_GRID_COLUMNS, fb.w),
    h: intIn(s.h, 1, DASHBOARD_GRID_MAX_ROW, fb.h),
    visible: s.visible === undefined ? fb.visible : s.visible !== false,
  };
  const style = DashboardInstances.normalizeTileStyle(s.style);
  if (style) out.style = style;
  return out;
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
    if (members.length < 2) return;
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
    const style = DashboardInstances.normalizeTileStyle(g.style);
    // Tab colours of a tab that left the group are dropped with it.
    if (style && style.tabs && style.tabs.items) {
      Object.keys(style.tabs.items).forEach(mid => { if (!members.includes(mid)) delete style.tabs.items[mid]; });
      if (!Object.keys(style.tabs.items).length) delete style.tabs.items;
      if (!Object.keys(style.tabs).length) delete style.tabs;
    }
    if (style && (style.mode === 'custom' || Object.keys(style).length > 1)) out[id].style = style;
  });
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
    geom.page = (typeof srcPage === 'string' && srcPage) ? srcPage : ((fb && fb.page) || 'dashboard');
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
  layout.copies = DashboardInstances.normalizeCopies(source.copies, layout.widgets, pageIds);

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
  // must stay last. Same rule as the client (js/dashboard-portrait.js).
  layout.portrait = DashboardPortrait.normalizePortrait(source.portrait, layout);
  return layout;
}

module.exports = { normalizeDashboardGeom, normalizeDashboardGroups, normalizeDashboardLayout };

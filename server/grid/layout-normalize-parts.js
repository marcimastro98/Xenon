// The small steps of checking a saved dashboard layout: one tile, the order of tiles, the tabs
// and the number of pages.

const {
  DASHBOARD_TAB_IDS, CALENDAR_TAB_IDS, MEDIA_VIEW_IDS, DEFAULT_DASHBOARD_LAYOUT,
} = require('./layout-defaults.js');

// What a saved layout with no `groups` gets: the tabs every install had before 5.0.0,
// when the chat shared the media tile and the Agenda had a tile of its own.
const LEGACY_SEEDED_GROUPS = Object.freeze({
  'media-group': Object.freeze({ ...DEFAULT_DASHBOARD_LAYOUT.groups['media-group'], members: Object.freeze(['media', 'chat']) }),
});

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
// A missing fallbackItem (a widget id present in DASHBOARD_WIDGET_IDS but not in
// DEFAULT_DASHBOARD_LAYOUT.widgets) must NOT 500 the whole settings endpoint —
// degrade to a safe hidden default so the id is still normalized cleanly.
const DASHBOARD_GEOM_FALLBACK = Object.freeze({ x: 0, y: 0, w: 8, h: 8, visible: false });

function normalizeDashboardItem(sourceItem, fallbackItem, maxOrder, allowedSizes) {
  const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  // A card id with no default entry used to throw here, and the blast radius was
  // far larger than a misplaced card: normalizeHubSettings is how the WHOLE
  // settings blob is rebuilt, so one missing default made `GET /settings` answer
  // 500 and left the server's in-memory copy at factory defaults — which
  // silently switched OFF every server-owned flag, paired-device access
  // included, while the file on disk still said it was on. A phone that had been
  // working for hours started getting the plain 403 of a build without the
  // feature. The data gap is fixed above and pinned by a test; this is the
  // second fence, because a normalizer for persisted data must degrade, never
  // take the store down with it.
  const fb = fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : { order: maxOrder, size: null };
  return {
    order: normalizeDashboardOrder(source.order, fb.order, maxOrder),
    size: normalizeDashboardSize(source.size, allowedSizes, fb.size),
    visible: source.visible === undefined ? true : source.visible !== false,
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

const DASHBOARD_PAGES_MAX = 8;

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

function normalizeCalendarTabs(source) {
  const src = source && typeof source === 'object' ? source : {};
  const srcOrder = Array.isArray(src.order) ? src.order : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.order;
  const order = srcOrder.filter(tab => CALENDAR_TAB_IDS.includes(tab));
  CALENDAR_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
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

module.exports = {
  LEGACY_SEEDED_GROUPS, cloneDashboardLayout, normalizeDashboardOrder, normalizeDashboardSize,
  DASHBOARD_GEOM_FALLBACK, normalizeDashboardItem, sortDashboardIds, reindexDashboardCollection,
  DASHBOARD_PAGES_MAX, normalizeDashboardTabs, normalizeCalendarTabs, normalizeMediaView,
};

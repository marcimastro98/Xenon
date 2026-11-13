// Whether a feed has anyone to show it to: its tile is on the dashboard or the ticker streams
// it. An unknown layout counts as yes.

const { hub } = require('../settings/current.js');

// A display-only feed is worth fetching only if someone can actually see it:
// its widget is on the dashboard (visible, duplicated as a copy, or merged into
// a tab-group) or the ticker streams that source. Any unexpected/legacy layout
// shape fails OPEN (fetch) — this gate may only ever save work, never hide data.
// Used for news + claude; stocks/football are deliberately NOT gated because
// their fetch also drives user-facing alerts (price moves, goals) that must
// keep working with the widget hidden (see _stocksAlertsWanted).
function _feedWidgetInUse(widgetId, tickerSource) {
  const s = hub.settings;
  if (!s || typeof s !== 'object') return true;
  if (tickerSource) {
    const t = s.ticker;
    if (t && t.enabled === true && t.sources && t.sources[tickerSource] !== false) return true;
  }
  const layout = s.dashboardLayout;
  if (!layout || typeof layout !== 'object') return true;
  const w = layout.widgets && layout.widgets[widgetId];
  if (!w || typeof w !== 'object') return true;
  if (w.visible === true) return true;
  if (Array.isArray(layout.copies) && layout.copies.some(c => c && c.widget === widgetId)) return true;
  const groups = layout.groups && typeof layout.groups === 'object' ? layout.groups : {};
  for (const gid of Object.keys(groups)) {
    const members = groups[gid] && Array.isArray(groups[gid].members) ? groups[gid].members : [];
    if (members.some(m => m === widgetId || (typeof m === 'string' && m.indexOf(widgetId + '~') === 0))) return true;
  }
  return false;
}

module.exports = { _feedWidgetInUse };

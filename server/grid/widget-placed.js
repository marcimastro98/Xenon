// Whether a tile is on the dashboard right now, answered strictly: an unknown layout is no.

const { hub } = require('../settings/current.js');

// "Is this tile on the dashboard", answered strictly: an unknown layout is NO.
// _feedWidgetInUse() answers yes when unsure, which is right for a cheap read
// and wrong for starting a long-lived child.
function _widgetPlaced(widgetId) {
  const layout = hub.settings && hub.settings.dashboardLayout;
  if (!layout || typeof layout !== 'object') return false;
  const w = layout.widgets && layout.widgets[widgetId];
  if (w && typeof w === 'object' && w.visible === true) return true;
  if (Array.isArray(layout.copies) && layout.copies.some((c) => c && c.widget === widgetId)) return true;
  const groups = layout.groups && typeof layout.groups === 'object' ? layout.groups : {};
  for (const gid of Object.keys(groups)) {
    const members = groups[gid] && Array.isArray(groups[gid].members) ? groups[gid].members : [];
    if (members.some((m) => m === widgetId || (typeof m === 'string' && m.indexOf(widgetId + '~') === 0))) return true;
  }
  return false;
}

module.exports = { _widgetPlaced };

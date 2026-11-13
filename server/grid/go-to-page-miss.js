// Tells Bit the real page names when it asked to go to a page that does not exist.

const PageTarget = require('../js/page-target.js');
const { normalizeDashboardPages } = require('./pages-normalize.js');
const { hub } = require('../settings/current.js');

// A Deck key's keyboard shortcut runs its tap here, dashboard or not.
// go_to_page: a page name that matches none is told back to Bit with the real
// names, before the dashboard is asked to move (js/page-target.js).
function goToPageMiss(args) {
  const pages = normalizeDashboardPages(hub.settings.dashboardLayout && hub.settings.dashboardLayout.pages);
  return PageTarget.pageTargetMiss(args && args.page, pages.map(p => ({ id: p.id, label: p.name || p.id })));
}

module.exports = { goToPageMiss };

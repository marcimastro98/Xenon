// Checks the list of dashboard pages saved with the settings: one entry per id, names cut to
// size, and no more pages than allowed.

const { DEFAULT_DASHBOARD_LAYOUT } = require('./layout-defaults.js');
const { cloneDashboardLayout, DASHBOARD_PAGES_MAX } = require('./layout-normalize-parts.js');
const contentInstalls = require('../js/content-installs.js');

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
    if (p.imported === true) page.imported = true;   // arrived via a shared preset → not re-exportable
    if (page.imported && contentInstalls.INSTALL_ID_RE.test(String(p.installId || ''))) page.installId = String(p.installId);
    out.push(page);
  });
  return out.length ? out.slice(0, DASHBOARD_PAGES_MAX) : seed;
}

module.exports = { normalizeDashboardPages };

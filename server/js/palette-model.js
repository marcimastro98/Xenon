'use strict';
// The "+" panel's model: which widgets it offers, under which category, and
// what each filter shows. Pure, so the rules are testable without a DOM; the
// panel itself (dashboard-palette.js) only draws what this returns.
//
// Two kinds of entry live side by side: a built-in widget (by its widget id)
// and a widget installed from the Store (by its package id). The generic
// "custom" host tile is never an entry: a package IS the thing the user adds,
// and the host tile is how it is placed, not something to pick.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PaletteModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
  // The panel's categories, in the order they are shown. `other` is last and
  // only appears when something lands in it.
  const CATEGORIES = ['productivity', 'media', 'system', 'streaming', 'other'];
  const CATEGORY_KEY = {
    productivity: 'palette_cat_productivity', media: 'palette_cat_media',
    system: 'palette_cat_system', streaming: 'palette_cat_streaming', other: 'palette_cat_other',
  };
  // The Store's categories are a different vocabulary (they describe packs and
  // themes too), so a widget's catalog category is translated, never shown raw.
  const FROM_CATALOG = {
    system: 'system', 'smart-home': 'system', media: 'media',
    streaming: 'streaming', deck: 'streaming', tools: 'productivity',
    style: 'other', fun: 'other',
  };
  const MANIFEST_CATEGORIES = ['productivity', 'media', 'system', 'streaming'];

  // A package's category: its own manifest first (the author knows best), then
  // the catalog entry it was installed from, then "other".
  function packageCategory(pkg, catalogEntry) {
    const own = pkg && typeof pkg.category === 'string' ? pkg.category : '';
    if (MANIFEST_CATEGORIES.includes(own)) return own;
    const cat = catalogEntry && typeof catalogEntry.category === 'string' ? catalogEntry.category : '';
    return FROM_CATALOG[cat] || 'other';
  }

  // The catalog entry a package came from, when it can be proved: the catalog
  // publishes a standalone widget under its pkgId; a widget that arrived inside a
  // bundle inherits the bundle's entry through the install receipt. A package
  // imported from a pasted code has neither, and that is an honest "unknown".
  function catalogEntryForPackage(pkgId, entries, receipts) {
    if (!pkgId || !Array.isArray(entries)) return null;
    const direct = entries.find((e) => e && e.pkgId === pkgId);
    if (direct) return direct;
    for (const r of Array.isArray(receipts) ? receipts : []) {
      if (!r || r.source !== 'catalog' || !r.sourceId) continue;
      const ids = r.resources && Array.isArray(r.resources.widgetIds) ? r.resources.widgetIds : [];
      if (!ids.includes(pkgId)) continue;
      const hit = entries.find((e) => e && (e.id === r.sourceId
        || (e.limited && e.limited.dropId && String(r.sourceId).startsWith(e.limited.dropId + '-'))));
      if (hit) return hit;
    }
    return null;
  }

  // A built-in widget's category from the panel's category table
  // ([{ labelKey, ids }], WIDGET_CATEGORIES in dashboard-palette.js).
  function builtinCategory(id, table) {
    for (const c of Array.isArray(table) ? table : []) {
      if (c && Array.isArray(c.ids) && c.ids.includes(id)) {
        const hit = Object.keys(CATEGORY_KEY).find((k) => CATEGORY_KEY[k] === c.labelKey);
        if (hit) return hit;
      }
    }
    return 'other';
  }

  // Every entry the panel offers, built-ins first in the order given, then the
  // installed packages by name. `custom` is dropped from the built-ins.
  //   builtins: [{ id, base }]   packages: [pkg]   catalog: entries[]   receipts: contentInstalls[]
  function buildEntries({ builtins, packages, table, catalog, receipts }) {
    const out = [];
    for (const b of Array.isArray(builtins) ? builtins : []) {
      if (!b || !b.id) continue;
      const base = b.base || b.id;
      if (base === 'custom') continue;
      out.push({ kind: 'builtin', id: b.id, base, category: builtinCategory(base, table), installed: false });
    }
    const pkgs = (Array.isArray(packages) ? packages : [])
      .filter((p) => p && p.id && p.name && p.surface !== 'ambient')
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const pkg of pkgs) {
      const entry = catalogEntryForPackage(pkg.id, catalog, receipts);
      out.push({ kind: 'pkg', id: pkg.id, base: 'custom', pkg, category: packageCategory(pkg, entry), installed: true });
    }
    return out;
  }

  // 'all' | 'installed' | a category id.
  function filterEntries(entries, filter) {
    const list = Array.isArray(entries) ? entries : [];
    if (!filter || filter === 'all') return list;
    if (filter === 'installed') return list.filter((e) => e.installed);
    return list.filter((e) => e.category === filter);
  }

  // The filters worth offering for these entries: "all", "installed" when a
  // Store widget is present (or `alwaysInstalled`, so the empty state can point
  // at the Store), then each category that has something in it.
  function availableFilters(entries, alwaysInstalled) {
    const list = Array.isArray(entries) ? entries : [];
    const out = ['all'];
    if (alwaysInstalled || list.some((e) => e.installed)) out.push('installed');
    for (const c of CATEGORIES) if (list.some((e) => e.category === c)) out.push(c);
    return out;
  }

  // [[category, entries]] in the panel's order, empty categories left out.
  function groupByCategory(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return CATEGORIES.map((c) => [c, list.filter((e) => e.category === c)]).filter(([, l]) => l.length);
  }

  return {
    CATEGORIES, CATEGORY_KEY, FROM_CATALOG, MANIFEST_CATEGORIES,
    packageCategory, catalogEntryForPackage, builtinCategory,
    buildEntries, filterEntries, availableFilters, groupByCategory,
  };
});

// The rows of the Installed list: receipts and Store packages merged so one thing is never listed
// twice, and a bundle's widgets tied to the bundle they came in.
'use strict';

(() => {
  const { HS, PS } = window.InstalledManagerRowFacts;

  // Build the row list. Two kinds of row, and they never describe the same
  // thing twice:
  //   • a receipt — the download unit; removing it removes its whole footprint
  //   • an SDK package — an individually removable widget
  // A widget-kind receipt that owns exactly one package IS that package, so it
  // renders as a single enriched row. A bundle's widgets stay individually
  // listed (that granularity existed before this tab and must survive): removing
  // one drops it from the bundle's receipt via forgetInstalledContentResource.
  async function collect() {
    let packages = [];
    try {
      const d = await fetch('/sdk/widgets').then((r) => r.json());
      packages = (d && d.packages) || [];
    } catch { /* server unreachable → receipts only */ }
    const records = (typeof ContentInstalls !== 'undefined')
      ? ContentInstalls.normalizeContentInstalls(HS().contentInstalls) : [];
    let legacy = null;
    try { legacy = PS() ? await PS().legacyImportRecord(records, packages) : null; } catch { legacy = null; }
    const all = legacy ? records.concat([legacy]) : records;

    const pkgById = new Map(packages.map((p) => [p.id, p]));
    const merged = new Set();   // packages already represented by their own receipt
    const rows = all.slice().sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0)).map((record) => {
      const ids = record.resources.widgetIds || [];
      const solo = (record.kind === 'widget' && ids.length === 1 && ContentInstalls.resourceCount(record.resources) === 1)
        ? pkgById.get(ids[0]) : null;
      if (solo) merged.add(solo.id);
      return { record, pkg: solo || null };
    });
    // A bundle's widgets stay individually listed, so the SAME package appears
    // twice: once as the download it came in, once as the removable widget. The
    // widget half had nothing to look itself up with — the catalog publishes the
    // BUNDLE (pkgId: null), not its parts — so it fell back to the grey glyph and
    // the two rows for one thing looked like two different things. The receipt
    // already records which widgets it installed, so the owner is provable rather
    // than guessed, and the widget row inherits the artwork of the package it
    // arrived in.
    const ownerByPkg = new Map();
    for (const record of all) {
      for (const id of (record.resources.widgetIds || [])) {
        if (!merged.has(id) && !ownerByPkg.has(id)) ownerByPkg.set(id, record);
      }
    }
    packages.filter((p) => !merged.has(p.id))
      .forEach((pkg) => rows.push({ record: null, pkg, owner: ownerByPkg.get(pkg.id) || null }));
    return rows;
  }

  window.InstalledManagerRowList = { collect };
})();

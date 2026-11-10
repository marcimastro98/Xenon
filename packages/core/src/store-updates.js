;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.storeUpdates = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Which Store items this PC owns, and which of them the catalog now lists in a
   * newer version. ONE join for every place that tells it: the in-app Store (its
   * cards, the Installed page, the count on the Settings entry points) and the
   * server, for the Xenon menu window, which has no Store loaded. Two copies of
   * this used to be how surfaces came to disagree about whether an update exists.
   *
   * Pure: the callers fetch the catalog, the installed packages and the install
   * receipts, and hand them in.
   */

  // Versions are compared fail-closed: a downgrade must never look like an
  // update, and a malformed side must never produce an update hint, nor mark an
  // entry "installed" against a junk version.
  //
  // The accepted shape matches what actually gets INSTALLED, not what the
  // catalog accepts. sdk-widgets.js normalizeManifest allows [0-9A-Za-z._-], so
  // 'v1.2.3' and '2.0.0-beta' are real installed versions; a numeric-dotted-only
  // test parsed them as null, which left a prerelease package stuck on its beta
  // forever, silently. So: the numeric core plus an optional -prerelease / +build,
  // and null for genuine junk.
  function verParse(v) {
    const m = /^v?([0-9]+(?:\.[0-9]+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v == null ? '' : v).trim());
    return m ? { core: m[1].split('.').map(Number), pre: m[2] || '' } : null;
  }

  function verLess(a, b) {
    const pa = verParse(a);
    const pb = verParse(b);
    if (!pa || !pb) return false;
    for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
      if ((pa.core[i] || 0) !== (pb.core[i] || 0)) return (pa.core[i] || 0) < (pb.core[i] || 0);
    }
    // Same numeric core: a prerelease precedes its release (2.0.0-beta < 2.0.0),
    // which lets a beta tester land on the stable build. Two prereleases of the
    // same core fall back to a plain string compare (beta.1 < beta.2): not full
    // semver precedence, just a stable ordering that never regresses.
    if (!pa.pre !== !pb.pre) return !!pa.pre;
    return pa.pre < pb.pre;
  }

  // What this machine has installed, joined two ways: SDK packages by pkgId,
  // everything else by its install receipt.
  //
  // packages: the /sdk/widgets list. catalogVersion is what the CATALOG called the
  // install, version what the package's own manifest says; they are set by
  // different people and routinely differ ('0.1.2' vs '0.1.2-sdk3e'), and comparing
  // a catalog number with a manifest number made an update that could never be
  // applied. The catalog stamp wins when there is one (installedPkgVersion).
  //
  // installs: hubSettings.contentInstalls. Receipts are appended in order, so a
  // forward walk keeps the newest version per entry: an update re-import wins and
  // clears the badge. A receipt with NO version still counts as installed: most
  // non-widget kinds (themes, backgrounds, pages, decks) publish none, and the
  // settings normalizer omits an empty sourceVersion altogether.
  //
  // Numbered limited copies install under their COPY id ('vanguard-50-01') while
  // the catalog publishes one entry per edition ('vanguard-50'), so the base id is
  // indexed too; it is consulted ONLY for entries that are limited drops, so a
  // plain entry can never be joined by accident.
  function buildIndex(packages, installs) {
    const pkg = new Map();
    for (const p of Array.isArray(packages) ? packages : []) {
      if (!p || typeof p.id !== 'string' || !p.id) continue;
      pkg.set(p.id, {
        manifest: String(p.version || '0.0.0'),
        catalog: typeof p.catalogVersion === 'string' ? p.catalogVersion : '',
      });
    }
    const receipts = new Map();
    const dropReceipts = new Map();
    const dropCopyIds = new Map();   // 'vanguard-50' -> 'vanguard-50-01': what the hub calls the copy
    for (const rec of Array.isArray(installs) ? installs : []) {
      if (!rec || typeof rec.sourceId !== 'string' || !rec.sourceId) continue;
      const sv = typeof rec.sourceVersion === 'string' ? rec.sourceVersion : '';
      receipts.set(rec.sourceId, sv);
      const m = /^(.+)-(\d{1,4})$/.exec(rec.sourceId);
      if (m) { dropReceipts.set(m[1], sv); dropCopyIds.set(m[1], rec.sourceId); }
    }
    return { pkg, receipts, dropReceipts, dropCopyIds };
  }

  // The version to compare an installed PACKAGE with the catalog: the catalog
  // stamp when present, the only one written in the same numbering as entry.version.
  function installedPkgVersion(rec) {
    if (!rec) return null;
    return rec.catalog || rec.manifest || null;
  }

  // The catalog entries this PC owns at an older version than the catalog lists.
  // An entry with no version is never an update.
  function findUpdates(entries, index) {
    if (!index || (!index.pkg.size && !index.receipts.size)) return [];
    return (Array.isArray(entries) ? entries : []).filter((e) => {
      if (!e || !e.version) return false;
      if (e.pkgId) return index.pkg.has(e.pkgId) && verLess(installedPkgVersion(index.pkg.get(e.pkgId)), e.version);
      const have = index.receipts.has(e.id) ? index.receipts.get(e.id)
        : (e.limited && index.dropReceipts.has(e.id)) ? index.dropReceipts.get(e.id) : null;
      return have != null && verLess(have, e.version);
    });
  }

  return Object.freeze({ verParse, verLess, buildIndex, installedPkgVersion, findUpdates });
});

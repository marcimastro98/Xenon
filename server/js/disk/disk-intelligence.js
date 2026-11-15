'use strict';

// Pure, shared reasoning for the Disk widget and Xenon AI. This module never
// decides what may be deleted: disk-categories.js owns the closed allowlist and
// disk-guard.js owns the final veto. It only turns already-classified,
// read-only numbers into an honest priority plan the UI can explain.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.DiskIntelligence = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const GIB = 1024 ** 3;

  const CATEGORY_RULES = Object.freeze({
    temp: Object.freeze({
      risk: 'safe', priority: 94, kind: 'temporary',
      why: 'Short-lived files left by Windows and applications.',
      effect: 'Applications may recreate a small part of them when used again.',
      action: 'Close active applications, review the list, then move the selected items to the Recycle Bin.',
    }),
    browserCache: Object.freeze({
      risk: 'safe', priority: 88, kind: 'browser_cache',
      why: 'Disposable web resources stored to make previously visited pages load faster.',
      effect: 'The first visit to some sites can be slower while the cache is rebuilt.',
      action: 'Close the affected browsers for the cleanest result, then recycle the selected cache folders.',
    }),
    pkgCache: Object.freeze({
      risk: 'safe', priority: 84, kind: 'developer_cache',
      why: 'Download caches kept by package managers such as npm, pip, NuGet and Gradle.',
      effect: 'Future installs may download packages again; project source files are not included.',
      action: 'Review which ecosystem owns each cache, then recycle the ones you no longer need locally.',
    }),
    buildOutput: Object.freeze({
      risk: 'review', priority: 78, kind: 'build_output',
      why: 'Generated dependencies and build artefacts inside project roots you explicitly trusted.',
      effect: 'The next build or install can take longer while the output is recreated.',
      action: 'Keep outputs for active offline work; recycle stale project outputs after checking the project name.',
    }),
    installers: Object.freeze({
      risk: 'review', priority: 62, kind: 'installer',
      why: 'Old installer packages in Downloads, beyond the age threshold you configured.',
      effect: 'You may need to download the installer again to repair or reinstall that application.',
      action: 'Keep rare drivers and licensed installers; recycle only packages you can obtain again.',
    }),
    recycleBin: Object.freeze({
      risk: 'permanent', priority: 54, kind: 'recycle_bin',
      why: 'Files already removed from their original locations and retained as an undo.',
      effect: 'Emptying the Recycle Bin is permanent and removes that recovery path.',
      action: 'Open or review the Recycle Bin first when the contents may still matter.',
    }),
  });

  function num(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  }

  function categoryEntries(categories) {
    const out = [];
    for (const [id, raw] of Object.entries(categories || {})) {
      const rule = CATEGORY_RULES[id];
      const bytes = num(raw && raw.bytes);
      const count = Math.max(0, Math.floor(num(raw && raw.count)));
      if (!rule || (!bytes && !count)) continue;
      out.push({ id, bytes, count, ...rule });
    }
    return out.sort((a, b) => (b.priority + Math.log2(1 + b.bytes / GIB) * 3) -
      (a.priority + Math.log2(1 + a.bytes / GIB) * 3));
  }

  function analyze(snapshot) {
    const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const volume = s.volume && typeof s.volume === 'object' ? s.volume : {};
    const capacity = num(volume.capacity || volume.total);
    const free = Math.min(capacity || Infinity, num(volume.free));
    const used = capacity ? Math.max(0, capacity - free) : num(volume.used);
    const indexed = num(s.total);
    const freePercent = capacity ? (free / capacity) * 100 : null;
    const usedPercent = capacity ? (used / capacity) * 100 : null;
    const coveragePercent = used ? Math.min(100, (indexed / used) * 100) : null;
    const categories = categoryEntries(s.categories);
    const safeBytes = categories.filter((c) => c.risk === 'safe').reduce((a, c) => a + c.bytes, 0);
    const reviewBytes = categories.filter((c) => c.risk === 'review').reduce((a, c) => a + c.bytes, 0);
    const permanentBytes = categories.filter((c) => c.risk === 'permanent').reduce((a, c) => a + c.bytes, 0);
    const duplicateBytes = (Array.isArray(s.dupes) ? s.dupes : []).reduce((a, g) => a + num(g && g.wasted), 0);
    const unaccountedBytes = Math.max(0, used - indexed);

    let state = 'unknown';
    let pressure = 0;
    if (freePercent != null) {
      if (freePercent < 5) { state = 'critical'; pressure = 100; }
      else if (freePercent < 10) { state = 'low'; pressure = 84; }
      else if (freePercent < 20) { state = 'watch'; pressure = 58; }
      else { state = 'healthy'; pressure = 24; }
    }

    const recommendations = categories.map((c) => ({
      type: 'category',
      category: c.id,
      bytes: c.bytes,
      count: c.count,
      risk: c.risk,
      priority: c.priority + (state === 'critical' ? 8 : state === 'low' ? 4 : 0),
      why: c.why,
      effect: c.effect,
      action: c.action,
    }));

    if (duplicateBytes > 0) {
      recommendations.push({
        type: 'duplicates', bytes: duplicateBytes, risk: 'review', priority: 72,
        why: 'These groups were verified byte for byte with a full content hash.',
        effect: 'Only extra copies are potential waste; one intentional original must always remain.',
        action: 'Compare the locations and keep the copy used by the application or project. Xenon never auto-deletes duplicates.',
      });
    }

    const top = Array.isArray(s.tree) ? s.tree.filter((d) => d && num(d.s) > 0) : [];
    const topFolder = top.find((d) => {
      const p = String(d.p || '').replace(/[\\/]+$/, '');
      const rootPath = String(s.root || '').replace(/[\\/]+$/, '');
      return p && p.toLowerCase() !== rootPath.toLowerCase();
    });
    if (topFolder && indexed && num(topFolder.s) / indexed >= 0.18) {
      recommendations.push({
        type: 'large_folder', bytes: num(topFolder.s), path: String(topFolder.p || ''),
        risk: 'manual', priority: 66,
        why: 'One folder accounts for a large share of the indexed space.',
        effect: 'Its contents are not classified as disposable, so deleting it blindly could remove valuable data or an installed application.',
        action: 'Open the location and remove content through its owning app or game launcher when possible.',
      });
    }

    if (capacity && unaccountedBytes > Math.max(5 * GIB, used * 0.1)) {
      recommendations.push({
        type: 'unaccounted', bytes: unaccountedBytes, risk: 'info', priority: 42,
        why: 'The volume reports more used space than the metadata index can attribute.',
        effect: 'The difference can include protected files, filesystem metadata, reserved storage, hard links or inaccessible folders.',
        action: 'Treat it as diagnostic information, not automatically cleanable space.',
      });
    }

    recommendations.sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.bytes || 0) - (a.bytes || 0));
    return {
      state,
      pressure,
      capacity,
      free,
      used,
      freePercent,
      usedPercent,
      indexedBytes: indexed,
      coveragePercent,
      unaccountedBytes,
      safeBytes,
      reviewBytes,
      permanentBytes,
      duplicateBytes,
      opportunityBytes: safeBytes + reviewBytes + permanentBytes + duplicateBytes,
      categories,
      recommendations,
    };
  }

  return { analyze, CATEGORY_RULES };
});

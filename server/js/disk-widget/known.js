// What the disk tile knows about the chosen drive while the page runs, how it asks the server, and
// the sums it does on what came back: the parts of the capacity bar, the children of a folder, what
// is ticked for cleaning.
'use strict';

(() => {
  const { tr, sepOf, pathParent } = window.DiskWidgetWording;

  const diskState = {
    pollTimer: null,
    status: null,
    selRoot: null,
    overview: null,
    overviewError: '',
    loadingOverview: false,
    loadingSlow: false,
    loadingSlowTimer: null,
    overviewRequest: 0,
    loadingRoot: null,   // the root the in-flight overview request is for
    // The drive whose persisted snapshot was already asked for while its index
    // rebuilds, so the poll does not ask again every 1.8 s.
    staleAskedFor: null,
    overviewAbort: null,
    activeView: undefined, // given its first value further down, where it was declared
    treeRoot: null,
    treeStack: [],
    treeLoading: false,
    treeError: '',
    treeRequest: 0,
    // The "Altre N voci" panel opened from the grouped treemap tile.
    treeOtherOpen: false,
    treeOtherItems: null,
    treeOtherBytes: 0,
    treeOtherResidual: 0,
    // The root level's own browse() result — same complete source as a drill-down
    // (direct files like pagefile.sys/hiberfil.sys included, real unlisted bytes),
    // instead of the size-capped overview.tree which dropped system files into a
    // bogus "50 GB not listed" chunk.
    rootBrowse: null,
    confirmCat: null,
    selectedIds: new Set(),
    cleaning: false,
    cleanState: null,
    addingRoot: false,
    pendingRootPath: '',
    lastReport: null,
    advisorModal: null,
    advisorAiRequest: 0,
  };

  async function api(url, body, options) {
    const opts = options || {};
    const controller = opts.controller || null;
    let timer = null;
    if (controller && opts.timeout) timer = setTimeout(() => controller.abort(), opts.timeout);
    try {
      const response = await fetch(url, body ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      } : { signal: controller ? controller.signal : undefined });
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) return { ok: false, error: 'http_' + response.status };
      return data || { ok: false, error: 'empty_response' };
    } catch (error) {
      if (error && error.name === 'AbortError') return { ok: false, error: 'timeout' };
      return { ok: false, error: 'offline' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function analysis() {
    if (!diskState.overview || !window.DiskIntelligence) return null;
    return window.DiskIntelligence.analyze(diskState.overview);
  }

  // What the drive holds, by kind, on one bar: the kinds the index measured,
  // then the used space it cannot attribute (system files, folders outside the
  // index), then free space as the empty track. A bar rather than a ring
  // because it carries several parts at once and reads at a glance on a wide,
  // short tile, which is what the Xeneon Edge is.
  const KIND_ORDER = ['video', 'image', 'audio', 'document', 'archive', 'app', 'game', 'other'];

  // A kind under this share of the drive folds into "other": a sliver no one
  // can see or tap is noise in the bar and a line of nothing in the legend.
  const KIND_MIN_SHARE = 0.005;

  function capacityParts(a) {
    if (!a || !a.capacity) return null;
    const cap = a.capacity;
    const kinds = diskState.overview.kinds || null;
    const parts = [];
    let listed = 0;
    let folded = 0;
    if (kinds) {
      for (const k of KIND_ORDER) {
        const b = Number(kinds[k]) || 0;
        if (b <= 0) continue;
        listed += b;
        if (k !== 'other' && b / cap < KIND_MIN_SHARE) { folded += b; continue; }
        if (k === 'other') { folded += b; continue; }
        parts.push({ id: k, bytes: b });
      }
      if (folded > 0) parts.push({ id: 'other', bytes: folded });
    } else if (diskState.overview.total > 0) {
      listed = diskState.overview.total;
      parts.push({ id: 'other', bytes: listed });
    }
    const unlisted = Math.max(0, a.used - listed);
    if (unlisted / cap >= KIND_MIN_SHARE) parts.push({ id: 'unlisted', bytes: unlisted });
    return { cap, parts };
  }

  // Up to three plain sentences, in the order they help: space you can free
  // now, what grew, when the drive fills up, then what only you can judge. Each
  // is something measured on this drive; a row with no data is left out,
  // never filled with a "learning…" placeholder.
  function treeRefFor(p) {
    const key = String(p || '').toLowerCase();
    return (diskState.overview.tree || []).find((d) => String(d.p || '').toLowerCase() === key) || null;
  }

  function childrenOf(rootPath) {
    const tree = diskState.overview && Array.isArray(diskState.overview.tree) ? diskState.overview.tree : [];
    const rootLower = String(rootPath || '').toLowerCase().replace(/\\+$/, '');
    const kids = [];
    let rootEntry = null;
    for (const dir of tree) {
      const raw = String(dir.p || '');
      const p = (sepOf(raw) === '/' && raw !== '/' ? raw.replace(/\/+$/, '') : raw.replace(/\\+$/, '')).toLowerCase();
      if (p === rootLower) { rootEntry = dir; continue; }
      if (pathParent(p) === rootLower) kids.push(dir);
    }
    kids.sort((a, b) => b.s - a.s);
    const directFiles = (diskState.overview && Array.isArray(diskState.overview.topFiles) ? diskState.overview.topFiles : [])
      .filter((file) => pathParent(String(file.p || '').toLowerCase()) === rootLower)
      .map((file) => ({ ...file, file: true }));
    const covered = kids.reduce((sum, dir) => sum + (dir.s || 0), 0) +
      directFiles.reduce((sum, file) => sum + (file.s || 0), 0);
    const total = rootEntry ? rootEntry.s : (diskState.treeRoot === diskState.overview.root.replace(/\\+$/, '') ? diskState.overview.total : covered);
    const items = [...kids, ...directFiles].sort((a, b) => (b.s || 0) - (a.s || 0)).slice(0, 27);
    const shown = items.reduce((sum, item) => sum + (item.s || 0), 0);
    if (total > shown) {
      items.push({
        p: rootPath + '\\…',
        s: total - shown,
        other: true,
        label: tr('disk_map_other', 'Altri file e cartelle'),
      });
    }
    return {
      kids: items,
      total: Math.max(total || covered, 1),
      directBytes: directFiles.reduce((sum, file) => sum + (file.s || 0), 0),
    };
  }

  function categoryItems(cat) {
    const category = diskState.overview && diskState.overview.categories ? diskState.overview.categories[cat] : null;
    return category && Array.isArray(category.items) ? category.items : [];
  }

  function selectedSummary(cat) {
    const items = categoryItems(cat);
    let bytes = 0;
    let count = 0;
    for (const item of items) {
      if (!diskState.selectedIds.has(item.i)) continue;
      bytes += Number(item.s) || 0;
      count++;
    }
    return { bytes, count };
  }

  async function cancelClean() {
    if (!diskState.cleaning || !diskState.cleanState || diskState.cleanState.permanent) return;
    await api('/disk/clean/cancel', {});
    // The SSE 'done' event delivers the final report; nothing else to do here.
  }

  function stopPolling() {
    if (diskState.pollTimer) clearInterval(diskState.pollTimer);
    diskState.pollTimer = null;
  }

  window.DiskWidgetKnown = {
    diskState, api, analysis, capacityParts, treeRefFor, childrenOf, categoryItems, selectedSummary,
    cancelClean, stopPolling,
  };
})();

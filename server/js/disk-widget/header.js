// The top of the disk tile: the drives it knows and the ones it could add, the title with what the
// index is doing, and the tabs.
'use strict';

window.DiskWidgetHeader = (wrapper) => {
  const { closeAdvisorModal, overviewCache, loadOverview, addRoot, renderAll } = wrapper;

  const { tr, fmtNumber } = window.DiskWidgetWording;
  const { diskState } = window.DiskWidgetKnown;
  const { VIEW_META, rootKeyOf, drivePresentation } = window.DiskWidgetPresentation;
  const { el, btn, withTransition, appendRootCopy } = window.DiskWidgetPieces;

  // ── Root and header ──────────────────────────────────────────────────────

  function renderRoots() {
    const row = el('div', 'diskw-roots');
    const roots = diskState.status && Array.isArray(diskState.status.roots) ? diskState.status.roots : [];
    for (const root of roots) {
      const info = drivePresentation(root);
      const chip = btn('diskw-root' + (diskState.selRoot === root.i ? ' is-active' : ''), '', async () => {
        closeAdvisorModal();
        diskState.selRoot = root.i;
        diskState.overview = overviewCache.get(root.i) || null;
        // The previous drive's root listing must not be drawn under this one.
        diskState.rootBrowse = null;
        diskState.overviewError = '';
        diskState.treeRoot = null;
        diskState.treeStack = [];
        diskState.treeError = '';
        diskState.confirmCat = null;
        diskState.activeView = 'overview';
        // Not forced: switching drive should reuse the server's snapshot when
        // it has one. Only ↻ and the reload after a cleanup ask for a rebuild.
        await loadOverview(false);
      }, info.title);
      appendRootCopy(chip, info);
      chip.setAttribute('aria-pressed', diskState.selRoot === root.i ? 'true' : 'false');
      chip.disabled = diskState.cleaning;
      row.appendChild(chip);
    }
    if (typeof window.addSearchIndexRoot === 'function' || typeof window.updateSearchSettings === 'function') {
      // The root a chip would add. The server names it (`path`), because only
      // it knows what a volume is called on this machine: a drive letter on
      // Windows, a mount point everywhere else. Rebuilding it here from a
      // letter is what limited this row to Windows.
      const rootKey = rootKeyOf;
      // Suppressed when a configured root already sits ON that volume, not only
      // when it IS that volume. That is what the old letter comparison meant on
      // Windows (indexing C:\Users hid the "add C:" chip) and it carries over
      // unchanged; expressing it as a path also makes it true for a mount point.
      const covered = (addPath) => {
        const key = rootKey(addPath);
        if (!key) return true;
        return roots.some((r) => {
          // The server already annotated each root with the volume it sits on
          // (the longest mount prefix). That is the only reliable way to know a
          // root is on the "/" volume: "/" is a prefix of every absolute path,
          // so the path test below would either match everything or nothing.
          if (rootKey(r.drive) === key) return true;
          const rk = rootKey(r.path);
          return rk === key || rk.startsWith(key + '\\') || rk.startsWith(key + '/');
        });
      };
      const driveDetails = diskState.status && Array.isArray(diskState.status.driveDetails)
        ? diskState.status.driveDetails
        : (diskState.status && Array.isArray(diskState.status.drives) ? diskState.status.drives : []).map((letter) => ({ letter }));
      for (const driveDetail of driveDetails) {
        const letter = String(driveDetail.letter || driveDetail.drive || '').slice(0, 1).toUpperCase();
        const addPath = String(driveDetail.path || '') || (/^[A-Z]$/.test(letter) ? letter + ':\\' : '');
        if (!addPath) continue;
        if (covered(addPath)) continue;
        const info = drivePresentation({ ...driveDetail, path: addPath });
        const chip = btn('diskw-root diskw-root-add', '', () => addRoot(addPath),
          tr('disk_add_drive', 'Aggiungi all’indice') + ' · ' + info.title);
        appendRootCopy(chip, info, '+ ');
        chip.disabled = diskState.cleaning || diskState.addingRoot;
        row.appendChild(chip);
      }
    }
    return row;
  }

  function renderHeader() {
    const head = el('div', 'diskw-head');
    const title = el('div', 'diskw-title-block');
    title.appendChild(el('div', 'diskw-title', tr('disk_title', 'Spazio intelligente')));
    const idx = diskState.status && diskState.status.index || {};
    // One plain line: what is watched and what that costs in memory. The RAM
    // figure used to be a capsule badge; it is a fact about the index, not an
    // alert, so it reads as text (the tooltip says it is not disk space).
    let subtitle = idx.building
      ? tr('disk_index_building', 'Sto imparando il disco…') + ' ' + fmtNumber((idx.progress && idx.progress.files) || idx.files) + ' file'
      : fmtNumber(idx.files) + ' ' + tr('disk_index_monitored', 'file monitorati localmente');
    if (!idx.building && idx.ramMB) subtitle += ' · ' + tr('disk_index_ram_line', '{n} MB di RAM per l’indice').replace('{n}', String(idx.ramMB));
    if (diskState.loadingOverview && diskState.overview) subtitle = tr('disk_updating', 'Aggiorno l’analisi…');
    const sub = el('div', 'diskw-subtitle' + (diskState.loadingOverview && diskState.overview ? ' is-updating' : ''), subtitle);
    if (!idx.building) sub.title = tr('disk_index_ram_tip', 'Memoria usata per tenere ricercabili i file. Non è spazio occupato sul disco.');
    title.appendChild(sub);
    head.appendChild(title);

    const actions = el('div', 'diskw-head-actions');
    const refreshBtn = btn('diskw-icon-btn', '↻', () => loadOverview(true), tr('disk_refresh', 'Aggiorna analisi'));
    refreshBtn.disabled = diskState.cleaning || diskState.loadingOverview || diskState.selRoot == null;
    actions.appendChild(refreshBtn);
    head.appendChild(actions);
    return head;
  }

  function renderTabs() {
    const nav = el('div', 'diskw-tabs');
    nav.setAttribute('role', 'tablist');
    for (const [id, key, fallback] of VIEW_META) {
      const tab = btn('diskw-tab' + (diskState.activeView === id ? ' is-active' : ''), tr(key, fallback), () => {
        withTransition(() => {
          diskState.activeView = id;
          if (window.TileTabMemory) TileTabMemory.set('disk', id);
          diskState.confirmCat = null;
          renderAll();
        });
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', diskState.activeView === id ? 'true' : 'false');
      tab.disabled = diskState.cleaning;
      nav.appendChild(tab);
    }
    return nav;
  }

  return { renderRoots, renderHeader, renderTabs };
};

// The map of the space in the disk tile: the tiles sized by what they hold, the list of the small
// ones, and the path of the level shown.
'use strict';

window.DiskWidgetSpaceMap = (wrapper) => {
  const { openOtherList, closeOtherList, openTreeNode, revealItem, canReveal, goToLevel } = wrapper;

  const { squarify } = window.DiskWidgetTreemap;
  const { tr, fmtSize, fmtNumber, pathLeaf, friendlyError, joinUnder } = window.DiskWidgetWording;
  const { diskState, childrenOf } = window.DiskWidgetKnown;
  const { TREEMAP_MIN_SHARE, splitTreemapEntries } = window.DiskWidgetPresentation;
  const { el, btn } = window.DiskWidgetPieces;

  function renderTreemap() {
    const section = el('section', 'diskw-section diskw-map-section');
    const head = el('div', 'diskw-section-head');
    const title = el('div');
    title.appendChild(el('h3', '', tr('disk_space_map', 'Mappa dello spazio')));
    // At the root, prefer the root's own browse (complete: system files + real
    // unlisted bytes) over overview.tree; fall back to the tree until it lands.
    const currentBrowse = diskState.treeStack.length
      ? diskState.treeStack[diskState.treeStack.length - 1]
      : (diskState.rootBrowse && diskState.rootBrowse.ok ? diskState.rootBrowse : null);
    const currentPath = currentBrowse ? currentBrowse.path : (diskState.treeRoot || diskState.overview.root);
    head.appendChild(title);
    const base = diskState.overview.root.replace(/\\+$/, '');
    section.appendChild(head);
    section.appendChild(renderCrumbs(base, currentPath));

    if (diskState.treeLoading) {
      const loading = el('div', 'diskw-map-loading');
      loading.appendChild(XenonLoader.create({ size: 'sm' }));
      loading.appendChild(el('span', '', tr('disk_map_opening', 'Leggo file e sottocartelle…')));
      section.appendChild(loading);
      return section;
    }
    if (diskState.treeError) {
      const error = el('div', 'diskw-map-error');
      error.appendChild(el('strong', '', tr('disk_map_error', 'Non sono riuscito ad aprire questo livello.')));
      error.appendChild(el('span', '', friendlyError(diskState.treeError)));
      section.appendChild(error);
      return section;
    }

    let kids;
    let total;
    let directBytes = 0;
    if (currentBrowse) {
      const children = Array.isArray(currentBrowse.children) ? currentBrowse.children : [];
      const directFiles = (Array.isArray(currentBrowse.directFiles) ? currentBrowse.directFiles : [])
        .map((file) => ({ ...file, file: true }));
      kids = [...children, ...directFiles].sort((a, b) => (b.s || 0) - (a.s || 0)).slice(0, 27);
      if (currentBrowse.otherBytes > 0) {
        kids.push({
          p: currentPath + '\\…',
          s: currentBrowse.otherBytes,
          other: true,
          label: tr('disk_map_other', 'Altri file e cartelle'),
        });
      }
      total = Math.max(Number(currentBrowse.total) || 0, 1);
      directBytes = Number(currentBrowse.directBytes) || 0;
    } else {
      ({ kids, total, directBytes } = childrenOf(currentPath || base));
    }
    if (!kids.length) {
      section.appendChild(el('div', 'diskw-empty', tr('disk_tree_empty', 'Questa cartella non contiene file indicizzati.')));
      return section;
    }
    // Keep only touch-sized tiles; fold small folders into one grouped tile and
    // give unlisted bytes their own honest tile.
    const { tiles, grouped, groupedBytes, residual, totalBytes } = splitTreemapEntries(kids);
    const floor = totalBytes / 2000;
    const cellInput = tiles.map((ref) => ({ area: Math.max(ref.s || 0, floor), ref }));
    // The grouped small entries: one tappable tile that opens their list.
    if (grouped.length > 0) {
      cellInput.push({
        area: Math.max(groupedBytes, floor),
        ref: { grouped: true, s: groupedBytes, count: grouped.length, items: grouped, residual },
      });
    }
    // Unlisted / unattributed bytes, only when worth a tile of their own.
    const showResidualTile = residual > 0 && residual >= totalBytes * TREEMAP_MIN_SHARE;
    if (showResidualTile) {
      cellInput.push({ area: residual, ref: { residualTile: true, s: residual } });
    } else if (residual > 0 && grouped.length > 0) {
      // Too small to stand alone: hand it to the grouped tile's list.
      cellInput[cellInput.length - 1].ref.residual = residual;
    }
    const cells = [];
    squarify(cellInput, 0, 0, 100, 100, cells);
    const map = el('div', 'diskw-treemap');
    cells.forEach((cell, index) => {
      const ref = cell.item.ref;
      let node;
      if (ref.grouped) {
        node = btn('diskw-cell diskw-cell-other diskw-cell-grouped',
          '', () => openOtherList(ref.items, ref.s + (ref.residual || 0), ref.residual || 0),
          tr('disk_map_other_open', 'Mostra le voci più piccole'));
      } else if (ref.residualTile) {
        node = el('div', 'diskw-cell diskw-cell-other diskw-cell-residual');
        node.title = tr('disk_map_residual_tip', 'Spazio non attribuito a una sottocartella: file di sistema o cartelle non indicizzate.');
      } else if (ref.file) {
        // A file cannot be opened into, but it can be shown where it lives.
        node = ref.id && canReveal()
          ? btn('diskw-cell diskw-cell-file is-revealable', '', () => revealItem(ref.id),
            tr('disk_reveal', 'Mostra nella cartella') + ' · ' + (ref.n || pathLeaf(ref.p)))
          : el('div', 'diskw-cell diskw-cell-file');
      } else {
        node = btn('diskw-cell', '', () => openTreeNode(ref), ref.p);
      }
      node.style.setProperty('--x', cell.x + '%');
      node.style.setProperty('--y', cell.y + '%');
      node.style.setProperty('--w', cell.w + '%');
      node.style.setProperty('--h', cell.h + '%');
      node.style.setProperty('--cell-i', String(index % 8));
      // Label layout adapts to the cell's height so the text is never clipped:
      // tall cells stack name+value, short-but-wide cells put them on one row,
      // and anything smaller shows nothing (the title tooltip still names it).
      const twoLine = cell.w > 13 && cell.h > 15;
      const oneLine = !twoLine && cell.w > 22 && cell.h > 7;
      if (twoLine || oneLine) {
        node.classList.add(oneLine ? 'is-flat' : 'is-stacked');
        const label = ref.grouped
          ? tr('disk_map_other_n', 'Altre {n} voci').replace('{n}', fmtNumber(ref.count))
          : ref.residualTile
            ? tr('disk_map_residual_label', 'Non attribuito')
            : (ref.file ? (ref.n || pathLeaf(ref.p)) : pathLeaf(ref.p));
        node.appendChild(el('span', 'diskw-cell-name', label));
        node.appendChild(el('span', 'diskw-cell-value', fmtSize(ref.s)));
      }
      map.appendChild(node);
    });
    if (diskState.treeOtherOpen && diskState.treeOtherItems) map.appendChild(renderOtherList());
    section.appendChild(map);
    if (!diskState.treeOtherOpen && directBytes > 0) {
      section.appendChild(el('p', 'diskw-map-note',
        fmtSize(directBytes) + ' ' +
        tr('disk_map_direct_files', 'sono file salvati direttamente in questa cartella, non sottocartelle.')));
    }
    return section;
  }

  // The list the grouped tile opens: every small folder/file the map folded
  // away, tappable to drill in, over a light backdrop inside the map area.
  function renderOtherList() {
    const overlay = el('div', 'diskw-otherlist');
    const panel = el('div', 'diskw-otherlist-panel');
    const head = el('div', 'diskw-otherlist-head');
    const titles = el('div');
    titles.appendChild(el('strong', '',
      tr('disk_map_other_n', 'Altre {n} voci').replace('{n}', fmtNumber((diskState.treeOtherItems || []).length + (diskState.treeOtherResidual > 0 ? 1 : 0)))));
    titles.appendChild(el('span', 'diskw-otherlist-sub', fmtSize(diskState.treeOtherBytes)));
    head.appendChild(titles);
    head.appendChild(btn('diskw-modal-close', '×', closeOtherList, tr('disk_close', 'Chiudi')));
    panel.appendChild(head);

    const list = el('div', 'diskw-otherlist-rows');
    for (const ref of diskState.treeOtherItems || []) {
      const isFolder = !ref.file;
      const row = isFolder
        ? btn('diskw-otherlist-row', '', () => { closeOtherList(); openTreeNode(ref); }, ref.p || '')
        : el('div', 'diskw-otherlist-row is-file');
      const icon = el('span', 'diskw-otherlist-icon', isFolder ? '▰' : '▤');
      row.appendChild(icon);
      const name = el('span', 'diskw-otherlist-name', ref.file ? (ref.n || pathLeaf(ref.p)) : pathLeaf(ref.p));
      row.appendChild(name);
      row.appendChild(el('span', 'diskw-otherlist-size', fmtSize(ref.s)));
      if (isFolder) row.appendChild(el('span', 'diskw-otherlist-arrow', '›'));
      list.appendChild(row);
    }
    if (diskState.treeOtherResidual > 0) {
      const row = el('div', 'diskw-otherlist-row is-file');
      row.appendChild(el('span', 'diskw-otherlist-icon', '…'));
      row.appendChild(el('span', 'diskw-otherlist-name', tr('disk_map_residual', 'Spazio non ancora elencato')));
      row.appendChild(el('span', 'diskw-otherlist-size', fmtSize(diskState.treeOtherResidual)));
      list.appendChild(row);
    }
    panel.appendChild(list);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closeOtherList(); });
    return overlay;
  }

  function renderCrumbs(base, currentPath) {
    const nav = el('nav', 'diskw-crumbs');
    nav.setAttribute('aria-label', tr('disk_crumbs', 'Percorso nella mappa'));
    const cur = String(currentPath || base).replace(/[\\/]+$/, '') || base;
    const rel = cur.length > base.length ? cur.slice(base.length) : '';
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    const levels = [{ label: pathLeaf(base) || base, path: base }];
    parts.forEach((p, i) => levels.push({ label: p, path: joinUnder(base, parts.slice(0, i + 1)) }));
    levels.forEach((lvl, i) => {
      if (i > 0) nav.appendChild(el('span', 'diskw-crumb-sep', '›'));
      if (i === levels.length - 1) {
        const here = el('span', 'diskw-crumb is-current', lvl.label);
        here.setAttribute('aria-current', 'location');
        nav.appendChild(here);
      } else {
        nav.appendChild(btn('diskw-crumb', lvl.label, () => goToLevel(lvl.path, base), lvl.path));
      }
    });
    return nav;
  }

  return { renderTreemap };
};

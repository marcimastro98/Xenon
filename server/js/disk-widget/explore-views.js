// The Explore and Duplicates tabs of the disk tile: the largest folders and files, the ones nobody
// touched in a year, and the identical copies.
'use strict';

window.DiskWidgetExploreViews = (wrapper) => {
  const { ltrPath, canReveal, revealBtn, copyPath } = wrapper;

  const { tr, fmtSize, pathLeaf } = window.DiskWidgetWording;
  const { diskState } = window.DiskWidgetKnown;
  const { el, btn } = window.DiskWidgetPieces;

  // ── Explore and duplicates ───────────────────────────────────────────────

  function renderPathRow(item, kind) {
    const row = el('div', 'diskw-path-row');
    const icon = el('span', 'diskw-path-icon', kind === 'folder' ? '▰' : '▤');
    row.appendChild(icon);
    const copy = el('div', 'diskw-path-copy');
    const path = String(item.p || '');
    copy.appendChild(el('strong', '', kind === 'folder' ? pathLeaf(path) : item.n || pathLeaf(path)));
    copy.appendChild(el('span', '', ltrPath(path)));
    row.appendChild(copy);
    row.appendChild(el('b', 'diskw-path-size', fmtSize(item.s)));
    if (item.id && canReveal()) row.appendChild(revealBtn(item.id));
    row.appendChild(btn('diskw-copy-btn', '⧉', () => copyPath(path), tr('disk_copy_path', 'Copia percorso')));
    return row;
  }

  function renderExplore() {
    const wrap = el('div', 'diskw-view diskw-explore');
    const folders = el('section', 'diskw-section');
    folders.appendChild(el('h3', '', tr('disk_top_folders', 'Cartelle più grandi')));
    const base = diskState.overview.root.replace(/\\+$/, '').toLowerCase();
    const topFolders = (diskState.overview.tree || []).filter((dir) =>
      String(dir.p || '').replace(/\\+$/, '').toLowerCase() !== base).slice(0, 14);
    for (const dir of topFolders) folders.appendChild(renderPathRow(dir, 'folder'));
    if (!topFolders.length) folders.appendChild(el('div', 'diskw-empty', tr('disk_tree_empty', 'Nessuna sottocartella rilevante qui')));
    wrap.appendChild(folders);

    const files = el('section', 'diskw-section');
    files.appendChild(el('h3', '', tr('disk_top_files', 'File più grandi')));
    for (const file of (diskState.overview.topFiles || []).slice(0, 16)) files.appendChild(renderPathRow(file, 'file'));
    if (!(diskState.overview.topFiles || []).length) files.appendChild(el('div', 'diskw-empty', tr('disk_no_files', 'Nessun file disponibile.')));
    wrap.appendChild(files);

    // Large files nobody has written to in a year: the space most often worth
    // a second look, and the one no cleanup rule can judge. Absent (an older
    // helper) means not measured, so the section is left out rather than
    // claiming there are none.
    if (Array.isArray(diskState.overview.staleFiles)) {
      const stale = el('section', 'diskw-section');
      stale.appendChild(el('h3', '', tr('disk_stale_title', 'Grandi e non modificati da un anno')));
      for (const file of diskState.overview.staleFiles.slice(0, 16)) {
        const row = renderPathRow(file, 'file');
        const when = file.m ? new Date(file.m).toLocaleDateString() : '';
        if (when) row.querySelector('.diskw-path-copy > strong').title = tr('disk_modified_on', 'Modificato il {date}').replace('{date}', when);
        stale.appendChild(row);
      }
      if (!diskState.overview.staleFiles.length) stale.appendChild(el('div', 'diskw-empty', tr('disk_stale_empty', 'Nessun file oltre 500 MB fermo da più di un anno.')));
      wrap.appendChild(stale);
    }
    return wrap;
  }

  function renderDuplicates() {
    const wrap = el('div', 'diskw-view');
    const dupes = diskState.overview.dupes || [];
    const total = dupes.reduce((sum, group) => sum + (group.wasted || 0), 0);
    const intro = el('section', 'diskw-dupe-intro');
    intro.appendChild(el('span', 'diskw-clean-summary-kicker', tr('disk_hash_verified', 'SHA-256 verificato')));
    intro.appendChild(el('strong', '', fmtSize(total)));
    intro.appendChild(el('p', '', tr('disk_dupes_note', 'Identici byte per byte. Xenon non elimina automaticamente una copia perché solo tu sai quale posizione è quella giusta.')));
    wrap.appendChild(intro);
    if (diskState.overview.dupesPending) {
      wrap.appendChild(el('div', 'diskw-index-note', tr('disk_dupes_checking', 'Sto confrontando altri file in background. La lista si aggiorna da sola.')));
    }

    if (!dupes.length) {
      wrap.appendChild(el('div', 'diskw-empty diskw-empty-card', tr('disk_no_dupes', 'Nessun grande duplicato verificato in questa fotografia.')));
      return wrap;
    }
    const groups = el('div', 'diskw-dupe-list');
    dupes.forEach((group, index) => {
      const card = el('article', 'diskw-dupe-group');
      const head = el('div', 'diskw-dupe-head');
      head.appendChild(el('strong', '', tr('disk_copy_group', 'Gruppo') + ' ' + (index + 1)));
      head.appendChild(el('span', '', fmtSize(group.s) + ' × ' + group.paths.length + ' · ' + fmtSize(group.wasted) + ' ' + tr('disk_dupes_wasted', 'sprecati')));
      card.appendChild(head);
      for (const entry of group.paths) {
        // {p, id} from a live overview, a bare path from a saved snapshot.
        const path = typeof entry === 'string' ? entry : String(entry && entry.p || '');
        const row = el('div', 'diskw-dupe-path');
        row.appendChild(el('span', '', ltrPath(path)));
        if (entry && entry.id && canReveal()) row.appendChild(revealBtn(entry.id));
        row.appendChild(btn('diskw-copy-btn', '⧉', () => copyPath(path), tr('disk_copy_path', 'Copia percorso')));
        card.appendChild(row);
      }
      groups.appendChild(card);
    });
    wrap.appendChild(groups);
    return wrap;
  }

  return { renderExplore, renderDuplicates };
};

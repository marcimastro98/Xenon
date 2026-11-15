// The left side of the overview in the disk tile: how full the drive is and with what, and the few
// things worth knowing about it.
'use strict';

window.DiskWidgetCapacityAndAdvice = (wrapper) => {
  const { renderAll, openAdvisorModal, openTreeNode, ltrPath } = wrapper;

  const { tr, fmtSize, fmtNumber, pathLeaf } = window.DiskWidgetWording;
  const { diskState, capacityParts, treeRefFor } = window.DiskWidgetKnown;
  const { kindName } = window.DiskWidgetPresentation;
  const { el, btn, withTransition, actionRow } = window.DiskWidgetPieces;

  // ── Overview ─────────────────────────────────────────────────────────────


  function renderCapacity(a) {
    const hero = el('section', 'diskw-cap');
    hero.dataset.pressure = a ? a.state : 'unknown';
    const line = el('div', 'diskw-cap-line');
    line.appendChild(el('strong', 'diskw-cap-free', a && a.capacity
      ? fmtSize(a.free) + ' ' + tr('disk_free_of', 'liberi su') + ' ' + fmtSize(a.capacity)
      : fmtSize(diskState.overview.total) + ' ' + tr('disk_indexed', 'indicizzati')));
    if (a && a.usedPercent != null) {
      line.appendChild(el('span', 'diskw-cap-used',
        tr('disk_used_pct', '{n}% usato').replace('{n}', String(Math.round(a.usedPercent)))));
    }
    hero.appendChild(line);

    const split = capacityParts(a);
    if (!split) return hero;
    const bar = el('div', 'diskw-cap-bar');
    bar.setAttribute('role', 'img');
    const spoken = [];
    for (const part of split.parts) {
      const seg = el('span', 'diskw-seg');
      seg.dataset.kind = part.id;
      seg.style.setProperty('--grow', String(part.bytes));
      const label = kindName(part.id) + ' · ' + fmtSize(part.bytes);
      seg.title = part.id === 'unlisted'
        ? label + '. ' + tr('disk_map_residual_tip', 'Spazio non attribuito a una sottocartella: file di sistema o cartelle non indicizzate.')
        : label;
      spoken.push(label);
      bar.appendChild(seg);
    }
    const free = el('span', 'diskw-seg diskw-seg-free');
    free.style.setProperty('--grow', String(Math.max(0, a.free)));
    free.title = tr('disk_kind_free', 'Libero') + ' · ' + fmtSize(a.free);
    bar.appendChild(free);
    spoken.push(free.title);
    bar.setAttribute('aria-label', spoken.join(', '));
    hero.appendChild(bar);

    // The legend names every part; identity is never colour alone.
    const legend = el('div', 'diskw-cap-legend');
    for (const part of split.parts) {
      const item = el('span', 'diskw-legend-item');
      const sw = el('i', 'diskw-swatch');
      sw.dataset.kind = part.id;
      item.appendChild(sw);
      item.appendChild(el('span', 'diskw-legend-name', kindName(part.id)));
      item.appendChild(el('b', '', fmtSize(part.bytes)));
      legend.appendChild(item);
    }
    hero.appendChild(legend);
    return hero;
  }

  // ── What is worth doing ──────────────────────────────────────────────────
  function goView(view) {
    withTransition(() => { diskState.activeView = view; diskState.confirmCat = null; renderAll(); });
  }

  function renderActions(a) {
    const section = el('section', 'diskw-section diskw-acts');
    const head = el('div', 'diskw-section-head');
    head.appendChild(el('h3', '', tr('disk_acts_title', 'Da sapere')));
    const deep = btn('diskw-small-btn', tr('disk_open_analysis', 'Apri analisi'), openAdvisorModal);
    deep.disabled = !!diskState.overview.stale;
    head.appendChild(deep);
    section.appendChild(head);

    const rows = [];
    const ins = diskState.overview.insights || {};
    if (a && a.safeBytes > 0) {
      rows.push(actionRow(
        tr('disk_act_safe', 'Puoi liberare {size} subito').replace('{size}', fmtSize(a.safeBytes)),
        tr('disk_act_safe_sub', 'Cache e file temporanei. Li rivedi prima che vadano nel Cestino.'),
        () => goView('clean')));
    }
    const grown = ins.growth && Array.isArray(ins.growth.folders) ? ins.growth.folders[0] : null;
    if (grown) {
      const ref = treeRefFor(grown.p);
      rows.push(actionRow(
        tr('disk_act_growth', '{name} è cresciuta di {size} in {days} giorni')
          .replace('{name}', pathLeaf(grown.p)).replace('{size}', fmtSize(grown.delta)).replace('{days}', String(ins.growth.days)),
        ltrPath(grown.p),
        ref && ref.id && !diskState.overview.stale ? () => { goView('overview'); void openTreeNode(ref); } : null));
    }
    const fc = ins.forecast || {};
    if (fc.state === 'filling') {
      rows.push(actionRow(
        tr('disk_act_fill', 'A questo ritmo il disco è pieno tra circa {days} giorni').replace('{days}', String(Math.max(1, fc.daysToFull))),
        tr('disk_act_fill_sub', '{size} in più al giorno, misurato su {days} giorni.')
          .replace('{size}', fmtSize(fc.perDay)).replace('{days}', String(fc.spanDays)),
        null));
    } else if (fc.state === 'stable' && fc.spanDays >= 7) {
      rows.push(actionRow(
        tr('disk_act_stable', 'Lo spazio usato è stabile'),
        tr('disk_act_stable_sub', 'Nessuna crescita costante negli ultimi {days} giorni.').replace('{days}', String(fc.spanDays)),
        null));
    }
    const review = a ? a.reviewBytes + a.duplicateBytes : 0;
    if (review > 0) {
      rows.push(actionRow(
        tr('disk_act_review', '{size} da rivedere').replace('{size}', fmtSize(review)),
        tr('disk_act_review_sub', 'Installer vecchi, cartelle di build e copie identiche. Decidi tu cosa tenere.'),
        () => goView(a.reviewBytes > 0 ? 'clean' : 'duplicates')));
    }
    const stale = Array.isArray(diskState.overview.staleFiles) ? diskState.overview.staleFiles : [];
    if (stale.length) {
      rows.push(actionRow(
        tr('disk_act_stale', '{n} file grandi non modificati da oltre un anno').replace('{n}', fmtNumber(stale.length)),
        tr('disk_act_stale_sub', '{size} in tutto. Li trovi in Esplora.')
          .replace('{size}', fmtSize(stale.reduce((s, f) => s + (Number(f.s) || 0), 0))),
        () => goView('explore')));
    }
    if (!rows.length) {
      rows.push(actionRow(tr('disk_act_none', 'Niente da sistemare: nessuna pulizia sicura in sospeso.'), '', null));
    }
    for (const row of rows.slice(0, 3)) section.appendChild(row);
    return section;
  }

  return { renderCapacity, renderActions };
};

// The cleanup of the disk tile as it is drawn: the cards of what can go, the list to tick before it
// goes, and the progress while it goes.
'use strict';

window.DiskWidgetCleanupViews = (wrapper) => {
  const { beginReview, renderAll, runClean, ltrPath } = wrapper;

  const { tr, CAT_META, fmtSize, fmtNumber, categoryName, riskLabel } = window.DiskWidgetWording;
  const { diskState, analysis, categoryItems, selectedSummary, cancelClean } = window.DiskWidgetKnown;
  const { drivePresentation } = window.DiskWidgetPresentation;
  const { el, btn, renderIndexLimitNote } = window.DiskWidgetPieces;

  function renderCategoryCard(cat, category) {
    const meta = CAT_META[cat] || { icon: '•', title: [cat, cat], risk: 'review', desc: ['', ''] };
    const card = el('article', 'diskw-cat diskw-risk-' + meta.risk);
    const top = el('div', 'diskw-cat-top');
    top.appendChild(el('span', 'diskw-cat-icon', meta.icon));
    const title = el('div', 'diskw-cat-title');
    title.appendChild(el('span', '', tr(meta.title[0], meta.title[1])));
    title.appendChild(el('small', 'diskw-risk', riskLabel(meta.risk)));
    top.appendChild(title);
    top.appendChild(el('strong', 'diskw-cat-size', fmtSize(category.bytes)));
    card.appendChild(top);
    card.appendChild(el('p', 'diskw-cat-desc', tr(meta.desc[0], meta.desc[1])));
    const foot = el('div', 'diskw-cat-foot');
    const countText = fmtNumber(category.count) + ' ' + tr('disk_items', 'elementi');
    foot.appendChild(el('span', '', countText));
    foot.appendChild(btn('diskw-review-btn',
      cat === 'recycleBin' ? tr('disk_empty_bin', 'Svuota cestino') : tr('disk_review', 'Rivedi'),
      () => beginReview(cat)));
    card.appendChild(foot);
    return card;
  }

  function renderClean() {
    const wrap = el('div', 'diskw-view');
    const a = analysis();
    // A saved snapshot shows what was there; it is never a cleanup target.
    if (diskState.overview.stale) {
      wrap.appendChild(el('div', 'diskw-empty diskw-empty-card', tr('disk_stale_clean', 'La pulizia torna disponibile quando l’indice ha finito di ricostruirsi.')));
      return wrap;
    }
    const intro = el('section', 'diskw-clean-summary');
    intro.appendChild(el('span', 'diskw-clean-summary-kicker', tr('disk_cleanup_plan', 'Piano di pulizia protetto')));
    intro.appendChild(el('strong', '', fmtSize(a ? a.safeBytes : 0)));
    intro.appendChild(el('p', '', tr('disk_cleanup_plan_desc', 'Classificati come rigenerabili dalle regole chiuse di Xenon. Scegli comunque ogni elemento prima del Cestino.')));
    wrap.appendChild(intro);
    const limitNote = renderIndexLimitNote();
    if (limitNote) wrap.appendChild(limitNote);

    const grid = el('div', 'diskw-cats');
    const cats = diskState.overview.categories || {};
    const order = Object.keys(CAT_META).filter((cat) => cats[cat] && (cats[cat].bytes > 0 || cats[cat].count > 0));
    if (!order.length) grid.appendChild(el('div', 'diskw-empty diskw-empty-card', tr('disk_cats_empty', 'Niente di sicuro da pulire trovato')));
    else for (const cat of order) grid.appendChild(renderCategoryCard(cat, cats[cat]));
    wrap.appendChild(grid);
    return wrap;
  }

  function renderConfirm() {
    const cat = diskState.confirmCat;
    const category = diskState.overview.categories[cat] || { items: [] };
    const meta = CAT_META[cat] || { risk: 'review' };
    const box = el('section', 'diskw-confirm diskw-risk-' + meta.risk);
    const head = el('div', 'diskw-confirm-head');
    head.appendChild(el('h3', '', categoryName(cat)));
    head.appendChild(el('span', 'diskw-confirm-risk', riskLabel(meta.risk)));
    box.appendChild(head);

    if (cat === 'recycleBin') {
      box.appendChild(el('div', 'diskw-permanent-callout', tr('disk_empty_bin_warn', 'Questa è definitiva: il contenuto del Cestino non è recuperabile dopo.')));
    } else {
      const summary = selectedSummary(cat);
      const selection = el('div', 'diskw-selection-summary');
      selection.appendChild(el('strong', '', fmtSize(summary.bytes)));
      selection.appendChild(el('span', '', fmtNumber(summary.count) + ' ' + tr('disk_selected', 'selezionati')));
      const all = categoryItems(cat);
      selection.appendChild(btn('diskw-small-btn', summary.count === all.length ? tr('disk_select_none', 'Deseleziona tutto') : tr('disk_select_all', 'Seleziona tutto'), () => {
        diskState.selectedIds = summary.count === all.length ? new Set() : new Set(all.map((item) => item.i));
        renderAll();
      }));
      box.appendChild(selection);

      const list = el('div', 'diskw-confirm-list');
      for (const item of all) {
        const label = el('label', 'diskw-confirm-row');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = diskState.selectedIds.has(item.i);
        check.addEventListener('change', () => {
          if (check.checked) diskState.selectedIds.add(item.i); else diskState.selectedIds.delete(item.i);
          renderAll();
        });
        label.appendChild(check);
        const copy = el('span', 'diskw-confirm-copy');
        copy.appendChild(el('span', 'diskw-confirm-path', ltrPath(item.p)));
        copy.appendChild(el('small', '', (item.kind === 'dir' ? tr('disk_folder', 'Cartella') : tr('disk_file', 'File')) + ', ' + fmtSize(item.s)));
        label.appendChild(copy);
        list.appendChild(label);
      }
      box.appendChild(list);
      if (category.truncated) {
        box.appendChild(el('p', 'diskw-confirm-note',
          tr('disk_truncated_note', 'Sono mostrati gli elementi più grandi. Dopo questa pulizia aggiorna per rivedere i restanti.')));
      }
      box.appendChild(el('p', 'diskw-confirm-note', tr('disk_confirm_note', 'Tutto finisce nel Cestino: puoi ripristinare da lì.')));
    }

    const actions = el('div', 'diskw-confirm-actions');
    const summary = selectedSummary(cat);
    const confirm = btn('diskw-btn diskw-btn-danger',
      diskState.cleaning ? tr('disk_cleaning', 'Pulizia…') : (cat === 'recycleBin' ? tr('disk_confirm_empty', 'Svuota definitivamente') : tr('disk_confirm_move', 'Sposta nel Cestino')),
      () => runClean(cat));
    confirm.disabled = diskState.cleaning || (cat !== 'recycleBin' && summary.count === 0);
    actions.appendChild(btn('diskw-btn', tr('disk_cancel', 'Annulla'), () => { diskState.confirmCat = null; diskState.selectedIds.clear(); renderAll(); }));
    actions.appendChild(confirm);
    box.appendChild(actions);
    return box;
  }

  function renderCleaning() {
    const state = diskState.cleanState || {};
    const refreshing = state.phase === 'refreshing';
    const permanent = state.permanent === true;
    const box = el('section', 'diskw-clean-loader' + (permanent ? ' is-permanent' : ''));
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-busy', 'true');

    const hero = el('div', 'diskw-clean-loader-hero');
    hero.appendChild(XenonLoader.create({ size: 'lg' }));
    const copy = el('div', 'diskw-clean-loader-copy');
    const title = refreshing
      ? tr('disk_clean_refresh_title', 'Aggiorno la mappa del disco')
      : permanent
        ? tr('disk_clean_empty_title', 'Svuotamento del Cestino in corso')
        : tr('disk_clean_title', 'Pulizia protetta in corso');
    copy.appendChild(el('h3', '', title));
    const detail = refreshing
      ? tr('disk_clean_refresh_detail', 'Rileggo l’indice e lo spazio libero per mostrarti soltanto ciò che esiste davvero dopo la pulizia.')
      : permanent
        ? tr('disk_clean_empty_detail', 'Windows sta rimuovendo definitivamente il contenuto del Cestino. Non chiudere Xenon finché la verifica non è conclusa.')
        : tr('disk_clean_detail', 'Xenon ricontrolla percorsi e protezioni, chiede a Windows di spostare gli elementi nel Cestino e verifica il filesystem.');
    copy.appendChild(el('p', '', detail));
    hero.appendChild(copy);
    box.appendChild(hero);

    const payload = el('div', 'diskw-clean-payload');
    payload.appendChild(el('span', '', categoryName(state.cat)));
    if (!permanent && state.count) {
      payload.appendChild(el('span', '', fmtNumber(state.count) + ' ' +
        tr('disk_items', 'elementi') + ' · ' + fmtSize(state.bytes)));
    }
    const selectedRoot = (diskState.status && diskState.status.roots || []).find((root) => root.i === diskState.selRoot);
    if (selectedRoot) {
      const rootInfo = drivePresentation(selectedRoot);
      payload.appendChild(el('span', '', rootInfo.primary + ' · ' + rootInfo.secondary));
    }
    box.appendChild(payload);

    // Real progress: a determinate bar over processed/total while moving, and
    // an "x di y" line so the number visibly climbs (the old bar was cosmetic).
    const total = Number(state.total) || 0;
    const processed = Math.min(Number(state.processed) || 0, total || Number.MAX_SAFE_INTEGER);
    const track = el('div', 'diskw-clean-track');
    const bar = el('span', '');
    if (!refreshing && !permanent && total > 0) {
      bar.style.width = Math.round((processed / total) * 100) + '%';
      bar.style.animation = 'none';
    }
    track.appendChild(bar);
    box.appendChild(track);
    if (!refreshing && !permanent && total > 0) {
      const line = el('p', 'diskw-clean-count',
        tr('disk_clean_progress', '{done} di {total} elementi')
          .replace('{done}', fmtNumber(processed)).replace('{total}', fmtNumber(total)));
      box.appendChild(line);
    }

    const stages = [
      [tr('disk_clean_stage_selection', 'Selezione verificata'), 'done'],
      [permanent
        ? tr('disk_clean_stage_empty', 'Rimozione definitiva')
        : tr('disk_clean_stage_recycle', 'Spostamento e verifica'), refreshing ? 'done' : 'active'],
      [tr('disk_clean_stage_refresh', 'Aggiornamento mappa'), refreshing ? 'active' : 'pending'],
    ];
    const stageList = el('div', 'diskw-clean-stages');
    stages.forEach(([label, stage], index) => {
      const row = el('div', 'diskw-clean-stage is-' + stage);
      row.appendChild(el('span', 'diskw-clean-stage-dot', stage === 'done' ? '✓' : String(index + 1)));
      row.appendChild(el('strong', '', label));
      stageList.appendChild(row);
    });
    box.appendChild(stageList);

    // Let the user stop a long cleanup. It finishes the current batch (never
    // mid-move) and reports what it managed to remove.
    if (!refreshing && !permanent && diskState.cleanState && diskState.cleanState.id != null && !state.cancelled) {
      const cancel = btn('diskw-btn diskw-clean-cancel', tr('disk_clean_stop', 'Interrompi'), () => cancelClean());
      box.appendChild(cancel);
    } else if (state.cancelled && !refreshing) {
      box.appendChild(el('p', 'diskw-clean-count', tr('disk_clean_stopping', 'Interruzione al termine del gruppo in corso…')));
    }
    return box;
  }

  return { renderClean, renderConfirm, renderCleaning };
};

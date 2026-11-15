// The parts of the disk analysis dialog: its heading, the space that can be freed, the largest
// things on the drive, and the box that asks Bit.
'use strict';

window.DiskWidgetAdvisorDialog = (wrapper) => {
  const { closeAdvisorModal, beginReview, ltrPath, runAdvisorAi } = wrapper;

  const { tr, CAT_META, fmtSize, fmtNumber, pathLeaf } = window.DiskWidgetWording;
  const { diskState } = window.DiskWidgetKnown;
  const {
    CATEGORY_GUIDE, drivePresentation, advisorAiReady, advisorFullContext, advisorRiskWords,
    advisorRecoveryItems,
  } = window.DiskWidgetPresentation;
  const { el, btn } = window.DiskWidgetPieces;
  const { advisorFact, advisorSection } = window.DiskWidgetAdvisorReport;

  function advisorHead() {
    const head = el('header', 'diskw-modal-head');
    const bit = el('span', 'diskw-modal-bit');
    if (window.BitApp) window.BitApp.showIcon(bit, 'idle');
    head.appendChild(bit);
    const heading = el('div', 'diskw-modal-heading');
    const title = el('h2', '', tr('disk_modal_title', 'Analisi del disco'));
    title.id = 'diskw-advisor-modal-title';
    heading.appendChild(title);
    const selectedRoot = (diskState.status && diskState.status.roots || []).find((root) => root.i === diskState.selRoot);
    const rootInfo = drivePresentation(selectedRoot || { path: diskState.overview.root });
    heading.appendChild(el('p', '', [rootInfo.primary, ...rootInfo.details].join(', ')));
    head.appendChild(heading);
    head.appendChild(btn('diskw-modal-close', '×', closeAdvisorModal, tr('disk_close', 'Chiudi')));
    return head;
  }

  // The heading of a row that opens, and all there is of one with nothing more to say.
  function advisorRowHead(tag, item, total) {
    const head = el(tag, 'diskw-modal-cat-head');
    head.appendChild(el('strong', 'diskw-modal-cat-name', item.label));
    head.appendChild(el('strong', 'diskw-modal-cat-size', fmtSize(item.bytes)));
    head.appendChild(el('span', 'diskw-modal-cat-risk', advisorRiskWords(item.risk)));
    if (item.count) {
      head.appendChild(el('span', 'diskw-modal-cat-count', fmtNumber(item.count) + ' ' + tr('disk_items', 'elementi')));
    }
    const bar = el('span', 'diskw-modal-cat-bar');
    const fill = el('span');
    fill.style.width = Math.max(2, Math.min(100, item.bytes / total * 100)) + '%';
    bar.appendChild(fill);
    head.appendChild(bar);
    return head;
  }

  function advisorCategory(item, total) {
    const meta = CAT_META[item.id] || { desc: ['', ''] };
    const guide = CATEGORY_GUIDE[item.id] || {};
    const row = el('details', 'diskw-modal-cat diskw-risk-' + item.risk);
    row.setAttribute('name', 'diskw-cat');   // one open at a time: the list stays a list
    const head = advisorRowHead('summary', item, total);
    head.appendChild(el('span', 'diskw-modal-caret'));
    row.appendChild(head);
    const body = el('div', 'diskw-modal-cat-body');
    body.appendChild(advisorFact(tr('disk_what_is_it', 'Cos’è e a cosa serve'), tr(meta.desc[0], meta.desc[1])));
    if (guide.after) {
      body.appendChild(advisorFact(tr('disk_after_cleaning', 'Cosa succede dopo'), tr(guide.after[0], guide.after[1])));
    }
    if (guide.prevent) {
      body.appendChild(advisorFact(tr('disk_reduce_recurrence', 'Come farlo tornare meno'), tr(guide.prevent[0], guide.prevent[1])));
    }
    body.appendChild(btn('diskw-modal-review', item.id === 'recycleBin'
      ? tr('disk_review_bin', 'Controlla il Cestino')
      : tr('disk_review_items', 'Rivedi gli elementi'), () => {
      closeAdvisorModal();
      diskState.activeView = 'clean';
      beginReview(item.id);
    }));
    row.appendChild(body);
    return row;
  }

  function advisorRecovery(a) {
    const items = advisorRecoveryItems(a);
    const title = tr('disk_recovery_map', 'Spazio che puoi liberare');
    if (!items.length) {
      const empty = advisorSection(title);
      empty.appendChild(el('p', 'diskw-modal-empty',
        tr('disk_no_cleanup_candidates', 'Non risultano candidati di pulizia in questa fotografia.')));
      return empty;
    }
    const section = advisorSection(title, tr('disk_recovery_map_hint', 'Apri una voce per sapere cos’è e cosa succede dopo.'));
    const total = Math.max(1, items.reduce((sum, item) => sum + item.bytes, 0));
    const list = el('div', 'diskw-modal-cats');
    for (const item of items) {
      if (item.id) {
        list.appendChild(advisorCategory(item, total));
        continue;
      }
      const row = el('div', 'diskw-modal-cat diskw-risk-' + item.risk);
      row.appendChild(advisorRowHead('div', item, total));
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  function advisorLargestRow(name, path, size) {
    const row = el('div', 'diskw-modal-largest-row');
    const copy = el('div');
    copy.appendChild(el('strong', '', name));
    copy.appendChild(el('span', '', ltrPath(path)));
    row.appendChild(copy);
    row.appendChild(el('b', '', fmtSize(size)));
    return row;
  }

  function advisorLargest() {
    const section = advisorSection(tr('disk_largest_not_delete', 'Gli elementi più grandi'),
      tr('disk_largest_not_delete_hint', 'Questi elementi spiegano il disco; non entrano nella pulizia automatica. Disinstalla app e giochi dal loro gestore quando possibile.'));
    const rootPath = String(diskState.overview.root || '').replace(/\\+$/, '').toLowerCase();
    const folders = (diskState.overview.tree || []).filter((item) =>
      String(item.p || '').replace(/\\+$/, '').toLowerCase() !== rootPath).slice(0, 6);
    const files = (diskState.overview.topFiles || []).slice(0, 6);
    const list = el('div', 'diskw-modal-largest');
    folders.forEach((item) => list.appendChild(advisorLargestRow(pathLeaf(item.p), item.p, item.s)));
    files.forEach((item) => list.appendChild(advisorLargestRow(item.n || pathLeaf(item.p), item.p, item.s)));
    if (!folders.length && !files.length) {
      list.appendChild(el('p', 'diskw-modal-empty', tr('disk_no_large_items', 'Nessun elemento grande disponibile.')));
    }
    section.appendChild(list);
    const guard = el('div', 'diskw-modal-do-not-touch');
    guard.appendChild(el('strong', '', tr('disk_never_auto_title', 'Xenon non decide mai su questi dati')));
    guard.appendChild(el('p', '', tr('disk_never_auto_detail',
      'Documenti, foto, video, cartelle delle app, file di sistema, dati riservati e copie identiche restano fuori dalla pulizia consigliata finché una regola chiusa e le protezioni non dicono il contrario.')));
    section.appendChild(guard);
    return section;
  }

  function advisorAi() {
    const section = el('section', 'diskw-modal-section');
    const head = el('div', 'diskw-modal-ai-head');
    const copy = el('div');
    copy.appendChild(el('h3', '', tr('disk_ai_deep_title', 'Analisi di Bit')));
    copy.appendChild(el('p', 'diskw-modal-section-intro', advisorFullContext()
      ? tr('disk_ai_share_full', 'Su tua autorizzazione, il provider riceve nomi e pesi di questa fotografia più profilo hardware, app installate, cartelle frequenti e aperture recenti. Mai il contenuto dei file.')
      : tr('disk_ai_share_snapshot', 'Solo se premi il pulsante, il provider riceve nomi, percorsi, pesi e categorie di questa fotografia. Mai il contenuto dei file.')));
    head.appendChild(copy);
    const ready = advisorAiReady();
    const output = el('div', 'diskw-modal-ai-output');
    const key = btn('diskw-modal-ask', ready ? tr('disk_ai_deepen', 'Chiedi a Bit') : tr('disk_ai_configure', 'Configura Bit'), () => {
      if (ready) {
        runAdvisorAi(key, output);
        return;
      }
      closeAdvisorModal();
      openSettingsCategory('ai');   // was a toggle: with Settings open it closed them
    });
    head.appendChild(key);
    output.appendChild(el('p', 'diskw-modal-ai-note', ready
      ? tr('disk_ai_optional', 'Facoltativo: l’analisi locale sopra funziona già senza inviare nulla.')
      : tr('disk_ai_not_enabled', 'Bit non è ancora configurato. Tutto quello che vedi qui sopra funziona anche senza.')));
    section.appendChild(head);
    section.appendChild(output);
    return section;
  }

  return { advisorHead, advisorRecovery, advisorLargest, advisorAi };
};

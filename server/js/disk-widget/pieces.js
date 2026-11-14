// The small pieces the disk widget is drawn from: an element with its text, a button, a row that
// says what is worth doing, and the notes about an index that is capped, old, loading or just
// cleaned. Every text goes in as text.
'use strict';

(() => {
  const { tr, fmtAgo } = window.DiskWidgetWording;
  const { diskState } = window.DiskWidgetKnown;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function btn(cls, label, onClick, title) {
    const node = el('button', cls, label);
    node.type = 'button';
    if (title) node.title = title;
    node.addEventListener('click', onClick);
    return node;
  }

  function withTransition(change) {
    if (typeof document.startViewTransition === 'function') document.startViewTransition(change);
    else change();
  }

  function appendRootCopy(chip, info, prefix) {
    chip.appendChild(el('strong', '', (prefix || '') + info.primary));
    chip.appendChild(el('small', '', info.secondary));
  }

  function actionRow(title, sub, onClick) {
    const row = onClick ? btn('diskw-act', '', onClick) : el('div', 'diskw-act is-static');
    const copy = el('span', 'diskw-act-copy');
    copy.appendChild(el('strong', '', title));
    if (sub) copy.appendChild(el('span', '', sub));
    row.appendChild(copy);
    if (onClick) row.appendChild(el('span', 'diskw-act-go', '›'));
    return row;
  }

  function renderIndexLimitNote() {
    if (!diskState.overview || !diskState.overview.index || (!diskState.overview.index.capped && !diskState.overview.index.detailCapped)) return null;
    return el('div', 'diskw-index-note', diskState.overview.index.capped
      ? tr('disk_index_capped', 'L’indice ha raggiunto il limite di sicurezza: i numeri sono utili ma non rappresentano ogni file.')
      : tr('disk_detail_capped', 'La mappa è completa; la lista di dettaglio per la pulizia mostra un campione limitato. Aggiorna dopo ogni passaggio.'));
  }

  function renderStaleNote() {
    if (!diskState.overview || !diskState.overview.stale) return null;
    return el('div', 'diskw-index-note', tr('disk_stale_note',
      'Dati dell’ultima analisi, {when}. L’indice si sta ricostruendo: pulizia e cartelle tornano disponibili quando ha finito.')
      .replace('{when}', fmtAgo(diskState.overview.generatedAt)));
  }

  function renderLoading() {
    const card = el('div', 'diskw-state-card');
    card.appendChild(XenonLoader.create());
    card.appendChild(el('strong', '', diskState.loadingSlow
      ? tr('disk_loading_slow', 'Sto aggregando milioni di file…')
      : tr('disk_loading', 'Compongo la mappa live…')));
    card.appendChild(el('p', '', diskState.loadingSlow
      ? tr('disk_loading_slow_detail', 'La prima fotografia di un disco molto grande può richiedere qualche secondo; le successive vengono riutilizzate.')
      : tr('disk_loading_detail', 'Dimensioni, cartelle grandi e duplicati vengono letti in una sola fotografia coerente.')));
    return card;
  }

  function renderReport() {
    if (!diskState.lastReport) return null;
    const cls = 'diskw-report' + (diskState.lastReport.error ? ' is-error' : diskState.lastReport.warning ? ' is-warning' : '');
    return el('div', cls, diskState.lastReport.pending ? (diskState.lastReport.text || tr('disk_cleaning', 'Pulizia…')) : diskState.lastReport.text);
  }

  window.DiskWidgetPieces = {
    el, btn, withTransition, appendRootCopy, actionRow, renderIndexLimitNote, renderStaleNote,
    renderLoading, renderReport,
  };
})();

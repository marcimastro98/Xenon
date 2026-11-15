'use strict';

// Disk Intelligence — a live, theme-aware storage cockpit backed by the
// Living Index. Paths travel out for display only. Cleanup sends root index +
// category + server-issued item ids, is re-stated and re-guarded server-side,
// and always targets the Recycle Bin (except the explicitly permanent
// "empty bin" action). Every path is untrusted text and uses textContent.
(function () {
  const { tr, fmtSize, fmtNumber, pathLeaf, friendlyError } = window.DiskWidgetWording;
  const POLL_MS = 1800;
  const OVERVIEW_TIMEOUT_MS = 125000;

  const {
    diskState, api, analysis, treeRefFor, categoryItems, selectedSummary, stopPolling,
  } = window.DiskWidgetKnown;
  // The last overview of each drive this page has seen, so switching back to a
  // drive (or refreshing it) redraws at once and updates in place instead of
  // blanking the tile behind a spinner.
  const overviewCache = new Map();
  // The tab last tapped is remembered across reloads (TileTabMemory); switching
  // drive still opens on the overview.
  const DISK_VIEWS = ['overview', 'clean', 'explore', 'duplicates'];
  diskState.activeView = window.TileTabMemory ? TileTabMemory.get('disk', DISK_VIEWS, 'overview') : 'overview';
  let advisorLetGo = null;

  // "Show in folder" opens a window on the PC, so it is offered only on the
  // PC: from a paired phone it would act on a screen nobody is looking at.
  const canReveal = () => !window.__xenonRemote;

  async function revealItem(id) {
    if (!id || diskState.selRoot == null) return;
    const out = await api('/disk/reveal', { i: diskState.selRoot, id });
    if (!out || !out.ok) {
      diskState.lastReport = { text: tr('disk_reveal_failed', 'Non sono riuscito ad aprire la cartella.'), error: true };
      renderAll();
    }
  }

  function revealBtn(id) {
    return btn('diskw-copy-btn', '↗', () => revealItem(id), tr('disk_reveal', 'Mostra nella cartella'));
  }

  const {
    el, btn, withTransition, renderIndexLimitNote, renderStaleNote, renderLoading, renderReport,
  } = window.DiskWidgetPieces;

  // Paths are shown inside `direction: rtl` boxes so the ellipsis eats the
  // START of a long path and the file name stays readable. That flips the
  // trailing neutrals of a short one: "C:" rendered as ":C". Isolating the
  // path as one LTR run fixes the order and keeps the head-truncation.
  const LRI = String.fromCharCode(0x2066);
  const PDI = String.fromCharCode(0x2069);
  function ltrPath(value) {
    const s = String(value == null ? '' : value);
    return s ? LRI + s + PDI : s;
  }

  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(String(path || ''));
      diskState.lastReport = { text: tr('disk_path_copied', 'Percorso copiato.') };
    } catch {
      diskState.lastReport = { text: tr('disk_copy_failed', 'Copia non riuscita.'), error: true };
    }
    renderAll();
  }

  async function addRoot(rootPath) {
    if (diskState.addingRoot || diskState.cleaning) return;
    closeAdvisorModal();
    diskState.addingRoot = true;
    diskState.pendingRootPath = String(rootPath || '');
    diskState.lastReport = { pending: true, text: tr('disk_adding_drive', 'Aggiungo il disco all’indice…') };
    renderAll();
    try {
      if (typeof window.addSearchIndexRoot === 'function') {
        await window.addSearchIndexRoot(rootPath);
      } else if (typeof window.getSearchSettings === 'function' && typeof window.updateSearchSettings === 'function') {
        const cur = window.getSearchSettings();
        window.updateSearchSettings({ indexRoots: [...(cur.indexRoots || []), rootPath] });
      } else {
        throw new Error('settings_unavailable');
      }
      await refresh();
      const found = (diskState.status && diskState.status.roots || []).find((r) =>
        String(r.path).toLowerCase() === String(rootPath).toLowerCase());
      if (found) {
        diskState.selRoot = found.i;
        diskState.pendingRootPath = '';
        diskState.overview = null;
        diskState.treeRoot = null;
        diskState.treeStack = [];
        diskState.treeError = '';
        diskState.lastReport = null;
      }
      startPolling();
    } catch {
      diskState.lastReport = { text: tr('disk_add_failed', 'Non sono riuscito ad aggiungere il disco.'), error: true };
    } finally {
      diskState.addingRoot = false;
      renderAll();
    }
  }

  const {
    renderRoots, renderHeader, renderTabs,
  } = window.DiskWidgetHeader({ closeAdvisorModal, overviewCache, loadOverview, addRoot, renderAll });

  const {
    renderCapacity, renderActions,
  } = window.DiskWidgetCapacityAndAdvice({ renderAll, openAdvisorModal, openTreeNode, ltrPath });

  function closeAdvisorModal() {
    diskState.advisorAiRequest++;
    if (advisorLetGo) advisorLetGo();
    advisorLetGo = null;
    if (diskState.advisorModal) diskState.advisorModal.remove();
    diskState.advisorModal = null;
    document.body.classList.remove('diskw-advisor-open');
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('disk-advisor', false);
  }

  const { renderAiMarkdown, advisorStats } = window.DiskWidgetAdvisorReport;

  // ── AI report markdown → DOM (safe) ──────────────────────────────────────

  async function runAdvisorAi(button, output) {
    const request = ++diskState.advisorAiRequest;
    button.disabled = true;
    output.replaceChildren();
    const busy = el('div', 'diskw-modal-ai-busy');
    busy.appendChild(XenonLoader.create({ size: 'sm' }));
    busy.appendChild(el('div', '', tr('disk_ai_working', 'Bit sta leggendo categorie, cartelle e app…')));
    output.appendChild(busy);
    const controller = new AbortController();
    const uiLang = typeof lang !== 'undefined' ? lang : 'en';
    const out = await api('/api/disk/advisor', { rootIndex: diskState.selRoot, lang: uiLang }, {
      controller,
      timeout: 65000,
    });
    if (request !== diskState.advisorAiRequest || !diskState.advisorModal) return;
    button.disabled = false;
    output.replaceChildren();
    if (out && out.ok && out.text) {
      const meta = el('div', 'diskw-modal-ai-meta');
      meta.appendChild(el('strong', '', tr('disk_ai_report', 'Rapporto di Bit')));
      meta.appendChild(el('span', '', out.fullContext
        ? tr('disk_ai_full_badge', 'Contesto PC autorizzato')
        : tr('disk_ai_snapshot_badge', 'Solo fotografia selezionata')));
      output.appendChild(meta);
      const body = el('div', 'diskw-modal-ai-text');
      renderAiMarkdown(body, out.text);
      output.appendChild(body);
    } else {
      const code = out && out.error;
      const message = code === 'no_provider'
        ? tr('disk_ai_no_provider', 'Configura un provider in Impostazioni → Bit. L’analisi locale qui sopra resta completa e disponibile.')
        : code === 'timeout'
          ? tr('disk_ai_timeout', 'Il provider ha impiegato troppo. Nessun dato è stato modificato: puoi riprovare.')
          : tr('disk_ai_failed', 'Bit non è riuscito a rispondere. L’analisi qui sopra resta disponibile e nessun file è stato toccato.');
      output.appendChild(el('div', 'diskw-modal-ai-error', message));
    }
  }

  const {
    advisorHead, advisorRecovery, advisorLargest, advisorAi,
  } = window.DiskWidgetAdvisorDialog({ closeAdvisorModal, beginReview, ltrPath, runAdvisorAi });

  function openAdvisorModal() {
    if (!diskState.overview) return;
    closeAdvisorModal();
    const a = analysis();
    if (!a) return;
    const overlay = el('div', 'diskw-advisor-modal');
    const dialog = el('section', 'diskw-advisor-dialog');
    dialog.tabIndex = -1;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'diskw-advisor-modal-title');
    dialog.appendChild(advisorHead());
    const body = el('div', 'diskw-advisor-body');
    body.appendChild(advisorStats(a));
    body.appendChild(advisorRecovery(a));
    body.appendChild(advisorLargest());
    body.appendChild(advisorAi());
    dialog.appendChild(body);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeAdvisorModal();
    });
    diskState.advisorModal = overlay;
    document.body.appendChild(overlay);
    document.body.classList.add('diskw-advisor-open');
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('disk-advisor', true);
    if (window.DialogFocus) advisorLetGo = window.DialogFocus.hold(dialog, { onEsc: closeAdvisorModal });
  }

  async function openTreeNode(ref) {
    if (!ref || ref.file || ref.other || ref.grouped || diskState.treeLoading) return;
    diskState.treeOtherOpen = false;
    diskState.treeOtherItems = null;
    if (!ref.id) {
      // Compatibility with a server that has not restarted onto the opaque-id
      // drill-down yet: the snapshot can still navigate its known directories.
      withTransition(() => {
        diskState.treeRoot = ref.p;
        diskState.treeError = '';
        renderAll();
      });
      return;
    }
    const request = ++diskState.treeRequest;
    diskState.treeLoading = true;
    diskState.treeError = '';
    renderAll();
    const out = await api('/disk/browse?i=' + encodeURIComponent(diskState.selRoot) +
      '&node=' + encodeURIComponent(ref.id));
    if (request !== diskState.treeRequest) return;
    diskState.treeLoading = false;
    if (out && out.ok) {
      diskState.treeStack.push(out);
      diskState.treeRoot = out.path;
    } else {
      diskState.treeError = out && out.error || 'index_unavailable';
    }
    renderAll();
  }


  function openOtherList(items, bytes, residual) {
    diskState.treeOtherItems = items;
    diskState.treeOtherBytes = bytes;
    diskState.treeOtherResidual = residual;
    diskState.treeOtherOpen = true;
    renderAll();
  }
  function closeOtherList() {
    diskState.treeOtherOpen = false;
    diskState.treeOtherItems = null;
    renderAll();
  }

  const {
    renderTreemap,
  } = window.DiskWidgetSpaceMap({ openOtherList, closeOtherList, openTreeNode, revealItem, canReveal, goToLevel });

  function goToLevel(target, base) {
    diskState.treeOtherOpen = false;
    diskState.treeOtherItems = null;
    diskState.treeError = '';
    const key = target.toLowerCase();
    withTransition(() => {
      if (key === base.toLowerCase()) {
        diskState.treeStack = [];
        diskState.treeRoot = base;
        renderAll();
        return;
      }
      const at = diskState.treeStack.findIndex((b) => String(b.path || '').replace(/[\\/]+$/, '').toLowerCase() === key);
      if (at >= 0) {
        diskState.treeStack = diskState.treeStack.slice(0, at + 1);
        diskState.treeRoot = diskState.treeStack[at].path;
        renderAll();
        return;
      }
      const ref = treeRefFor(target);
      if (ref && ref.id) {
        diskState.treeStack = [];
        void openTreeNode(ref);
        return;
      }
      diskState.treeStack = [];
      diskState.treeRoot = target;
      renderAll();
    });
  }

  function renderOverview() {
    const wrap = el('div', 'diskw-view diskw-overview');
    const a = analysis();
    const side = el('div', 'diskw-overview-side');
    side.appendChild(renderCapacity(a));
    const staleNote = renderStaleNote();
    if (staleNote) side.appendChild(staleNote);
    const limitNote = renderIndexLimitNote();
    if (limitNote) side.appendChild(limitNote);
    side.appendChild(renderActions(a));
    wrap.appendChild(side);
    wrap.appendChild(renderTreemap());
    return wrap;
  }

  // ── Safe cleanup ─────────────────────────────────────────────────────────

  function beginReview(cat) {
    diskState.confirmCat = cat;
    diskState.selectedIds = new Set(categoryItems(cat).map((item) => item.i));
    withTransition(renderAll);
  }

  const {
    renderClean, renderConfirm, renderCleaning,
  } = window.DiskWidgetCleanupViews({ beginReview, renderAll, runClean, ltrPath });

  async function runClean(cat) {
    if (diskState.cleaning) return;
    const ids = cat === 'recycleBin' ? [] : [...diskState.selectedIds];
    const summary = selectedSummary(cat);
    diskState.cleaning = true;
    diskState.cleanState = {
      phase: 'processing',
      id: null,
      cat,
      total: summary.count,
      processed: 0,
      count: summary.count,
      bytes: summary.bytes,
      freedBytes: 0,
      permanent: cat === 'recycleBin',
    };
    diskState.confirmCat = null;
    diskState.lastReport = null;
    renderAll();
    const out = await api('/disk/clean', { root: diskState.selRoot, category: cat, ids });
    diskState.selectedIds.clear();

    // Every cleanup — bin emptying included — is a background job: the POST
    // only accepts it, and the SSE `disk_clean` stream (onCleanProgress)
    // drives the rest.
    if (out && out.ok && out.started) {
      diskState.cleanState.id = out.id;
      renderAll();
      return;
    }
    // Rejected before it began (busy, nothing approved, bad selection…).
    diskState.cleaning = false;
    diskState.cleanState = null;
    diskState.lastReport = { text: friendlyError(out && out.error), error: true };
    renderAll();
  }

  // Progress + completion for a background category cleanup, pushed over SSE.
  // Also the re-attach path: a page loaded while a job runs adopts it here (or
  // via adoptCleanFromStatus on the next poll).
  async function onCleanProgress(snap) {
    if (!snap) return;
    // Ignore a stale event from a job we already finished, but always adopt a
    // running job we are not yet tracking (the reload case).
    if (diskState.cleanState && diskState.cleanState.id != null && snap.id != null && snap.id !== diskState.cleanState.id) return;
    if (!diskState.cleaning && snap.running) {
      diskState.cleaning = true;
      diskState.confirmCat = null;
      diskState.lastReport = null;
    }
    if (!diskState.cleaning && !snap.running) return;           // nothing we care about

    diskState.cleanState = {
      phase: snap.phase === 'done' ? 'refreshing' : 'processing',
      id: snap.id,
      cat: snap.cat,
      total: snap.total,
      processed: snap.processed,
      count: snap.total,
      bytes: snap.totalBytes,
      freedBytes: snap.freedBytes,
      cancelled: snap.cancelled === true,
      permanent: snap.permanent === true,
    };
    renderAll();

    if (snap.phase !== 'done') return;
    // The job finished: build the report, refresh the map, clear the loader.
    const rep = snap.report || {};
    let report;
    if (rep.ok && rep.emptied) {
      report = { text: tr('disk_report_emptied', 'Cestino svuotato.') };
    } else if (rep.ok) {
      let message = fmtNumber(rep.deleted) + ' ' + tr('disk_items', 'elementi') + ' → ' +
        tr('disk_report_bin', 'Cestino') + ' · ' + fmtSize(rep.freedBytes) + ' ' + tr('disk_report_freed', 'liberati');
      const refusedList = rep.refused || [];
      if (refusedList.length) message += ' · ' + fmtNumber(refusedList.length) + ' ' + tr('disk_report_refused', 'non spostati');
      // If what stayed behind stayed because a running program holds it open,
      // say so — "refused" alone reads like a malfunction.
      if (refusedList.some((r) => r.reason === 'in_use' || r.reason === 'partly_in_use')) {
        message += ' · ' + tr('disk_report_inuse', 'ciò che resta è in uso da programmi aperti');
      }
      report = { text: message, warning: rep.partial === true };
    } else {
      report = { text: friendlyError(rep.error), error: rep.error !== 'cancelled' };
    }
    await loadOverview(true);
    diskState.cleaning = false;
    diskState.cleanState = null;
    diskState.lastReport = report;
    renderAll();
  }

  // A cleanup already running when the widget (re)loads: adopt it from the
  // status snapshot so the loader shows instead of stale category cards.
  function adoptCleanFromStatus() {
    const snap = diskState.status && diskState.status.clean;
    if (!snap) return;
    if (snap.running && !diskState.cleaning) {
      void onCleanProgress(snap);
    }
  }

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

  // ── States and lifecycle ─────────────────────────────────────────────────

  function renderError() {
    const card = el('div', 'diskw-state-card diskw-state-error');
    card.appendChild(el('strong', '', tr('disk_error_title', 'Questa vista non è arrivata')));
    card.appendChild(el('p', '', friendlyError(diskState.overviewError)));
    card.appendChild(btn('diskw-btn diskw-btn-accent', tr('disk_retry', 'Riprova'), () => loadOverview(true)));
    return card;
  }

  // The Full Disk Access card. It is deliberately concrete about the cause —
  // "an update revoked it" is the difference between a user who fixes it in ten
  // seconds and one who concludes the widget is broken — and it opens the pane
  // itself, because the setting sits four levels deep under a name that differs
  // per macOS version and per language.
  function renderFdaHint() {
    const hint = el('div', 'diskw-hint');
    hint.appendChild(el('div', 'diskw-hint-mark', '⚿'));
    hint.appendChild(el('div', 'diskw-hint-title', tr('disk_fda_title', 'macOS ha revocato un permesso a Xenon')));
    hint.appendChild(el('div', 'diskw-hint-text', tr('disk_fda_text',
      'Dopo ogni aggiornamento macOS toglie a Xenon l’Accesso completo al disco. Senza, la mappa del disco e la ricerca restano vuote. Riattivalo: togli Xenon dall’elenco e riaggiungila.')));
    const btn = el('button', 'diskw-btn', tr('disk_fda_open', 'Apri le impostazioni'));
    btn.type = 'button';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      // api() posts when it is handed a body; an empty object is the POST.
      api('/macos/fda-settings', {})
        .catch(() => {})
        // Re-enabled either way: the pane may have opened behind the dashboard,
        // and a button that stays dead looks like it did nothing at all.
        .finally(() => { btn.disabled = false; });
    });
    hint.appendChild(btn);
    return hint;
  }

  // The Xenon Helper card. The helper builds the disk index, and a setup that never
  // brought it, or a clean-up that took it away, left this card telling people to run
  // an installer that the setup .exe never shows them. On Windows the same verified
  // download the setup does is one press away (the route is the one Settings uses
  // under the Media tile). A paired phone cannot press it: that route is for the PC,
  // so there the card only says what is missing.
  function renderHelperHint() {
    const hint = el('div', 'diskw-hint');
    hint.appendChild(el('div', 'diskw-hint-mark', '◌'));
    hint.appendChild(el('div', 'diskw-hint-title', tr('disk_helper_title', 'Serve Xenon Helper')));
    const canInstall = diskState.status.canInstallHelper === true && !window.__xenonRemote;
    hint.appendChild(el('div', 'diskw-hint-text', canInstall
      ? tr('disk_helper_text_win', 'Xenon Helper è il componente che costruisce l’indice del disco, e su questo PC non c’è. Premi il pulsante per scaricarlo di nuovo.')
      : tr('disk_helper_text', 'L’analisi del disco ha bisogno di un indice: aggiungi una cartella in Impostazioni → Ricerca e disco.')));
    if (!canInstall) return hint;

    const label = tr('settings_media_viz_install', 'Installa Xenon Helper');
    const btn = el('button', 'diskw-btn', label);
    btn.type = 'button';
    const result = el('div', 'diskw-hint-text diskw-hint-result');
    result.hidden = true;
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = tr('settings_media_viz_installing', 'Installazione in corso…');
      result.hidden = true;
      const r = await api('/audio/levels/install-helper', {});
      if (r && r.ok) { await refresh(); return; }   // the real tile replaces this card
      btn.disabled = false;
      btn.textContent = label;
      const code = (r && (r.status || r.error)) || 'no_server';
      const key = (code === 'not-ready' || code === 'skip-not-latest' || code === 'offline' || code === 'timeout')
        ? 'settings_media_viz_install_offline'
        : (code === 'signature-invalid' || code === 'mismatch')
          ? 'settings_media_viz_install_unverified'
          : 'settings_media_viz_install_failed';
      result.textContent = tr(key, 'Xenon Helper non si è installato.') + ' (' + code + ')';
      result.hidden = false;
    });
    hint.appendChild(btn);
    hint.appendChild(result);
    return hint;
  }

  function render(mount) {
    mount.replaceChildren();
    if (!diskState.status) {
      mount.appendChild(renderLoading());
      return;
    }
    if (!diskState.status.helper) {
      mount.appendChild(renderHelperHint());
      return;
    }

    mount.appendChild(renderHeader());
    mount.appendChild(renderRoots());
    const report = renderReport();
    if (report) mount.appendChild(report);

    const roots = diskState.status.roots || [];
    if (!roots.length) {
      // macOS took the permission away, and it does so on its own: the grant is
      // tied to the app's signature, which changes with every Xenon update. The
      // generic "turn the live index on" card below sends the user to a setting
      // that is already right, so this case has to name what actually happened.
      // Xenon keeps out of the home folder in the meantime, because walking it
      // without the grant means a macOS dialog for the Desktop, one for
      // Documents, one for Downloads, one for Photos and one for Music, on
      // every pass.
      if (diskState.status.fdaBlocked) {
        mount.appendChild(renderFdaHint());
        return;
      }
      const hint = el('div', 'diskw-hint');
      hint.appendChild(el('div', 'diskw-hint-mark', '✦'));
      hint.appendChild(el('div', 'diskw-hint-title', tr('disk_enable_title', 'Accendi l’indice vivo')));
      hint.appendChild(el('div', 'diskw-hint-text', tr('disk_enable_text', 'Scegli i dischi da tenere indicizzati in tempo reale.')));
      mount.appendChild(hint);
      return;
    }
    if (diskState.cleaning && diskState.cleanState) {
      if (diskState.overview) mount.appendChild(renderTabs());
      mount.appendChild(renderCleaning());
      return;
    }
    // The spinner is for a drive with nothing to show yet. Anything already
    // drawn stays while it is refreshed, and the header says so.
    if (diskState.loadingOverview && !diskState.overview) {
      mount.appendChild(renderLoading());
      return;
    }
    if (diskState.overviewError && !diskState.overview) {
      mount.appendChild(renderError());
      return;
    }
    if (!diskState.overview) {
      const idx = diskState.status.index || {};
      const empty = el('div', 'diskw-state-card');
      empty.appendChild(el('strong', '', idx.building
        ? tr('disk_index_building', 'Sto imparando il disco…')
        : tr('disk_pick_root', 'Tocca un disco o una cartella qui sopra.')));
      if (idx.building) empty.appendChild(el('p', '', fmtNumber((idx.progress && idx.progress.files) || idx.files) + ' file'));
      mount.appendChild(empty);
      return;
    }

    mount.appendChild(renderTabs());
    if (diskState.confirmCat) mount.appendChild(renderConfirm());
    else if (diskState.activeView === 'clean') mount.appendChild(renderClean());
    else if (diskState.activeView === 'explore') mount.appendChild(renderExplore());
    else if (diskState.activeView === 'duplicates') mount.appendChild(renderDuplicates());
    else mount.appendChild(renderOverview());
  }

  function renderAll() {
    document.querySelectorAll('.disk-widget-mount').forEach(render);
  }

  async function loadOverview(refresh) {
    // Skip only a duplicate of the request already in flight. A different
    // drive must always load, or a chip tapped mid-load would be ignored.
    if (diskState.selRoot == null || (diskState.loadingOverview && !refresh && diskState.loadingRoot === diskState.selRoot)) return;
    const requestId = ++diskState.overviewRequest;
    if (diskState.overviewAbort) diskState.overviewAbort.abort();
    diskState.overviewAbort = new AbortController();
    const requestedRoot = diskState.selRoot;
    diskState.loadingRoot = requestedRoot;
    diskState.loadingOverview = true;
    diskState.loadingSlow = false;
    diskState.overviewError = '';
    if (diskState.loadingSlowTimer) clearTimeout(diskState.loadingSlowTimer);
    diskState.loadingSlowTimer = setTimeout(() => {
      if (diskState.loadingOverview && diskState.overviewRequest === requestId) {
        diskState.loadingSlow = true;
        renderAll();
      }
    }, 2800);
    renderAll();
    const out = await api('/disk/overview?i=' + encodeURIComponent(requestedRoot) + (refresh ? '&refresh=1' : ''), null, {
      controller: diskState.overviewAbort,
      timeout: OVERVIEW_TIMEOUT_MS,
    });
    if (requestId !== diskState.overviewRequest || requestedRoot !== diskState.selRoot) return;
    diskState.loadingOverview = false;
    diskState.loadingSlow = false;
    diskState.overviewAbort = null;
    if (diskState.loadingSlowTimer) { clearTimeout(diskState.loadingSlowTimer); diskState.loadingSlowTimer = null; }
    if (out && out.ok) {
      // A refresh of the drive already on screen keeps the level the map is
      // showing; a different drive (or the first load) starts at its root.
      const sameDrive = diskState.overview && !diskState.overview.stale && diskState.overview.root === out.root;
      diskState.overview = out;
      overviewCache.set(requestedRoot, out);
      diskState.overviewError = '';
      if (!sameDrive) {
        diskState.treeRoot = out.root.replace(/\\+$/, '');
        diskState.treeStack = [];
        diskState.treeOtherOpen = false;
        diskState.treeOtherItems = null;
      }
      diskState.treeError = '';
      diskState.rootBrowse = null;
      // Pull the root's real contents (files + folders) so the map matches what
      // drilling in shows. Best-effort: the map falls back to overview.tree
      // until this lands (or if the server predates browse).
      void loadRootBrowse(out.rootId, requestId);
    } else if (diskState.overview && !diskState.overview.stale && diskState.overview.root) {
      // A failed refresh leaves the last good analysis on screen and says so.
      diskState.lastReport = { text: friendlyError(out && out.error || 'index_unavailable'), error: true };
    } else {
      diskState.overview = null;
      diskState.overviewError = out && out.error || 'index_unavailable';
    }
    renderAll();
  }

  // While the index rebuilds (after a restart, minutes on a big drive) the
  // widget shows the last analysis it saved, marked with its age, instead of
  // a spinner. Display only: the server keeps no ids for it.
  async function loadStaleSnapshot() {
    if (diskState.selRoot == null || diskState.overview || diskState.staleAskedFor === diskState.selRoot) return;
    diskState.staleAskedFor = diskState.selRoot;
    const asked = diskState.selRoot;
    const out = await api('/disk/overview?i=' + encodeURIComponent(asked) + '&stale=1');
    if (asked !== diskState.selRoot || diskState.overview || !out || !out.ok) return;
    diskState.overview = out;
    diskState.treeRoot = String(out.root || '').replace(/\\+$/, '');
    diskState.treeStack = [];
    renderAll();
  }

  // The server learned something about a drive after answering (the
  // background duplicate check): refetch it if it is the one on screen.
  function onDiskUpdate(info) {
    if (!diskState.overview || diskState.overview.stale || !info || info.root !== diskState.overview.root) return;
    void loadOverview(false);
  }

  async function loadRootBrowse(rootId, requestId) {
    if (!rootId || diskState.selRoot == null) return;
    const out = await api('/disk/browse?i=' + encodeURIComponent(diskState.selRoot) + '&node=' + encodeURIComponent(rootId));
    if (requestId !== diskState.overviewRequest) return;   // a newer overview superseded us
    if (out && out.ok) { diskState.rootBrowse = out; renderAll(); }
  }

  async function refresh() {
    const out = await api('/disk/status');
    if (out && out.ok) diskState.status = out;
    if (!diskState.status) { renderAll(); return; }
    const roots = diskState.status.roots || [];
    if (diskState.pendingRootPath) {
      const pending = roots.find((root) =>
        String(root.path).toLowerCase() === diskState.pendingRootPath.toLowerCase());
      if (pending) {
        diskState.selRoot = pending.i;
        diskState.pendingRootPath = '';
        diskState.overview = null;
        diskState.overviewError = '';
        diskState.treeRoot = null;
        diskState.treeStack = [];
        diskState.treeError = '';
      }
    }
    if (diskState.selRoot == null || !roots.some((root) => root.i === diskState.selRoot)) {
      diskState.selRoot = roots.length ? roots[0].i : null;
      diskState.overview = null;
      diskState.overviewError = '';
      diskState.treeRoot = null;
      diskState.treeStack = [];
      diskState.treeError = '';
    }
    // Re-attach to a cleanup that is running (e.g. after a reload) so the
    // loader shows real progress instead of stale category cards.
    adoptCleanFromStatus();
    const idx = diskState.status.index || {};
    // Poll while the index builds, a root is being added, or a cleanup runs
    // (the SSE stream is the primary channel; the poll is the safety net if it
    // drops).
    if (idx.building || diskState.addingRoot || diskState.cleaning) startPolling(); else stopPolling();
    // Crucial transition: the page often loads while the initial index is
    // building. Once it becomes ready, the already-selected chip must load its
    // overview automatically instead of sitting forever on "tap a drive".
    if (diskState.selRoot != null && idx.ready && (!diskState.overview || diskState.overview.stale) && !diskState.overviewError && !diskState.loadingOverview) {
      void loadOverview(false);
    } else if (diskState.selRoot != null && !idx.ready && !diskState.overview) {
      void loadStaleSnapshot();
    }
    renderAll();
  }

  function startPolling() {
    if (diskState.pollTimer) return;
    diskState.pollTimer = setInterval(async () => {
      if (!document.querySelector('.disk-widget-mount')) { stopPolling(); return; }
      await refresh();
    }, POLL_MS);
  }

  function renderWidgets() {
    if (!document.querySelector('.disk-widget-mount')) {
      stopPolling();
      if (diskState.overviewAbort) diskState.overviewAbort.abort();
      return;
    }
    if (!diskState.status) void refresh();
    else renderAll();
  }

  function init() { renderWidgets(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.DiskWidget = { renderWidgets, refresh, onCleanProgress, onDiskUpdate };
})();

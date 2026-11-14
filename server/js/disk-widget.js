'use strict';

// Disk Intelligence — a live, theme-aware storage cockpit backed by the
// Living Index. Paths travel out for display only. Cleanup sends root index +
// category + server-issued item ids, is re-stated and re-guarded server-side,
// and always targets the Recycle Bin (except the explicitly permanent
// "empty bin" action). Every path is untrusted text and uses textContent.
(function () {
  const {
    tr, CAT_META, fmtSize, fmtNumber, fmtAgo, sepOf, pathParent, pathLeaf, categoryName, riskLabel,
    friendlyError, joinUnder,
  } = window.DiskWidgetWording;
  const POLL_MS = 1800;
  const OVERVIEW_TIMEOUT_MS = 125000;

  const {
    diskState, api, analysis, capacityParts, treeRefFor, childrenOf, categoryItems, selectedSummary,
    cancelClean, stopPolling,
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

  const {
    VIEW_META, CATEGORY_GUIDE, rootKeyOf, drivePresentation, kindName, advisorAiReady,
    advisorFullContext, advisorRiskWords, advisorRecoveryItems, TREEMAP_MIN_SHARE,
    splitTreemapEntries,
  } = window.DiskWidgetPresentation;

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

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

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

  // ── Root and header ──────────────────────────────────────────────────────

  function appendRootCopy(chip, info, prefix) {
    chip.appendChild(el('strong', '', (prefix || '') + info.primary));
    chip.appendChild(el('small', '', info.secondary));
  }

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
  function actionRow(title, sub, onClick) {
    const row = onClick ? btn('diskw-act', '', onClick) : el('div', 'diskw-act is-static');
    const copy = el('span', 'diskw-act-copy');
    copy.appendChild(el('strong', '', title));
    if (sub) copy.appendChild(el('span', '', sub));
    row.appendChild(copy);
    if (onClick) row.appendChild(el('span', 'diskw-act-go', '›'));
    return row;
  }

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

  function renderIndexLimitNote() {
    if (!diskState.overview || !diskState.overview.index || (!diskState.overview.index.capped && !diskState.overview.index.detailCapped)) return null;
    return el('div', 'diskw-index-note', diskState.overview.index.capped
      ? tr('disk_index_capped', 'L’indice ha raggiunto il limite di sicurezza: i numeri sono utili ma non rappresentano ogni file.')
      : tr('disk_detail_capped', 'La mappa è completa; la lista di dettaglio per la pulizia mostra un campione limitato. Aggiorna dopo ogni passaggio.'));
  }

  function closeAdvisorModal() {
    diskState.advisorAiRequest++;
    if (advisorLetGo) advisorLetGo();
    advisorLetGo = null;
    if (diskState.advisorModal) diskState.advisorModal.remove();
    diskState.advisorModal = null;
    document.body.classList.remove('diskw-advisor-open');
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('disk-advisor', false);
  }

  function advisorStat(label, value, detail) {
    const stat = el('div', 'diskw-modal-stat');
    stat.appendChild(el('span', '', label));
    stat.appendChild(el('strong', '', value));
    if (detail) stat.appendChild(el('small', '', detail));
    return stat;
  }

  function advisorFact(label, text) {
    const row = el('div', 'diskw-modal-fact');
    row.appendChild(el('strong', '', label));
    row.appendChild(el('p', '', text));
    return row;
  }

  // ── AI report markdown → DOM (safe) ──────────────────────────────────────
  // The provider returns markdown (headings, **bold**, `| tables |`, ---); the
  // panel used to drop it in as raw text, so the report read as a wall of
  // asterisks and pipes. This builds NODES, never innerHTML: every piece of the
  // untrusted AI text reaches the page through textContent, so there is nothing
  // to inject. It covers exactly what the storage report uses — headings,
  // lists, tables, rules, bold/italic/code — and anything unknown stays plain.
  const MD_INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|_[^_\n]+_)/;
  function mdInline(node, text) {
    String(text).split(MD_INLINE_RE).forEach((p) => {
      if (!p) return;
      if (p.length > 2 && p[0] === '`' && p[p.length - 1] === '`') node.appendChild(el('code', 'diskw-md-code', p.slice(1, -1)));
      else if (p.length > 4 && (p.startsWith('**') || p.startsWith('__'))) node.appendChild(el('strong', '', p.slice(2, -2)));
      else if (p.length > 2 && (p[0] === '*' || p[0] === '_')) node.appendChild(el('em', '', p.slice(1, -1)));
      else node.appendChild(document.createTextNode(p));
    });
    return node;
  }
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function renderAiMarkdown(box, raw) {
    const lines = String(raw || '').replace(/\r/g, '').split('\n');
    let list = null;
    const endList = () => { list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Horizontal rule.
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { endList(); box.appendChild(el('hr', 'diskw-md-hr')); continue; }

      // Table: a row, then a |---|---| separator, then rows until a non-row.
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        endList();
        const header = splitRow(line);
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && isTableRow(lines[j]) && !isTableSep(lines[j]); j++) rows.push(splitRow(lines[j]));
        const scroller = el('div', 'diskw-md-tablewrap');
        const table = el('table', 'diskw-md-table');
        const thead = el('thead', '');
        const htr = el('tr', '');
        header.forEach((c) => mdInline(htr.appendChild(el('th', '')), c));
        thead.appendChild(htr);
        table.appendChild(thead);
        const tbody = el('tbody', '');
        rows.forEach((cells) => {
          const tr = el('tr', '');
          for (let k = 0; k < header.length; k++) mdInline(tr.appendChild(el('td', '')), cells[k] || '');
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        scroller.appendChild(table);
        box.appendChild(scroller);
        i = j - 1;
        continue;
      }

      const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        endList();
        const level = Math.min(heading[1].length, 4);
        mdInline(box.appendChild(el('div', 'diskw-md-h diskw-md-h' + level)), heading[2]);
        continue;
      }

      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        if (!list) { list = el('div', 'diskw-md-list'); box.appendChild(list); }
        const indent = ((bullet ? bullet[1] : numbered[1]) || '').length;
        const item = el('div', 'diskw-md-li' + (indent >= 2 ? ' is-sub' : ''));
        item.appendChild(el('span', 'diskw-md-bullet', numbered ? numbered[2] + '.' : '•'));
        mdInline(item.appendChild(el('div', 'diskw-md-litext')), bullet ? bullet[2] : numbered[3]);
        list.appendChild(item);
        continue;
      }

      endList();
      if (!line.trim()) continue;          // blank line = the gap between blocks
      mdInline(box.appendChild(el('div', 'diskw-md-p')), line);
    }
    return box;
  }

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

  function advisorStats(a) {
    const percent = (value) => (value != null ? Math.round(value) + '%' : '');
    const stats = el('div', 'diskw-modal-stats');
    stats.appendChild(advisorStat(tr('disk_used_space', 'Spazio usato'), fmtSize(a.used), percent(a.usedPercent)));
    stats.appendChild(advisorStat(tr('disk_free_space', 'Spazio libero'), fmtSize(a.free), percent(a.freePercent)));
    stats.appendChild(advisorStat(
      tr('disk_recommended_cleanup', 'Pulizia consigliata'),
      fmtSize(a.safeBytes),
      tr('disk_recommended_cleanup_hint', 'cache e temporanei rigenerabili')));
    stats.appendChild(advisorStat(
      tr('disk_personal_decision', 'Scelta personale'),
      fmtSize(a.reviewBytes + a.duplicateBytes),
      tr('disk_personal_decision_hint', 'Xenon non decide al posto tuo')));
    return stats;
  }

  function advisorSection(title, intro) {
    const section = el('section', 'diskw-modal-section');
    section.appendChild(el('h3', '', title));
    if (intro) section.appendChild(el('p', 'diskw-modal-section-intro', intro));
    return section;
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

  const { squarify } = window.DiskWidgetTreemap;

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

  function renderStaleNote() {
    if (!diskState.overview || !diskState.overview.stale) return null;
    return el('div', 'diskw-index-note', tr('disk_stale_note',
      'Dati dell’ultima analisi, {when}. L’indice si sta ricostruendo: pulizia e cartelle tornano disponibili quando ha finito.')
      .replace('{when}', fmtAgo(diskState.overview.generatedAt)));
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

  function renderError() {
    const card = el('div', 'diskw-state-card diskw-state-error');
    card.appendChild(el('strong', '', tr('disk_error_title', 'Questa vista non è arrivata')));
    card.appendChild(el('p', '', friendlyError(diskState.overviewError)));
    card.appendChild(btn('diskw-btn diskw-btn-accent', tr('disk_retry', 'Riprova'), () => loadOverview(true)));
    return card;
  }

  function renderReport() {
    if (!diskState.lastReport) return null;
    const cls = 'diskw-report' + (diskState.lastReport.error ? ' is-error' : diskState.lastReport.warning ? ' is-warning' : '');
    return el('div', cls, diskState.lastReport.pending ? (diskState.lastReport.text || tr('disk_cleaning', 'Pulizia…')) : diskState.lastReport.text);
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

'use strict';

// Disk Intelligence — a live, theme-aware storage cockpit backed by the
// Living Index. Paths travel out for display only. Cleanup sends root index +
// category + server-issued item ids, is re-stated and re-guarded server-side,
// and always targets the Recycle Bin (except the explicitly permanent
// "empty bin" action). Every path is untrusted text and uses textContent.
(function () {
  const tr = (key, fallback) => {
    const value = typeof window.t === 'function' ? window.t(key) : '';
    return value && value !== key ? value : (fallback != null ? fallback : key);
  };
  const POLL_MS = 1800;
  const OVERVIEW_TIMEOUT_MS = 125000;

  let pollTimer = null;
  let status = null;
  let selRoot = null;
  let overview = null;
  let overviewError = '';
  let loadingOverview = false;
  let loadingSlow = false;
  let loadingSlowTimer = null;
  let overviewRequest = 0;
  let overviewAbort = null;
  let activeView = 'overview';
  let treeRoot = null;
  let treeStack = [];
  let treeLoading = false;
  let treeError = '';
  let treeRequest = 0;
  // The "Altre N voci" panel opened from the grouped treemap tile.
  let treeOtherOpen = false;
  let treeOtherItems = null;
  let treeOtherBytes = 0;
  let treeOtherResidual = 0;
  // The root level's own browse() result — same complete source as a drill-down
  // (direct files like pagefile.sys/hiberfil.sys included, real unlisted bytes),
  // instead of the size-capped overview.tree which dropped system files into a
  // bogus "50 GB not listed" chunk.
  let rootBrowse = null;
  let confirmCat = null;
  let selectedIds = new Set();
  let cleaning = false;
  let cleanState = null;
  let addingRoot = false;
  let pendingRootPath = '';
  let lastReport = null;
  let advisorModal = null;
  let advisorAiRequest = 0;
  let advisorKeyHandler = null;

  const CAT_META = {
    temp: {
      icon: '⌁', title: ['disk_cat_temp', 'File temporanei'], risk: 'safe',
      desc: ['disk_cat_temp_desc', 'Residui transitori di Windows e delle app. Possono ricrearsi quando servono.'],
    },
    browserCache: {
      icon: '◎', title: ['disk_cat_browser', 'Cache dei browser'], risk: 'safe',
      desc: ['disk_cat_browser_desc', 'Copie locali dei siti: liberano spazio, poi alcune pagine possono caricarsi più lentamente la prima volta.'],
    },
    pkgCache: {
      icon: '⌘', title: ['disk_cat_pkg', 'Cache dei package manager'], risk: 'safe',
      desc: ['disk_cat_pkg_desc', 'Pacchetti scaricabili di nuovo da npm, pip, NuGet, Gradle e altri strumenti di sviluppo.'],
    },
    buildOutput: {
      icon: '◇', title: ['disk_cat_build', 'Output di build'], risk: 'review',
      desc: ['disk_cat_build_desc', 'Dipendenze e artefatti generati solo dentro le cartelle progetto autorizzate nelle Impostazioni.'],
    },
    installers: {
      icon: '↓', title: ['disk_cat_installers', 'Vecchi installer'], risk: 'review',
      desc: ['disk_cat_installers_desc', 'Installer in Download più vecchi della soglia scelta. Conserva driver rari o licenze offline.'],
    },
    recycleBin: {
      icon: '⌫', title: ['disk_cat_recycle', 'Cestino'], risk: 'permanent',
      desc: ['disk_cat_recycle_desc', 'È l’undo delle eliminazioni precedenti. Svuotarlo rimuove definitivamente il contenuto.'],
    },
  };

  const VIEW_META = [
    ['overview', 'disk_tab_overview', 'Panoramica'],
    ['clean', 'disk_tab_clean', 'Pulizia'],
    ['explore', 'disk_tab_explore', 'Esplora'],
    ['duplicates', 'disk_tab_duplicates', 'Duplicati'],
  ];

  const CATEGORY_GUIDE = {
    temp: {
      after: ['disk_guide_temp_after', 'Le app ricreano solo ciò che serve; il primo avvio può essere appena più lento.'],
      prevent: ['disk_guide_temp_prevent', 'Chiudi correttamente le app e limita i programmi che accumulano sessioni o crash log.'],
    },
    browserCache: {
      after: ['disk_guide_browser_after', 'I siti ricostruiscono la cache durante le visite successive; account e preferiti non vengono toccati.'],
      prevent: ['disk_guide_browser_prevent', 'Riduci la cache dalle impostazioni del browser o puliscila periodicamente, senza bloccarla del tutto.'],
    },
    pkgCache: {
      after: ['disk_guide_pkg_after', 'npm, pip, NuGet o Gradle riscaricheranno i pacchetti necessari; il codice dei progetti resta intatto.'],
      prevent: ['disk_guide_pkg_prevent', 'Usa i comandi di prune/cache clean del relativo gestore e rimuovi ambienti di progetti abbandonati.'],
    },
    buildOutput: {
      after: ['disk_guide_build_after', 'La prossima build o installazione può richiedere più tempo e ricreare gran parte dello spazio.'],
      prevent: ['disk_guide_build_prevent', 'Configura clean automatici nei progetti e conserva output offline solo per i lavori attivi.'],
    },
    installers: {
      after: ['disk_guide_installer_after', 'Per riparare o reinstallare l’app dovrai riscaricare il pacchetto eliminato.'],
      prevent: ['disk_guide_installer_prevent', 'Archivia solo driver rari o installer con licenza; elimina i download sostituibili dopo l’installazione.'],
    },
    recycleBin: {
      after: ['disk_guide_bin_after', 'Perdi definitivamente la possibilità di ripristinare quei file dal Cestino.'],
      prevent: ['disk_guide_bin_prevent', 'Svuotalo solo dopo aver controllato il contenuto; usa una pulizia pianificata se vuoi limitarne la crescita.'],
    },
  };

  function fmtSize(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
    return v.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1') + ' ' + units[i];
  }

  function fmtNumber(value) {
    return Math.max(0, Number(value) || 0).toLocaleString();
  }

  function pathLeaf(value) {
    const parts = String(value || '').replace(/\\+$/, '').split('\\').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(value || '');
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
    if (!overview || !window.DiskIntelligence) return null;
    return window.DiskIntelligence.analyze(overview);
  }

  function categoryName(cat) {
    const meta = CAT_META[cat];
    return meta ? tr(meta.title[0], meta.title[1]) : cat;
  }

  function riskLabel(risk) {
    if (risk === 'safe') return tr('disk_risk_safe', 'Sicuro');
    if (risk === 'permanent') return tr('disk_risk_permanent', 'Definitivo');
    return tr('disk_risk_review', 'Da rivedere');
  }

  function friendlyError(code) {
    const map = {
      timeout: tr('disk_error_timeout', 'L’analisi ha impiegato troppo. L’indice resta attivo: riprova tra poco.'),
      index_unavailable: tr('disk_error_index', 'L’indice non ha completato questa vista. Riprova o attendi che finisca di aggiornarsi.'),
      index_off: tr('disk_error_index_off', 'L’indice vivo non è disponibile per questa posizione.'),
      bad_root: tr('disk_error_root', 'Questo disco non è più nell’elenco indicizzato.'),
      offline: tr('disk_error_offline', 'Xenon non riesce a parlare con il backend locale.'),
      no_overview: tr('disk_error_expired', 'La fotografia di pulizia è scaduta. Aggiorna e riprova.'),
      nothing_approved: tr('disk_error_guarded', 'Le protezioni hanno rifiutato tutti gli elementi selezionati. Nessun file è stato toccato.'),
      delete_failed: tr('disk_error_delete', 'Windows non ha spostato gli elementi selezionati. Chiudi le app che li stanno usando e riprova.'),
      helper_missing: tr('disk_error_helper', 'Xenon Helper non è disponibile.'),
      busy: tr('disk_error_busy', 'Una pulizia è già in corso. Attendi che finisca.'),
      index_building: tr('disk_error_index', 'L’indice non ha completato questa vista. Riprova o attendi che finisca di aggiornarsi.'),
      cancelled: tr('disk_report_cancelled', 'Pulizia interrotta.'),
      empty_failed: tr('disk_error_empty', 'Windows non ha svuotato il Cestino. Qualche file potrebbe essere in uso: riprova tra poco.'),
    };
    return map[code] || tr('disk_error_generic', 'Non è stato possibile completare l’operazione.') + (code ? ' · ' + code : '');
  }

  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(String(path || ''));
      lastReport = { text: tr('disk_path_copied', 'Percorso copiato.') };
    } catch {
      lastReport = { text: tr('disk_copy_failed', 'Copia non riuscita.'), error: true };
    }
    renderAll();
  }

  async function addRoot(rootPath) {
    if (addingRoot || cleaning) return;
    closeAdvisorModal();
    addingRoot = true;
    pendingRootPath = String(rootPath || '');
    lastReport = { pending: true, text: tr('disk_adding_drive', 'Aggiungo il disco all’indice…') };
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
      const found = (status && status.roots || []).find((r) =>
        String(r.path).toLowerCase() === String(rootPath).toLowerCase());
      if (found) {
        selRoot = found.i;
        pendingRootPath = '';
        overview = null;
        treeRoot = null;
        treeStack = [];
        treeError = '';
        lastReport = null;
      }
      startPolling();
    } catch {
      lastReport = { text: tr('disk_add_failed', 'Non sono riuscito ad aggiungere il disco.'), error: true };
    } finally {
      addingRoot = false;
      renderAll();
    }
  }

  // ── Root and header ──────────────────────────────────────────────────────

  function drivePresentation(source) {
    const item = source || {};
    const pathValue = String(item.path || (item.letter ? item.letter + ':\\' : ''));
    const drive = String(item.drive || (item.letter ? item.letter + ':' : '') ||
      ((/^[A-Za-z]:/.exec(pathValue) || [])[0] || '')).toUpperCase();
    const label = String(item.label || '').trim();
    const model = String(item.model || '').trim();
    const fileSystem = String(item.fileSystem || '').trim();
    const isDriveRoot = /^[A-Za-z]:\\?$/.test(pathValue);
    const leaf = pathValue.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || pathValue;
    const primary = isDriveRoot
      ? (label || model || tr('disk_local_drive', 'Disco locale'))
      : leaf;
    const details = [];
    const addDetail = (value) => {
      const text = String(value || '').trim();
      if (!text || details.some((part) => part.toLowerCase() === text.toLowerCase())) return;
      details.push(text);
    };
    addDetail(drive);
    if (isDriveRoot) {
      if (label) addDetail(model);
      addDetail(fileSystem);
    } else {
      addDetail(label || model);
      addDetail(fileSystem);
    }
    const titleParts = [pathValue];
    if (label) titleParts.push(label);
    if (model) titleParts.push(model);
    if (fileSystem) titleParts.push(fileSystem);
    return {
      primary,
      secondary: details.join(' · ') || pathValue,
      title: titleParts.filter(Boolean).join(' · '),
    };
  }

  function appendRootCopy(chip, info, prefix) {
    chip.appendChild(el('strong', '', (prefix || '') + info.primary));
    chip.appendChild(el('small', '', info.secondary));
  }

  function renderRoots() {
    const row = el('div', 'diskw-roots');
    const roots = status && Array.isArray(status.roots) ? status.roots : [];
    for (const root of roots) {
      const info = drivePresentation(root);
      const chip = btn('diskw-root' + (selRoot === root.i ? ' is-active' : ''), '', async () => {
        closeAdvisorModal();
        selRoot = root.i;
        overview = null;
        overviewError = '';
        treeRoot = null;
        treeStack = [];
        treeError = '';
        confirmCat = null;
        activeView = 'overview';
        await loadOverview(true);
      }, info.title);
      appendRootCopy(chip, info);
      chip.setAttribute('aria-pressed', selRoot === root.i ? 'true' : 'false');
      chip.disabled = cleaning;
      row.appendChild(chip);
    }
    if (typeof window.addSearchIndexRoot === 'function' || typeof window.updateSearchSettings === 'function') {
      const have = new Set(roots.map((r) => String(r.path || '').slice(0, 1).toUpperCase()));
      const driveDetails = status && Array.isArray(status.driveDetails)
        ? status.driveDetails
        : (status && Array.isArray(status.drives) ? status.drives : []).map((letter) => ({ letter }));
      for (const driveDetail of driveDetails) {
        const letter = String(driveDetail.letter || driveDetail.drive || '').slice(0, 1).toUpperCase();
        if (!letter) continue;
        if (have.has(letter)) continue;
        const info = drivePresentation({ ...driveDetail, path: letter + ':\\' });
        const chip = btn('diskw-root diskw-root-add', '', () => addRoot(letter + ':\\'),
          tr('disk_add_drive', 'Aggiungi all’indice') + ' · ' + info.title);
        appendRootCopy(chip, info, '+ ');
        chip.disabled = cleaning || addingRoot;
        row.appendChild(chip);
      }
    }
    return row;
  }

  function renderHeader() {
    const head = el('div', 'diskw-head');
    const title = el('div', 'diskw-title-block');
    title.appendChild(el('div', 'diskw-title', tr('disk_title', 'Spazio intelligente')));
    const idx = status && status.index || {};
    const subtitle = idx.building
      ? tr('disk_index_building', 'Sto imparando il disco…') + ' ' + fmtNumber((idx.progress && idx.progress.files) || idx.files) + ' file'
      : fmtNumber(idx.files) + ' ' + tr('disk_index_monitored', 'file monitorati localmente');
    title.appendChild(el('div', 'diskw-subtitle', subtitle));
    head.appendChild(title);

    const actions = el('div', 'diskw-head-actions');
    const badge = el('span', 'diskw-live-badge' + (idx.building ? ' is-building' : ''),
      idx.building ? tr('disk_badge_learning', 'apprendo') : tr('disk_index_ram', 'RAM indice') + ' · ' + (idx.ramMB || 0) + ' MB');
    if (!idx.building) {
      badge.title = tr('disk_index_ram_tip', 'Memoria usata per tenere ricercabili i file. Non è spazio occupato sul disco.');
      badge.setAttribute('aria-label', badge.textContent + '. ' + badge.title);
    }
    actions.appendChild(badge);
    const refreshBtn = btn('diskw-icon-btn', '↻', () => loadOverview(true), tr('disk_refresh', 'Aggiorna analisi'));
    refreshBtn.disabled = cleaning || loadingOverview || selRoot == null;
    actions.appendChild(refreshBtn);
    head.appendChild(actions);
    return head;
  }

  function renderTabs() {
    const nav = el('div', 'diskw-tabs');
    nav.setAttribute('role', 'tablist');
    for (const [id, key, fallback] of VIEW_META) {
      const tab = btn('diskw-tab' + (activeView === id ? ' is-active' : ''), tr(key, fallback), () => {
        withTransition(() => {
          activeView = id;
          confirmCat = null;
          renderAll();
        });
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', activeView === id ? 'true' : 'false');
      tab.disabled = cleaning;
      nav.appendChild(tab);
    }
    return nav;
  }

  // ── Overview ─────────────────────────────────────────────────────────────

  function renderGauge(a) {
    const hero = el('section', 'diskw-capacity');
    const gauge = el('div', 'diskw-gauge');
    const pct = a && a.usedPercent != null ? Math.max(0, Math.min(100, a.usedPercent)) : 0;
    gauge.style.setProperty('--disk-used', pct.toFixed(2) + '%');
    gauge.dataset.pressure = a ? a.state : 'unknown';
    const gaugeInner = el('div', 'diskw-gauge-inner');
    gaugeInner.appendChild(el('strong', '', a && a.freePercent != null ? Math.round(a.freePercent) + '%' : '—'));
    gaugeInner.appendChild(el('span', '', tr('disk_free', 'libero')));
    gauge.appendChild(gaugeInner);
    hero.appendChild(gauge);

    const copy = el('div', 'diskw-capacity-copy');
    const freeText = a && a.capacity
      ? fmtSize(a.free) + ' ' + tr('disk_free_of', 'liberi su') + ' ' + fmtSize(a.capacity)
      : fmtSize(overview.total) + ' ' + tr('disk_indexed', 'indicizzati');
    copy.appendChild(el('div', 'diskw-capacity-main', freeText));
    copy.appendChild(el('div', 'diskw-capacity-sub',
      fmtSize(overview.total) + ' · ' + fmtNumber(overview.files) + ' ' + tr('disk_files', 'file nella mappa')));

    const metrics = el('div', 'diskw-metrics');
    const metricData = [
      [
        tr('disk_safe_now', 'Pulizia consigliata'),
        fmtSize(a ? a.safeBytes : 0),
        'safe',
        tr('disk_safe_now_hint', 'Cache e file temporanei rigenerabili, sempre da confermare prima del Cestino.'),
      ],
      [
        tr('disk_review_space', 'Solo con una tua scelta'),
        fmtSize(a ? a.reviewBytes + a.duplicateBytes : 0),
        'review',
        tr('disk_review_space_hint', 'Installer, build e copie identiche: Xenon non può sapere quali ti servono.'),
      ],
      [
        tr('disk_index_coverage', 'Spazio spiegato'),
        a && a.used ? fmtSize(a.indexedBytes) + ' / ' + fmtSize(a.used) : '—',
        'neutral',
        tr('disk_index_coverage_hint', 'Quanto dello spazio usato è attribuito a file leggibili; il resto può essere protetto, riservato o inaccessibile.'),
      ],
    ];
    for (const [label, value, tone, hint] of metricData) {
      const metric = el('div', 'diskw-metric diskw-tone-' + tone);
      metric.title = hint;
      metric.appendChild(el('span', '', label));
      metric.appendChild(el('strong', '', value));
      metric.appendChild(el('small', '', hint));
      metrics.appendChild(metric);
    }
    copy.appendChild(metrics);
    hero.appendChild(copy);
    return hero;
  }

  function renderAdvisor(a) {
    const card = el('section', 'diskw-advisor');
    const top = el('div', 'diskw-advisor-top');
    const brand = el('div', 'diskw-advisor-brand');
    brand.appendChild(el('span', 'diskw-advisor-mark', '✦'));
    const brandCopy = el('div');
    brandCopy.appendChild(el('div', 'diskw-advisor-title', tr('disk_advisor', 'Xenon Advisor')));
    brandCopy.appendChild(el('div', 'diskw-advisor-mode', tr('disk_advisor_mode', 'analisi locale + AI su richiesta')));
    brand.appendChild(brandCopy);
    top.appendChild(brand);
    const ask = btn('diskw-ai-btn', tr('disk_open_analysis', 'Apri analisi'), openAdvisorModal);
    top.appendChild(ask);
    card.appendChild(top);

    let headline;
    let detail;
    if (a && a.safeBytes > 0) {
      headline = tr('disk_advisor_safe_prefix', 'Puoi recuperare') + ' ' + fmtSize(a.safeBytes) + ' ' +
        tr('disk_advisor_safe_suffix', 'senza toccare documenti personali.');
      const first = a.categories.find((c) => c.risk === 'safe');
      detail = first
        ? categoryName(first.id) + ' · ' + fmtSize(first.bytes) + '. ' + tr('disk_advisor_review_first', 'Rivedi la selezione prima di confermare.')
        : tr('disk_advisor_review_first', 'Rivedi la selezione prima di confermare.');
    } else if (a && a.duplicateBytes > 0) {
      headline = fmtSize(a.duplicateBytes) + ' ' + tr('disk_advisor_dupes', 'in copie identiche verificate.');
      detail = tr('disk_advisor_dupes_detail', 'Xenon non sceglie mai quale originale conservare: confronta le posizioni nella scheda Duplicati.');
    } else {
      const large = a && a.recommendations.find((r) => r.type === 'large_folder');
      headline = tr('disk_advisor_clean', 'Nessun residuo sicuro importante: il disco è già pulito.');
      detail = large
        ? tr('disk_advisor_large', 'La maggiore opportunità è capire se ti serve ancora la cartella più grande, non cancellarla alla cieca.')
        : tr('disk_advisor_clean_detail', 'Continua a usare la mappa per individuare app, giochi o archivi che non usi più.');
    }
    card.appendChild(el('div', 'diskw-advisor-headline', headline));
    card.appendChild(el('div', 'diskw-advisor-detail', detail));

    const safeguards = el('div', 'diskw-safeguards');
    for (const text of [
      tr('disk_guard_human', 'Conferma sempre umana'),
      tr('disk_guard_bin', 'Cestino come undo'),
      tr('disk_guard_ai', 'AI senza permesso di eliminare'),
    ]) safeguards.appendChild(el('span', '', '✓ ' + text));
    card.appendChild(safeguards);
    return card;
  }

  function renderIndexLimitNote() {
    if (!overview || !overview.index || (!overview.index.capped && !overview.index.detailCapped)) return null;
    return el('div', 'diskw-index-note', overview.index.capped
      ? tr('disk_index_capped', 'L’indice ha raggiunto il limite di sicurezza: i numeri sono utili ma non rappresentano ogni file.')
      : tr('disk_detail_capped', 'La mappa è completa; la lista di dettaglio per la pulizia mostra un campione limitato. Aggiorna dopo ogni passaggio.'));
  }

  function advisorAiReady() {
    const settings = typeof hubSettings !== 'undefined' && hubSettings ? hubSettings : {};
    const provider = settings.aiProvider || 'gemini';
    if (provider === 'ollama') return true;
    if (provider === 'openai') return settings.openaiApiKeySet === true;
    if (provider === 'anthropic') return settings.anthropicApiKeySet === true;
    return !!settings.geminiApiKey;
  }

  function advisorFullContext() {
    if (typeof window.getSearchSettings === 'function') {
      const settings = window.getSearchSettings();
      return settings && settings.aiFullContext === true;
    }
    return typeof hubSettings !== 'undefined' && hubSettings && hubSettings.searchSettings &&
      hubSettings.searchSettings.aiFullContext === true;
  }

  function closeAdvisorModal() {
    advisorAiRequest++;
    if (advisorKeyHandler) document.removeEventListener('keydown', advisorKeyHandler);
    advisorKeyHandler = null;
    if (advisorModal) advisorModal.remove();
    advisorModal = null;
    document.body.classList.remove('diskw-advisor-open');
  }

  function advisorStat(label, value, detail) {
    const card = el('div', 'diskw-modal-stat');
    card.appendChild(el('span', '', label));
    card.appendChild(el('strong', '', value));
    card.appendChild(el('small', '', detail));
    return card;
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
    const request = ++advisorAiRequest;
    button.disabled = true;
    output.replaceChildren();
    const busy = el('div', 'diskw-modal-ai-busy');
    busy.appendChild(el('div', 'diskw-spinner'));
    busy.appendChild(el('div', '', tr('disk_ai_working', 'Xenon sta collegando categorie, cartelle, app e possibili effetti…')));
    output.appendChild(busy);
    const controller = new AbortController();
    const uiLang = typeof lang !== 'undefined' ? lang : 'en';
    const out = await api('/api/disk/advisor', { rootIndex: selRoot, lang: uiLang }, {
      controller,
      timeout: 65000,
    });
    if (request !== advisorAiRequest || !advisorModal) return;
    button.disabled = false;
    output.replaceChildren();
    if (out && out.ok && out.text) {
      const meta = el('div', 'diskw-modal-ai-meta');
      meta.appendChild(el('span', '', '✦ ' + tr('disk_ai_report', 'Rapporto AI')));
      meta.appendChild(el('span', '', out.fullContext
        ? tr('disk_ai_full_badge', 'contesto PC autorizzato')
        : tr('disk_ai_snapshot_badge', 'solo fotografia selezionata')));
      output.appendChild(meta);
      const body = el('div', 'diskw-modal-ai-text');
      renderAiMarkdown(body, out.text);
      output.appendChild(body);
    } else {
      const code = out && out.error;
      const message = code === 'no_provider'
        ? tr('disk_ai_no_provider', 'Configura un provider in Impostazioni → Xenon AI. L’analisi locale qui sopra resta completa e disponibile.')
        : code === 'timeout'
          ? tr('disk_ai_timeout', 'Il provider ha impiegato troppo. Nessun dato è stato modificato: puoi riprovare.')
          : tr('disk_ai_failed', 'L’approfondimento AI non è riuscito. L’analisi locale resta disponibile e nessun file è stato toccato.');
      output.appendChild(el('div', 'diskw-modal-ai-error', message));
    }
  }

  function openAdvisorModal() {
    if (!overview) return;
    closeAdvisorModal();
    const a = analysis();
    if (!a) return;
    const overlay = el('div', 'diskw-advisor-modal');
    const dialog = el('section', 'diskw-advisor-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'diskw-advisor-modal-title');

    const head = el('div', 'diskw-modal-head');
    const heading = el('div', 'diskw-modal-heading');
    heading.appendChild(el('span', 'diskw-modal-mark', '✦'));
    const headingCopy = el('div');
    const modalTitle = el('h2', '', tr('disk_modal_title', 'Xenon Storage Advisor'));
    modalTitle.id = 'diskw-advisor-modal-title';
    headingCopy.appendChild(modalTitle);
    const selectedRoot = (status && status.roots || []).find((root) => root.i === selRoot);
    const rootInfo = drivePresentation(selectedRoot || { path: overview.root });
    headingCopy.appendChild(el('p', '', rootInfo.primary + ' · ' + rootInfo.secondary));
    heading.appendChild(headingCopy);
    head.appendChild(heading);
    head.appendChild(btn('diskw-modal-close', '×', closeAdvisorModal, tr('disk_close', 'Chiudi')));
    dialog.appendChild(head);

    const localNotice = el('div', 'diskw-modal-local');
    localNotice.appendChild(el('strong', '', '✓ ' + tr('disk_local_analysis', 'Analisi locale pronta')));
    localNotice.appendChild(el('span', '', tr('disk_local_analysis_detail', 'Questa prima analisi nasce sul PC e non usa né richiede l’AI.')));
    dialog.appendChild(localNotice);

    const stats = el('div', 'diskw-modal-stats');
    stats.appendChild(advisorStat(
      tr('disk_used_space', 'Spazio usato'),
      fmtSize(a.used),
      tr('disk_used_space_hint', 'capacità meno spazio libero')));
    stats.appendChild(advisorStat(
      tr('disk_free_space', 'Spazio libero'),
      fmtSize(a.free),
      a.freePercent != null ? Math.round(a.freePercent) + '%' : '—'));
    stats.appendChild(advisorStat(
      tr('disk_recommended_cleanup', 'Pulizia consigliata'),
      fmtSize(a.safeBytes),
      tr('disk_recommended_cleanup_hint', 'cache e temporanei rigenerabili')));
    stats.appendChild(advisorStat(
      tr('disk_personal_decision', 'Scelta personale'),
      fmtSize(a.reviewBytes + a.duplicateBytes),
      tr('disk_personal_decision_hint', 'Xenon non decide al posto tuo')));
    dialog.appendChild(stats);

    const present = a.categories.filter((category) => category.bytes > 0 || category.count > 0);
    const chartSection = el('section', 'diskw-modal-section');
    chartSection.appendChild(el('h3', '', tr('disk_recovery_map', 'Dove si trova il possibile recupero')));
    chartSection.appendChild(el('p', 'diskw-modal-section-intro',
      tr('disk_recovery_map_hint', 'Il colore indica il tipo di decisione, non un’autorizzazione a cancellare automaticamente.')));
    const chartTotal = Math.max(1, present.reduce((sum, category) => sum + category.bytes, 0) + a.duplicateBytes);
    const chart = el('div', 'diskw-modal-chart');
    const chartRows = [...present.map((category) => ({
      label: categoryName(category.id),
      bytes: category.bytes,
      risk: category.risk,
    }))];
    if (a.duplicateBytes > 0) {
      chartRows.push({
        label: tr('disk_verified_copies', 'Copie identiche verificate'),
        bytes: a.duplicateBytes,
        risk: 'review',
      });
    }
    chartRows.sort((left, right) => right.bytes - left.bytes);
    if (!chartRows.length) {
      chart.appendChild(el('div', 'diskw-modal-empty',
        tr('disk_no_cleanup_candidates', 'Non risultano candidati di pulizia in questa fotografia.')));
    }
    for (const item of chartRows) {
      const row = el('div', 'diskw-modal-chart-row diskw-risk-' + item.risk);
      const rowHead = el('div');
      rowHead.appendChild(el('span', '', item.label));
      rowHead.appendChild(el('strong', '', fmtSize(item.bytes)));
      row.appendChild(rowHead);
      const bar = el('div', 'diskw-modal-chart-track');
      const fill = el('span', '');
      fill.style.width = Math.max(2, Math.min(100, item.bytes / chartTotal * 100)) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      chart.appendChild(row);
    }
    chartSection.appendChild(chart);
    dialog.appendChild(chartSection);

    const guideSection = el('section', 'diskw-modal-section');
    guideSection.appendChild(el('h3', '', tr('disk_cleanup_encyclopedia', 'Cosa sono, cosa succede, come limitarli')));
    guideSection.appendChild(el('p', 'diskw-modal-section-intro',
      tr('disk_cleanup_encyclopedia_hint', 'Ogni voce è spiegata prima che tu debba prendere una decisione.')));
    const guides = el('div', 'diskw-modal-guides');
    for (const category of present) {
      const meta = CAT_META[category.id] || { icon: '•', desc: ['', ''] };
      const guide = CATEGORY_GUIDE[category.id] || {};
      const card = el('article', 'diskw-modal-guide diskw-risk-' + category.risk);
      const cardHead = el('div', 'diskw-modal-guide-head');
      cardHead.appendChild(el('span', 'diskw-cat-icon', meta.icon));
      const cardTitle = el('div');
      cardTitle.appendChild(el('strong', '', categoryName(category.id)));
      cardTitle.appendChild(el('small', '', category.risk === 'safe'
        ? tr('disk_risk_recommended', 'Consigliata, con conferma')
        : category.risk === 'permanent'
          ? tr('disk_risk_permanent', 'Definitiva')
          : tr('disk_risk_your_choice', 'Decidi tu')));
      cardHead.appendChild(cardTitle);
      const amount = el('div', 'diskw-modal-guide-size');
      amount.appendChild(el('strong', '', fmtSize(category.bytes)));
      amount.appendChild(el('small', '', fmtNumber(category.count) + ' ' + tr('disk_items', 'elementi')));
      cardHead.appendChild(amount);
      card.appendChild(cardHead);
      card.appendChild(advisorFact(
        tr('disk_what_is_it', 'Cos’è e a cosa serve'),
        tr(meta.desc[0], meta.desc[1])));
      if (guide.after) {
        card.appendChild(advisorFact(
          tr('disk_after_cleaning', 'Cosa succede dopo'),
          tr(guide.after[0], guide.after[1])));
      }
      if (guide.prevent) {
        card.appendChild(advisorFact(
          tr('disk_reduce_recurrence', 'Come farlo tornare meno'),
          tr(guide.prevent[0], guide.prevent[1])));
      }
      card.appendChild(btn('diskw-modal-review', category.id === 'recycleBin'
        ? tr('disk_review_bin', 'Controlla il Cestino')
        : tr('disk_review_items', 'Rivedi gli elementi'), () => {
        closeAdvisorModal();
        activeView = 'clean';
        beginReview(category.id);
      }));
      guides.appendChild(card);
    }
    if (!present.length) {
      guides.appendChild(el('div', 'diskw-modal-empty',
        tr('disk_already_clean', 'Non ci sono categorie di pulizia attive: il valore del widget è soprattutto capire dove si trova lo spazio.')));
    }
    guideSection.appendChild(guides);
    dialog.appendChild(guideSection);

    const largestSection = el('section', 'diskw-modal-section');
    largestSection.appendChild(el('h3', '', tr('disk_largest_not_delete', 'Più grandi non significa eliminabili')));
    largestSection.appendChild(el('p', 'diskw-modal-section-intro',
      tr('disk_largest_not_delete_hint', 'Questi elementi spiegano il disco; non entrano nella pulizia automatica. Disinstalla app e giochi dal loro gestore quando possibile.')));
    const largest = el('div', 'diskw-modal-largest');
    const rootPath = String(overview.root || '').replace(/\\+$/, '').toLowerCase();
    const folders = (overview.tree || []).filter((item) =>
      String(item.p || '').replace(/\\+$/, '').toLowerCase() !== rootPath).slice(0, 6);
    const files = (overview.topFiles || []).slice(0, 6);
    for (const item of [...folders.map((entry) => ({ ...entry, kind: 'folder' })),
      ...files.map((entry) => ({ ...entry, kind: 'file' }))]) {
      const row = el('div', 'diskw-modal-largest-row');
      row.appendChild(el('span', 'diskw-path-icon', item.kind === 'folder' ? '▰' : '▤'));
      const copy = el('div');
      copy.appendChild(el('strong', '', item.kind === 'folder'
        ? pathLeaf(item.p)
        : (item.n || pathLeaf(item.p))));
      copy.appendChild(el('span', '', ltrPath(item.p)));
      row.appendChild(copy);
      row.appendChild(el('b', '', fmtSize(item.s)));
      largest.appendChild(row);
    }
    if (!folders.length && !files.length) {
      largest.appendChild(el('div', 'diskw-modal-empty', tr('disk_no_large_items', 'Nessun elemento grande disponibile.')));
    }
    largestSection.appendChild(largest);
    const guard = el('div', 'diskw-modal-do-not-touch');
    guard.appendChild(el('strong', '', tr('disk_never_auto_title', 'Xenon non decide mai su questi dati')));
    guard.appendChild(el('p', '', tr('disk_never_auto_detail',
      'Documenti, foto, video, cartelle delle app, file di sistema, dati riservati e copie identiche restano fuori dalla pulizia consigliata finché una regola chiusa e le protezioni non dicono il contrario.')));
    largestSection.appendChild(guard);
    dialog.appendChild(largestSection);

    const aiSection = el('section', 'diskw-modal-section diskw-modal-ai');
    const aiHead = el('div', 'diskw-modal-ai-head');
    const aiCopy = el('div');
    aiCopy.appendChild(el('h3', '', tr('disk_ai_deep_title', 'Approfondimento con la tua AI')));
    const fullContext = advisorFullContext();
    aiCopy.appendChild(el('p', '', fullContext
      ? tr('disk_ai_share_full', 'Su tua autorizzazione, il provider riceve nomi e pesi di questa fotografia più app installate, cartelle frequenti e aperture recenti. Mai il contenuto dei file.')
      : tr('disk_ai_share_snapshot', 'Solo se premi il pulsante, il provider riceve nomi, percorsi, pesi e categorie di questa fotografia. Mai il contenuto dei file.')));
    aiHead.appendChild(aiCopy);
    const aiButton = btn('diskw-ai-btn', tr('disk_ai_deepen', 'Approfondisci con AI'), () => {});
    aiHead.appendChild(aiButton);
    aiSection.appendChild(aiHead);
    const aiOutput = el('div', 'diskw-modal-ai-output');
    if (advisorAiReady()) {
      aiOutput.appendChild(el('div', 'diskw-modal-ai-ready',
        tr('disk_ai_optional', 'Facoltativo: l’analisi locale sopra funziona già senza inviare nulla.')));
      aiButton.addEventListener('click', () => runAdvisorAi(aiButton, aiOutput));
    } else {
      aiButton.textContent = tr('disk_ai_configure', 'Configura Xenon AI');
      aiButton.addEventListener('click', () => {
        closeAdvisorModal();
        if (typeof toggleSettings === 'function') toggleSettings();
        if (typeof settingsSetCategory === 'function') settingsSetCategory('ai');
      });
      aiOutput.appendChild(el('div', 'diskw-modal-ai-ready',
        tr('disk_ai_not_enabled', 'Nessuna AI configurata: non c’è alcun errore. Tutti i numeri e le spiegazioni locali restano disponibili.')));
    }
    aiSection.appendChild(aiOutput);
    dialog.appendChild(aiSection);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeAdvisorModal();
    });
    advisorKeyHandler = (event) => {
      if (event.key !== 'Escape' || !advisorModal) return;
      closeAdvisorModal();
    };
    document.addEventListener('keydown', advisorKeyHandler);
    advisorModal = overlay;
    document.body.appendChild(overlay);
    document.body.classList.add('diskw-advisor-open');
    dialog.querySelector('.diskw-modal-close').focus();
  }

  function childrenOf(rootPath) {
    const tree = overview && Array.isArray(overview.tree) ? overview.tree : [];
    const rootLower = String(rootPath || '').toLowerCase().replace(/\\+$/, '');
    const kids = [];
    let rootEntry = null;
    for (const dir of tree) {
      const p = String(dir.p || '').toLowerCase().replace(/\\+$/, '');
      if (p === rootLower) { rootEntry = dir; continue; }
      const cut = p.lastIndexOf('\\');
      if (cut >= 0 && p.slice(0, cut) === rootLower) kids.push(dir);
    }
    kids.sort((a, b) => b.s - a.s);
    const directFiles = (overview && Array.isArray(overview.topFiles) ? overview.topFiles : [])
      .filter((file) => {
        const p = String(file.p || '').toLowerCase();
        return p.slice(0, p.lastIndexOf('\\')) === rootLower;
      })
      .map((file) => ({ ...file, file: true }));
    const covered = kids.reduce((sum, dir) => sum + (dir.s || 0), 0) +
      directFiles.reduce((sum, file) => sum + (file.s || 0), 0);
    const total = rootEntry ? rootEntry.s : (treeRoot === overview.root.replace(/\\+$/, '') ? overview.total : covered);
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

  async function openTreeNode(ref) {
    if (!ref || ref.file || ref.other || ref.grouped || treeLoading) return;
    treeOtherOpen = false;
    treeOtherItems = null;
    if (!ref.id) {
      // Compatibility with a server that has not restarted onto the opaque-id
      // drill-down yet: the snapshot can still navigate its known directories.
      withTransition(() => {
        treeRoot = ref.p;
        treeError = '';
        renderAll();
      });
      return;
    }
    const request = ++treeRequest;
    treeLoading = true;
    treeError = '';
    renderAll();
    const out = await api('/disk/browse?i=' + encodeURIComponent(selRoot) +
      '&node=' + encodeURIComponent(ref.id));
    if (request !== treeRequest) return;
    treeLoading = false;
    if (out && out.ok) {
      treeStack.push(out);
      treeRoot = out.path;
    } else {
      treeError = out && out.error || 'index_unavailable';
    }
    renderAll();
  }

  // A treemap with dozens of cells turns small folders into pixel-sized squares
  // no finger can hit on the Edge. Keep as a tile only what is big enough to
  // read and touch; fold the rest into ONE "Altre N voci" tile that opens a
  // tappable list. The floors keep the map from emptying out when folders are
  // evenly sized.
  const TREEMAP_MAX_TILES = 14;    // hard cap on standalone tiles
  const TREEMAP_MIN_TILES = 4;     // always show at least this many, even if small
  const TREEMAP_MIN_SHARE = 0.02;  // a tile must be ≥2% of the level to stand alone

  // Split the level's entries into standalone tiles and a grouped remainder.
  // `entries` is size-desc and may end with a server "other" (unlisted bytes).
  function splitTreemapEntries(entries) {
    const serverOther = entries.find((e) => e.other) || null;
    const real = entries.filter((e) => !e.other);
    const totalBytes = real.reduce((s, e) => s + (e.s || 0), 0) + (serverOther ? serverOther.s || 0 : 0);
    const tiles = [];
    const grouped = [];
    real.forEach((ref, i) => {
      const share = totalBytes > 0 ? (ref.s || 0) / totalBytes : 0;
      const keep = tiles.length < TREEMAP_MAX_TILES && (share >= TREEMAP_MIN_SHARE || i < TREEMAP_MIN_TILES);
      if (keep) tiles.push(ref); else grouped.push(ref);
    });
    // A lone leftover with nothing unlisted behind it is better shown than hidden.
    if (grouped.length === 1 && !serverOther) { tiles.push(grouped.pop()); }
    const residual = serverOther ? (serverOther.s || 0) : 0;
    // groupedBytes counts ONLY the real small entries — the residual is unlisted
    // space, not "an item", and folding it in made a tile say "3 items · 50 GB"
    // when 50 GB of that was unattributed. It gets its own tile below.
    const groupedBytes = grouped.reduce((s, e) => s + (e.s || 0), 0);
    return { tiles, grouped, groupedBytes, residual, totalBytes };
  }

  function openOtherList(items, bytes, residual) {
    treeOtherItems = items;
    treeOtherBytes = bytes;
    treeOtherResidual = residual;
    treeOtherOpen = true;
    renderAll();
  }
  function closeOtherList() {
    treeOtherOpen = false;
    treeOtherItems = null;
    renderAll();
  }

  function squarify(items, x, y, w, h, out) {
    if (!items.length || w <= 0 || h <= 0) return;
    let row = [];
    let rest = items;
    const total = items.reduce((sum, item) => sum + item.area, 0);
    if (!total) return;
    const scale = (w * h) / total;
    const worst = (test) => {
      const sum = test.reduce((acc, item) => acc + item.area * scale, 0);
      const short = Math.min(w, h);
      let ratio = 0;
      for (const item of test) {
        const area = item.area * scale;
        ratio = Math.max(ratio, (short * short * area) / (sum * sum), (sum * sum) / (short * short * area));
      }
      return ratio;
    };
    while (rest.length) {
      const next = [...row, rest[0]];
      if (row.length && worst(next) > worst(row)) break;
      row = next;
      rest = rest.slice(1);
    }
    const sum = row.reduce((acc, item) => acc + item.area * scale, 0);
    if (w >= h) {
      const columnWidth = sum / h;
      let cy = y;
      for (const item of row) {
        const cellHeight = (item.area * scale) / columnWidth;
        out.push({ item, x, y: cy, w: columnWidth, h: cellHeight });
        cy += cellHeight;
      }
      squarify(rest, x + columnWidth, y, w - columnWidth, h, out);
    } else {
      const rowHeight = sum / w;
      let cx = x;
      for (const item of row) {
        const cellWidth = (item.area * scale) / rowHeight;
        out.push({ item, x: cx, y, w: cellWidth, h: rowHeight });
        cx += cellWidth;
      }
      squarify(rest, x, y + rowHeight, w, h - rowHeight, out);
    }
  }

  function renderTreemap() {
    const section = el('section', 'diskw-section diskw-map-section');
    const head = el('div', 'diskw-section-head');
    const title = el('div');
    title.appendChild(el('h3', '', tr('disk_space_map', 'Mappa dello spazio')));
    // At the root, prefer the root's own browse (complete: system files + real
    // unlisted bytes) over overview.tree; fall back to the tree until it lands.
    const currentBrowse = treeStack.length
      ? treeStack[treeStack.length - 1]
      : (rootBrowse && rootBrowse.ok ? rootBrowse : null);
    const currentPath = currentBrowse ? currentBrowse.path : (treeRoot || overview.root);
    title.appendChild(el('p', '', ltrPath(currentPath)));
    head.appendChild(title);
    const base = overview.root.replace(/\\+$/, '');
    if (currentPath && currentPath.replace(/\\+$/, '') !== base) {
      head.appendChild(btn('diskw-small-btn', '← ' + tr('disk_up', 'Su'), () => {
        treeOtherOpen = false;
        treeOtherItems = null;
        withTransition(() => {
          if (treeStack.length) {
            treeStack.pop();
            treeRoot = treeStack.length ? treeStack[treeStack.length - 1].path : base;
          } else {
            const cut = treeRoot.lastIndexOf('\\');
            treeRoot = cut > 1 ? treeRoot.slice(0, cut) : base;
          }
          treeError = '';
          renderAll();
        });
      }));
    }
    section.appendChild(head);

    if (treeLoading) {
      const loading = el('div', 'diskw-map-loading');
      loading.appendChild(el('div', 'diskw-spinner'));
      loading.appendChild(el('span', '', tr('disk_map_opening', 'Leggo file e sottocartelle…')));
      section.appendChild(loading);
      return section;
    }
    if (treeError) {
      const error = el('div', 'diskw-map-error');
      error.appendChild(el('strong', '', tr('disk_map_error', 'Non sono riuscito ad aprire questo livello.')));
      error.appendChild(el('span', '', friendlyError(treeError)));
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
        node = el('div', 'diskw-cell diskw-cell-file');
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
    if (treeOtherOpen && treeOtherItems) map.appendChild(renderOtherList());
    section.appendChild(map);
    if (!treeOtherOpen && directBytes > 0) {
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
      tr('disk_map_other_n', 'Altre {n} voci').replace('{n}', fmtNumber((treeOtherItems || []).length + (treeOtherResidual > 0 ? 1 : 0)))));
    titles.appendChild(el('span', 'diskw-otherlist-sub', fmtSize(treeOtherBytes)));
    head.appendChild(titles);
    head.appendChild(btn('diskw-modal-close', '×', closeOtherList, tr('disk_close', 'Chiudi')));
    panel.appendChild(head);

    const list = el('div', 'diskw-otherlist-rows');
    for (const ref of treeOtherItems || []) {
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
    if (treeOtherResidual > 0) {
      const row = el('div', 'diskw-otherlist-row is-file');
      row.appendChild(el('span', 'diskw-otherlist-icon', '…'));
      row.appendChild(el('span', 'diskw-otherlist-name', tr('disk_map_residual', 'Spazio non ancora elencato')));
      row.appendChild(el('span', 'diskw-otherlist-size', fmtSize(treeOtherResidual)));
      list.appendChild(row);
    }
    panel.appendChild(list);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closeOtherList(); });
    return overlay;
  }

  function renderOverview() {
    const wrap = el('div', 'diskw-view');
    const a = analysis();
    wrap.appendChild(renderGauge(a));
    const limitNote = renderIndexLimitNote();
    if (limitNote) wrap.appendChild(limitNote);
    wrap.appendChild(renderAdvisor(a));
    wrap.appendChild(renderTreemap());
    return wrap;
  }

  // ── Safe cleanup ─────────────────────────────────────────────────────────

  function categoryItems(cat) {
    const category = overview && overview.categories ? overview.categories[cat] : null;
    return category && Array.isArray(category.items) ? category.items : [];
  }

  function beginReview(cat) {
    confirmCat = cat;
    selectedIds = new Set(categoryItems(cat).map((item) => item.i));
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
    const intro = el('section', 'diskw-clean-summary');
    intro.appendChild(el('span', 'diskw-clean-summary-kicker', tr('disk_cleanup_plan', 'Piano di pulizia protetto')));
    intro.appendChild(el('strong', '', fmtSize(a ? a.safeBytes : 0)));
    intro.appendChild(el('p', '', tr('disk_cleanup_plan_desc', 'Classificati come rigenerabili dalle regole chiuse di Xenon. Scegli comunque ogni elemento prima del Cestino.')));
    wrap.appendChild(intro);
    const limitNote = renderIndexLimitNote();
    if (limitNote) wrap.appendChild(limitNote);

    const grid = el('div', 'diskw-cats');
    const cats = overview.categories || {};
    const order = Object.keys(CAT_META).filter((cat) => cats[cat] && (cats[cat].bytes > 0 || cats[cat].count > 0));
    if (!order.length) grid.appendChild(el('div', 'diskw-empty diskw-empty-card', tr('disk_cats_empty', 'Niente di sicuro da pulire trovato')));
    else for (const cat of order) grid.appendChild(renderCategoryCard(cat, cats[cat]));
    wrap.appendChild(grid);
    return wrap;
  }

  function selectedSummary(cat) {
    const items = categoryItems(cat);
    let bytes = 0;
    let count = 0;
    for (const item of items) {
      if (!selectedIds.has(item.i)) continue;
      bytes += Number(item.s) || 0;
      count++;
    }
    return { bytes, count };
  }

  function renderConfirm() {
    const cat = confirmCat;
    const category = overview.categories[cat] || { items: [] };
    const meta = CAT_META[cat] || { risk: 'review' };
    const box = el('section', 'diskw-confirm diskw-risk-' + meta.risk);
    const head = el('div', 'diskw-confirm-head');
    const title = el('div');
    title.appendChild(el('span', 'diskw-confirm-kicker', riskLabel(meta.risk)));
    title.appendChild(el('h3', '', categoryName(cat)));
    head.appendChild(title);
    head.appendChild(btn('diskw-icon-btn', '×', () => { confirmCat = null; selectedIds.clear(); renderAll(); }, tr('disk_cancel', 'Annulla')));
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
        selectedIds = summary.count === all.length ? new Set() : new Set(all.map((item) => item.i));
        renderAll();
      }));
      box.appendChild(selection);

      const list = el('div', 'diskw-confirm-list');
      for (const item of all) {
        const label = el('label', 'diskw-confirm-row');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selectedIds.has(item.i);
        check.addEventListener('change', () => {
          if (check.checked) selectedIds.add(item.i); else selectedIds.delete(item.i);
          renderAll();
        });
        label.appendChild(check);
        const copy = el('span', 'diskw-confirm-copy');
        copy.appendChild(el('span', 'diskw-confirm-path', ltrPath(item.p)));
        copy.appendChild(el('small', '', (item.kind === 'dir' ? tr('disk_folder', 'Cartella') : tr('disk_file', 'File')) + ' · ' + fmtSize(item.s)));
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
      cleaning ? tr('disk_cleaning', 'Pulizia…') : (cat === 'recycleBin' ? tr('disk_confirm_empty', 'Svuota definitivamente') : tr('disk_confirm_move', 'Sposta nel Cestino')),
      () => runClean(cat));
    confirm.disabled = cleaning || (cat !== 'recycleBin' && summary.count === 0);
    actions.appendChild(confirm);
    actions.appendChild(btn('diskw-btn', tr('disk_cancel', 'Annulla'), () => { confirmCat = null; selectedIds.clear(); renderAll(); }));
    box.appendChild(actions);
    return box;
  }

  function renderCleaning() {
    const state = cleanState || {};
    const refreshing = state.phase === 'refreshing';
    const permanent = state.permanent === true;
    const box = el('section', 'diskw-clean-loader' + (permanent ? ' is-permanent' : ''));
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-busy', 'true');

    const hero = el('div', 'diskw-clean-loader-hero');
    const orbit = el('div', 'diskw-clean-orbit');
    orbit.appendChild(el('span', '', permanent ? '⌫' : '↻'));
    hero.appendChild(orbit);
    const copy = el('div', 'diskw-clean-loader-copy');
    copy.appendChild(el('span', 'diskw-clean-loader-kicker',
      tr('disk_clean_operation', 'Operazione protetta')));
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
    const selectedRoot = (status && status.roots || []).find((root) => root.i === selRoot);
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
    if (!refreshing && !permanent && cleanState && cleanState.id != null && !state.cancelled) {
      const cancel = btn('diskw-btn diskw-clean-cancel', tr('disk_clean_stop', 'Interrompi'), () => cancelClean());
      box.appendChild(cancel);
    } else if (state.cancelled && !refreshing) {
      box.appendChild(el('p', 'diskw-clean-count', tr('disk_clean_stopping', 'Interruzione al termine del gruppo in corso…')));
    }
    return box;
  }

  async function runClean(cat) {
    if (cleaning) return;
    const ids = cat === 'recycleBin' ? [] : [...selectedIds];
    const summary = selectedSummary(cat);
    cleaning = true;
    cleanState = {
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
    confirmCat = null;
    lastReport = null;
    renderAll();
    const out = await api('/disk/clean', { root: selRoot, category: cat, ids });
    selectedIds.clear();

    // Every cleanup — bin emptying included — is a background job: the POST
    // only accepts it, and the SSE `disk_clean` stream (onCleanProgress)
    // drives the rest.
    if (out && out.ok && out.started) {
      cleanState.id = out.id;
      renderAll();
      return;
    }
    // Rejected before it began (busy, nothing approved, bad selection…).
    cleaning = false;
    cleanState = null;
    lastReport = { text: friendlyError(out && out.error), error: true };
    renderAll();
  }

  // Progress + completion for a background category cleanup, pushed over SSE.
  // Also the re-attach path: a page loaded while a job runs adopts it here (or
  // via adoptCleanFromStatus on the next poll).
  async function onCleanProgress(snap) {
    if (!snap) return;
    // Ignore a stale event from a job we already finished, but always adopt a
    // running job we are not yet tracking (the reload case).
    if (cleanState && cleanState.id != null && snap.id != null && snap.id !== cleanState.id) return;
    if (!cleaning && snap.running) {
      cleaning = true;
      confirmCat = null;
      lastReport = null;
    }
    if (!cleaning && !snap.running) return;           // nothing we care about

    cleanState = {
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
    cleaning = false;
    cleanState = null;
    lastReport = report;
    renderAll();
  }

  // A cleanup already running when the widget (re)loads: adopt it from the
  // status snapshot so the loader shows instead of stale category cards.
  function adoptCleanFromStatus() {
    const snap = status && status.clean;
    if (!snap) return;
    if (snap.running && !cleaning) {
      void onCleanProgress(snap);
    }
  }

  async function cancelClean() {
    if (!cleaning || !cleanState || cleanState.permanent) return;
    await api('/disk/clean/cancel', {});
    // The SSE 'done' event delivers the final report; nothing else to do here.
  }

  // ── Explore and duplicates ───────────────────────────────────────────────

  function renderPathRow(item, kind) {
    const row = el('div', 'diskw-path-row');
    const icon = el('span', 'diskw-path-icon', kind === 'folder' ? '▰' : '▤');
    row.appendChild(icon);
    const copy = el('div', 'diskw-path-copy');
    const path = String(item.p || '');
    copy.appendChild(el('strong', '', kind === 'folder' ? path.split('\\').filter(Boolean).pop() || path : item.n || path.split('\\').pop()));
    copy.appendChild(el('span', '', ltrPath(path)));
    row.appendChild(copy);
    row.appendChild(el('b', 'diskw-path-size', fmtSize(item.s)));
    row.appendChild(btn('diskw-copy-btn', '⧉', () => copyPath(path), tr('disk_copy_path', 'Copia percorso')));
    return row;
  }

  function renderExplore() {
    const wrap = el('div', 'diskw-view diskw-explore');
    const folders = el('section', 'diskw-section');
    folders.appendChild(el('h3', '', tr('disk_top_folders', 'Cartelle più grandi')));
    const base = overview.root.replace(/\\+$/, '').toLowerCase();
    const topFolders = (overview.tree || []).filter((dir) =>
      String(dir.p || '').replace(/\\+$/, '').toLowerCase() !== base).slice(0, 14);
    for (const dir of topFolders) folders.appendChild(renderPathRow(dir, 'folder'));
    if (!topFolders.length) folders.appendChild(el('div', 'diskw-empty', tr('disk_tree_empty', 'Nessuna sottocartella rilevante qui')));
    wrap.appendChild(folders);

    const files = el('section', 'diskw-section');
    files.appendChild(el('h3', '', tr('disk_top_files', 'File più grandi')));
    for (const file of (overview.topFiles || []).slice(0, 16)) files.appendChild(renderPathRow(file, 'file'));
    if (!(overview.topFiles || []).length) files.appendChild(el('div', 'diskw-empty', tr('disk_no_files', 'Nessun file disponibile.')));
    wrap.appendChild(files);
    return wrap;
  }

  function renderDuplicates() {
    const wrap = el('div', 'diskw-view');
    const dupes = overview.dupes || [];
    const total = dupes.reduce((sum, group) => sum + (group.wasted || 0), 0);
    const intro = el('section', 'diskw-dupe-intro');
    intro.appendChild(el('span', 'diskw-clean-summary-kicker', tr('disk_hash_verified', 'SHA-256 verificato')));
    intro.appendChild(el('strong', '', fmtSize(total)));
    intro.appendChild(el('p', '', tr('disk_dupes_note', 'Identici byte per byte. Xenon non elimina automaticamente una copia perché solo tu sai quale posizione è quella giusta.')));
    wrap.appendChild(intro);

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
      for (const path of group.paths) {
        const row = el('div', 'diskw-dupe-path');
        row.appendChild(el('span', '', ltrPath(path)));
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
    card.appendChild(el('div', 'diskw-spinner'));
    card.appendChild(el('strong', '', loadingSlow
      ? tr('disk_loading_slow', 'Sto aggregando milioni di file…')
      : tr('disk_loading', 'Compongo la mappa live…')));
    card.appendChild(el('p', '', loadingSlow
      ? tr('disk_loading_slow_detail', 'La prima fotografia di un disco molto grande può richiedere qualche secondo; le successive vengono riutilizzate.')
      : tr('disk_loading_detail', 'Dimensioni, cartelle grandi e duplicati vengono letti in una sola fotografia coerente.')));
    return card;
  }

  function renderError() {
    const card = el('div', 'diskw-state-card diskw-state-error');
    card.appendChild(el('strong', '', tr('disk_error_title', 'Questa vista non è arrivata')));
    card.appendChild(el('p', '', friendlyError(overviewError)));
    card.appendChild(btn('diskw-btn diskw-btn-accent', tr('disk_retry', 'Riprova'), () => loadOverview(true)));
    return card;
  }

  function renderReport() {
    if (!lastReport) return null;
    const cls = 'diskw-report' + (lastReport.error ? ' is-error' : lastReport.warning ? ' is-warning' : '');
    return el('div', cls, lastReport.pending ? (lastReport.text || tr('disk_cleaning', 'Pulizia…')) : lastReport.text);
  }

  function render(mount) {
    mount.replaceChildren();
    if (!status) {
      mount.appendChild(renderLoading());
      return;
    }
    if (!status.helper) {
      const hint = el('div', 'diskw-hint');
      hint.appendChild(el('div', 'diskw-hint-mark', '◌'));
      hint.appendChild(el('div', 'diskw-hint-title', tr('disk_helper_title', 'Serve Xenon Helper')));
      hint.appendChild(el('div', 'diskw-hint-text', tr('disk_helper_text', 'L’analisi del disco usa il componente nativo opzionale, installato da INSTALL.bat.')));
      mount.appendChild(hint);
      return;
    }

    mount.appendChild(renderHeader());
    mount.appendChild(renderRoots());
    const report = renderReport();
    if (report) mount.appendChild(report);

    const roots = status.roots || [];
    if (!roots.length) {
      const hint = el('div', 'diskw-hint');
      hint.appendChild(el('div', 'diskw-hint-mark', '✦'));
      hint.appendChild(el('div', 'diskw-hint-title', tr('disk_enable_title', 'Accendi l’indice vivo')));
      hint.appendChild(el('div', 'diskw-hint-text', tr('disk_enable_text', 'Scegli i dischi da tenere indicizzati in tempo reale.')));
      mount.appendChild(hint);
      return;
    }
    if (cleaning && cleanState) {
      if (overview) mount.appendChild(renderTabs());
      mount.appendChild(renderCleaning());
      return;
    }
    if (loadingOverview) {
      mount.appendChild(renderLoading());
      return;
    }
    if (overviewError) {
      mount.appendChild(renderError());
      return;
    }
    if (!overview) {
      const idx = status.index || {};
      const empty = el('div', 'diskw-state-card');
      empty.appendChild(el('strong', '', idx.building
        ? tr('disk_index_building', 'Sto imparando il disco…')
        : tr('disk_pick_root', 'Tocca un disco o una cartella qui sopra.')));
      if (idx.building) empty.appendChild(el('p', '', fmtNumber((idx.progress && idx.progress.files) || idx.files) + ' file'));
      mount.appendChild(empty);
      return;
    }

    mount.appendChild(renderTabs());
    if (confirmCat) mount.appendChild(renderConfirm());
    else if (activeView === 'clean') mount.appendChild(renderClean());
    else if (activeView === 'explore') mount.appendChild(renderExplore());
    else if (activeView === 'duplicates') mount.appendChild(renderDuplicates());
    else mount.appendChild(renderOverview());
  }

  function renderAll() {
    document.querySelectorAll('.disk-widget-mount').forEach(render);
  }

  async function loadOverview(refresh) {
    if (selRoot == null || loadingOverview && !refresh) return;
    const requestId = ++overviewRequest;
    if (overviewAbort) overviewAbort.abort();
    overviewAbort = new AbortController();
    const requestedRoot = selRoot;
    loadingOverview = true;
    loadingSlow = false;
    overviewError = '';
    if (loadingSlowTimer) clearTimeout(loadingSlowTimer);
    loadingSlowTimer = setTimeout(() => {
      if (loadingOverview && overviewRequest === requestId) {
        loadingSlow = true;
        renderAll();
      }
    }, 2800);
    renderAll();
    const out = await api('/disk/overview?i=' + encodeURIComponent(requestedRoot) + (refresh ? '&refresh=1' : ''), null, {
      controller: overviewAbort,
      timeout: OVERVIEW_TIMEOUT_MS,
    });
    if (requestId !== overviewRequest || requestedRoot !== selRoot) return;
    loadingOverview = false;
    loadingSlow = false;
    overviewAbort = null;
    if (loadingSlowTimer) { clearTimeout(loadingSlowTimer); loadingSlowTimer = null; }
    if (out && out.ok) {
      overview = out;
      overviewError = '';
      treeRoot = out.root.replace(/\\+$/, '');
      treeStack = [];
      treeError = '';
      rootBrowse = null;
      treeOtherOpen = false;
      treeOtherItems = null;
      // Pull the root's real contents (files + folders) so the map matches what
      // drilling in shows. Best-effort: the map falls back to overview.tree
      // until this lands (or if the server predates browse).
      void loadRootBrowse(out.rootId, requestId);
    } else {
      overview = null;
      overviewError = out && out.error || 'index_unavailable';
    }
    renderAll();
  }

  async function loadRootBrowse(rootId, requestId) {
    if (!rootId || selRoot == null) return;
    const out = await api('/disk/browse?i=' + encodeURIComponent(selRoot) + '&node=' + encodeURIComponent(rootId));
    if (requestId !== overviewRequest) return;   // a newer overview superseded us
    if (out && out.ok) { rootBrowse = out; renderAll(); }
  }

  async function refresh() {
    const out = await api('/disk/status');
    if (out && out.ok) status = out;
    if (!status) { renderAll(); return; }
    const roots = status.roots || [];
    if (pendingRootPath) {
      const pending = roots.find((root) =>
        String(root.path).toLowerCase() === pendingRootPath.toLowerCase());
      if (pending) {
        selRoot = pending.i;
        pendingRootPath = '';
        overview = null;
        overviewError = '';
        treeRoot = null;
        treeStack = [];
        treeError = '';
      }
    }
    if (selRoot == null || !roots.some((root) => root.i === selRoot)) {
      selRoot = roots.length ? roots[0].i : null;
      overview = null;
      overviewError = '';
      treeRoot = null;
      treeStack = [];
      treeError = '';
    }
    // Re-attach to a cleanup that is running (e.g. after a reload) so the
    // loader shows real progress instead of stale category cards.
    adoptCleanFromStatus();
    const idx = status.index || {};
    // Poll while the index builds, a root is being added, or a cleanup runs
    // (the SSE stream is the primary channel; the poll is the safety net if it
    // drops).
    if (idx.building || addingRoot || cleaning) startPolling(); else stopPolling();
    // Crucial transition: the page often loads while the initial index is
    // building. Once it becomes ready, the already-selected chip must load its
    // overview automatically instead of sitting forever on "tap a drive".
    if (selRoot != null && idx.ready && !overview && !overviewError && !loadingOverview) {
      void loadOverview(false);
    }
    renderAll();
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!document.querySelector('.disk-widget-mount')) { stopPolling(); return; }
      await refresh();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function renderWidgets() {
    if (!document.querySelector('.disk-widget-mount')) {
      stopPolling();
      if (overviewAbort) overviewAbort.abort();
      return;
    }
    if (!status) void refresh();
    else renderAll();
  }

  function init() { renderWidgets(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.DiskWidget = { renderWidgets, refresh, onCleanProgress };
})();

// How the disk widget writes things: its words, sizes, counts and ages, the name of a category and
// of a risk, an error a person can read, and the parts of a path.
'use strict';

(() => {
  const tr = (key, fallback) => {
    const value = typeof window.t === 'function' ? window.t(key) : '';
    return value && value !== key ? value : (fallback != null ? fallback : key);
  };

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

  // "3 min fa": how old the numbers on screen are.
  function fmtAgo(ts) {
    const ms = Date.now() - (Number(ts) || 0);
    if (!Number.isFinite(ms) || ms < 60000) return tr('disk_ago_now', 'adesso');
    const min = Math.round(ms / 60000);
    if (min < 60) return tr('disk_ago_min', '{n} min fa').replace('{n}', String(min));
    const h = Math.round(min / 60);
    if (h < 36) return tr('disk_ago_hour', '{n} h fa').replace('{n}', String(h));
    return tr('disk_ago_day', '{n} giorni fa').replace('{n}', String(Math.round(h / 24)));
  }

  // Paths arrive spelled the way the machine spells them, and this widget
  // compared them with a hard-coded backslash in five places. Off Windows that
  // separator appears in no path, so every one of those tests answered "no":
  // the treemap found no direct children of its own root and rendered the whole
  // volume as one "unattributed" block, and the breadcrumb could not go up.
  // The separator is derived from the path itself rather than from a platform
  // flag — an absolute POSIX path starts with "/", a Windows one with a drive
  // letter — so there is nothing extra to plumb through and nothing to keep in
  // step with the server.
  const sepOf = (value) => (String(value || '').charAt(0) === '/' ? '/' : '\\');

  function pathParent(value) {
    const raw = String(value || '');
    const sep = sepOf(raw);
    const trimmed = sep === '/' && raw !== '/' ? raw.replace(/\/+$/, '') : raw.replace(/\\+$/, '');
    const cut = trimmed.lastIndexOf(sep);
    if (cut < 0) return '';
    // The parent of "/x" is the POSIX root, which IS its separator — slicing at
    // index 0 would leave the empty string and orphan every top-level folder.
    if (cut === 0) return sep === '/' ? '/' : '';
    return trimmed.slice(0, cut);
  }

  function pathLeaf(value) {
    const raw = String(value || '');
    const sep = sepOf(raw);
    const parts = raw.replace(sep === '/' ? /\/+$/ : /\\+$/, '').split(sep).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : raw;
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

  // Where the map is, as a path you can tap back up. Each level is a button
  // that returns there: the drill-down stack when it holds that level, else the
  // level's id from the overview, else (an older server, ids absent) the
  // local navigation over the overview's tree. Never above the root: `base`
  // is the boundary the ids were minted against.
  function joinUnder(base, parts) {
    const sep = sepOf(base);
    if (!parts.length) return base;
    return (base === '/' ? '' : base) + sep + parts.join(sep);
  }

  window.DiskWidgetWording = {
    tr, CAT_META, fmtSize, fmtNumber, fmtAgo, sepOf, pathParent, pathLeaf, categoryName, riskLabel,
    friendlyError, joinUnder,
  };
})();

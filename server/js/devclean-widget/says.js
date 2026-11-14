// What the developer clean-up tile says and the small parts it is drawn from: a word in the user's
// language, an element and a button, a size in the language's own decimals, the sentence for each
// reason the supporter code does not unlock it, the names of the places it looks in, why a place
// cannot be read, the line with a size, and whether a tile is on screen.
'use strict';

(() => {
  const tr = (key, fallback) => {
    const value = typeof window.t === 'function' ? window.t(key) : '';
    return value && value !== key ? value : (fallback != null ? fallback : key);
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function btn(cls, label, onClick, disabled) {
    const node = el('button', cls, label);
    node.type = 'button';
    node.disabled = !!disabled;
    node.addEventListener('click', onClick);
    return node;
  }

  function fmtSize(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    // The UI language's decimal mark: 20,1 GB in Italian, 20.1 GB in English.
    const uiLang = (typeof lang === 'string' && lang) || document.documentElement.lang || undefined;
    const digits = v >= 100 || i === 0 ? 0 : 1;
    return new Intl.NumberFormat(uiLang, { maximumFractionDigits: digits }).format(v) + ' ' + units[i];
  }

  const UNLOCK_ERRORS = {
    bad_request: ['devclean_unlock_no_code', 'Inserisci il codice sostenitore qui sotto.'],
    bad_code: ['devclean_unlock_bad_code', 'Il codice salvato non è valido. Inseriscine un altro qui sotto.'],
    expired: ['devclean_unlock_expired', 'Il pass è scaduto. Rinnovalo per sbloccare la funzione.'],
    limit: ['devclean_unlock_limit', 'Il pass è già usato su tre dispositivi.'],
    rate_limited: ['devclean_unlock_rate', 'Troppi tentativi. Riprova tra qualche minuto.'],
    // The hub does not offer this feature yet: not a network problem, and not
    // the user's code either.
    bad_entry: ['devclean_unlock_unavailable', 'Lo sblocco non è ancora attivo sul server dei sostenitori. Riprova più tardi.'],
  };

  const SOURCES = [
    { key: 'docker', title: ['devclean_src_docker', 'Docker'] },
    { key: 'ollama', title: ['devclean_src_ollama', 'Modelli Ollama'] },
    { key: 'vscode', title: ['devclean_src_vscode', 'Cartelle degli editor'] },
    { key: 'vhdx', title: ['devclean_src_vhdx', 'Dischi virtuali WSL'] },
  ];

  const REASONS = {
    not_installed: ['devclean_reason_missing', 'Non installato su questo computer'],
    not_running: ['devclean_reason_off', 'Spento: avvialo per vedere i dati'],
    windows_only: ['devclean_reason_windows', 'Solo su Windows'],
    error: ['devclean_reason_error', 'Non leggibile adesso'],
  };

  function reasonText(src) {
    const r = REASONS[src.reason] || REASONS.error;
    return tr(r[0], r[1]);
  }

  function sizeLine(src) {
    if (!src.available) return reasonText(src);
    const parts = [tr('devclean_used', '{n} occupati').replace('{n}', fmtSize(src.bytes))];
    if (src.reclaimable > 0) parts.push(tr('devclean_free', '{n} recuperabili').replace('{n}', fmtSize(src.reclaimable)));
    return parts.join(' · ');
  }

  // The tile ships hidden in index.html, so a mount existing says nothing:
  // only one that is laid out (on the current page) pays for a reading.
  function onScreen() {
    return [...document.querySelectorAll('.devclean-widget-mount')].some((m) => m.getClientRects().length > 0);
  }

  window.DevcleanWidgetSays = {
    tr, el, btn, fmtSize, UNLOCK_ERRORS, SOURCES, reasonText, sizeLine, onScreen,
  };
})();

'use strict';

// Dev cleanup — supporter-only tile for the space developer tools keep: Docker
// images and build cache, Ollama models, editor workspace storage of deleted
// projects, and the WSL/Docker virtual disks that never shrink on their own.
// The server mints every item id and refuses all of it until the feature is
// unlocked; this file only renders and sends `source + ids`. Model and project
// names are untrusted text: textContent only.
(function () {
  const tr = (key, fallback) => {
    const value = typeof window.t === 'function' ? window.t(key) : '';
    return value && value !== key ? value : (fallback != null ? fallback : key);
  };
  const base = () => (typeof SERVER === 'string' ? SERVER : '');

  let unlocked = null;     // null = not asked yet
  let unlockError = '';
  let unlocking = false;
  let codeSaved = null;    // does this PC hold a supporter pass? null = unknown
  let codeFormOpen = false;
  let codeDraft = '';      // kept across re-renders so a typed code is not lost
  let preview = null;      // this PC's names-free numbers, for the locked pitch
  let previewLoading = false;
  // Same destination as the gallery's "Become a supporter" (community-gallery.js).
  const SUPPORT_URL = 'https://www.buymeacoffee.com/marcimastro98';
  let data = null;
  let loading = false;
  let loadError = '';
  let confirm = null;      // { source, ids, text } | { compact: id, text }
  let busy = false;
  let notice = '';
  const picked = { ollama: new Set(), vscode: new Set() };

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

  async function api(url, body) {
    try {
      const res = await fetch(base() + url, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : { cache: 'no-store' });
      let out = null;
      try { out = await res.json(); } catch { /* empty body */ }
      return out || { ok: false, error: 'http_' + res.status };
    } catch {
      return { ok: false, error: 'offline' };
    }
  }

  // ── data ──────────────────────────────────────────────────────────────────

  async function loadState() {
    const out = await api('/api/features/devclean');
    unlocked = !!(out && out.unlocked);
    if (!unlocked) await loadCodeSaved();
    renderWidgets();
  }

  // The pitch's numbers run docker/reg like the overview, so they too are read
  // only once the tile is actually on screen.
  async function loadPreview() {
    if (previewLoading) return;
    previewLoading = true;
    preview = await api('/api/features/devclean/preview');
    previewLoading = false;
    renderAll();
  }

  // A boolean only: the pass itself never comes back from the server.
  async function loadCodeSaved() {
    const out = await api('/api/community/supporter');
    codeSaved = !!(out && out.saved);
  }

  async function loadOverview(refresh) {
    if (loading) return;
    loading = true;
    loadError = '';
    renderAll();
    const out = await api('/api/devclean/overview' + (refresh ? '?refresh=1' : ''));
    loading = false;
    if (out && out.ok) {
      data = out;
      // A job started before a reload (or on another surface) is still running.
      const compactJob = out.vhdx && out.vhdx.job;
      busy = (out.job && out.job.state === 'running')
        || !!(compactJob && !['done', 'error', 'declined'].includes(compactJob.state));
      for (const key of Object.keys(picked)) {
        const ids = new Set(((out[key] && out[key].items) || []).map((it) => it.id));
        picked[key] = new Set([...picked[key]].filter((id) => ids.has(id)));
      }
    } else if (out && out.error === 'locked') {
      unlocked = false;
    } else {
      loadError = tr('devclean_error_load', 'Non riesco a leggere i dati adesso. Riprova tra poco.');
    }
    renderAll();
  }

  const UNLOCK_ERRORS = {
    bad_request: ['devclean_unlock_no_code', 'Inserisci il codice sostenitore qui sotto.'],
    bad_code: ['devclean_unlock_bad_code', 'Il codice salvato non è valido. Inseriscine un altro qui sotto.'],
    expired: ['devclean_unlock_expired', 'Il pass è scaduto. Rinnovalo per sbloccare la funzione.'],
    limit: ['devclean_unlock_limit', 'Il pass è già usato su tre dispositivi.'],
    rate_limited: ['devclean_unlock_rate', 'Troppi tentativi. Riprova tra qualche minuto.'],
  };

  async function unlock() {
    unlocking = true;
    unlockError = '';
    renderAll();
    const out = await api('/api/features/devclean/unlock', {});
    unlocking = false;
    if (out && out.ok) {
      unlocked = true;
      await loadOverview(true);
      return;
    }
    const err = out && out.error;
    const msg = UNLOCK_ERRORS[err];
    unlockError = msg ? tr(msg[0], msg[1]) : tr('devclean_unlock_network', 'Non riesco a contattare il server dei sostenitori.');
    // A wrong or missing pass is fixed right here, not in Settings.
    if (err === 'bad_code' || err === 'bad_request') codeFormOpen = true;
    renderAll();
  }

  // Store the typed pass (the same store Settings uses), then unlock with it.
  async function saveCodeAndUnlock() {
    const code = codeDraft.trim();
    if (!code) return;
    unlocking = true;
    unlockError = '';
    renderAll();
    const out = await api('/api/community/supporter/save', { code });
    if (!out || !out.ok) {
      unlocking = false;
      unlockError = out && out.error === 'bad_code'
        ? tr('devclean_code_format', 'Il codice ha la forma XS-XXXX-XXXX-XXXX. Controllalo nell’email che hai ricevuto.')
        : tr('devclean_unlock_network', 'Non riesco a contattare il server dei sostenitori.');
      renderAll();
      return;
    }
    codeSaved = true;
    codeDraft = '';
    codeFormOpen = false;
    await unlock();
  }

  async function runConfirmed() {
    const c = confirm;
    confirm = null;
    busy = true;
    notice = '';
    renderAll();
    const out = c.compact
      ? await api('/api/devclean/compact', { id: c.compact })
      : await api('/api/devclean/run', { source: c.source, ids: c.ids });
    if (!out || !out.ok) {
      busy = false;
      notice = out && out.error === 'busy'
        ? tr('devclean_busy', 'C’è già un’operazione in corso.')
        : tr('devclean_error_run', 'L’operazione non è partita. Riprova.');
      renderAll();
    }
    // Success is reported by the SSE events below.
  }

  // SSE 'devclean': { kind: 'run' | 'compact', job }.
  function onProgress(info) {
    const job = info && info.job;
    if (!job) return;
    if (info.kind === 'compact') {
      if (data && data.vhdx) data.vhdx.job = job;
      if (job.state === 'done') {
        notice = tr('devclean_compact_done', 'Disco compattato: recuperati {n}.').replace('{n}', fmtSize((job.before || 0) - (job.after || 0)));
      } else if (job.state === 'declined') {
        notice = tr('devclean_compact_declined', 'Compattazione annullata.');
      } else if (job.state === 'error') {
        notice = tr('devclean_compact_error', 'La compattazione non è riuscita. Il disco non è stato modificato.');
      }
      busy = !['done', 'error', 'declined'].includes(job.state);
    } else if (job.state === 'done') {
      busy = false;
      notice = job.failed && job.failed.length
        ? tr('devclean_run_partial', 'Liberati {n}. Alcuni elementi non sono stati rimossi.').replace('{n}', fmtSize(job.freed))
        : tr('devclean_run_done', 'Liberati {n}.').replace('{n}', fmtSize(job.freed));
    }
    if (!busy) void loadOverview(true); else renderAll();
  }

  // ── render ────────────────────────────────────────────────────────────────

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

  function renderHead() {
    const head = el('div', 'devclean-head');
    const titles = el('div', 'devclean-titles');
    titles.appendChild(el('div', 'devclean-title', tr('layout_widget_devclean', 'Pulizia sviluppatore')));
    if (unlocked && data) {
      titles.appendChild(el('div', 'devclean-sub', tr('devclean_total', '{n} recuperabili').replace('{n}', fmtSize(data.reclaimable))));
    }
    head.appendChild(titles);
    if (unlocked) {
      const refresh = btn('devclean-icon-btn', '↻', () => loadOverview(true), loading || busy);
      refresh.setAttribute('aria-label', tr('devclean_refresh', 'Aggiorna'));
      head.appendChild(refresh);
    }
    return head;
  }

  function reasonText(src) {
    const r = REASONS[src.reason] || REASONS.error;
    return tr(r[0], r[1]);
  }

  function renderLocked() {
    return window.DevCleanPitch.render({ el, btn, tr, fmtSize, reasonText }, {
      preview, codeSaved, codeFormOpen, unlocking, unlockError,
      supportUrl: SUPPORT_URL,
      onUnlock: unlock,
      onOpenForm: () => { codeFormOpen = true; renderAll(); },
      codeForm: renderCodeForm,
    });
  }

  function renderCodeForm() {
    const form = el('form', 'devclean-code');
    const input = el('input', 'devclean-code-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'XS-XXXX-XXXX-XXXX';
    input.setAttribute('aria-label', tr('devclean_enter_code', 'Inserisci il pass'));
    input.value = codeDraft;
    input.disabled = unlocking;
    input.addEventListener('input', () => { codeDraft = input.value; });
    form.appendChild(input);
    const submit = el('button', 'devclean-btn devclean-btn-accent', unlocking
      ? tr('devclean_unlocking', 'Sblocco…') : tr('devclean_code_unlock', 'Salva e sblocca'));
    submit.type = 'submit';
    submit.disabled = unlocking;
    form.appendChild(submit);
    form.addEventListener('submit', (e) => { e.preventDefault(); saveCodeAndUnlock(); });
    return form;
  }

  function sizeLine(src) {
    if (!src.available) return reasonText(src);
    const parts = [tr('devclean_used', '{n} occupati').replace('{n}', fmtSize(src.bytes))];
    if (src.reclaimable > 0) parts.push(tr('devclean_free', '{n} recuperabili').replace('{n}', fmtSize(src.reclaimable)));
    return parts.join(' · ');
  }

  function pickList(key, items) {
    const list = el('ul', 'devclean-list');
    for (const it of items) {
      const row = el('li', 'devclean-row' + (it.protected ? ' is-protected' : ''));
      const label = el('label', 'devclean-pick');
      const box = el('input');
      box.type = 'checkbox';
      box.disabled = !!it.protected || busy;
      box.checked = picked[key].has(it.id);
      box.addEventListener('change', () => {
        if (box.checked) picked[key].add(it.id); else picked[key].delete(it.id);
        renderAll();
      });
      label.appendChild(box);
      label.appendChild(el('span', 'devclean-name', it.name));
      row.appendChild(label);
      row.appendChild(el('span', 'devclean-size', it.protected ? tr('devclean_in_use', 'in uso') : fmtSize(it.bytes)));
      list.appendChild(row);
    }
    return list;
  }

  function askRun(source, ids, text) {
    confirm = { source, ids, text };
    renderAll();
  }

  function renderSourceBody(key, src, card) {
    if (key === 'docker') {
      if (src.reclaimable > 0) {
        card.appendChild(btn('devclean-btn', tr('devclean_docker_prune', 'Elimina immagini inutilizzate e cache'),
          () => askRun('docker', src.items.filter((it) => it.reclaimable > 0).map((it) => it.id),
            tr('devclean_docker_confirm', 'Le immagini usate da un container restano. Le altre si riscaricano al prossimo docker pull o build.')),
          busy));
      }
      return;
    }
    if (key === 'ollama' || key === 'vscode') {
      if (!src.items.length) {
        card.appendChild(el('p', 'devclean-empty', key === 'vscode'
          ? tr('devclean_vscode_none', 'Nessuna cartella di progetti cancellati.')
          : tr('devclean_ollama_none', 'Nessun modello installato.')));
        return;
      }
      card.appendChild(pickList(key, src.items));
      const ids = [...picked[key]];
      const freed = src.items.filter((it) => picked[key].has(it.id)).reduce((n, it) => n + it.bytes, 0);
      const label = key === 'ollama'
        ? tr('devclean_ollama_remove', 'Rimuovi selezionati')
        : tr('devclean_vscode_trash', 'Sposta nel Cestino');
      card.appendChild(btn('devclean-btn', ids.length ? label + ' · ' + fmtSize(freed) : label, () => askRun(key, ids,
        key === 'ollama'
          ? tr('devclean_ollama_confirm', 'I modelli si possono riscaricare da Ollama quando servono.')
          : tr('devclean_vscode_confirm', 'Sono le impostazioni locali di progetti che non esistono più. Restano nel Cestino.')),
      busy || !ids.length));
      return;
    }
    renderDisks(src, card);
  }

  function renderDisks(src, card) {
    const job = src.job;
    const list = el('ul', 'devclean-list');
    for (const it of src.items) {
      const row = el('li', 'devclean-row');
      row.appendChild(el('span', 'devclean-name', it.name + ' · ' + it.file));
      const side = el('span', 'devclean-disk-side');
      side.appendChild(el('span', 'devclean-size', fmtSize(it.bytes)));
      if (it.offer) {
        side.appendChild(btn('devclean-btn devclean-btn-small', tr('devclean_compact', 'Compatta'), () => {
          confirm = { compact: it.id, text: tr('devclean_compact_confirm',
            'Windows chiederà i permessi da amministratore. Docker e WSL verranno chiusi: riaprili quando hai finito.') };
          renderAll();
        }, busy));
      }
      row.appendChild(side);
      list.appendChild(row);
    }
    card.appendChild(list);
    if (job && !['done', 'error', 'declined'].includes(job.state)) {
      const STATES = {
        prompt: ['devclean_compact_prompt', 'Conferma la richiesta di Windows…'],
        stopping: ['devclean_compact_stopping', 'Chiudo Docker e WSL…'],
        compacting: ['devclean_compact_running', 'Compattazione in corso, può richiedere qualche minuto…'],
      };
      const s = STATES[job.state] || STATES.compacting;
      card.appendChild(el('p', 'devclean-progress', tr(s[0], s[1])));
    }
  }

  function renderSources() {
    const grid = el('div', 'devclean-grid');
    for (const { key, title } of SOURCES) {
      const src = data[key] || { available: false, reason: 'error' };
      // A tool this machine does not have is noise, not information.
      if (!src.available && (src.reason === 'not_installed' || src.reason === 'windows_only')) continue;
      const card = el('section', 'devclean-card' + (src.available ? '' : ' is-off'));
      card.appendChild(el('h3', 'devclean-card-title', tr(title[0], title[1])));
      card.appendChild(el('p', 'devclean-card-size', sizeLine(src)));
      if (src.available) renderSourceBody(key, src, card);
      grid.appendChild(card);
    }
    if (!grid.childElementCount) grid.appendChild(el('p', 'devclean-empty', tr('devclean_nothing', 'Nessuno strumento di sviluppo trovato su questo computer.')));
    return grid;
  }

  function renderConfirm() {
    const box = el('section', 'devclean-confirm');
    box.appendChild(el('p', '', confirm.text));
    const actions = el('div', 'devclean-actions');
    actions.appendChild(btn('devclean-btn', tr('devclean_cancel', 'Annulla'), () => { confirm = null; renderAll(); }));
    actions.appendChild(btn('devclean-btn devclean-btn-accent', tr('devclean_go', 'Procedi'), runConfirmed));
    box.appendChild(actions);
    return box;
  }

  function render(mount) {
    mount.replaceChildren(renderHead());
    if (unlocked === null) { mount.appendChild(el('p', 'devclean-empty', tr('devclean_loading', 'Carico…'))); return; }
    if (!unlocked) { mount.replaceChildren(renderLocked()); return; }
    if (notice) mount.appendChild(el('p', 'devclean-notice', notice));
    if (confirm) { mount.appendChild(renderConfirm()); return; }
    if (loadError) mount.appendChild(el('p', 'devclean-error', loadError));
    if (!data) { mount.appendChild(el('p', 'devclean-empty', tr('devclean_loading', 'Carico…'))); return; }
    mount.appendChild(renderSources());
  }

  function renderAll() {
    document.querySelectorAll('.devclean-widget-mount').forEach(render);
  }

  // The tile ships hidden in index.html, so a mount existing says nothing:
  // only one that is laid out (on the current page) pays for a reading.
  function onScreen() {
    return [...document.querySelectorAll('.devclean-widget-mount')].some((m) => m.getClientRects().length > 0);
  }

  // A tile shown later (page turn, added from the palette) must load by itself.
  const watched = new WeakSet();
  const seen = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) renderWidgets(); })
    : null;

  function renderWidgets() {
    if (!document.querySelector('.devclean-widget-mount')) return;
    if (seen) {
      document.querySelectorAll('.devclean-widget-mount').forEach((m) => {
        if (!watched.has(m)) { watched.add(m); seen.observe(m); }
      });
    }
    if (unlocked === null) { void loadState(); return; }
    if (onScreen()) {
      if (unlocked && !data && !loading) { void loadOverview(false); return; }
      if (!unlocked && !preview && !previewLoading) { void loadPreview(); }
    }
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderWidgets);
  else renderWidgets();

  window.DevCleanWidget = { renderWidgets, onProgress };
})();

'use strict';

// ── Update awareness ────────────────────────────────────────────────────────
// At startup the dashboard asks the server (which probes GitHub at most daily,
// fail-silent) whether a newer release exists. If so — and the user hasn't said
// "don't show again" for that version — a polished modal presents the release
// notes (the GitHub release body, rendered with a tiny safe markdown parser)
// and offers Download / Later / Don't-show-again. A manual "Check for updates"
// button forces a fresh probe. Everything degrades to nothing when offline.

(function () {
  const DISMISS_KEY = 'xenon.update.dismissed'; // last version the user dismissed

  function tr(key, fallback) {
    return (typeof window.t === 'function' && window.t(key)) || fallback;
  }

  function dismissedVersion() {
    try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
  }
  function rememberDismissed(version) {
    try { localStorage.setItem(DISMISS_KEY, String(version || '')); } catch { /* ignore */ }
  }

  async function check(force) {
    try {
      const res = await fetch('/update/check' + (force ? '?force=1' : ''));
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ── Safe markdown → DOM ─────────────────────────────────────────────────────
  // The notes come from GitHub: treat them as untrusted. We build DOM nodes with
  // textContent only (never innerHTML), and accept only http(s) links.
  function appendInline(parent, text) {
    const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) {
        const a = document.createElement('a');
        a.href = m[2]; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = m[1];
        parent.appendChild(a);
      } else if (m[3] !== undefined) {
        const s = document.createElement('strong');
        s.textContent = m[3];
        parent.appendChild(s);
      } else if (m[4] !== undefined) {
        const c = document.createElement('code');
        c.textContent = m[4];
        parent.appendChild(c);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderMarkdown(container, md) {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    let list = null;
    const closeList = () => { list = null; };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^\s*[-*]\s+/.test(line)) {
        if (!list) { list = document.createElement('ul'); list.className = 'upd-list'; container.appendChild(list); }
        const li = document.createElement('li');
        appendInline(li, line.replace(/^\s*[-*]\s+/, ''));
        list.appendChild(li);
      } else if (/^#{1,6}\s+/.test(line)) {
        closeList();
        const level = line.match(/^#+/)[0].length;
        const h = document.createElement(level <= 2 ? 'h3' : 'h4');
        h.className = 'upd-h';
        appendInline(h, line.replace(/^#+\s+/, ''));
        container.appendChild(h);
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        const p = document.createElement('p');
        p.className = 'upd-p';
        appendInline(p, line);
        container.appendChild(p);
      }
    }
  }

  // ── Modal ───────────────────────────────────────────────────────────────────
  let openOverlay = null;

  // Freeze the animated ambient background while this frosted overlay is up (issue
  // #56 — see ambient-freeze.js). Reference-counted by token so it composes with the
  // Settings panel, which is frosted too and can be open underneath us.
  function freezeAmbient(on) {
    try {
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze('update', on);
    } catch { /* ignore */ }
  }

  function closeModal() {
    if (!openOverlay) return;
    openOverlay.remove();
    openOverlay = null;
    freezeAmbient(false);
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  function openModal(info) {
    if (!info || !info.latest) return;
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'upd-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    const card = document.createElement('div');
    card.className = 'upd-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'upd-close';
    closeBtn.setAttribute('aria-label', tr('update_later', 'Più tardi'));
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeModal);
    card.appendChild(closeBtn);

    const head = document.createElement('div');
    head.className = 'upd-head';
    const badge = document.createElement('div');
    badge.className = 'upd-badge';
    badge.textContent = '✨';
    head.appendChild(badge);
    const headText = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'upd-title';
    title.textContent = tr('update_title', 'Aggiornamento disponibile');
    const ver = document.createElement('div');
    ver.className = 'upd-ver';
    // Strip any leading "v" before re-adding our own, so a "v"-prefixed version
    // from the server can never render as "vv3.2.4".
    const stripV = (s) => String(s || '').replace(/^v/i, '');
    ver.textContent = 'v' + stripV(info.latest) + (info.current ? '  ·  ' + tr('update_from', 'dalla v') + stripV(info.current) : '');
    headText.appendChild(title);
    headText.appendChild(ver);
    head.appendChild(headText);
    card.appendChild(head);

    const notesTitle = document.createElement('div');
    notesTitle.className = 'upd-notes-title';
    notesTitle.textContent = tr('update_whatsnew', 'Novità di questa versione');
    card.appendChild(notesTitle);

    const notes = document.createElement('div');
    notes.className = 'upd-notes';
    if (info.notes && info.notes.trim()) {
      renderMarkdown(notes, info.notes);
    } else {
      const p = document.createElement('p');
      p.className = 'upd-p';
      p.textContent = tr('update_no_notes', 'Apri la pagina della release per i dettagli.');
      notes.appendChild(p);
    }
    card.appendChild(notes);

    const statusEl = document.createElement('div');
    statusEl.className = 'upd-status';
    statusEl.hidden = true;
    card.appendChild(statusEl);

    const actions = document.createElement('div');
    actions.className = 'upd-actions';

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'upd-btn primary';
    dlBtn.textContent = tr('update_download', 'Scarica');
    dlBtn.addEventListener('click', () => {
      try { window.open(info.url || 'https://github.com/marcimastro98/Xenon/releases/latest', '_blank', 'noopener'); } catch { /* ignore */ }
      closeModal();
    });
    actions.appendChild(dlBtn);

    const laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = 'upd-btn';
    laterBtn.textContent = tr('update_later', 'Più tardi');
    laterBtn.addEventListener('click', closeModal);
    actions.appendChild(laterBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'upd-btn ghost';
    dismissBtn.textContent = tr('update_dismiss', 'Non mostrare più');
    dismissBtn.addEventListener('click', () => { rememberDismissed(info.latest); closeModal(); });
    actions.appendChild(dismissBtn);

    card.appendChild(actions);
    overlay.appendChild(card);

    // If one-click update is possible here, add an "Update now" primary button
    // (the manual Download stays as a fallback). Non-blocking — the modal is
    // already usable while we probe.
    enhanceAutoUpdate(info, { actions, statusEl, dlBtn });
    document.body.appendChild(overlay);
    openOverlay = overlay;
    freezeAmbient(true);
    document.addEventListener('keydown', onKey);
  }

  // ── One-click update (safe two-step: prepare → apply) ────────────────────────
  async function enhanceAutoUpdate(info, ui) {
    let st;
    try { st = await (await fetch('/update/self-status')).json(); } catch { return; }
    if (!st || !st.supported) return; // git checkout or applier missing → manual only

    ui.dlBtn.classList.remove('primary');
    ui.dlBtn.textContent = tr('update_download_manual', 'Scarica manualmente');

    const state = { staged: !!(st.staged && st.staged.version === info.latest) };
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'upd-btn primary';
    autoBtn.textContent = state.staged ? tr('update_apply', 'Applica e riavvia') : tr('update_auto', 'Aggiorna ora');
    autoBtn.addEventListener('click', async () => {
      if (state.staged) { applyUpdate(info, ui, autoBtn); return; }
      autoBtn.disabled = true;
      ui.statusEl.hidden = false;
      ui.statusEl.className = 'upd-status';
      ui.statusEl.textContent = tr('update_preparing', 'Scarico e preparo… (può richiedere un minuto)');
      let r;
      try { r = await (await fetch('/update/prepare', { method: 'POST' })).json(); } catch { r = null; }
      autoBtn.disabled = false;
      if (r && r.ok) {
        state.staged = true;
        autoBtn.textContent = tr('update_apply', 'Applica e riavvia');
        ui.statusEl.className = 'upd-status ok';
        ui.statusEl.textContent = tr('update_ready', 'Pronto: premi "Applica e riavvia".');
      } else {
        ui.statusEl.className = 'upd-status error';
        // Surface the server's reason code (e.g. version_mismatch, download_failed)
        // so a failed prepare is diagnosable from a screenshot, not a blind dead end.
        const reason = r && r.error ? ' (' + r.error + ')' : '';
        ui.statusEl.textContent = tr('update_prepare_failed', 'Preparazione non riuscita. Puoi scaricare manualmente.') + reason;
      }
    });
    ui.actions.insertBefore(autoBtn, ui.actions.firstChild);
  }

  function applyUpdate(info, ui, btn) {
    btn.disabled = true;
    ui.statusEl.hidden = false;
    ui.statusEl.className = 'upd-status';
    ui.statusEl.textContent = tr('update_applying', 'Avvio aggiornamento…');
    fetch('/update/apply', { method: 'POST' })
      .then((r) => r.json())
      .then((res) => {
        if (res && res.ok) {
          showUpdatingOverlay(info.latest);
        } else {
          ui.statusEl.className = 'upd-status error';
          ui.statusEl.textContent = tr('update_apply_failed', 'Avvio aggiornamento non riuscito.');
          btn.disabled = false;
        }
      })
      // The swap may kill the server before the response arrives — treat as started.
      .catch(() => showUpdatingOverlay(info.latest));
  }

  function showUpdatingOverlay(targetVersion) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'upd-overlay';
    const card = document.createElement('div');
    card.className = 'upd-card upd-updating';
    const sp = document.createElement('div');
    sp.className = 'upd-spinner';
    const msg = document.createElement('div');
    msg.className = 'upd-title';
    msg.textContent = tr('update_updating', 'Aggiornamento in corso…');
    const sub = document.createElement('div');
    sub.className = 'upd-ver upd-updating-sub';
    sub.textContent = tr('update_updating_sub', 'L’app si chiuderà e si riavvierà da sola. Non chiudere questa pagina.');
    card.appendChild(sp);
    card.appendChild(msg);
    card.appendChild(sub);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    openOverlay = overlay;
    freezeAmbient(true);   // closeModal() above cleared it; this overlay is frosted too
    pollUntilBack(targetVersion);
  }

  async function pollUntilBack(targetVersion) {
    const start = Date.now();
    const deadline = start + 6 * 60 * 1000;
    let hinted = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      // If nothing has happened after a bit, the admin (UAC) prompt is the usual
      // reason — surface it instead of spinning silently.
      if (!hinted && Date.now() - start > 25000) {
        hinted = true;
        const sub = document.querySelector('.upd-updating-sub');
        if (sub) sub.textContent = tr('update_uac_hint', 'Accetta il prompt di amministratore (UAC) se compare. Se l’hai annullato, ricarica la pagina e riprova.');
      }
      try {
        const res = await fetch('/version', { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          // Reload only once the NEW version is serving (avoids catching the old
          // server in the brief window before it's killed).
          if (j && j.version && (!targetVersion || j.version === targetVersion)) {
            location.reload();
            return;
          }
        }
      } catch { /* server is restarting — keep polling */ }
    }
    const sub = document.querySelector('.upd-updating-sub');
    if (sub) sub.textContent = tr('update_updating_timeout', 'Sta impiegando più del previsto. Ricarica la pagina tra poco.');
  }

  // ── Indicators (red dot + footer pill / check button) ───────────────────────
  // Single source of truth: when an update is available, show the red dot on the
  // topbar Settings button + a pill in the Settings footer, and HIDE the now-
  // redundant "Check for updates" button. When up to date, do the opposite.
  // After an update the next check reports nothing new, so the dot clears itself.
  function refreshIndicators(info) {
    const available = !!(info && info.updateAvailable);

    const dot = document.getElementById('settings-update-dot');
    if (dot) dot.hidden = !available;

    const checkBtn = document.getElementById('settings-update-check');
    const out = document.getElementById('settings-version');
    const existing = document.querySelector('.settings-update-pill');
    if (existing) existing.remove();

    if (available && out) {
      const a = document.createElement('a');
      a.className = 'settings-update-pill';
      a.href = info.url || 'https://github.com/marcimastro98/Xenon/releases/latest';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = tr('update_available', 'Update available') + ' · v' + info.latest;
      a.addEventListener('click', (e) => { e.preventDefault(); openModal(info); });
      out.insertAdjacentElement('beforebegin', a);
      if (checkBtn) checkBtn.hidden = true;
    } else if (checkBtn) {
      checkBtn.hidden = false;
    }
  }

  // ── Entry points ─────────────────────────────────────────────────────────────
  async function autoCheck() {
    const info = await check(false);
    refreshIndicators(info);
    if (!info || !info.updateAvailable) return;
    if (dismissedVersion() === info.latest) return; // user opted out of the popup for this version
    openModal(info);
  }

  // Manual "Check for updates" button (forces a fresh probe).
  window.checkForUpdatesNow = async function checkForUpdatesNow(btn) {
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = tr('update_checking', 'Controllo…'); }
    const info = await check(true);
    if (btn) { btn.disabled = false; btn.textContent = original; }
    refreshIndicators(info);
    if (info && info.updateAvailable) {
      openModal(info);
    } else if (window.XenonToast) {
      window.XenonToast.show({
        type: 'success',
        kicker: 'Xenon',
        title: tr('update_uptodate', 'Sei alla versione più recente'),
        message: info && info.current ? 'v' + info.current : '',
      });
    }
  };

  window.XenonUpdate = { check, openModal, refresh: () => check(false).then(refreshIndicators) };

  document.addEventListener('DOMContentLoaded', autoCheck, { once: true });
})();

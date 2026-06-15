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

  function closeModal() {
    if (!openOverlay) return;
    openOverlay.remove();
    openOverlay = null;
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
    ver.textContent = 'v' + info.latest + (info.current ? '  ·  ' + tr('update_from', 'dalla v') + info.current : '');
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
    document.body.appendChild(overlay);
    openOverlay = overlay;
    document.addEventListener('keydown', onKey);
  }

  // ── Entry points ─────────────────────────────────────────────────────────────
  async function autoCheck() {
    const info = await check(false);
    if (!info || !info.updateAvailable) return;
    if (dismissedVersion() === info.latest) return; // user opted out for this version
    openModal(info);
  }

  // Manual "Check for updates" button (forces a fresh probe).
  window.checkForUpdatesNow = async function checkForUpdatesNow(btn) {
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = tr('update_checking', 'Controllo…'); }
    const info = await check(true);
    if (btn) { btn.disabled = false; btn.textContent = original; }
    if (info && info.updateAvailable) {
      openModal(info);
    } else if (typeof window.showHubToast === 'function') {
      window.showHubToast('Xenon', tr('update_uptodate', 'Sei alla versione più recente'), info && info.current ? 'v' + info.current : '');
    }
  };

  // Let the existing Settings "update available" pill open this modal too.
  window.XenonUpdate = { check, openModal };

  document.addEventListener('DOMContentLoaded', autoCheck, { once: true });
})();

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

  // Running inside the Tauri native shell? The shell sets __XENON_NATIVE__ very
  // early (its init script) and Tauri injects window.isTauri. On the native app
  // the in-app updater owns the update flow (a signed download + relaunch — see
  // native-bridge.js and the Rust shell). The web "Download" button here would
  // only bounce the user to the GitHub release page in an external browser,
  // which is NOT an update — the exact bug users hit. So on native every update
  // affordance routes to the in-app installer instead of GitHub.
  function isNativeShell() {
    return window.__XENON_NATIVE__ === true || window.isTauri === true
      || !!(window.XenonNative && window.XenonNative.isNative);
  }

  // Kick off the native shell's signed in-app update (download + relaunch). The
  // Rust navigation hook catches this scheme, re-checks, installs and restarts;
  // mirrors the native update toast in native-bridge.js.
  function triggerNativeInstall() {
    try { window.location.href = 'xenon-update:install'; } catch { /* not native */ }
    try {
      if (window.XenonToast && typeof window.XenonToast.show === 'function') {
        window.XenonToast.show({
          type: 'info',
          title: tr('native_update_installing', 'Updating Xenon…'),
          message: tr('native_update_installing_hint', 'The app will restart when it is done.'),
        });
      }
    } catch { /* best effort */ }
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

  // ── Media allowlist ─────────────────────────────────────────────────────────
  // The notes are untrusted text from GitHub. To render an <img>/<video> without
  // turning the modal into a tracking-pixel surface, media is restricted to
  // GitHub-hosted https URLs (screenshots/clips the author attached to the
  // release). The server enforces the same list; this is defense in depth.
  function isAllowedMediaUrl(u) {
    try {
      const url = new URL(String(u));
      if (url.protocol !== 'https:') return false;
      const h = url.hostname.toLowerCase();
      if (h === 'github.com') return url.pathname.startsWith('/user-attachments/assets/');
      return h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com');
    } catch { return false; }
  }

  function buildImage(url, alt) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = url;
    if (alt) img.alt = alt;
    return img;
  }

  // ── Safe markdown → DOM ─────────────────────────────────────────────────────
  // The notes come from GitHub: treat them as untrusted. We build DOM nodes with
  // textContent only (never innerHTML), accept only http(s) links, and only
  // GitHub-hosted media (see isAllowedMediaUrl).
  function appendInline(parent, text) {
    // Group 1 = optional "!" (image marker), 2 = link/alt text, 3 = url; then bold, code.
    const re = /(!?)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[3] !== undefined) {
        if (m[1] === '!') {
          // Inline image (e.g. a small screenshot mid-sentence). Non-GitHub images
          // (shields.io badges, etc.) are dropped rather than loaded from arbitrary hosts.
          if (isAllowedMediaUrl(m[3])) {
            const img = buildImage(m[3], m[2]);
            img.className = 'upd-inline-img';
            parent.appendChild(img);
          }
        } else {
          const a = document.createElement('a');
          a.href = m[3]; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = m[2];
          parent.appendChild(a);
        }
      } else if (m[4] !== undefined) {
        const s = document.createElement('strong');
        s.textContent = m[4];
        parent.appendChild(s);
      } else if (m[5] !== undefined) {
        const c = document.createElement('code');
        c.textContent = m[5];
        parent.appendChild(c);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // A block-level image/video embedded in the notes. Images open a fullscreen
  // lightbox on tap (the Xeneon Edge is a small touchscreen — a thumbnail alone
  // is unreadable). Videos play inline with native controls. Either degrades to a
  // "open on GitHub" link if the media fails to load.
  function appendMedia(container, url, type, alt) {
    const fig = document.createElement('figure');
    fig.className = 'upd-media';
    if (type === 'video') {
      const v = document.createElement('video');
      v.className = 'upd-media-el';
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      const s = document.createElement('source');
      s.src = url;
      v.appendChild(s);
      v.addEventListener('error', () => replaceWithFallback(fig, url));
      fig.appendChild(v);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'upd-media-btn';
      btn.setAttribute('aria-label', tr('update_media_zoom', 'Ingrandisci immagine'));
      const img = buildImage(url, alt);
      img.className = 'upd-media-el';
      img.addEventListener('error', () => replaceWithFallback(fig, url));
      btn.appendChild(img);
      btn.addEventListener('click', () => openLightbox(url, alt));
      fig.appendChild(btn);
    }
    if (alt) {
      const cap = document.createElement('figcaption');
      cap.className = 'upd-media-cap';
      cap.textContent = alt;
      fig.appendChild(cap);
    }
    container.appendChild(fig);
  }

  function replaceWithFallback(fig, url) {
    fig.textContent = '';
    const a = document.createElement('a');
    a.className = 'upd-media-fallback';
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = tr('update_media_open', 'Apri media su GitHub');
    fig.appendChild(a);
  }

  function renderMarkdown(container, md, mediaTypes) {
    const media = mediaTypes || {};
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    let list = null;
    const closeList = () => { list = null; };
    // Matches a line that is ONLY a markdown image: ![alt](url)
    const loneImg = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const t = line.trim();
      // Block media: a lone markdown image, or a bare GitHub media URL the server
      // classified (this is how videos arrive). Rendered in place, not in a gallery.
      const im = t.match(loneImg);
      if (im && isAllowedMediaUrl(im[2])) {
        closeList();
        appendMedia(container, im[2], 'image', im[1]);
        continue;
      }
      if (/^https?:\/\/\S+$/.test(t) && isAllowedMediaUrl(t) && (media[t] === 'image' || media[t] === 'video')) {
        closeList();
        appendMedia(container, t, media[t], '');
        continue;
      }
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
        // Skip a paragraph left empty because its only content was dropped (e.g. a
        // non-GitHub image badge on its own line) — no stray blank gap.
        if (p.childNodes.length) container.appendChild(p);
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
    closeLightbox();
    openOverlay.remove();
    openOverlay = null;
    freezeAmbient(false);
    document.removeEventListener('keydown', onKey);
  }
  // Ignore Escape while the lightbox is up — it owns Escape then (see onLightboxKey),
  // so closing a zoomed image doesn't also tear down the modal underneath it.
  function onKey(e) { if (e.key === 'Escape' && !lightboxEl) closeModal(); }

  // ── Image lightbox ──────────────────────────────────────────────────────────
  // Tap a screenshot to view it fullscreen — a thumbnail is unreadable on the
  // Xeneon Edge. Sits above the update modal (which stays mounted underneath).
  let lightboxEl = null;
  function openLightbox(url, alt) {
    closeLightbox();
    const ov = document.createElement('div');
    ov.className = 'upd-lightbox';
    ov.addEventListener('click', closeLightbox);
    const img = document.createElement('img');
    img.className = 'upd-lightbox-img';
    img.src = url;
    if (alt) img.alt = alt;
    ov.appendChild(img);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'upd-lightbox-close';
    x.setAttribute('aria-label', tr('update_close', 'Chiudi'));
    x.textContent = '×';
    ov.appendChild(x);
    document.body.appendChild(ov);
    lightboxEl = ov;
    document.addEventListener('keydown', onLightboxKey);
  }
  function closeLightbox() {
    if (!lightboxEl) return;
    lightboxEl.remove();
    lightboxEl = null;
    document.removeEventListener('keydown', onLightboxKey);
  }
  function onLightboxKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); } }

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
      renderMarkdown(notes, info.notes, info.mediaTypes);
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

    const native = isNativeShell();
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'upd-btn primary';
    if (native) {
      // Native shell: install in-app (signed download + relaunch) — never open
      // GitHub in a browser. This is the whole update path on the native app.
      dlBtn.textContent = tr('update_auto', 'Aggiorna ora');
      dlBtn.addEventListener('click', () => { triggerNativeInstall(); closeModal(); });
    } else {
      dlBtn.textContent = tr('update_download', 'Scarica');
      dlBtn.addEventListener('click', () => {
        try { window.open(info.url || 'https://github.com/marcimastro98/Xenon/releases/latest', '_blank', 'noopener'); } catch { /* ignore */ }
        closeModal();
      });
    }
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
    // already usable while we probe. Skipped on native: that probe targets the
    // server self-update (the Node backend), which is a different component from
    // the native .exe — the native shell already updates itself in-app above.
    if (!native) enhanceAutoUpdate(info, { actions, statusEl, dlBtn });
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
      // On native, DON'T give it a GitHub href/target: the shell's external-link
      // shim intercepts target="_blank" clicks in the capture phase and would
      // open GitHub before our own handler runs. A local '#' href keeps the pill
      // clickable while the handler opens the (native-aware) in-app modal.
      if (isNativeShell()) {
        a.href = '#';
      } else {
        a.href = info.url || 'https://github.com/marcimastro98/Xenon/releases/latest';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.textContent = tr('update_available', 'Update available') + ' · v' + info.latest;
      a.addEventListener('click', (e) => { e.preventDefault(); openModal(info); });
      out.insertAdjacentElement('beforebegin', a);
      if (checkBtn) checkBtn.hidden = true;
    } else if (checkBtn) {
      checkBtn.hidden = false;
    }
  }

  // ── What's New (curated highlights for the running version) ──────────────────
  // A separate modal from the "update available" one above: it announces the
  // headline features of the version the user is ALREADY on, from the curated,
  // build-shipped server/whatsnew.json. It reappears at every startup until the
  // user taps "Don't show again" for that release's id, and only comes back when
  // a later build ships a new id (a bugfix release keeps the old id → no re-nag).
  const WHATSNEW_KEY = 'xenon.whatsnew.dismissed';
  function dismissedWhatsNew() { try { return localStorage.getItem(WHATSNEW_KEY) || ''; } catch { return ''; } }
  function rememberWhatsNew(id) { try { localStorage.setItem(WHATSNEW_KEY, String(id || '')); } catch { /* ignore */ } }

  // Text fields may be a plain string or a { <lang>: string } map — pick the UI
  // language (set on <html lang> by i18n), then English, then whatever exists.
  function pickLang(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const l = (document.documentElement.lang || 'en').toLowerCase();
      const keys = Object.keys(v);
      return v[l] || v.en || (keys.length ? v[keys[0]] : '') || '';
    }
    return '';
  }

  async function loadWhatsNew() {
    try {
      const res = await fetch('/whatsnew');
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  function openWhatsNew(wn) {
    if (!wn || !wn.id || !Array.isArray(wn.highlights) || !wn.highlights.length) return;
    closeModal();

    const overlay = document.createElement('div');
    overlay.className = 'upd-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

    const card = document.createElement('div');
    card.className = 'upd-card upd-whatsnew';
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
    title.textContent = pickLang(wn.title) || tr('whatsnew_title', 'Novità');
    const sub = document.createElement('div');
    sub.className = 'upd-ver';
    sub.textContent = tr('whatsnew_sub', 'Scopri cosa è cambiato in questa versione');
    headText.appendChild(title);
    headText.appendChild(sub);
    head.appendChild(headText);
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'upd-notes upd-hl-list';
    for (const h of wn.highlights) {
      const item = document.createElement('div');
      item.className = 'upd-hl';
      if (h && h.media && (h.mediaType === 'image' || h.mediaType === 'video') && isAllowedMediaUrl(h.media)) {
        appendMedia(item, h.media, h.mediaType, '');
      }
      const ht = pickLang(h && h.title);
      if (ht) {
        const ttl = document.createElement('div');
        ttl.className = 'upd-hl-title';
        ttl.textContent = ht;
        item.appendChild(ttl);
      }
      const hb = pickLang(h && h.body);
      if (hb) {
        const bod = document.createElement('div');
        bod.className = 'upd-hl-body';
        bod.textContent = hb;
        item.appendChild(bod);
      }
      list.appendChild(item);
    }
    card.appendChild(list);

    // Closing invite (e.g. "open Settings / read the full release notes"). Sits
    // outside the scrolling notes area so it's always visible above the buttons.
    const footerText = pickLang(wn.footer);
    if (footerText) {
      const foot = document.createElement('div');
      foot.className = 'upd-hl-footer';
      foot.textContent = footerText;
      card.appendChild(foot);
    }

    const actions = document.createElement('div');
    actions.className = 'upd-actions';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'upd-btn primary';
    okBtn.textContent = tr('whatsnew_great', 'Fantastico!');
    okBtn.addEventListener('click', closeModal);
    actions.appendChild(okBtn);

    if (wn.url) {
      const allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'upd-btn';
      allBtn.textContent = tr('whatsnew_all', 'Tutte le novità');
      allBtn.addEventListener('click', () => {
        try { window.open(wn.url, '_blank', 'noopener'); } catch { /* ignore */ }
      });
      actions.appendChild(allBtn);
    }

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'upd-btn ghost';
    dismissBtn.textContent = tr('update_dismiss', 'Non mostrare più');
    dismissBtn.addEventListener('click', () => { rememberWhatsNew(wn.id); closeModal(); });
    actions.appendChild(dismissBtn);

    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    openOverlay = overlay;
    freezeAmbient(true);
    document.addEventListener('keydown', onKey);
  }

  // ── Entry points ─────────────────────────────────────────────────────────────
  // At startup, curated "What's New" for the running version takes precedence over
  // the "update available" nudge (you can only act on one popup at a time, and the
  // update dot/pill stays visible either way). Whichever doesn't auto-open is still
  // reachable — the update modal from the Settings pill, and What's New reappears
  // next startup until dismissed.
  async function boot() {
    const [info, wn] = await Promise.all([check(false), loadWhatsNew()]);
    refreshIndicators(info);
    const wnPending = !!(wn && wn.id && dismissedWhatsNew() !== wn.id
      && Array.isArray(wn.highlights) && wn.highlights.length);
    const updatePending = !!(info && info.updateAvailable && dismissedVersion() !== info.latest);
    if (wnPending) openWhatsNew(wn);
    // On the native app, don't auto-pop this web modal: the shell shows its own
    // in-app "update available — tap to install" toast (native-bridge.js), and
    // two competing popups is exactly how a user ended up on the GitHub page.
    // The Settings pill still opens this modal on demand (now native-aware).
    else if (updatePending && !isNativeShell()) openModal(info);
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
  window.XenonWhatsNew = { load: loadWhatsNew, open: openWhatsNew };

  document.addEventListener('DOMContentLoaded', boot, { once: true });
})();

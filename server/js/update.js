'use strict';

// ── Update awareness ────────────────────────────────────────────────────────
// At startup the dashboard asks the server (which probes GitHub at most daily,
// fail-silent) whether a newer release exists. If so — and the user hasn't
// skipped that exact version — a polished modal presents the release notes (the
// GitHub release body, rendered with a tiny safe markdown parser) and offers
// Download / Later / Skip-this-version. A manual "Check for updates" button
// forces a fresh probe. Everything degrades to nothing when offline.
// The skip stores ONE version, never a flag: the next release always prompts.

(function () {
  const {
    stripV, semverNewer, isNativeShell, rememberDismissed, isVersionSkipped, readShellTried,
    rememberShellTried, rememberShellPending, takeShellPending, shellBehind, shellCatchUpPlan,
    hasUpdate,
  } = window.UpdateVersions;
  const RESULT_ACK_KEY = 'xenon.update.resultAck'; // last apply failure already shown as a toast
  const SHELL_ERR_KEY = 'xenon.update.shellErrPending'; // shell update failed right before a reload
  // How often a waiting app update asks whether this is a quiet moment.
  const SHELL_QUIET_FIRST_MS = 2 * 60 * 1000;
  const SHELL_QUIET_EVERY_MS = 10 * 60 * 1000;

  function tr(key, fallback) {
    return (typeof window.t === 'function' && window.t(key)) || fallback;
  }

  // Human text for an applier reason code (npm_install_failed, verify_failed…).
  // Unknown codes fall through verbatim so they stay diagnosable from a screenshot.
  function updReasonText(code) {
    if (!code) return '';
    const key = 'update_reason_' + code;
    const v = (typeof window.t === 'function') ? window.t(key) : '';
    return (v && v !== key) ? v : code;
  }

  // One-line explanation of a failed apply from the applier's persisted result.
  //
  // `detail` is the failing tool's OWN sentence, when there is one — today that
  // means npm's first `npm ERR!` line, captured by update-apply.ps1. The reason
  // code names the stage that failed and stops there, which is a true answer to a
  // question nobody is asking: "dependency installation failed" is the same text
  // whether the machine is offline, behind a proxy, out of disk, or has an
  // antivirus holding a file open, and those have four different fixes. It is
  // shown verbatim and untranslated on purpose: it is a tool's own words, and it
  // exists to be read and pasted by whoever is stuck.
  function applyFailureText(lastResult) {
    const base = lastResult && lastResult.rolledBack === false
      ? tr('update_failed_not_rolled_back', 'The update failed and automatic recovery also failed: please re-run INSTALL.bat.')
      : tr('update_failed_rolled_back', 'The update could not be applied and your previous version was restored.');
    const reason = updReasonText(lastResult && lastResult.reason);
    const detail = String((lastResult && lastResult.detail) || '').trim().slice(0, 200);
    return base + (reason ? ' (' + reason + ')' : '') + (detail ? ' — ' + detail : '');
  }

  async function fetchSelfStatus() {
    try { return await (await fetch('/update/self-status')).json(); } catch { return null; }
  }

  // On native, "update" means BOTH components: the Node backend (the dashboard
  // itself — updated through the same signed prepare/apply self-update the web
  // surface uses) and then the Tauri shell exe (through the shell's signed
  // updater, driven via the xenon-update: scheme with progress/error events
  // reported back by the Rust side). See nativeUpdateFlow below — the old
  // fire-and-forget toast that only updated the shell (and swallowed every
  // failure) is exactly the "Updating Xenon… and nothing happens" bug.


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
    if (window.BitApp) badge.innerHTML = window.BitApp.icon('idle');   // static, trusted markup
    head.appendChild(badge);
    const headText = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'upd-title';
    title.textContent = tr('update_title', 'Aggiornamento disponibile');
    const ver = document.createElement('div');
    ver.className = 'upd-ver';
    // With the dashboard current, what is being updated is the app: say which
    // version it comes from, not "from v4.11.13 to v4.11.13".
    const from = !info.updateAvailable && shellBehind(info)
      ? (window.__XENON_NATIVE_CAPS__ || {}).shellVersion
      : info.current;
    ver.textContent = 'v' + stripV(info.latest) + (from ? ', ' + tr('update_from', 'dalla v') + stripV(from) : '');
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

    // Skips THIS release only — the button used to say "Don't show again", which
    // promised something the code never did (and made people afraid to press it).
    // The title spells out that the next release still prompts.
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'upd-btn ghost';
    skipBtn.textContent = tr('update_skip', 'Salta questa versione');
    skipBtn.title = tr('update_skip_hint', 'Non chiedere più per la v{v}. Il prossimo aggiornamento verrà mostrato.')
      .replace('{v}', stripV(info.latest));
    skipBtn.addEventListener('click', () => { rememberDismissed(info.latest); closeModal(); });
    actions.appendChild(skipBtn);

    const laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = 'upd-btn';
    laterBtn.textContent = tr('update_later', 'Più tardi');
    laterBtn.addEventListener('click', closeModal);
    actions.appendChild(laterBtn);

    // The main key closes the row: on every window of the app it is the last one.
    const native = isNativeShell();
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'upd-btn primary';
    if (native) {
      // Native shell: one tap updates everything in-app — backend first, then
      // the shell exe — never open GitHub in a browser.
      dlBtn.textContent = tr('update_auto', 'Aggiorna ora');
      dlBtn.addEventListener('click', () => { nativeUpdateFlow(info); });
    } else {
      dlBtn.textContent = tr('update_download', 'Scarica');
      dlBtn.addEventListener('click', () => {
        try { window.open(info.url || 'https://github.com/marcimastro98/Xenon/releases/latest', '_blank', 'noopener'); } catch { /* ignore */ }
        closeModal();
      });
    }
    actions.appendChild(dlBtn);

    card.appendChild(actions);
    overlay.appendChild(card);

    // If one-click update is possible here, add an "Update now" primary button
    // (the manual Download stays as a fallback). Non-blocking — the modal is
    // already usable while we probe. Skipped on native: that probe targets the
    // server self-update (the Node backend), which is a different component from
    // the native .exe — the native shell already updates itself in-app above.
    if (!native) enhanceAutoUpdate(info, { actions, statusEl, dlBtn, skipBtn });
    document.body.appendChild(overlay);
    openOverlay = overlay;
    freezeAmbient(true);
    document.addEventListener('keydown', onKey);
  }

  // ── One-click update (safe two-step: prepare → apply) ────────────────────────
  async function enhanceAutoUpdate(info, ui) {
    const st = await fetchSelfStatus();
    if (!st || !st.supported) return; // git checkout or applier missing → manual only

    ui.dlBtn.classList.replace('primary', 'ghost');
    ui.dlBtn.textContent = tr('update_download_manual', 'Scarica manualmente');
    ui.skipBtn.after(ui.dlBtn);

    const state = { staged: !!(st.staged && stripV(String(st.staged.version || '')) === stripV(info.latest)) };
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
    ui.actions.appendChild(autoBtn);
  }

  function applyUpdate(info, ui, btn) {
    btn.disabled = true;
    ui.statusEl.hidden = false;
    ui.statusEl.className = 'upd-status';
    ui.statusEl.textContent = tr('update_applying', 'Avvio aggiornamento…');
    const applyStartedAt = Date.now();
    fetch('/update/apply', { method: 'POST' })
      .then((r) => r.json())
      .then((res) => {
        if (res && res.ok) {
          const ctrl = showUpdatingOverlay();
          pollUntilBack(info.latest, ctrl, { applyStartedAt });
        } else {
          ui.statusEl.className = 'upd-status error';
          ui.statusEl.textContent = tr('update_apply_failed', 'Avvio aggiornamento non riuscito.');
          btn.disabled = false;
        }
      })
      // The swap may kill the server before the response arrives — treat as started.
      .catch(() => {
        const ctrl = showUpdatingOverlay();
        pollUntilBack(info.latest, ctrl, { applyStartedAt });
      });
  }

  // Full-screen progress card shown while an update runs. Returns a controller
  // so the caller (web apply, native orchestrator) can retitle the phases and
  // flip it into a terminal error state instead of spinning blind.
  function showUpdatingOverlay() {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'upd-overlay';
    const card = document.createElement('div');
    card.className = 'upd-card upd-updating';
    const sp = XenonLoader.create({ size: 'lg' });
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
    return {
      setTitle(text) { msg.textContent = text; },
      setSub(text) { sub.textContent = text; },
      // Terminal failure: swap the spinner for a clear explanation + actions.
      fail(title, body, onRetry) {
        sp.remove();
        msg.textContent = title;
        sub.textContent = body;
        const actions = document.createElement('div');
        actions.className = 'upd-actions';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'upd-btn';
        closeBtn.textContent = tr('update_close', 'Chiudi');
        closeBtn.addEventListener('click', closeModal);
        actions.appendChild(closeBtn);
        if (onRetry) {
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'upd-btn primary';
          retryBtn.textContent = tr('update_retry', 'Riprova');
          retryBtn.addEventListener('click', () => { closeModal(); onRetry(); });
          actions.appendChild(retryBtn);
        }
        card.appendChild(actions);
      },
    };
  }

  // Poll /version until the NEW version serves. Resolves true on success, false
  // on a surfaced failure or timeout. When the server answers with a DIFFERENT
  // version, consult the applier's persisted result (see update-apply.ps1): a
  // failure newer than applyStartedAt means the update rolled back — explain it
  // instead of spinning to the 6-minute timeout. Callers pass onSuccess to
  // chain further phases (the native shell update); default is a page reload.
  async function pollUntilBack(targetVersion, ctrl, opts) {
    opts = opts || {};
    const applyStartedAt = opts.applyStartedAt || 0;
    const target = stripV(targetVersion);
    const start = Date.now();
    const deadline = start + 6 * 60 * 1000;
    let hinted = false;

    const failedResult = (st) => {
      const lr = st && st.lastResult;
      if (!lr || lr.ok) return null;
      const at = Date.parse(lr.at || '') || 0;
      return at >= applyStartedAt ? lr : null;
    };
    const showFailure = (lr) => {
      try { localStorage.setItem(RESULT_ACK_KEY, String(lr.at || '')); } catch { /* ignore */ }
      ctrl.fail(tr('update_failed_title', 'Aggiornamento non riuscito'), applyFailureText(lr),
        lr.rolledBack === false ? null : () => { location.reload(); });
    };

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      // If nothing has happened after a bit, the admin (UAC) prompt is the usual
      // reason — surface it instead of spinning silently.
      if (!hinted && Date.now() - start > 25000) {
        hinted = true;
        ctrl.setSub(tr('update_uac_hint', 'Accetta il prompt di amministratore (UAC) se compare. Se l’hai annullato, ricarica la pagina e riprova.'));
      }
      try {
        const res = await fetch('/version', { cache: 'no-store' });
        if (res.ok) {
          const j = await res.json();
          const v = j && j.version ? stripV(j.version) : '';
          // Proceed only once the NEW version is serving (avoids catching the old
          // server in the brief window before it's killed).
          if (v && (!target || v === target)) {
            if (opts.onSuccess) { opts.onSuccess(); } else { location.reload(); }
            return true;
          }
          // A server answering with the OLD version can be the rollback having
          // completed — but also the old server not yet killed. Only the
          // applier's own persisted verdict distinguishes the two.
          if (v && applyStartedAt) {
            const lr = failedResult(await fetchSelfStatus());
            if (lr) { showFailure(lr); return false; }
          }
        }
      } catch { /* server is restarting — keep polling */ }
    }
    // Timed out: one last look at the persisted result for a real explanation
    // before falling back to the vague "taking longer than expected".
    const lr = failedResult(await fetchSelfStatus());
    if (lr) { showFailure(lr); return false; }
    ctrl.setSub(tr('update_updating_timeout', 'Sta impiegando più del previsto. Ricarica la pagina tra poco.'));
    return false;
  }

  // ── Native one-tap update (backend first, then the shell exe) ───────────────
  // The two components update through their own signed channels; this drives
  // them in order behind one overlay. Backend failures STOP the flow (never
  // update the shell over a broken dashboard); shell failures are non-fatal
  // (the dashboard is already updated — the shell re-offers at next launch).
  let nativeFlowActive = false; // double-tap guard: two flows = two appliers racing
  let shellPhaseRunning = false; // the shell's own update has started in this page (runShellPhase)
  async function nativeUpdateFlow(info) {
    // The Xenon menu's window is not the app that replaces itself: the dashboard
    // takes the update over (layers::spec::dashboard_page).
    if (typeof isSheetPage === 'function' && isSheetPage()) {
      try { window.location.href = (window.__xenonSignal || String)('xenon-app:open-dashboard?open=update'); } catch { /* not native */ }
      return;
    }
    if (nativeFlowActive || shellPhaseRunning) return;
    nativeFlowActive = true;
    try { await nativeUpdateFlowInner(info); } finally { nativeFlowActive = false; }
  }

  async function nativeUpdateFlowInner(info) {
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    const latest = stripV(info && info.latest);
    // Unknown shell version (older shell without the caps injection) ⇒ assume
    // the shell is outdated and let its own updater decide (it no-ops when current).
    // A shell that cannot replace itself (an Arch package: pacman owns it) is
    // never "outdated" here; asking it to update would only report a failure.
    const shellOutdated = caps.shellSelfUpdate === false ? false
      : caps.shellVersion ? semverNewer(latest, caps.shellVersion) : true;
    const backendOutdated = !!(info && info.updateAvailable);
    const st = await fetchSelfStatus();
    const ctrl = showUpdatingOverlay();

    // The backend needs updating but its status couldn't even be read: NEVER
    // fall through to a shell-only update — that half-updates in silence, the
    // exact bug this flow exists to kill. Surface it, offer retry.
    if (backendOutdated && !st) {
      ctrl.fail(tr('update_failed_title', 'Aggiornamento non riuscito'),
        tr('update_prepare_failed', 'Preparazione non riuscita. Puoi scaricare manualmente.'),
        () => nativeUpdateFlow(info));
      return;
    }

    // The backend needs updating and this install says it cannot update itself
    // — a dev checkout, or a build whose applier script is missing. Running the
    // shell phase alone would download a new shell, restart, and leave the
    // dashboard serving the OLD version with nothing said: the app relaunches
    // and the update pill is still there, which is indistinguishable from the
    // button doing nothing. That is the half-update in silence this flow exists
    // to kill — the guard above catches a status that could not be read, and
    // this one catches a status that was read and said no.
    if (backendOutdated && st && !st.supported) {
      // The reason rides along in the same parenthetical shape the prepare
      // failure uses. It is a code, not a sentence, and deliberately so: it is
      // there to be read back to us, and a stuck install is diagnosed from it in
      // one line instead of a round of guesses.
      const why = (st.reason ? ' (' + st.reason + ')' : '');
      ctrl.fail(tr('update_failed_title', 'Aggiornamento non riuscito'),
        tr('update_self_unsupported',
          'Questa installazione non può aggiornarsi da sola, e reinstallare non la ripara. Mandaci questo motivo:') + why);
      return;
    }

    if (backendOutdated && st && st.supported) {
      ctrl.setTitle(tr('update_native_backend_phase', 'Aggiorno la dashboard…'));
      if (shellOutdated) rememberShellPending(latest);
      const staged = !!(st.staged && stripV(String(st.staged.version || '')) === latest);
      if (!staged) {
        ctrl.setSub(tr('update_preparing', 'Scarico e preparo… (può richiedere un minuto)'));
        let r;
        try { r = await (await fetch('/update/prepare', { method: 'POST' })).json(); } catch { r = null; }
        if (!r || !r.ok) {
          const reason = r && r.error ? ' (' + r.error + ')' : '';
          ctrl.fail(tr('update_failed_title', 'Aggiornamento non riuscito'),
            tr('update_prepare_failed', 'Preparazione non riuscita. Puoi scaricare manualmente.') + reason,
            () => nativeUpdateFlow(info));
          return;
        }
      }
      ctrl.setSub(tr('update_updating_sub', 'L’app si chiuderà e si riavvierà da sola. Non chiudere questa pagina.'));
      const applyStartedAt = Date.now();
      let started = true;
      try {
        const res = await (await fetch('/update/apply', { method: 'POST' })).json();
        started = !!(res && res.ok);
      } catch { /* the swap may kill the server before the response arrives — started */ }
      if (!started) {
        ctrl.fail(tr('update_failed_title', 'Aggiornamento non riuscito'),
          tr('update_apply_failed', 'Avvio aggiornamento non riuscito.'), () => nativeUpdateFlow(info));
        return;
      }
      const ok = await pollUntilBack(latest, ctrl, {
        applyStartedAt,
        // Don't reload on success: the shell phase (if any) chains from here,
        // and ITS restart/reload is what boots the freshly served dashboard.
        // On macOS this page usually never gets here: the applier relaunches
        // the whole app, and the next page finishes the job (shellCatchUpPlan).
        onSuccess: () => {},
      });
      if (!ok) return; // failure/timeout already on screen
      if (shellOutdated) { runShellPhase(ctrl, caps, latest); return; }
      location.reload();
      return;
    }

    if (shellOutdated) { runShellPhase(ctrl, caps, latest); return; }
    // Nothing left to do (both current) — a plain reload clears the overlay.
    location.reload();
  }

  // Drive the Tauri shell's signed self-update. New shells report progress and
  // errors through XenonNative.onShellUpdateEvent (evaled by the Rust side);
  // old shells are fire-and-forget, so a grace timer reloads the dashboard
  // whether or not the shell managed to restart itself.
  //
  // Once per page: the shell has no guard of its own, and a second
  // `xenon-update:install` (the shell's toast tapped while an automatic update
  // runs) would start a second download racing the first. The version it goes
  // for is remembered, so no automatic path starts it again (shellCatchUpPlan).
  function runShellPhase(ctrl, caps, target) {
    if (shellPhaseRunning) return;
    shellPhaseRunning = true;
    rememberShellTried(target);
    ctrl.setTitle(tr('update_native_shell_phase', 'Aggiorno l’app…'));
    ctrl.setSub(tr('native_update_installing_hint', 'The app will restart when it is done.'));

    const shellFailed = () => {
      // Non-fatal: the dashboard (backend) is already up to date. Remember the
      // failure across the reload so boot() can explain it — a toast shown now
      // would die with the reload.
      try { localStorage.setItem(SHELL_ERR_KEY, '1'); } catch { /* ignore */ }
      location.reload();
    };

    if (caps.updateEvents && window.XenonNative && typeof window.XenonNative.setShellUpdateListener === 'function') {
      // Watchdog: if the shell stops emitting (eval lost, process wedged), fall
      // back to a reload rather than an overlay that spins forever.
      let watchdog = null;
      const rearm = (ms) => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(shellFailed, ms);
      };
      rearm(90000);
      window.XenonNative.setShellUpdateListener((e) => {
        if (!e || !e.phase) return;
        // Any event proves the shell updater is alive — keep the watchdog fed
        // even for phases without their own UI ('checking', size-less downloads).
        rearm(120000);
        if (e.phase === 'downloading') {
          const pct = e.total ? Math.round((e.received / e.total) * 100) : null;
          ctrl.setSub(tr('update_native_shell_downloading', 'Scarico l’aggiornamento dell’app…') + (pct != null ? ' ' + pct + '%' : ''));
        } else if (e.phase === 'installing' || e.phase === 'restarting') {
          // The app is about to relaunch itself; the fresh page load takes over.
          ctrl.setSub(tr('native_update_installing_hint', 'The app will restart when it is done.'));
        } else if (e.phase === 'uptodate') {
          if (watchdog) clearTimeout(watchdog);
          location.reload();
        } else if (e.phase === 'error') {
          if (watchdog) clearTimeout(watchdog);
          shellFailed();
        }
      });
    } else {
      // Old shell without events: no way to observe the outcome, so just land
      // on the (already updated) dashboard after a grace period. NO failure
      // flag here — a slow download legitimately takes longer than this, and
      // the app restarting mid-use is the success signal on these shells.
      setTimeout(() => location.reload(), 25000);
    }
    // With this launch's nonce, or the shell drops it (see native-bridge.js).
    try { window.location.href = (window.__xenonSignal || String)('xenon-update:install'); } catch { /* not native */ }
  }

  // ── The app catching up with its dashboard ───────────────────────────────────
  // The app is two pieces: the shell the OS launches and the dashboard behind
  // it. The dashboard updates itself, by hand or on its own; the shell only
  // through its own signed updater. A shell left behind keeps every fix that
  // lives in it (window placement, wake from sleep, GPU) away from the user
  // while Settings reads "up to date". Reported from a Mac on 4.11.12 whose
  // crash log still said v4.11.7 on every line.



  // Run the plan once per page load. 'quiet' asks the server, which knows the
  // switch, a postponed update, the idle time and whether this shell can update
  // with nobody there to answer a password prompt (only Windows can). It stops
  // for good on any no that waiting cannot change, or when a newer release
  // turns up (the dashboard goes first again), and otherwise looks again every
  // ten minutes.
  let shellCatchUpTimer = null;
  // "Widgets only" (shell-driver.html): nothing on screen to draw the overlay
  // on, so the app half runs unseen; the app restarting is the sign, as it is
  // for the quiet catch-up.
  const isShellDriver = () => document.documentElement.hasAttribute('data-shell-driver');
  function shellPhaseView() {
    if (isShellDriver()) return { setTitle() {}, setSub() {}, fail() {} };
    return showUpdatingOverlay();
  }
  function catchUpShell(info) {
    const pending = takeShellPending();
    if (!shellBehind(info) || info.updateAvailable) return;
    const target = stripV(info.current);
    const plan = shellCatchUpPlan({
      behind: true,
      updateAvailable: false,
      current: target,
      latest: info.latest,
      tried: readShellTried(),
      pending,
      skipped: isVersionSkipped(target),
      now: Date.now(),
    });
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    if (plan === 'now') {
      runShellPhase(shellPhaseView(), caps, target);
      return;
    }
    if (plan !== 'quiet' || shellCatchUpTimer) return;
    const lookAgain = () => { shellCatchUpTimer = setTimeout(look, SHELL_QUIET_EVERY_MS); };
    const look = async () => {
      shellCatchUpTimer = null;
      if (shellPhaseRunning || nativeFlowActive) return;
      let a = null;
      try { a = await (await fetch('/update/auto-status?safe=1')).json(); } catch { a = null; }
      if (!a) { lookAgain(); return; }
      if (!a.enabled || a.shellSilent !== true) return;
      if (a.latest && stripV(a.latest) !== target) return;
      const tried = readShellTried();
      if (tried === null || tried === target) return;   // tapped meanwhile, or nothing can be remembered
      if (a.safeNow === true && !(a.postponedUntil > 0)) {
        runShellPhase(shellPhaseView(), caps, target);
        return;
      }
      lookAgain();
    };
    shellCatchUpTimer = setTimeout(look, SHELL_QUIET_FIRST_MS);
  }

  // ── Indicators (red dot + footer pill / check button) ───────────────────────
  function refreshIndicators(info) {
    const available = hasUpdate(info);

    const dot = document.getElementById('settings-update-dot');
    if (dot) dot.hidden = !available;

    const aboutCount = document.getElementById('settings-about-update');
    if (aboutCount) aboutCount.hidden = !available;

    const checkBtn = document.getElementById('settings-update-check');
    const existing = document.querySelector('.settings-update-pill');
    if (existing) existing.remove();

    if (available && checkBtn) {
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
      a.textContent = tr('update_available', 'Update available') + ' v' + stripV(info.latest);
      a.addEventListener('click', (e) => { e.preventDefault(); openModal(info); });
      checkBtn.insertAdjacentElement('beforebegin', a);
      checkBtn.hidden = true;
    } else if (checkBtn) {
      checkBtn.hidden = false;
    }
  }

  // ── After an update ──────────────────────────────────────────────────────────
  // What the person is told once the new version runs, from the curated,
  // build-shipped server/whatsnew.json. A major opens the full-screen What's New
  // (js/whats-new.js) and keeps coming back until it is closed, however it is
  // closed. A patch or a minor opens the list of what was fixed (js/release-
  // notes-card.js), once. js/release-notice.js holds the rules.
  //
  // Both are remembered on close, not on open: a page reloaded under them has not
  // told anyone anything. The stored answers live in hub settings, a file on the
  // PC (js/settings.js, see XenonStartupCards), with the pre-v4.11.6 localStorage
  // key kept in step for What's New. Without that module nothing can be
  // remembered, so nothing opens rather than open and come back forever.
  //
  // The version number at the bottom of Settings opens What's New again.
  const CARDS = () => (window.XenonStartupCards || null);
  function dismissedWhatsNew(id) { const c = CARDS(); return c ? c.whatsNewDismissed(id) : true; }
  function rememberWhatsNew(id) { const c = CARDS(); if (c) c.rememberWhatsNew(id); }
  const notice = () => window.XenonReleaseNotice;

  // Text fields may be a plain string or a { <lang>: string } map.
  const pickLang = (v) => notice().localText(v, document.documentElement.lang);
  const trKey = (key) => tr(key, key);

  async function loadWhatsNew() {
    try {
      const res = await fetch('/whatsnew');
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // The menu takes the screen only where a shell draws it: never on a phone.
  async function menuKey() {
    if (!isNativeShell()) return '';
    try { return (await (await fetch(SERVER + '/xenon-menu')).json()).menuKey || ''; } catch { return ''; }
  }

  async function openScreenMenu(section) {
    try {
      const res = await fetch(SERVER + '/screen-menu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: true, section }),
      });
      return res.ok ? (await res.json()).where : 'closed';
    } catch { return 'closed'; }
  }

  async function screenMenuOpen() {
    try { return (await (await fetch(SERVER + '/screen-menu', { cache: 'no-store' })).json()).open === true; } catch { return false; }
  }

  function openExternal(url) {
    try { window.open(url, '_blank', 'noopener'); } catch { /* ignore */ }
  }

  // `done` runs when it closes; without it the stage was asked for by hand.
  function openStoreFor(target) {
    const store = window.CommunityGallery;
    if (!store) return;
    if (target === 'supporters') store.openSupporters();
    else store.openSparks();
  }

  const lookOffer = () => (window.LookTrial && window.LookTrial.offered() ? window.LookTrial : null);

  async function openWhatsNew(wn, done) {
    if (!wn || !wn.id || !Array.isArray(wn.highlights) || !wn.highlights.length || !window.XenonWhatsNewStage) return;
    if (document.querySelector('.wn-stage')) return; // stepped aside for a try of the look, Bit can still ask
    closeModal();
    const key = await menuKey();
    freezeAmbient(true);
    window.XenonWhatsNewStage.open(wn, {
      text: pickLang,
      tr: trKey,
      openUrl: openExternal,
      openMenu: openScreenMenu,
      menuIsOpen: screenMenuOpen,
      canOpenMenu: isNativeShell(),
      menuKey: key,
      openStore: openStoreFor,
      look: lookOffer(),
      onAside: (out) => freezeAmbient(!out),
      onClose: () => {
        freezeAmbient(false);
        rememberWhatsNew(wn.id);
        if (done) done();
      },
    });
  }

  function openReleaseNotes(wn, notes, done) {
    window.XenonReleaseNotes.openNotes({
      notes, text: pickLang, tr: trKey, url: wn.url, openUrl: openExternal,
      onClose: () => {
        CARDS().rememberUpdateNotice({ notes: notes.version });
        done();
      },
    });
  }

  function failureReason(lr) {
    const detail = String(lr.detail || '').trim().slice(0, 200);
    return [updReasonText(lr.reason), detail].filter(Boolean).join(': ') || applyFailureText(lr);
  }

  function openUpdateFailed(lr, done) {
    window.XenonReleaseNotes.openFailed({
      lastResult: lr,
      detail: failureReason(lr),
      tr: trKey,
      onRetry: async () => { const info = await check(true); if (hasUpdate(info)) openModal(info); },
      onClose: () => {
        try { localStorage.setItem(RESULT_ACK_KEY, String(lr.at)); } catch { /* ignore */ }
        CARDS().rememberUpdateNotice({ failedAt: lr.at });
        done();
      },
    });
  }

  function pendingFailure(lr) {
    const c = CARDS();
    if (!c || !notice().failurePending(lr, c.updateFailSeen())) return null;
    let ack = '';
    try { ack = localStorage.getItem(RESULT_ACK_KEY) || ''; } catch { /* ignore */ }
    return ack === String(lr.at) ? null : lr;
  }

  // What still has to be said, oldest news first, one at a time: each opens only
  // when the screen is free, and the next waits for the one before to close.
  function noticeQueue(wn, lr) {
    const c = CARDS();
    const queue = [];
    const failed = pendingFailure(lr);
    if (failed) queue.push((next) => openUpdateFailed(failed, next));
    if (c && wn) {
      const { major, notes } = notice().pick({ wn, whatsNewSeen: c.whatsNewSeen(), notesSeen: c.releaseNotesSeen() });
      if (major && !dismissedWhatsNew(wn.id)) queue.push((next) => openWhatsNew(wn, next));
      if (notes) queue.push((next) => openReleaseNotes(wn, notes, next));
    }
    return queue;
  }

  let noticesRunning = false;
  function runNotices(queue) {
    if (noticesRunning || !queue.length) return;
    noticesRunning = true;
    const next = () => {
      const show = queue.shift();
      if (!show) { noticesRunning = false; return; }
      whenNothingElseIsUp(() => show(next));
    };
    next();
  }

  // An automatic update failed while this page stayed open.
  async function showUpdateNotices() {
    const [wn, st] = await Promise.all([loadWhatsNew(), fetchSelfStatus()]);
    runNotices(noticeQueue(wn, st && st.lastResult));
  }

  // ── Entry points ─────────────────────────────────────────────────────────────
  // At startup, curated "What's New" for the running version takes precedence over
  // the "update available" nudge (you can only act on one popup at a time, and the
  // update dot/pill stays visible either way). Whichever doesn't auto-open is still
  // reachable — the update modal from the Settings pill, and What's New from the
  // version number in Settings.
  // Failures that happened while no page was watching: an apply that rolled
  // back after the page was closed (the applier's persisted result), or a shell
  // update that errored right before the reload (flag set by runShellPhase).
  // Shown once, then acknowledged.
  // ── Will Xenon still be here after the next sign-in? ───────────────────────
  // The engine checks its own per-logon startup task and puts back the three
  // conditions the installer owns (see server/startup-task.js). Two things are
  // worth a word here, and nothing else is: a repair, because the app changed
  // something on this PC without being asked; and a task that is switched OFF,
  // because that one is the user's to turn back on and until they do, Xenon
  // will simply not be there tomorrow — with nothing on screen to say why. That
  // silence is what this exists for: it was reported as days of features going
  // wrong, by someone whose engine kept being stopped.
  //
  // Once per load, and never on a healthy install.
  async function surfaceStartupTaskNotice() {
    let st = null;
    try { st = await fetch('/api/startup-task').then((r) => r.json()); } catch { return; }
    if (!st || !st.ok || !st.found || !window.XenonToast) return;
    const problems = Array.isArray(st.problems) ? st.problems : [];
    const repaired = Array.isArray(st.repaired) ? st.repaired : [];
    if (problems.includes('disabled')) {
      window.XenonToast.show({
        type: 'warning',
        duration: 0,   // sticky: this is the one notice that costs the user their next session
        title: tr('startup_task_off_title', 'Xenon will not start at your next sign-in'),
        message: tr('startup_task_off_msg', 'Its startup entry has been switched off. Xenon never does that itself: Windows and cleanup or antivirus tools can. Turn it back on in Task Manager, under Startup apps, where it is listed as Xenon.'),
      });
    } else if (repaired.length) {
      window.XenonToast.show({
        type: 'info',
        duration: 10000,
        title: tr('startup_task_fixed_title', 'Xenon repaired its own startup entry'),
        message: tr('startup_task_fixed_msg', 'Something had changed the conditions it starts under: it would have stopped on battery, or been stopped after a few days. Those are back as they were installed.'),
      });
    }
  }

  function surfaceShellFailure(info) {
    try {
      if (localStorage.getItem(SHELL_ERR_KEY)) {
        localStorage.removeItem(SHELL_ERR_KEY);
        // The flag records "the shell update produced no outcome in time", not
        // a proven failure — an install can simply outlast the watchdog. If the
        // shell is in fact current now, the update landed: say nothing.
        const caps = window.__XENON_NATIVE_CAPS__ || {};
        const shellCurrent = !!(info && info.latest && caps.shellVersion
          && !semverNewer(stripV(info.latest), caps.shellVersion));
        if (!shellCurrent && window.XenonToast) {
          window.XenonToast.show({
            type: 'error',
            duration: 12000,
            title: tr('update_failed_title', 'Aggiornamento non riuscito'),
            message: tr('update_native_shell_error', 'L’app non è riuscita a completare il proprio aggiornamento. La dashboard è aggiornata: riproverà al prossimo avvio.'),
          });
        }
      }
    } catch { /* localStorage unavailable */ }
  }

  // This modal arrives on its own clock: `boot()` awaits `/update/check`, which
  // on a fresh install is a live GitHub call plus the media probes, so it can
  // land seconds after the first-run screen question opened. It used to render
  // into that regardless, and at z-index 4000 against the picker's 4100 it
  // landed BEHIND the dialog — a modal nobody could see, over a question nobody
  // could answer past.
  //
  // The arbiter is the one that knows what is on screen (js/interrupt-queue.js),
  // so this asks it rather than keeping a poller of its own. It still opens with
  // no delay on a clear dashboard: whenIdle() runs synchronously when nothing is
  // queued and nothing is up. Without the module — a stripped page, a load
  // order that went wrong — open anyway: an update notice that silently never
  // appears is worse than one that appears at a bad moment.
  function whenNothingElseIsUp(fn) {
    const I = window.XenonInterrupts;
    if (!I || typeof I.whenIdle !== 'function') { fn(); return; }
    I.whenIdle(fn, { priority: I.PRIORITY.update, maxTries: Infinity });
  }

  async function boot() {
    // Update notices, What's New and the shell catch-up belong to the main
    // dashboard; a layer window has none of that chrome on screen.
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    // The driver of "widgets only" keeps only the app catching up with its
    // dashboard; the update card lives in the alerts window (screen-alerts.js).
    if (isShellDriver()) { catchUpShell(await check(false)); return; }
    const [info, wn] = await Promise.all([check(false), loadWhatsNew()]);
    // Wait for the stored dismissal to be known before deciding anything. The
    // check() above already went to the network, so in practice the local
    // /settings fetch this waits on has long since answered; the guarantee still
    // has to be stated, or on a slow/failed release check the order flips and a
    // dismissed modal re-opens. Bounded inside whenReady — see settings.js.
    await new Promise((resolve) => {
      const c = CARDS();
      if (c && typeof c.whenReady === 'function') c.whenReady(resolve); else resolve();
    });
    refreshIndicators(info);
    surfaceShellFailure(info);         // fire-and-forget; only ever shows a toast
    surfaceStartupTaskNotice();        // same: silent on a healthy install
    catchUpShell(info);                // native only, and only with the app behind its dashboard
    // Read what has been seen HERE, after the awaits: on a first run settings.js
    // marks this release as seen while those fetches are still in flight.
    const st = await fetchSelfStatus();
    const queue = noticeQueue(wn, st && st.lastResult);
    const updatePending = !!(info && info.updateAvailable && !isVersionSkipped(info.latest));
    // On the native app, don't auto-pop this web modal: the shell shows its own
    // in-app "update available — tap to install" toast (native-bridge.js), and
    // two competing popups is exactly how a user ended up on the GitHub page.
    // The Settings pill still opens this modal on demand (now native-aware).
    if (updatePending && !isNativeShell()) queue.push((next) => { openModal(info); next(); });
    runNotices(queue);
  }

  // What's New of the running build, once it has been seen.
  async function reopenWhatsNew() {
    const wn = await loadWhatsNew();
    if (wn) openWhatsNew(wn);
  }

  // The version number on Settings' About page is the way back to it; Bit is the other.
  function wireVersionLabel() {
    const el = document.getElementById('settings-version');
    if (!el) return;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.title = tr('whatsnew_sub', 'Scopri cosa è cambiato in questa versione');
    el.addEventListener('click', reopenWhatsNew);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reopenWhatsNew(); }
    });
  }

  // Manual "Check for updates" button (forces a fresh probe).
  window.checkForUpdatesNow = async function checkForUpdatesNow(btn) {
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = tr('update_checking', 'Controllo…'); }
    const info = await check(true);
    if (btn) { btn.disabled = false; btn.textContent = original; }
    refreshIndicators(info);
    if (hasUpdate(info)) {
      openModal(info);
    } else if (window.XenonToast) {
      window.XenonToast.show({
        type: 'success',
        kicker: 'Xenon',
        title: tr('update_uptodate', 'Sei alla versione più recente'),
        message: info && info.current ? 'v' + info.current : '',
        important: true,   // the answer to the user's own "check for updates" tap
      });
    }
  };

  // nativeOrchestrate doubles as the feature marker the native shell's legacy
  // rescue script checks — its presence means this dashboard drives the full
  // backend+shell update flow itself.
  window.XenonUpdate = {
    check,
    openModal,
    refresh: () => check(false).then(refreshIndicators),
    nativeOrchestrate: nativeUpdateFlow,
    showNotices: showUpdateNotices,
    // Shared with the native shell's own update toast (native-bridge.js) so both
    // surfaces read and write ONE skipped version, normalized the same way.
    isVersionSkipped,
    skipVersion: rememberDismissed,
  };
  window.XenonWhatsNew = { load: loadWhatsNew, open: openWhatsNew, reopen: reopenWhatsNew };

  document.addEventListener('DOMContentLoaded', wireVersionLabel, { once: true });
  document.addEventListener('DOMContentLoaded', boot, { once: true });
})();

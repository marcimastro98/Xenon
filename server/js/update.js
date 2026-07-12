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
  const RESULT_ACK_KEY = 'xenon.update.resultAck'; // last apply failure already shown as a toast
  const SHELL_ERR_KEY = 'xenon.update.shellErrPending'; // shell update failed right before a reload

  function tr(key, fallback) {
    return (typeof window.t === 'function' && window.t(key)) || fallback;
  }

  // Strip any leading "v" so version strings compare/render consistently
  // (a "v"-prefixed version from the server must never render as "vv3.2.4").
  const stripV = (s) => String(s || '').replace(/^v/i, '');

  // Minimal semver triple compare: true only when a is strictly newer than b.
  // Deliberately PERMISSIVE with junk (unlike the fail-closed server/semver.js):
  // a malformed segment coerces to 0, so a garbled caps.shellVersion still
  // compares — the orchestrator would rather offer a shell update once too
  // often than never on exactly the broken installs that need it.
  function semverNewer(a, b) {
    const pa = stripV(a).split('.');
    const pb = stripV(b).split('.');
    for (let i = 0; i < 3; i++) {
      const x = parseInt(pa[i], 10) || 0;
      const y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x > y;
    }
    return false;
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
  function applyFailureText(lastResult) {
    const base = lastResult && lastResult.rolledBack === false
      ? tr('update_failed_not_rolled_back', 'The update failed and automatic recovery also failed — please re-run INSTALL.bat.')
      : tr('update_failed_rolled_back', 'The update could not be applied and your previous version was restored.');
    const reason = updReasonText(lastResult && lastResult.reason);
    return base + (reason ? ' (' + reason + ')' : '');
  }

  async function fetchSelfStatus() {
    try { return await (await fetch('/update/self-status')).json(); } catch { return null; }
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

  // On native, "update" means BOTH components: the Node backend (the dashboard
  // itself — updated through the same signed prepare/apply self-update the web
  // surface uses) and then the Tauri shell exe (through the shell's signed
  // updater, driven via the xenon-update: scheme with progress/error events
  // reported back by the Rust side). See nativeUpdateFlow below — the old
  // fire-and-forget toast that only updated the shell (and swallowed every
  // failure) is exactly the "Updating Xenon… and nothing happens" bug.

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
    const st = await fetchSelfStatus();
    if (!st || !st.supported) return; // git checkout or applier missing → manual only

    ui.dlBtn.classList.remove('primary');
    ui.dlBtn.textContent = tr('update_download_manual', 'Scarica manualmente');

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
    ui.actions.insertBefore(autoBtn, ui.actions.firstChild);
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
        if (onRetry) {
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'upd-btn primary';
          retryBtn.textContent = tr('update_retry', 'Riprova');
          retryBtn.addEventListener('click', () => { closeModal(); onRetry(); });
          actions.appendChild(retryBtn);
        }
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'upd-btn';
        closeBtn.textContent = tr('update_close', 'Chiudi');
        closeBtn.addEventListener('click', closeModal);
        actions.appendChild(closeBtn);
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
  async function nativeUpdateFlow(info) {
    if (nativeFlowActive) return;
    nativeFlowActive = true;
    try { await nativeUpdateFlowInner(info); } finally { nativeFlowActive = false; }
  }

  async function nativeUpdateFlowInner(info) {
    const caps = window.__XENON_NATIVE_CAPS__ || {};
    const latest = stripV(info && info.latest);
    // Unknown shell version (older shell without the caps injection) ⇒ assume
    // the shell is outdated and let its own updater decide (it no-ops when current).
    const shellOutdated = caps.shellVersion ? semverNewer(latest, caps.shellVersion) : true;
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

    if (backendOutdated && st && st.supported) {
      ctrl.setTitle(tr('update_native_backend_phase', 'Aggiorno la dashboard…'));
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
        onSuccess: () => {},
      });
      if (!ok) return; // failure/timeout already on screen
      if (shellOutdated) { runShellPhase(ctrl, caps); return; }
      location.reload();
      return;
    }

    if (shellOutdated) { runShellPhase(ctrl, caps); return; }
    // Nothing left to do (both current) — a plain reload clears the overlay.
    location.reload();
  }

  // Drive the Tauri shell's signed self-update. New shells report progress and
  // errors through XenonNative.onShellUpdateEvent (evaled by the Rust side);
  // old shells are fire-and-forget, so a grace timer reloads the dashboard
  // whether or not the shell managed to restart itself.
  function runShellPhase(ctrl, caps) {
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
    try { window.location.href = 'xenon-update:install'; } catch { /* not native */ }
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
  // Failures that happened while no page was watching: an apply that rolled
  // back after the page was closed (the applier's persisted result), or a shell
  // update that errored right before the reload (flag set by runShellPhase).
  // Shown once, then acknowledged.
  async function surfacePendingUpdateNotices(info) {
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
            message: tr('update_native_shell_error', 'L’app non è riuscita a completare il proprio aggiornamento. La dashboard è aggiornata — riproverà al prossimo avvio.'),
          });
        }
      }
    } catch { /* localStorage unavailable */ }
    const st = await fetchSelfStatus();
    const lr = st && st.lastResult;
    if (!lr || lr.ok || !lr.at) return;
    let ack = '';
    try { ack = localStorage.getItem(RESULT_ACK_KEY) || ''; } catch { /* ignore */ }
    if (ack === String(lr.at)) return;
    try { localStorage.setItem(RESULT_ACK_KEY, String(lr.at)); } catch { /* ignore */ }
    if (window.XenonToast) {
      window.XenonToast.show({
        type: 'error',
        duration: 15000,
        title: tr('update_failed_title', 'Aggiornamento non riuscito'),
        message: applyFailureText(lr),
      });
    }
  }

  async function boot() {
    const [info, wn] = await Promise.all([check(false), loadWhatsNew()]);
    refreshIndicators(info);
    surfacePendingUpdateNotices(info); // fire-and-forget; only ever shows toasts
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

  // nativeOrchestrate doubles as the feature marker the native shell's legacy
  // rescue script checks — its presence means this dashboard drives the full
  // backend+shell update flow itself.
  window.XenonUpdate = {
    check,
    openModal,
    refresh: () => check(false).then(refreshIndicators),
    nativeOrchestrate: nativeUpdateFlow,
  };
  window.XenonWhatsNew = { load: loadWhatsNew, open: openWhatsNew };

  document.addEventListener('DOMContentLoaded', boot, { once: true });
})();

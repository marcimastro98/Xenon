'use strict';

// ── Game Companion (opt-in, Settings → Funzioni AI) ─────────────────────────
// While a game is in the foreground, shows a floating pill; tapping it opens
// an overlay with the game name, session time, live FPS and an AI insight of
// the current screen (one Gemini vision request per analysis).
// Cost guard: NO automatic analysis — a vision request runs only when the
// user taps «Analizza schermo» or sends a question. FPS/session timers tick
// only while the overlay is visible.
(function () {
  // The session follows the game being RUNNING (alive in the foreground OR the
  // background), reported by the server as `gameRunning` — it verifies the game's
  // PID, so it stays true while the user taps the dashboard (which steals focus)
  // and flips false only when the game actually exits. No timers/linger guessing.
  let running = false;      // game alive (foreground or background)
  let proc = '';
  let sessionStart = null;
  let overlayOpen = false;
  let tickTimer = null;
  let fpsTimer = null;
  let analyzing = false;

  function enabled() {
    return typeof aiFeatureEnabled === 'function' && aiFeatureEnabled('gameCompanion');
  }

  function prettyName(p) {
    const base = String(p || '').replace(/\.exe$/i, '');
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
  }

  // Called from the status SSE/poll pipeline in main.js with the server's
  // `gameRunning` flag (the game is alive, in foreground or background).
  function onStatus(isRunning, processName) {
    if (isRunning) {
      if (!sessionStart) sessionStart = Date.now();
      running = true;
      proc = String(processName || '') || proc;
    } else {
      // Game exited. Hide the pill. If the overlay is open the user is mid-question,
      // so leave it usable and just reset once they close it (closeOverlay).
      running = false;
      if (!overlayOpen) { sessionStart = null; proc = ''; }
    }
    syncPill();
  }

  function endSession() {
    running = false;
    sessionStart = null;
    proc = '';
    closeOverlay();
  }

  function syncPill() {
    const pill = document.getElementById('gc-pill');
    if (!pill) return;
    const show = running && enabled() && !overlayOpen;
    pill.hidden = !show;
    if (show) {
      const label = document.getElementById('gc-pill-label');
      if (label) label.textContent = prettyName(proc) || t('gc_title');
    }
  }

  function fmtSession() {
    if (!sessionStart) return '0:00';
    const s = Math.max(0, Math.floor((Date.now() - sessionStart) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }

  async function pollFps() {
    try {
      const r = await fetch('/network');
      const d = await r.json();
      const el = document.getElementById('gc-fps');
      if (el) el.textContent = (d && d.fps != null) ? String(Math.round(d.fps)) : '—';
    } catch { /* transient — keep last value */ }
  }

  function openOverlay() {
    if (!enabled()) return;
    const ov = document.getElementById('gc-overlay');
    if (!ov || overlayOpen) return;
    overlayOpen = true;
    ov.hidden = false;
    requestAnimationFrame(() => ov.classList.add('show'));
    const g = document.getElementById('gc-game');
    if (g) g.textContent = prettyName(proc) || '—';
    const tick = () => {
      const el = document.getElementById('gc-session');
      if (el) el.textContent = fmtSession();
    };
    tick();
    tickTimer = setInterval(tick, 1000);
    pollFps();
    fpsTimer = setInterval(pollFps, 3000);
    syncPill();
    // No automatic analysis: the user decides when to spend a vision request
    // («Analizza schermo» or a typed question).
    const out = document.getElementById('gc-insight');
    if (out && !out.textContent.trim()) out.textContent = t('gc_waiting');
  }

  function closeOverlay() {
    const ov = document.getElementById('gc-overlay');
    overlayOpen = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (fpsTimer) { clearInterval(fpsTimer); fpsTimer = null; }
    if (ov && !ov.hidden) {
      ov.classList.remove('show');
      setTimeout(() => { ov.hidden = true; }, 250);
    }
    // If the game exited while the overlay was open, fully reset now so the pill
    // doesn't come back. If it's still running, syncPill restores the pill.
    if (!running) { sessionStart = null; proc = ''; }
    syncPill();
  }

  // Free-form question about the game: same vision request, grounded in the
  // live screenshot, but answering the user's text instead of the stock tip.
  function ask() {
    const input = document.getElementById('gc-question');
    const q = input ? input.value.trim() : '';
    if (!q) { analyze(); return; }
    if (input) input.value = '';
    analyze(q);
  }

  async function analyze(question) {
    if (analyzing || !overlayOpen) return;
    const out = document.getElementById('gc-insight');
    const btn = document.getElementById('gc-analyze');
    const askBtn = document.getElementById('gc-ask-btn');
    const apiKey = (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.geminiApiKey) || '';
    if (!apiKey) {
      if (out) out.textContent = t('gc_need_key');
      return;
    }
    analyzing = true;
    if (btn) btn.disabled = true;
    if (askBtn) askBtn.disabled = true;
    if (out) { out.textContent = t('gc_analyzing'); out.classList.add('gc-insight-loading'); }
    try {
      const r = await fetch('/api/companion/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `lang` is the UI language global from i18n.js (hubSettings has no
        // language field — reading it always fell back to English replies).
        body: JSON.stringify({
          key: apiKey,
          lang: (typeof lang !== 'undefined' && lang) || 'en',
          question: typeof question === 'string' ? question.slice(0, 300) : '',
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d || !d.text) throw new Error((d && d.error) || 'companion error');
      if (out) out.textContent = d.text;
      if (d.fps != null) {
        const f = document.getElementById('gc-fps');
        if (f) f.textContent = String(Math.round(d.fps));
      }
    } catch {
      if (out) out.textContent = t('gc_error');
    } finally {
      analyzing = false;
      if (btn) btn.disabled = false;
      if (askBtn) askBtn.disabled = false;
    }
    if (out) out.classList.remove('gc-insight-loading');
  }

  document.addEventListener('ai-features-changed', () => {
    if (!enabled()) endSession();
    syncPill();
  });

  window.GameCompanion = { onStatus, openOverlay, closeOverlay, analyze, ask };
})();

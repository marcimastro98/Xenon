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

  // Bit on the card. The card is the thing in front while it is open (the user
  // is at the dashboard, not playing), so like the voice view it moves under
  // game mode and stops only for the low-GPU choices; hidden, it stops by itself.
  const CARD_HOLD = ['low-power-gpu', 'perf-mode'];
  // What the card is doing -> Bit's mood in the head and its pose by the answer.
  const BIT_STATE = {
    waiting: { mood: 'idle', pose: ['idle'] },
    looking: { mood: 'think', pose: ['think', 'think'] },
    answered: { mood: 'idle', pose: ['happy', 'done'], play: 'nod' },
    failed: { mood: 'worry', pose: ['worry'] },
  };

  function showBit(state) {
    if (!window.BitApp) return;
    const s = BIT_STATE[state] || BIT_STATE.waiting;
    const head = document.getElementById('gc-bit');
    const player = head && BitApp.mount(head, { mood: s.mood, fidgets: false, hold: CARD_HOLD });
    if (player) {
      player.setMood(s.mood);
      if (s.play) player.play(s.play);
    }
    const by = document.getElementById('gc-reply-bit');
    if (by) by.innerHTML = BitApp.still(s.pose[0], 18, s.pose[1]);
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
      paintPillBit();
    }
  }

  // Bit with a controller, still: game mode is on while the pill shows, so it
  // would not move anyway, and a still costs nothing during play.
  function paintPillBit() {
    const icon = document.getElementById('gc-pill-icon');
    if (!icon || icon.firstChild || !window.BitApp) return;
    const svg = BitApp.icon('gaming');
    if (svg) icon.innerHTML = svg;
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
    loadCost();
    pollFps();
    fpsTimer = setInterval(pollFps, 3000);
    syncPill();
    // No automatic analysis: the user decides when to spend a vision request
    // («Analizza schermo» or a typed question).
    const out = document.getElementById('gc-insight');
    if (out && !out.textContent.trim()) { out.textContent = t('gc_waiting'); showBit('waiting'); }
    else showBit(out && out.dataset.bit);
    // Bit says hello with the controller in hand, then waits.
    const head = window.BitApp && BitApp.playerFor(document.getElementById('gc-bit'));
    if (head) head.play('gaming');
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

  // The answer remembers its state, so reopening the card shows the same Bit.
  function setBitState(out, state) {
    if (out) out.dataset.bit = state;
    showBit(state);
  }

  // What a look costs on Sparks, under the buttons and before pressing: the
  // hub's charge for the last look, or the price table until one is made. On
  // any other AI there is nothing to pay here, so the line stays hidden.
  function paintCost(sparks) {
    const el = document.getElementById('gc-cost');
    if (!el) return;
    const on = Number.isFinite(sparks) && sparks > 0 && !!(window.XenonCredits && XenonCredits.active());
    el.hidden = !on;
    if (!on) return;
    el.textContent = sparks < 1
      ? t('gc_cost_under')
      : t('gc_cost').replace('{n}', XenonCredits.format(sparks));
  }

  async function loadCost() {
    try {
      const r = await fetch(SERVER + '/api/companion/cost');
      const d = await r.json();
      paintCost(d && d.ok ? d.sparks : null);
    } catch { paintCost(null); }
  }

  // Why Bit could not answer, in words the user can act on. Out of Sparks
  // comes with the way to recharge, where the Sparks shop exists.
  const PROBLEM_TEXT = { no_ai: 'gc_need_key', no_vision: 'gc_no_vision', no_credits: 'gc_no_sparks' };
  function showProblem(out, code) {
    if (!out) return;
    out.textContent = t(PROBLEM_TEXT[code] || 'gc_error');
    out.classList.remove('gc-insight-loading');
    const shop = window.XenonCredits && typeof XenonCredits.openShop === 'function';
    if (code === 'no_credits' && shop) {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'gc-recharge';
      go.textContent = t('bit_model_topup');
      go.addEventListener('click', () => { closeOverlay(); XenonCredits.openShop(); });
      out.append(' ', go);
    }
    setBitState(out, 'failed');
  }

  async function analyze(question) {
    if (analyzing || !overlayOpen) return;
    const out = document.getElementById('gc-insight');
    const btn = document.getElementById('gc-analyze');
    const askBtn = document.getElementById('gc-ask-btn');
    // The AI set for Bit answers (Sparks, a key, Ollama); the server says when
    // it cannot look at a picture.
    if (typeof _aiHasKey === 'function' && !_aiHasKey()) {
      showProblem(out, 'no_ai');
      return;
    }
    analyzing = true;
    if (btn) btn.disabled = true;
    if (askBtn) askBtn.disabled = true;
    if (out) { out.textContent = t('gc_analyzing'); out.classList.add('gc-insight-loading'); }
    setBitState(out, 'looking');
    try {
      const r = await fetch('/api/companion/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `lang` is the UI language global from i18n.js (hubSettings has no
        // language field — reading it always fell back to English replies).
        body: JSON.stringify({
          lang: (typeof lang !== 'undefined' && lang) || 'en',
          question: typeof question === 'string' ? question.slice(0, 300) : '',
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d || !d.text) throw new Error((d && d.error) || 'companion error');
      if (out) out.textContent = d.text;
      setBitState(out, 'answered');
      // A paid look: the line shows what this one cost, the chip the new balance.
      if (Number.isFinite(d.sparks)) {
        paintCost(d.sparks);
        if (window.XenonCredits && typeof XenonCredits.refresh === 'function') XenonCredits.refresh(true);
      }
      if (d.fps != null) {
        const f = document.getElementById('gc-fps');
        if (f) f.textContent = String(Math.round(d.fps));
      }
    } catch (e) {
      showProblem(out, e && e.message);
    } finally {
      analyzing = false;
      if (btn) btn.disabled = false;
      if (askBtn) askBtn.disabled = false;
    }
    if (out) out.classList.remove('gc-insight-loading');
  }

  // A Deck key, its keyboard shortcut or the voice (SSE `game_companion`,
  // capabilities/game-companion.js): the card opens with or without a game,
  // told which game runs and since when, so the session time is the game's.
  function show(o) {
    const d = o && typeof o === 'object' ? o : {};
    if (typeof d.game === 'string' && d.game) proc = d.game.slice(0, 80);
    if (Number.isFinite(d.since) && d.since > 0 && d.since <= Date.now()) sessionStart = d.since;
    openOverlay();
    return overlayOpen;
  }

  const isOpen = () => overlayOpen;

  document.addEventListener('ai-features-changed', () => {
    if (!enabled()) endSession();
    syncPill();
  });

  window.GameCompanion = { onStatus, openOverlay, closeOverlay, analyze, ask, show, isOpen };
})();

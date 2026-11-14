'use strict';
// Bit — the pixel guardian pet (Settings → Notifiche → Vitals → Bit).
//
// A little 8-bit creature that lives in a corner of the dashboard (and/or as a
// mini chip next to the topbar clock — pet.position: floating/topbar/both),
// mirrors the health of your Vitals meters, and — when you let a vital sit at
// ZERO — climbs an escalation ladder of friendly abuse: speech-bubble roasts
// and toasts, then dashboard decay (desaturation + glitch) and a CRT "GAME
// OVER" card, then pixel popups on the PC monitors, then minimize-all, then a
// workstation lock. Every rung past the toasts is a separate opt-in (see
// normalizeVitals), the PC-invading rungs also require presence (system idle
// from the status SSE — the Xeneon touchscreen alone can't prove you're at the
// PC), and everything stands down during a game when "quiet in game" is on…
// though Bit does keep receipts for when the match ends.
//
// Context awareness: Bit sleeps while you're away (the meters freeze too — see
// vitals.js away-pause) and greets you on return; sleeps through the night
// (23–07, pet.nightQuiet) without ever escalating past decay; remembers your
// daily self-care streak and lifetime records (vitals.state.mem) and celebrates
// streaks; and — opt-in (pet.aiRoasts) — asks the configured Xenon AI provider
// for a personalized one-liner built from real context, falling back to the
// offline phrase bank on any failure or timeout, so the ladder never waits.
//
// Truce (snooze / mute-today) and per-episode escalation flags persist in
// vitals.state.pet: a reload can't re-fire GAME OVER / minimize / lock, and a
// truce granted on one surface holds on every other (server-merged).
//
// Phrases + escalation thresholds live in vitals-pet-core.js (unit-tested).
// All timers are gated: nothing runs unless the pet is enabled, and teardown
// clears every interval/timeout it started (and closes the audio context).
(function () {
  const core = window.VitalsPetCore;
  const {
    t, thresholdsMs, cfg, petCfg, activated, lang, vitalName, todayKey, popupsAllowed, petState,
    memState, saveVitalsState, persistEp, bumpMemPatch, snoozed,
  } = window.VitalsPetSaved;

  const EMPTY = 0.02;              // same "at zero" threshold as vitals.js
  const LOW = 0.25;
  const TICK_MS = 5000;
  const {
    CLIP, MOOD_RGB, state, present, roastCtx, sound, mountBit, react, releaseBits, setMood, setDecay,
    glitchPulse, closeGameOver, readPcCaps, pcCan, serverNag, ledFlash,
  } = window.VitalsPetEffects;
  const NAG_GLOBAL_GAP_MS = 90000; // min gap between nag toasts across ALL vitals
  const MIN_WARN_MS = 30000;       // warning before minimize-all
  const LOCK_WARN_MS = 60000;      // countdown before the workstation lock
  const BUBBLE_MS = 9000;
  const DECAY_FULL_MS = 15 * 60000; // from decay onset to full black & white
  const DECAY_BASE = 0.15;          // visible desaturation the instant decay starts
  const AI_ROAST_TIMEOUT_MS = 3500; // AI slower than this → offline bank line
  // On Sparks the hub charges even when the reply comes late, so wait longer
  // before throwing a paid line away.
  const AI_ROAST_SPARKS_TIMEOUT_MS = 8000;

  // ── Bit's look: the shared engine (shared/src/bit*.js via js/bit-app.js) ──
  const GAMEOVER_PX = 56;

  // ── state ──
  const bag = {};             // shuffle-bag state (vitals-pet-core)
  const episodes = {};        // vitalId -> escalation bookkeeping for the current zero-episode



  // ── durable pet state (vitals.state.pet / .mem — see normalizeVitals) ──
  function phrase(kind, vital, deadMs) {
    return core.pick(bag, {
      kind, vital, lang: lang(), tone: petCfg().tone,
      vars: { vital: vitalName(vital), min: Math.max(1, Math.round((deadMs || 0) / 60000)) },
    });
  }

  // ── AI roasts (opt-in) ──
  async function roastOrBank(kind, vital, deadMs) {
    const bank = () => phrase(kind, vital, deadMs); // lazy — don't burn a bag draw when AI answers
    try {
      const pet = petCfg();
      if (pet.aiRoasts !== true) return bank();
      if (typeof _aiProviderReady !== 'function' || typeof _aiProviderCfg !== 'function' || !_aiProviderReady()) return bank();
      // Bit speaks up on its own: it never spends a Claude Code / Codex
      // subscription, and Sparks only up to the daily number the user picked
      // (the server holds both), so skip the round trip when it would say no.
      const provider = _aiProviderCfg().provider;
      if (['claudecode', 'codex'].includes(provider)) return bank();
      const onSparks = provider === 'xenon';
      if (onSparks && !(Number(pet.roastSparksCap) > 0)) return bank();
      const now = Date.now();
      if (now - state.lastAiAt < NAG_GLOBAL_GAP_MS) return bank();
      state.lastAiAt = now;
      const prov = _aiProviderCfg();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), onSparks ? AI_ROAST_SPARKS_TIMEOUT_MS : AI_ROAST_TIMEOUT_MS);
      const res = await fetch('/api/vitals/roast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          key: (typeof hubSettings === 'object' && hubSettings && hubSettings.geminiApiKey) || '',
          provider: prov.provider,
          model: prov.model,
          ollamaUrl: prov.ollamaUrl,
          lang: lang(),
          tone: pet.tone,
          ctx: roastCtx(kind, vital, deadMs),
        }),
      });
      clearTimeout(timer);
      if (res && res.ok) {
        const out = await res.json().catch(() => null);
        const text = out && typeof out.text === 'string' ? core.fitLine(out.text, 140) : '';
        if (text) return text;
      }
    } catch { /* timeout / offline / provider error — the bank never fails */ }
    return bank();
  }

  // ── 8-bit sounds (tiny WebAudio square-wave synth, no assets) ──
  // ── DOM: pet + chip + bubble + menu ──

  function mount() {
    if (state.host) return;
    state.host = document.createElement('div');
    state.host.className = 'vpet';
    state.host.id = 'vitals-pet';
    const bubble = document.createElement('div');
    bubble.className = 'vpet-bubble';
    bubble.hidden = true;
    const txt = document.createElement('span');
    txt.className = 'vpet-bubble-txt';
    bubble.appendChild(txt);
    state.host.appendChild(bubble);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vpet-sprite';
    btn.setAttribute('aria-label', 'Bit');
    btn.addEventListener('click', toggleMenu);
    state.host.appendChild(btn);
    document.body.appendChild(state.host);
    mountBit(btn, true);
    setMood(state.mood || 'neutral', true);
  }
  function unmountFloating() {
    if (!state.host) return;
    if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null; }
    if (state.typeTimer) { clearInterval(state.typeTimer); state.typeTimer = null; }
    closeMenu();
    state.host.remove();
    state.host = null;
    releaseBits();
  }

  // The topbar mini-Bit: first child of #clock-vitals, so it rides the
  // minimal-island reparenting together with the clock exactly like the vitals
  // chips (vitals.js syncTopbar knows to preserve it and to keep the host
  // visible while it exists).
  function mountChip() {
    if (state.chip) return;
    const hostEl = document.getElementById('clock-vitals');
    if (!hostEl) return;
    state.chip = document.createElement('button');
    state.chip.type = 'button';
    state.chip.id = 'clock-bit';
    state.chip.className = 'clock-bit';
    state.chip.setAttribute('aria-label', 'Bit');
    const spr = document.createElement('span');
    spr.className = 'cb-sprite';
    state.chip.appendChild(spr);
    state.chip.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(e); });
    hostEl.prepend(state.chip);
    mountBit(spr, false); // a tiny Bit next to the clock stays still between moods
    hostEl.hidden = false;
    if (window.TopbarMinimal && window.TopbarMinimal.applyIslandLayout) window.TopbarMinimal.applyIslandLayout();
    setMood(state.mood || 'neutral', true);
  }
  function unmountChip() {
    if (!state.chip) return;
    state.chip.remove();
    state.chip = null;
    releaseBits();
    if (state.chipBubbleTimer) { clearTimeout(state.chipBubbleTimer); state.chipBubbleTimer = null; }
    if (state.chipBubbleEl) { state.chipBubbleEl.remove(); state.chipBubbleEl = null; }
    const hostEl = document.getElementById('clock-vitals');
    if (hostEl && !hostEl.querySelector('.clock-vital')) hostEl.hidden = true;
    if (window.TopbarMinimal && window.TopbarMinimal.applyIslandLayout) window.TopbarMinimal.applyIslandLayout();
  }
  function ensureMounts() {
    const pos = petCfg().position || 'floating';
    if (pos === 'topbar') unmountFloating(); else mount();
    if (pos === 'floating') unmountChip(); else mountChip();
  }

  function teardown() {
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null; }
    if (state.typeTimer) { clearInterval(state.typeTimer); state.typeTimer = null; }
    if (state.lockCountTimer) { clearInterval(state.lockCountTimer); state.lockCountTimer = null; }
    closeMenu();
    closeGameOver();
    setDecay(0);
    Object.keys(episodes).forEach(k => delete episodes[k]);
    state.roastGen++; // void any in-flight roast — its bubble/toast must not fire post-teardown
    state.nightGreeted = false;
    unmountChip();
    if (state.host) { state.host.remove(); state.host = null; }
    releaseBits();
    // Stop-what-you-start: an enable→disable cycle must not leave a live
    // AudioContext behind (sound() lazily recreates it).
    if (state.audioCtx) { try { state.audioCtx.close().catch(() => {}); } catch { /* already closed */ } state.audioCtx = null; }
  }

  function showBubble(text, ms) {
    if (!text) return;
    if (!state.host) { showChipBubble(text, ms); return; }
    const bubble = state.host.querySelector('.vpet-bubble');
    const txt = state.host.querySelector('.vpet-bubble-txt');
    if (!bubble || !txt) return;
    if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null; }
    if (state.typeTimer) { clearInterval(state.typeTimer); state.typeTimer = null; }
    bubble.hidden = false;
    // Typewriter — untrusted-ish text (phrase bank / AI reply), so textContent only.
    let i = 0;
    txt.textContent = '';
    state.typeTimer = setInterval(() => {
      i += 2;
      txt.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(state.typeTimer); state.typeTimer = null; }
    }, 24);
    state.bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
      if (state.typeTimer) { clearInterval(state.typeTimer); state.typeTimer = null; }
    }, ms || BUBBLE_MS);
  }
  // Compact bubble under the topbar chip, for when the floating pet is off
  // (position: 'topbar'). textContent only, same as the main bubble.
  function showChipBubble(text, ms) {
    if (!state.chip || !text) return;
    if (state.chipBubbleTimer) { clearTimeout(state.chipBubbleTimer); state.chipBubbleTimer = null; }
    if (!state.chipBubbleEl) {
      state.chipBubbleEl = document.createElement('div');
      state.chipBubbleEl.className = 'vpet-chip-bubble';
      document.body.appendChild(state.chipBubbleEl);
    }
    state.chipBubbleEl.textContent = text;
    state.chipBubbleEl.style.setProperty('--vpet-rgb', MOOD_RGB[state.mood] || MOOD_RGB.neutral);
    const r = state.chip.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    state.chipBubbleEl.style.maxWidth = width + 'px';
    state.chipBubbleEl.style.top = Math.round(r.bottom + 8) + 'px';
    state.chipBubbleEl.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2))) + 'px';
    state.chipBubbleEl.hidden = false;
    state.chipBubbleTimer = setTimeout(() => { if (state.chipBubbleEl) state.chipBubbleEl.hidden = true; }, ms || BUBBLE_MS);
  }

  // Quick menu: worst meters + truce controls. Rebuilt on every open; anchored
  // under the chip when opened from the topbar, inside the pet otherwise.
  function buildMenu() {
    const v = cfg();
    const snap = window.VitalsWidget && window.VitalsWidget.snapshot ? window.VitalsWidget.snapshot() : null;
    const menu = document.createElement('div');
    menu.className = 'vpet-menu';
    const head = document.createElement('div');
    head.className = 'vpet-menu-head';
    head.textContent = 'Bit';
    const lv = document.createElement('span');
    lv.className = 'vpet-menu-lv';
    lv.textContent = t('vitals_level', 'Livello {n}').replace('{n}', String(1 + Math.floor((Number(v.state && v.state.xp) || 0) / 100)));
    head.appendChild(lv);
    // Bit's memory on display: the current self-care streak (days in a row).
    const streak = Number(memState().streak) || 0;
    if (streak >= 2) {
      const st = document.createElement('span');
      st.className = 'vpet-menu-streak';
      st.textContent = t('vpet_streak_days', '{n} giorni di fila').replace('{n}', String(streak));
      st.title = t('vpet_streak_title', 'Self-care streak (days in a row)');
      head.appendChild(st);
    }
    menu.appendChild(head);
    if (snap) {
      snap.ids.forEach((id) => {
        const lvl = snap.levels[id];
        if (lvl > LOW) return;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'vpet-menu-row' + (lvl <= EMPTY ? ' is-dead' : '');
        const name = document.createElement('span');
        name.textContent = vitalName(id);
        const pct = document.createElement('span');
        pct.className = 'vpet-menu-pct';
        pct.textContent = Math.round(lvl * 100) + '%';
        row.append(name, pct);
        row.addEventListener('click', () => {
          closeMenu();
          if (window.VitalsWidget) window.VitalsWidget.openDetail(id);
        });
        menu.appendChild(row);
      });
    }
    const snooze = document.createElement('button');
    snooze.type = 'button';
    snooze.className = 'vpet-menu-act';
    snooze.textContent = t('vpet_snooze', 'Tregua 30 min');
    snooze.addEventListener('click', () => {
      state.roastGen++; // a roast in flight must not break the truce it predates
      saveVitalsState({ pet: { ...petState(), snoozeUntil: Date.now() + 30 * 60000 } });
      closeMenu();
      showBubble(t('vpet_snooze_ok', 'Ok. 30 minuti. Poi torno.'), 5000);
    });
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'vpet-menu-act';
    mute.textContent = t('vpet_mute_today', 'Zitto per oggi');
    mute.addEventListener('click', () => {
      state.roastGen++;
      saveVitalsState({ pet: { ...petState(), muteDay: todayKey() } });
      closeMenu();
      showBubble(t('vpet_mute_ok', 'Silenzio fino a domani. Ricordati che esisto.'), 5000);
    });
    menu.append(snooze, mute);
    // The pet is the same Bit as the assistant: one tap to its chat, with a
    // question about the meters ready to send or change.
    if (typeof window.openAiPanel === 'function') {
      const talk = document.createElement('button');
      talk.type = 'button';
      talk.className = 'vpet-menu-act';
      talk.textContent = t('vpet_talk', 'Parla con Bit');
      talk.addEventListener('click', () => {
        closeMenu();
        window.openAiPanel();
        const input = document.getElementById('ai-text-input');
        if (input && !input.value) input.value = t('vpet_talk_prompt', 'Come sto con i vitali?');
      });
      menu.appendChild(talk);
    }
    return menu;
  }
  function toggleMenu(e) {
    const open = document.querySelector('.vpet-menu');
    if (open) { closeMenu(); return; }
    const menu = buildMenu();
    const fromChip = !!(e && state.chip && (e.currentTarget === state.chip || state.chip.contains(e.target)));
    if (!fromChip && state.host) {
      state.host.appendChild(menu);
    } else if (state.chip) {
      // Opened from the topbar chip: no host to nest in, so anchor a fixed
      // menu right under the chip (clamped to the viewport).
      menu.classList.add('vpet-menu-anchored');
      menu.dataset.mood = state.mood;
      menu.style.setProperty('--vpet-rgb', MOOD_RGB[state.mood] || MOOD_RGB.neutral);
      document.body.appendChild(menu);
      const r = state.chip.getBoundingClientRect();
      const w = menu.offsetWidth || 220;
      menu.style.top = Math.round(r.bottom + 8) + 'px';
      menu.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))) + 'px';
    } else {
      return;
    }
    setTimeout(() => document.addEventListener('pointerdown', onOutsideMenu, { once: true }), 0);
  }
  function onOutsideMenu(e) {
    const menu = document.querySelector('.vpet-menu');
    const inside = (state.host && state.host.contains(e.target)) || (state.chip && state.chip.contains(e.target)) || (menu && menu.contains(e.target));
    if (inside) {
      // Tap landed back inside the pet/menu — re-arm instead of closing.
      document.addEventListener('pointerdown', onOutsideMenu, { once: true });
      return;
    }
    closeMenu();
  }
  function closeMenu() {
    document.removeEventListener('pointerdown', onOutsideMenu);
    const m = document.querySelector('.vpet-menu');
    if (m) m.remove();
  }

  // ── dashboard effects (decay filter + glitch pulse + GAME OVER card) ──

  function showGameOver(vital, deadMs, allDead) {
    closeGameOver();
    const ov = document.createElement('div');
    ov.className = 'vpet-gameover';
    const card = document.createElement('div');
    card.className = 'vpet-go-card';
    const title = document.createElement('div');
    title.className = 'vpet-go-title';
    title.textContent = 'GAME OVER';
    const sub = document.createElement('div');
    sub.className = 'vpet-go-sub';
    sub.textContent = allDead ? phrase('alldead', '', deadMs) : phrase('gameover', vital, deadMs);
    const ico = document.createElement('div');
    ico.className = 'vpet-go-sprite';
    // The engine's own palette and numbers only (BitApp.still), never user text.
    ico.innerHTML = window.BitApp ? window.BitApp.still(CLIP[allDead ? 'ghost' : 'angry'], GAMEOVER_PX) : '';
    const actions = document.createElement('div');
    actions.className = 'vpet-go-actions';
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'vpet-go-btn is-fix';
    fix.textContent = t('vpet_gameover_fix', 'RIMEDIA');
    fix.addEventListener('click', () => {
      closeGameOver();
      if (window.VitalsWidget) window.VitalsWidget.openDetail(vital);
    });
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'vpet-go-btn';
    skip.textContent = t('vpet_gameover_ignore', 'IGNORA');
    skip.addEventListener('click', closeGameOver);
    actions.append(fix, skip);
    const coin = document.createElement('div');
    coin.className = 'vpet-go-coin';
    coin.textContent = t('vpet_gameover_coin', 'INSERT SELF-CARE TO CONTINUE');
    card.append(ico, title, sub, actions, coin);
    ov.appendChild(card);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeGameOver(); });
    document.body.appendChild(ov);
    state.gameOverEl = ov;
    sound('gameover');
  }

  // ── server-side actions (each rung re-checked server-side too) ──


  function toast(type, title, message, vital) {
    if (!popupsAllowed() || !window.XenonToast) return;
    window.XenonToast.show({
      // Bit plays its own 8-bit cue via sound() (gated by pet.sounds), so the
      // generic notification cue is suppressed here to avoid a double sound.
      type, kicker: 'Bit', title, message, duration: 10000, silent: true,
      onClick: vital ? () => { if (window.VitalsWidget) window.VitalsWidget.openDetail(vital); } : undefined,
    });
  }

  // ── the escalation tick ──
  function tick() {
    if (!activated()) { teardown(); return; }
    ensureMounts();
    const pet = petCfg();
    const snap = window.VitalsWidget && window.VitalsWidget.snapshot ? window.VitalsWidget.snapshot() : null;
    if (!snap || !snap.enabled) return;
    // Boot fence (vitals.js): right after a PC boot the meters read zero for a
    // few ticks until ensureFresh reseeds them — escalating on that stale zero
    // would greet the user at logon with the entire nag ladder at once.
    if (typeof window.VitalsWidget.bootSynced === 'function' && !window.VitalsWidget.bootSynced()) return;
    const now = Date.now();

    // Away: the meters are frozen (vitals.js away-pause) and nobody is there to
    // roast — Bit just sleeps until vitals.js announces the return (onReturn).
    if (snap.away === true) { setMood('sleep'); return; }

    // Quiet hours (the user's window, 23–07 by default): Bit sleeps; decay may
    // still creep, but no bubbles, toasts, GAME OVER or PC actions until the
    // window ends. One yawny line if the user is demonstrably around anyway.
    const quietNight = pet.nightQuiet !== false && core.isNight(new Date().getHours(), pet.quietFrom, pet.quietTo);
    if (quietNight) {
      if (!state.nightGreeted && present() && !snoozed()) {
        state.nightGreeted = true;
        showBubble(phrase('night', '', 0), 7000);
      }
    } else {
      state.nightGreeted = false;
    }

    // Mood mirrors the WORST meter; ghost when everything is dead; asleep at night.
    const lvls = snap.ids.map(id => snap.levels[id]);
    const worst = lvls.length ? Math.min.apply(null, lvls) : 1;
    const deadIds = snap.ids.filter(id => snap.levels[id] <= EMPTY);
    const allDead = snap.ids.length > 0 && deadIds.length === snap.ids.length;
    if (quietNight) setMood('sleep');
    else setMood(allDead ? 'ghost' : worst <= EMPTY ? 'angry' : worst <= LOW ? 'worried' : worst < 0.55 ? 'neutral' : 'happy');

    // Truce while gaming: keep quiet, keep receipts.
    const quiet = pet.quietInGame !== false && state.status.gaming === true;
    if (quiet) {
      if (deadIds.length) state.diedDuringGame = deadIds[0];
      closeGameOver();
      setDecay(0);
      state.prevGaming = true;
      return;
    }
    if (state.prevGaming && !state.status.gaming) {
      state.prevGaming = false;
      if (state.diedDuringGame && deadIds.length && !quietNight) {
        const vid = deadIds[0];
        const dm = now - (snap.zeroAt[vid] || now);
        sound('angry');
        const gen = state.roastGen;
        roastOrBank('welcomeback', vid, dm).then((roast) => {
          if (gen !== state.roastGen || !activated()) return;
          showBubble(roast);
          toast('warning', 'GG', roast, vid);
        });
      }
      state.diedDuringGame = '';
    }

    // Episodes end the moment a vital is no longer at zero. (Their persisted
    // twins stay behind as inert history — see the note above bumpMemPatch.)
    Object.keys(episodes).forEach((id) => {
      if (!deadIds.includes(id)) delete episodes[id];
    });
    const persisted = petState().ep;

    const atMs = thresholdsMs(pet);
    let anyDecay = false;
    let decayDepth = 0;
    deadIds.forEach((id) => {
      const z = snap.zeroAt[id] || now;
      const deadMs = Math.max(0, now - z);
      let ep = episodes[id];
      if (!ep) {
        // A persisted episode with the same zeroAt identity means this is a
        // reload/second surface mid-episode: restore the one-shot flags and
        // repeat stamps instead of re-firing GAME OVER / minimize / lock.
        const saved = persisted && persisted[id];
        const sameEpisode = saved && Math.abs((Number(saved.z) || 0) - z) < 1500;
        ep = episodes[id] = sameEpisode
          ? {
              nextNag: 0,
              nextGameover: Number(saved.goAt) || 0,
              nextOverlay: Number(saved.ovAt) || 0,
              minWarnAt: 0,
              minimized: saved.min === true,
              lockWarnAt: 0,
              locked: saved.lock === true,
              ledSent: true,
              first: false,
            }
          : { nextNag: 0, nextGameover: 0, nextOverlay: 0, minWarnAt: 0, minimized: false, lockWarnAt: 0, locked: false, ledSent: false, first: true };
        if (!sameEpisode) persistEp(id, z, ep); // anchor the new episode's identity
      }
      const stages = core.stagesFor(deadMs, {
        effects: pet.effects !== false,
        monitors: pet.monitors === true && pcCan('monitors'),
        minimize: pet.minimize === true && pcCan('minimize'),
        lock: pet.lock === true,
        present: present(),
        at: atMs,
      });

      if (!ep.ledSent) { ep.ledSent = true; if (pet.lighting === true && !quietNight) ledFlash(); }

      if (!quietNight && stages.includes('nag') && !snoozed() && now >= ep.nextNag && now - state.lastNagAt >= NAG_GLOBAL_GAP_MS) {
        const first = ep.first;
        ep.first = false;
        ep.nextNag = now + core.repeatDelay('nag');
        state.lastNagAt = now;
        sound('angry');
        const gen = state.roastGen; // a refill/truce while the roast is in flight voids it
        roastOrBank(first ? 'zero' : 'nag', id, deadMs).then((text) => {
          if (gen !== state.roastGen || !activated()) return;
          showBubble(text);
          toast('warning', vitalName(id) + ': 0%', text, id);
        });
      }

      if (stages.includes('decay')) {
        anyDecay = true;
        // Ramp from a faint tint at onset to full black & white DECAY_FULL_MS later.
        const ramp = Math.min(1, Math.max(0, (deadMs - atMs.decay) / DECAY_FULL_MS));
        const d = DECAY_BASE + (1 - DECAY_BASE) * ramp;
        if (d > decayDepth) decayDepth = d;
      }

      if (!quietNight && stages.includes('gameover') && !snoozed() && now >= ep.nextGameover && !state.gameOverEl && !document.body.dataset.panel) {
        ep.nextGameover = now + core.repeatDelay('gameover');
        persistEp(id, z, ep, bumpMemPatch('gameoversTotal'));
        showGameOver(id, deadMs, allDead);
      }

      if (!quietNight && stages.includes('overlay') && !snoozed() && now >= ep.nextOverlay) {
        ep.nextOverlay = now + core.repeatDelay('overlay');
        persistEp(id, z, ep);
        serverNag('overlay', { text: phrase('nag', id, deadMs), mood: allDead ? 'ghost' : 'angry', all: deadIds.length >= 3 });
      }

      if (!quietNight && stages.includes('minimize') && !ep.minimized && !snoozed()) {
        if (!ep.minWarnAt) {
          ep.minWarnAt = now;
          const warn = phrase('minwarn', id, deadMs);
          showBubble(warn);
          toast('error', '!', warn, id);
          sound('warn');
        } else if (now - ep.minWarnAt >= MIN_WARN_MS) {
          ep.minimized = true;
          persistEp(id, z, ep);
          serverNag('minimize', { text: phrase('minimized', id, deadMs) });
        }
      } else if (ep.minWarnAt && !ep.minimized) {
        // The warn countdown got interrupted (truce, night, presence lost,
        // toggle off): a stale minWarnAt would fire the action INSTANTLY when
        // the gate re-opens minutes later, skipping the promised 30s warning.
        ep.minWarnAt = 0;
      }

      if (!quietNight && stages.includes('lock') && !ep.locked && !snoozed()) {
        if (!ep.lockWarnAt) {
          ep.lockWarnAt = now;
          const warn = phrase('lockwarn', id, deadMs);
          toast('error', '⏱', warn, id);
          sound('warn');
          startLockCountdown(id);
        } else if (now - ep.lockWarnAt >= LOCK_WARN_MS) {
          ep.locked = true;
          persistEp(id, z, ep, bumpMemPatch('locksTotal'));
          // Send the "it was me" line so the server can flash it on the real
          // monitors right before the lock screen takes over.
          serverNag('lock', { text: phrase('locked', id, deadMs), mood: 'angry' });
        }
      } else if (ep.lockWarnAt && !ep.locked) {
        // Same reset for the lock countdown — startLockCountdown's interval
        // self-aborts (and hides the bubble) the moment lockWarnAt clears.
        ep.lockWarnAt = 0;
      }
    });

    setDecay(anyDecay ? decayDepth : 0);
    if (anyDecay && !snoozed() && !quietNight) glitchPulse(now);
  }

  // Dramatic 1s countdown while the lock warning runs: in the pet's bubble, or
  // under the topbar chip when Bit lives only there. Aborts the moment the
  // vital is refilled (the episode disappears) or the pet is torn down.
  function lockCountLine(text) {
    if (state.host) {
      const bubble = state.host.querySelector('.vpet-bubble');
      const txt = state.host.querySelector('.vpet-bubble-txt');
      if (!bubble || !txt) return;
      if (state.typeTimer) { clearInterval(state.typeTimer); state.typeTimer = null; }
      bubble.hidden = !text;
      if (text) txt.textContent = text;
      return;
    }
    if (text) showChipBubble(text, 1500);
    else if (state.chipBubbleEl) state.chipBubbleEl.hidden = true;
  }
  function startLockCountdown(vital) {
    if (state.lockCountTimer) clearInterval(state.lockCountTimer);
    state.lockCountTimer = setInterval(() => {
      const ep = episodes[vital];
      if ((!state.host && !state.chip) || !ep || !ep.lockWarnAt || ep.locked) {
        clearInterval(state.lockCountTimer);
        state.lockCountTimer = null;
        // Don't strand a frozen countdown when it is aborted (truce, presence
        // lost; the refill path overwrites it with its own praise anyway).
        if (ep && !ep.lockWarnAt) lockCountLine('');
        return;
      }
      const left = Math.max(0, Math.ceil((ep.lockWarnAt + LOCK_WARN_MS - Date.now()) / 1000));
      if (left <= 0) { clearInterval(state.lockCountTimer); state.lockCountTimer = null; lockCountLine(''); return; }
      lockCountLine(t('vpet_lock_in', 'Blocco del PC tra {s} s: {vital}!').replace('{s}', String(left)).replace('{vital}', vitalName(vital)));
    }, 1000);
  }

  // ── public API ──
  function sync() {
    if (activated()) {
      ensureMounts();
      if (!state.tickTimer) { state.tickTimer = setInterval(tick, TICK_MS); tick(); }
      if (!state.pcCaps) readPcCaps();
    } else {
      teardown();
    }
  }

  // Fed by the status SSE (main.js): gaming flag + system idle seconds.
  function onStatus(data) {
    if (!data || typeof data !== 'object') return;
    if (data.gaming != null) state.status.gaming = !!data.gaming;
    if (data.idleSec !== undefined) state.status.idleSec = (typeof data.idleSec === 'number' && data.idleSec >= 0) ? data.idleSec : null;
  }

  // A refill anywhere (widget, chips, AI): praise + wipe that vital's episode.
  // `info.streakUp` > 0 = this refill just extended the daily self-care streak
  // to N days — celebrate that instead of the stock praise.
  function onRefill(id, info) {
    if (!activated()) return;
    state.roastGen++; // an in-flight nag roast must not overwrite the praise below
    delete episodes[id];
    if (state.lockCountTimer) { clearInterval(state.lockCountTimer); state.lockCountTimer = null; }
    closeGameOver();
    const snap = window.VitalsWidget && window.VitalsWidget.snapshot ? window.VitalsWidget.snapshot() : null;
    const stillDead = snap ? snap.ids.some(v => snap.levels[v] <= EMPTY) : false;
    if (!stillDead) setDecay(0);
    const streakUp = info && Number(info.streakUp) > 0 ? Math.round(Number(info.streakUp)) : 0;
    showBubble(streakUp ? phrase('streak', '', streakUp * 60000) : phrase('praise', '', 0), 6000);
    react(streakUp ? 'celebrate' : 'thanks');
    sound('praise');
    tick();
  }

  // The user just came back after an away period (vitals.js credited the
  // frozen span and calls this exactly once — only the crediting surface).
  function onReturn(minsAway) {
    if (!activated() || snoozed()) return;
    ensureMounts();
    state.lastNagAt = Date.now(); // the greeting owns the next NAG_GLOBAL_GAP window
    const gen = state.roastGen;
    roastOrBank('return', '', Math.max(1, Number(minsAway) || 1) * 60000).then((text) => {
      if (gen !== state.roastGen || !activated()) return;
      setMood('happy');
      react('welcomeBack');
      showBubble(text, 8000);
      sound('talk');
    });
  }

  document.addEventListener('DOMContentLoaded', sync);
  window.VitalsPet = { sync, onStatus, onRefill, onReturn };
})();

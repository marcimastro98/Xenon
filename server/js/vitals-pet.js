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
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const EMPTY = 0.02;              // same "at zero" threshold as vitals.js
  const LOW = 0.25;
  const TICK_MS = 5000;
  const PRESENT_IDLE_S = 180;      // system input within 3 min = user is at the PC
  const NAG_GLOBAL_GAP_MS = 90000; // min gap between nag toasts across ALL vitals
  const MIN_WARN_MS = 30000;       // warning before minimize-all
  const LOCK_WARN_MS = 60000;      // countdown before the workstation lock
  const GLITCH_EVERY_MS = 45000;   // glitch pulse cadence while decay is active
  const BUBBLE_MS = 9000;
  const DECAY_FULL_MS = 15 * 60000; // from decay onset to full black & white
  const DECAY_BASE = 0.15;          // visible desaturation the instant decay starts
  const AI_ROAST_TIMEOUT_MS = 3500; // AI slower than this → offline bank line

  // ── pixel sprite (static, trusted markup — same px() idiom as vitals.js) ──
  const px = (fill, cells) => cells.map(c =>
    `<rect x="${c[0]}" y="${c[1]}" width="${c[2] || 1}" height="${c[3] || 1}" fill="${fill}"/>`).join('');
  const wrap = (inner) => `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`;
  const INK = '#0d1117';
  const BODY = px('var(--vpet-body)', [[6, 0], [6, 1], [3, 2, 6], [2, 3, 8, 6], [3, 9, 6], [3, 10, 2], [7, 10, 2]]);
  const EYES = { open: px(INK, [[4, 4, 1, 2], [7, 4, 1, 2]]), blink: px(INK, [[4, 5], [7, 5]]) };
  const FACES = {
    happy:   (eyes) => BODY + EYES[eyes] + px(INK, [[4, 7], [5, 8, 2], [7, 7]]),
    neutral: (eyes) => BODY + EYES[eyes] + px(INK, [[5, 7, 2]]),
    worried: (eyes) => BODY + EYES[eyes] + px(INK, [[4, 3], [7, 3], [5, 8, 2]]) + px('#4fc3f7', [[10, 4]]),
    angry:   (eyes) => BODY + px(INK, [[3, 3, 2], [7, 3, 2]]) + EYES[eyes] + px(INK, [[4, 8], [5, 7], [6, 8], [7, 7]])
             + px('#e8f4ff', [[0, 1], [11, 2]]),
    // Asleep (away / night quiet): the exact same body (brand rule: never a new
    // Bit shape) with closed eyes and a soft mouth; the "zzz" is CSS (::after).
    sleep:   () => BODY + EYES.blink + px(INK, [[5, 8, 2]]),
    ghost:   (alt) => px('#e8f4ff', [[3, 1, 6], [2, 2, 8], [2, 3, 8, 6]])
             + px('#e8f4ff', alt ? [[3, 9], [5, 9], [7, 9]] : [[2, 9], [4, 9], [6, 9], [8, 9]])
             + px(INK, [[4, 4, 1, 2], [7, 4, 1, 2], [5, 7, 2]]),
  };
  function spriteMarkup(mood, alt) {
    if (mood === 'ghost') return wrap(FACES.ghost(alt));
    return wrap((FACES[mood] || FACES.neutral)(alt ? 'blink' : 'open'));
  }
  const MOOD_RGB = { happy: '110,231,135', neutral: '255,215,94', worried: '255,166,87', angry: '255,90,95', sleep: '138,180,248', ghost: '232,244,255' };

  // ── state ──
  let host = null;            // floating pet root element
  let chip = null;            // topbar mini-Bit button (#clock-bit)
  let tickTimer = null;
  let frameTimer = null;
  let frameAlt = false;
  let bubbleTimer = null;
  let typeTimer = null;
  let chipBubbleEl = null;
  let chipBubbleTimer = null;
  let glitchAt = 0;
  let lockCountTimer = null;
  const bag = {};             // shuffle-bag state (vitals-pet-core)
  const episodes = {};        // vitalId -> escalation bookkeeping for the current zero-episode
  let lastNagAt = 0;
  let lastAiAt = 0;           // AI-roast cooldown (own budget, apart from lastNagAt)
  let roastGen = 0;           // bumped on refill/truce/teardown — stale async roasts are dropped
  let nightGreeted = false;   // "why are you awake" fired once per night session
  let status = { gaming: false, idleSec: null };
  let prevGaming = false;
  let diedDuringGame = '';    // vital that hit zero while quiet-in-game held fire
  let mood = '';
  const reducedMotion = (typeof matchMedia === 'function') ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  // Per-stage escalation delays (minutes → ms). The user tunes each rung in
  // Settings → Bit; a missing/invalid value falls back to the ladder default
  // (kept in sync with core.STAGE_AT and normalizeVitals). `nag` is always 0.
  const THR_DEFAULT = { decay: 5, gameover: 8, overlay: 10, minimize: 15, lock: 20 };
  function thresholdsMs(pet) {
    const thr = (pet && pet.thresholds && typeof pet.thresholds === 'object') ? pet.thresholds : {};
    const at = {};
    Object.keys(THR_DEFAULT).forEach((stage) => {
      const m = Number(thr[stage]);
      at[stage] = (Number.isFinite(m) && m > 0 ? m : THR_DEFAULT[stage]) * 60000;
    });
    return at;
  }

  function cfg() {
    const v = (typeof hubSettings === 'object' && hubSettings && hubSettings.vitals) ? hubSettings.vitals : null;
    return v || { enabled: false, pet: null, items: {}, state: {} };
  }
  function petCfg() { const v = cfg(); return (v.pet && typeof v.pet === 'object') ? v.pet : {}; }
  function activated() { const v = cfg(); return v.enabled !== false && v.pet && v.pet.enabled === true; }
  // Follow the ACTIVE UI language (i18n mirrors it onto <html lang>) so Bit's
  // roasts match what the user actually reads — hubSettings.language can be ''
  // ("follow browser"), in which case only <html lang> knows the resolved code.
  function lang() {
    const doc = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || '';
    return doc || (typeof hubSettings === 'object' && hubSettings && hubSettings.language) || 'it';
  }
  function vitalName(id) { return t('vitals_' + id, id); }
  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function popupsAllowed() {
    const n = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || {};
    return n.enabled !== false && n.popups !== false;
  }

  // ── durable pet state (vitals.state.pet / .mem — see normalizeVitals) ──
  // Truce and per-episode flags live in settings, so they survive reloads and
  // sync across surfaces via the server's merge (vitals-pet-core helpers).
  function petState() {
    const v = cfg();
    return (v.state && v.state.pet && typeof v.state.pet === 'object') ? v.state.pet : { snoozeUntil: 0, muteDay: '', ep: {} };
  }
  function memState() {
    const v = cfg();
    return (v.state && v.state.mem && typeof v.state.mem === 'object') ? v.state.mem : {};
  }
  function saveVitalsState(patch) {
    if (typeof hubSettings === 'undefined' || typeof normalizeSettings !== 'function' || typeof saveHubSettings !== 'function') return;
    const v = cfg();
    hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...v, state: { ...(v.state || {}), ...patch } } });
    saveHubSettings();
  }
  // One settings write per escalation event: the episode entry plus (optionally)
  // a memory-counter bump ride the same save.
  function persistEp(id, z, ep, extraState) {
    const ps = petState();
    const entry = { z, goAt: ep.nextGameover || 0, ovAt: ep.nextOverlay || 0, min: ep.minimized === true, lock: ep.locked === true };
    saveVitalsState({ pet: { ...ps, ep: { ...(ps.ep || {}), [id]: entry } }, ...(extraState || {}) });
  }
  // NOTE: persisted episode entries are never deleted, only overwritten. The
  // server merge keeps the newest entry per vital (and would resurrect a
  // deletion from its own copy anyway — a delete could never stick and the
  // retry would loop a settings write every tick). Stale entries are harmless:
  // they're keyed by the episode's zeroAt identity, so a dead-again vital gets
  // a NEW z that never matches the old entry, and the map is bounded at one
  // entry per vital by construction.
  function bumpMemPatch(field) {
    const mem = memState();
    return { mem: { ...mem, [field]: (Number(mem[field]) || 0) + 1 } };
  }
  function snoozed() {
    const ps = petState();
    return Date.now() < (Number(ps.snoozeUntil) || 0) || ps.muteDay === todayKey();
  }
  function present() { return typeof status.idleSec === 'number' && status.idleSec >= 0 && status.idleSec < PRESENT_IDLE_S; }
  function phrase(kind, vital, deadMs) {
    return core.pick(bag, {
      kind, vital, lang: lang(), tone: petCfg().tone,
      vars: { vital: vitalName(vital), min: Math.max(1, Math.round((deadMs || 0) / 60000)) },
    });
  }

  // ── AI roasts (opt-in) ──
  // Ask the configured Xenon AI provider for ONE in-character line built from
  // real context. Best-effort with a hard timeout: any failure, empty reply or
  // missing provider falls back to the offline bank — the caller awaits only
  // the TEXT, never the escalation itself. _aiProviderCfg/_aiProviderReady are
  // ai.js top-level globals (ai.js loads before this script); typeof-guarded
  // for surfaces that don't load ai.js.
  function roastCtx(kind, vital, deadMs) {
    const mem = memState();
    const h = new Date().getHours();
    const timeOfDay = h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 23 ? 'evening' : 'night';
    const md = (typeof mediaData !== 'undefined' && mediaData && mediaData.active) ? mediaData : null;
    const wd = (typeof weatherData !== 'undefined' && weatherData && weatherData.ok) ? weatherData : null;
    return {
      kind,
      vital: vital ? vitalName(vital) : '',
      min: Math.max(0, Math.round((deadMs || 0) / 60000)),
      streak: Number(mem.streak) || 0,
      gaming: status.gaming === true,
      timeOfDay,
      media: md ? [md.title, md.artist].filter(Boolean).join(' — ').slice(0, 80) : '',
      weather: wd ? [wd.condition, wd.tempC != null ? Math.round(wd.tempC) + '°C' : ''].filter(Boolean).join(', ').slice(0, 60) : '',
    };
  }
  async function roastOrBank(kind, vital, deadMs) {
    const bank = () => phrase(kind, vital, deadMs); // lazy — don't burn a bag draw when AI answers
    try {
      const pet = petCfg();
      if (pet.aiRoasts !== true) return bank();
      if (typeof _aiProviderReady !== 'function' || typeof _aiProviderCfg !== 'function' || !_aiProviderReady()) return bank();
      const now = Date.now();
      if (now - lastAiAt < NAG_GLOBAL_GAP_MS) return bank();
      lastAiAt = now;
      const prov = _aiProviderCfg();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), AI_ROAST_TIMEOUT_MS);
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
        const text = out && typeof out.text === 'string' ? out.text.trim().slice(0, 140) : '';
        if (text) return text;
      }
    } catch { /* timeout / offline / provider error — the bank never fails */ }
    return bank();
  }

  // ── 8-bit sounds (tiny WebAudio square-wave synth, no assets) ──
  let audioCtx = null;
  function sound(name) {
    if (petCfg().sounds === false) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); if (audioCtx.state === 'suspended') return; }
      const SEQ = {
        talk:     [[523, 60], [659, 70]],
        angry:    [[220, 90], [174, 90], [147, 130]],
        gameover: [[392, 130], [330, 130], [262, 130], [196, 240]],
        praise:   [[523, 70], [659, 70], [784, 70], [1047, 150]],
        warn:     [[880, 110], [587, 110], [880, 110], [587, 110]],
      }[name];
      if (!SEQ) return;
      let at = audioCtx.currentTime + 0.02;
      SEQ.forEach(([f, d]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.035, at);
        gain.gain.exponentialRampToValueAtTime(0.001, at + d / 1000);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(at);
        osc.stop(at + d / 1000 + 0.02);
        at += d / 1000;
      });
    } catch { /* audio blocked or unavailable — silence is acceptable */ }
  }

  // ── DOM: pet + chip + bubble + menu ──
  // One state machine, two mounts: the floating pet and the topbar chip render
  // the same mood/frame — paintSprites() fans a sprite update out to whichever
  // mounts exist, so there is never a second timer or a second mood ladder.
  function paintSprites() {
    const m = spriteMarkup(mood, frameAlt);
    if (host) { const b = host.querySelector('.vpet-sprite'); if (b) b.innerHTML = m; }   // static, trusted SVG
    if (chip) { const s = chip.querySelector('.cb-sprite'); if (s) s.innerHTML = m; }     // static, trusted SVG
  }
  function frameTick() {
    if ((!host && !chip) || document.hidden) return;
    // Quiesce with the rest of the dashboard: no sprite churn while the page
    // sits idle (ambient-idle pauses every decorative loop) or when the user
    // asked for reduced motion.
    if (document.body.classList.contains('ambient-idle')) return;
    if (reducedMotion && reducedMotion.matches) return;
    frameAlt = !frameAlt;
    paintSprites();
  }

  function mount() {
    if (host) return;
    host = document.createElement('div');
    host.className = 'vpet';
    host.id = 'vitals-pet';
    const bubble = document.createElement('div');
    bubble.className = 'vpet-bubble';
    bubble.hidden = true;
    const txt = document.createElement('span');
    txt.className = 'vpet-bubble-txt';
    bubble.appendChild(txt);
    host.appendChild(bubble);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vpet-sprite';
    btn.setAttribute('aria-label', 'Bit');
    btn.addEventListener('click', toggleMenu);
    host.appendChild(btn);
    document.body.appendChild(host);
    setMood(mood || 'neutral', true);
  }
  function unmountFloating() {
    if (!host) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    closeMenu();
    host.remove();
    host = null;
  }

  // The topbar mini-Bit: first child of #clock-vitals, so it rides the
  // minimal-island reparenting together with the clock exactly like the vitals
  // chips (vitals.js syncTopbar knows to preserve it and to keep the host
  // visible while it exists).
  function mountChip() {
    if (chip) return;
    const hostEl = document.getElementById('clock-vitals');
    if (!hostEl) return;
    chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'clock-bit';
    chip.className = 'clock-bit';
    chip.setAttribute('aria-label', 'Bit');
    const spr = document.createElement('span');
    spr.className = 'cb-sprite';
    chip.appendChild(spr);
    chip.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(e); });
    hostEl.prepend(chip);
    hostEl.hidden = false;
    if (window.TopbarMinimal && window.TopbarMinimal.applyIslandLayout) window.TopbarMinimal.applyIslandLayout();
    setMood(mood || 'neutral', true);
  }
  function unmountChip() {
    if (!chip) return;
    chip.remove();
    chip = null;
    if (chipBubbleTimer) { clearTimeout(chipBubbleTimer); chipBubbleTimer = null; }
    if (chipBubbleEl) { chipBubbleEl.remove(); chipBubbleEl = null; }
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
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    if (lockCountTimer) { clearInterval(lockCountTimer); lockCountTimer = null; }
    closeMenu();
    closeGameOver();
    setDecay(0);
    Object.keys(episodes).forEach(k => delete episodes[k]);
    roastGen++; // void any in-flight roast — its bubble/toast must not fire post-teardown
    nightGreeted = false;
    unmountChip();
    if (host) { host.remove(); host = null; }
    // Stop-what-you-start: an enable→disable cycle must not leave a live
    // AudioContext behind (sound() lazily recreates it).
    if (audioCtx) { try { audioCtx.close().catch(() => {}); } catch { /* already closed */ } audioCtx = null; }
  }

  function setMood(next, force) {
    if (next === mood && !force) return;
    mood = next;
    [host, chip].forEach((el) => {
      if (!el) return;
      el.dataset.mood = next;
      el.style.setProperty('--vpet-rgb', MOOD_RGB[next] || MOOD_RGB.neutral);
    });
    paintSprites();
  }

  function showBubble(text, ms) {
    if (!text) return;
    if (!host) { showChipBubble(text, ms); return; }
    const bubble = host.querySelector('.vpet-bubble');
    const txt = host.querySelector('.vpet-bubble-txt');
    if (!bubble || !txt) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    bubble.hidden = false;
    // Typewriter — untrusted-ish text (phrase bank / AI reply), so textContent only.
    let i = 0;
    txt.textContent = '';
    typeTimer = setInterval(() => {
      i += 2;
      txt.textContent = text.slice(0, i);
      if (i >= text.length) { clearInterval(typeTimer); typeTimer = null; }
    }, 24);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
      if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    }, ms || BUBBLE_MS);
  }
  // Compact bubble under the topbar chip, for when the floating pet is off
  // (position: 'topbar'). textContent only, same as the main bubble.
  function showChipBubble(text, ms) {
    if (!chip || !text) return;
    if (chipBubbleTimer) { clearTimeout(chipBubbleTimer); chipBubbleTimer = null; }
    if (!chipBubbleEl) {
      chipBubbleEl = document.createElement('div');
      chipBubbleEl.className = 'vpet-chip-bubble';
      document.body.appendChild(chipBubbleEl);
    }
    chipBubbleEl.textContent = text;
    chipBubbleEl.style.setProperty('--vpet-rgb', MOOD_RGB[mood] || MOOD_RGB.neutral);
    const r = chip.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    chipBubbleEl.style.maxWidth = width + 'px';
    chipBubbleEl.style.top = Math.round(r.bottom + 8) + 'px';
    chipBubbleEl.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2))) + 'px';
    chipBubbleEl.hidden = false;
    chipBubbleTimer = setTimeout(() => { if (chipBubbleEl) chipBubbleEl.hidden = true; }, ms || BUBBLE_MS);
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
    head.textContent = 'BIT';
    const lv = document.createElement('span');
    lv.className = 'vpet-menu-lv';
    lv.textContent = 'LV ' + (1 + Math.floor((Number(v.state && v.state.xp) || 0) / 100));
    head.appendChild(lv);
    // Bit's memory on display: the current self-care streak (days in a row).
    const streak = Number(memState().streak) || 0;
    if (streak >= 2) {
      const st = document.createElement('span');
      st.className = 'vpet-menu-streak';
      st.textContent = '🔥' + streak;
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
      roastGen++; // a roast in flight must not break the truce it predates
      saveVitalsState({ pet: { ...petState(), snoozeUntil: Date.now() + 30 * 60000 } });
      closeMenu();
      showBubble(lang().startsWith('it') ? 'Ok. 30 minuti. Poi torno.' : 'Fine. 30 minutes. Then I\'m back.', 5000);
    });
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'vpet-menu-act';
    mute.textContent = t('vpet_mute_today', 'Zitto per oggi');
    mute.addEventListener('click', () => {
      roastGen++;
      saveVitalsState({ pet: { ...petState(), muteDay: todayKey() } });
      closeMenu();
      showBubble(lang().startsWith('it') ? 'Silenzio fino a domani. Ricordati che esisto.' : 'Silent until tomorrow. Remember I exist.', 5000);
    });
    menu.append(snooze, mute);
    return menu;
  }
  function toggleMenu(e) {
    const open = document.querySelector('.vpet-menu');
    if (open) { closeMenu(); return; }
    const menu = buildMenu();
    const fromChip = !!(e && chip && (e.currentTarget === chip || chip.contains(e.target)));
    if (!fromChip && host) {
      host.appendChild(menu);
    } else if (chip) {
      // Opened from the topbar chip: no host to nest in, so anchor a fixed
      // menu right under the chip (clamped to the viewport).
      menu.classList.add('vpet-menu-anchored');
      menu.dataset.mood = mood;
      menu.style.setProperty('--vpet-rgb', MOOD_RGB[mood] || MOOD_RGB.neutral);
      document.body.appendChild(menu);
      const r = chip.getBoundingClientRect();
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
    const inside = (host && host.contains(e.target)) || (chip && chip.contains(e.target)) || (menu && menu.contains(e.target));
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
  function pager() { return document.getElementById('dashboard-pager'); }
  // Progressive decay: `depth` 0..1 drives how far the dashboard has drained of
  // colour (0 = untouched, 1 = full black & white). The engine ramps it up the
  // longer a vital rots at zero; a refill drops it straight back to 0. The class
  // toggle (not just the var) is what lets a refill fully clear the effect.
  function setDecay(depth) {
    const p = pager();
    const d = Math.max(0, Math.min(1, Number(depth) || 0));
    if (p) {
      p.classList.toggle('vpet-decay', d > 0);
      if (d > 0) p.style.setProperty('--vpet-decay', d.toFixed(3));
      else p.style.removeProperty('--vpet-decay');
    }
    if (d <= 0) glitchAt = 0;
  }
  function glitchPulse(now) {
    if (document.hidden || (!host && !chip)) return;
    if (now - glitchAt < GLITCH_EVERY_MS) return;
    glitchAt = now;
    const g = document.createElement('div');
    g.className = 'vpet-glitch';
    document.body.appendChild(g);
    setTimeout(() => g.remove(), 900);
  }

  let gameOverEl = null;
  function closeGameOver() { if (gameOverEl) { gameOverEl.remove(); gameOverEl = null; } }
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
    ico.innerHTML = spriteMarkup(allDead ? 'ghost' : 'angry', false);   // static, trusted SVG
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
    gameOverEl = ov;
    sound('gameover');
  }

  // ── server-side actions (each rung re-checked server-side too) ──
  function serverNag(action, extra) {
    try {
      fetch('/api/vitals/nag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Send the UI language so the PC-side popup can pick a font that can
        // actually render the script (Consolas has no CJK glyphs → tofu boxes).
        body: JSON.stringify(Object.assign({ action, lang: lang() }, extra || {})),
      }).catch(() => {});
    } catch { /* offline — the dashboard-side nagging carries on */ }
  }
  // Bit's rage → a dedicated red LED burst (the 'vitals' event flash). Opt-in via
  // Settings → Bit ("Fai lampeggiare i LED quando si arrabbia"); a no-op if the
  // user has no lighting configured (the server just ignores the event).
  function ledFlash() {
    try {
      fetch('/api/lighting/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'vitals' }),
      }).catch(() => {});
    } catch { /* lighting optional */ }
  }

  function toast(type, title, message, vital) {
    if (!popupsAllowed() || !window.XenonToast) return;
    window.XenonToast.show({
      // Bit plays its own 8-bit cue via sound() (gated by pet.sounds), so the
      // generic notification cue is suppressed here to avoid a double sound.
      type, kicker: 'BIT', title, message, duration: 10000, silent: true,
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

    // Night quiet (23–07): Bit sleeps; decay may still creep, but no bubbles,
    // toasts, GAME OVER or PC actions until morning. One yawny line if the
    // user is demonstrably around anyway.
    const quietNight = pet.nightQuiet !== false && core.isNight(new Date().getHours());
    if (quietNight) {
      if (!nightGreeted && present() && !snoozed()) {
        nightGreeted = true;
        showBubble(phrase('night', '', 0), 7000);
      }
    } else {
      nightGreeted = false;
    }

    // Mood mirrors the WORST meter; ghost when everything is dead; asleep at night.
    const lvls = snap.ids.map(id => snap.levels[id]);
    const worst = lvls.length ? Math.min.apply(null, lvls) : 1;
    const deadIds = snap.ids.filter(id => snap.levels[id] <= EMPTY);
    const allDead = snap.ids.length > 0 && deadIds.length === snap.ids.length;
    if (quietNight) setMood('sleep');
    else setMood(allDead ? 'ghost' : worst <= EMPTY ? 'angry' : worst <= LOW ? 'worried' : worst < 0.55 ? 'neutral' : 'happy');

    // Truce while gaming: keep quiet, keep receipts.
    const quiet = pet.quietInGame !== false && status.gaming === true;
    if (quiet) {
      if (deadIds.length) diedDuringGame = deadIds[0];
      closeGameOver();
      setDecay(0);
      prevGaming = true;
      return;
    }
    if (prevGaming && !status.gaming) {
      prevGaming = false;
      if (diedDuringGame && deadIds.length && !quietNight) {
        const vid = deadIds[0];
        const dm = now - (snap.zeroAt[vid] || now);
        sound('angry');
        const gen = roastGen;
        roastOrBank('welcomeback', vid, dm).then((roast) => {
          if (gen !== roastGen || !activated()) return;
          showBubble(roast);
          toast('warning', 'GG', roast, vid);
        });
      }
      diedDuringGame = '';
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
        monitors: pet.monitors === true,
        minimize: pet.minimize === true,
        lock: pet.lock === true,
        present: present(),
        at: atMs,
      });

      if (!ep.ledSent) { ep.ledSent = true; if (pet.lighting === true && !quietNight) ledFlash(); }

      if (!quietNight && stages.includes('nag') && !snoozed() && now >= ep.nextNag && now - lastNagAt >= NAG_GLOBAL_GAP_MS) {
        const first = ep.first;
        ep.first = false;
        ep.nextNag = now + core.repeatDelay('nag');
        lastNagAt = now;
        sound('angry');
        const gen = roastGen; // a refill/truce while the roast is in flight voids it
        roastOrBank(first ? 'zero' : 'nag', id, deadMs).then((text) => {
          if (gen !== roastGen || !activated()) return;
          showBubble(text);
          toast('warning', vitalName(id) + ' — 0%', text, id);
        });
      }

      if (stages.includes('decay')) {
        anyDecay = true;
        // Ramp from a faint tint at onset to full black & white DECAY_FULL_MS later.
        const ramp = Math.min(1, Math.max(0, (deadMs - atMs.decay) / DECAY_FULL_MS));
        const d = DECAY_BASE + (1 - DECAY_BASE) * ramp;
        if (d > decayDepth) decayDepth = d;
      }

      if (!quietNight && stages.includes('gameover') && !snoozed() && now >= ep.nextGameover && !gameOverEl && !document.body.dataset.panel) {
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
          // monitors right before the Windows lock screen takes over.
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

  // Dramatic 1s countdown in the bubble while the lock warning runs. Aborts the
  // moment the vital is refilled (the episode disappears) or the pet is torn down.
  function startLockCountdown(vital) {
    if (lockCountTimer) clearInterval(lockCountTimer);
    const it = lang().startsWith('it');
    lockCountTimer = setInterval(() => {
      const ep = episodes[vital];
      if (!host || !ep || !ep.lockWarnAt || ep.locked) {
        clearInterval(lockCountTimer);
        lockCountTimer = null;
        // Don't strand a frozen "PC LOCK IN Ns" bubble when the countdown is
        // aborted (truce, presence lost; the refill path overwrites it with
        // its own praise bubble anyway).
        if (host && ep && !ep.lockWarnAt) {
          const b = host.querySelector('.vpet-bubble');
          if (b) b.hidden = true;
        }
        return;
      }
      const left = Math.max(0, Math.ceil((ep.lockWarnAt + LOCK_WARN_MS - Date.now()) / 1000));
      const bubble = host.querySelector('.vpet-bubble');
      const txt = host.querySelector('.vpet-bubble-txt');
      if (bubble && txt) {
        bubble.hidden = false;
        txt.textContent = (it ? 'BLOCCO PC TRA ' : 'PC LOCK IN ') + left + 's — ' + vitalName(vital) + '!';
      }
      if (left <= 0) { clearInterval(lockCountTimer); lockCountTimer = null; if (bubble) bubble.hidden = true; }
    }, 1000);
  }

  // ── public API ──
  function sync() {
    if (activated()) {
      ensureMounts();
      if (!frameTimer) frameTimer = setInterval(frameTick, 700);
      if (!tickTimer) { tickTimer = setInterval(tick, TICK_MS); tick(); }
    } else {
      teardown();
    }
  }

  // Fed by the status SSE (main.js): gaming flag + system idle seconds.
  function onStatus(data) {
    if (!data || typeof data !== 'object') return;
    if (data.gaming != null) status.gaming = !!data.gaming;
    if (data.idleSec !== undefined) status.idleSec = (typeof data.idleSec === 'number' && data.idleSec >= 0) ? data.idleSec : null;
  }

  // A refill anywhere (widget, chips, AI): praise + wipe that vital's episode.
  // `info.streakUp` > 0 = this refill just extended the daily self-care streak
  // to N days — celebrate that instead of the stock praise.
  function onRefill(id, info) {
    if (!activated()) return;
    roastGen++; // an in-flight nag roast must not overwrite the praise below
    delete episodes[id];
    if (lockCountTimer) { clearInterval(lockCountTimer); lockCountTimer = null; }
    closeGameOver();
    const snap = window.VitalsWidget && window.VitalsWidget.snapshot ? window.VitalsWidget.snapshot() : null;
    const stillDead = snap ? snap.ids.some(v => snap.levels[v] <= EMPTY) : false;
    if (!stillDead) setDecay(0);
    const streakUp = info && Number(info.streakUp) > 0 ? Math.round(Number(info.streakUp)) : 0;
    showBubble(streakUp ? phrase('streak', '', streakUp * 60000) : phrase('praise', '', 0), 6000);
    sound('praise');
    tick();
  }

  // The user just came back after an away period (vitals.js credited the
  // frozen span and calls this exactly once — only the crediting surface).
  function onReturn(minsAway) {
    if (!activated() || snoozed()) return;
    ensureMounts();
    lastNagAt = Date.now(); // the greeting owns the next NAG_GLOBAL_GAP window
    const gen = roastGen;
    roastOrBank('return', '', Math.max(1, Number(minsAway) || 1) * 60000).then((text) => {
      if (gen !== roastGen || !activated()) return;
      setMood('happy');
      showBubble(text, 8000);
      sound('talk');
    });
  }

  document.addEventListener('DOMContentLoaded', sync);
  window.VitalsPet = { sync, onStatus, onRefill, onReturn };
})();

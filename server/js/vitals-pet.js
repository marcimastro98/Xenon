'use strict';
// Bit — the pixel guardian pet (Settings → Notifiche → Vitals → Bit).
//
// A little 8-bit creature that lives in a corner of the dashboard, mirrors the
// health of your Vitals meters, and — when you let a vital sit at ZERO — climbs
// an escalation ladder of friendly abuse: speech-bubble roasts and toasts, then
// dashboard decay (desaturation + glitch) and a CRT "GAME OVER" card, then
// pixel popups on the PC monitors, then minimize-all, then a workstation lock.
// Every rung past the toasts is a separate opt-in (see normalizeVitals), the
// PC-invading rungs also require presence (system idle from the status SSE —
// the Xeneon touchscreen alone can't prove you're at the PC), and everything
// stands down during a game when "quiet in game" is on… though Bit does keep
// receipts for when the match ends.
//
// Phrases + escalation thresholds live in vitals-pet-core.js (unit-tested).
// All timers are gated: nothing runs unless the pet is enabled, and teardown
// clears every interval/timeout it started.
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
    ghost:   (alt) => px('#e8f4ff', [[3, 1, 6], [2, 2, 8], [2, 3, 8, 6]])
             + px('#e8f4ff', alt ? [[3, 9], [5, 9], [7, 9]] : [[2, 9], [4, 9], [6, 9], [8, 9]])
             + px(INK, [[4, 4, 1, 2], [7, 4, 1, 2], [5, 7, 2]]),
  };
  function spriteMarkup(mood, alt) {
    if (mood === 'ghost') return wrap(FACES.ghost(alt));
    return wrap((FACES[mood] || FACES.neutral)(alt ? 'blink' : 'open'));
  }
  const MOOD_RGB = { happy: '110,231,135', neutral: '255,215,94', worried: '255,166,87', angry: '255,90,95', ghost: '232,244,255' };

  // ── state ──
  let host = null;            // pet root element
  let tickTimer = null;
  let frameTimer = null;
  let frameAlt = false;
  let bubbleTimer = null;
  let typeTimer = null;
  let glitchAt = 0;
  let lockCountTimer = null;
  const bag = {};             // shuffle-bag state (vitals-pet-core)
  const episodes = {};        // vitalId -> escalation bookkeeping for the current zero-episode
  let lastNagAt = 0;
  let snoozeUntil = 0;
  let muteDay = '';
  let status = { gaming: false, idleSec: null };
  let prevGaming = false;
  let diedDuringGame = '';    // vital that hit zero while quiet-in-game held fire
  let mood = '';

  function cfg() {
    const v = (typeof hubSettings === 'object' && hubSettings && hubSettings.vitals) ? hubSettings.vitals : null;
    return v || { enabled: false, pet: null, items: {}, state: {} };
  }
  function petCfg() { const v = cfg(); return (v.pet && typeof v.pet === 'object') ? v.pet : {}; }
  function activated() { const v = cfg(); return v.enabled !== false && v.pet && v.pet.enabled === true; }
  function lang() { return (typeof hubSettings === 'object' && hubSettings && hubSettings.language) || 'it'; }
  function vitalName(id) { return t('vitals_' + id, id); }
  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function popupsAllowed() {
    const n = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || {};
    return n.enabled !== false && n.popups !== false;
  }
  function snoozed() { return Date.now() < snoozeUntil || muteDay === todayKey(); }
  function present() { return typeof status.idleSec === 'number' && status.idleSec >= 0 && status.idleSec < PRESENT_IDLE_S; }
  function phrase(kind, vital, deadMs) {
    return core.pick(bag, {
      kind, vital, lang: lang(), tone: petCfg().tone,
      vars: { vital: vitalName(vital), min: Math.max(1, Math.round((deadMs || 0) / 60000)) },
    });
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

  // ── DOM: pet + bubble + menu ──
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
    setMood('neutral', true);
    if (!frameTimer) frameTimer = setInterval(() => {
      if (!host || document.hidden) return;
      frameAlt = !frameAlt;
      const b = host.querySelector('.vpet-sprite');
      if (b) b.innerHTML = spriteMarkup(mood, frameAlt);          // static, trusted SVG
    }, 700);
  }

  function teardown() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    if (lockCountTimer) { clearInterval(lockCountTimer); lockCountTimer = null; }
    closeMenu();
    closeGameOver();
    setDecay(false);
    Object.keys(episodes).forEach(k => delete episodes[k]);
    if (host) { host.remove(); host = null; }
  }

  function setMood(next, force) {
    if (!host || (next === mood && !force)) { mood = next; return; }
    mood = next;
    host.dataset.mood = next;
    host.style.setProperty('--vpet-rgb', MOOD_RGB[next] || MOOD_RGB.neutral);
    const b = host.querySelector('.vpet-sprite');
    if (b) b.innerHTML = spriteMarkup(mood, frameAlt);            // static, trusted SVG
  }

  function showBubble(text, ms) {
    if (!host || !text) return;
    const bubble = host.querySelector('.vpet-bubble');
    const txt = host.querySelector('.vpet-bubble-txt');
    if (!bubble || !txt) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    bubble.hidden = false;
    // Typewriter — untrusted-ish text (phrase bank), so textContent only.
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

  // Quick menu: worst meters + truce controls. Rebuilt on every open.
  function toggleMenu() {
    if (!host) return;
    const open = host.querySelector('.vpet-menu');
    if (open) { closeMenu(); return; }
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
      snoozeUntil = Date.now() + 30 * 60000;
      closeMenu();
      showBubble(lang().startsWith('it') ? 'Ok. 30 minuti. Poi torno.' : 'Fine. 30 minutes. Then I\'m back.', 5000);
    });
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'vpet-menu-act';
    mute.textContent = t('vpet_mute_today', 'Zitto per oggi');
    mute.addEventListener('click', () => {
      muteDay = todayKey();
      closeMenu();
      showBubble(lang().startsWith('it') ? 'Silenzio fino a domani. Ricordati che esisto.' : 'Silent until tomorrow. Remember I exist.', 5000);
    });
    menu.append(snooze, mute);
    host.appendChild(menu);
    setTimeout(() => document.addEventListener('pointerdown', onOutsideMenu, { once: true }), 0);
  }
  function onOutsideMenu(e) {
    if (host && host.contains(e.target)) {
      // Tap landed back inside the pet — re-arm instead of closing.
      document.addEventListener('pointerdown', onOutsideMenu, { once: true });
      return;
    }
    closeMenu();
  }
  function closeMenu() {
    document.removeEventListener('pointerdown', onOutsideMenu);
    const m = host && host.querySelector('.vpet-menu');
    if (m) m.remove();
  }

  // ── dashboard effects (decay filter + glitch pulse + GAME OVER card) ──
  function pager() { return document.getElementById('dashboard-pager'); }
  function setDecay(on) {
    const p = pager();
    if (p) p.classList.toggle('vpet-decay', !!on);
    if (!on) glitchAt = 0;
  }
  function glitchPulse(now) {
    if (document.hidden || !host) return;
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
        body: JSON.stringify(Object.assign({ action }, extra || {})),
      }).catch(() => {});
    } catch { /* offline — the dashboard-side nagging carries on */ }
  }
  function ledFlash() {
    try {
      fetch('/api/lighting/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'notification' }),
      }).catch(() => {});
    } catch { /* lighting optional */ }
  }

  function toast(type, title, message, vital) {
    if (!popupsAllowed() || !window.XenonToast) return;
    window.XenonToast.show({
      type, kicker: 'BIT', title, message, duration: 10000,
      onClick: vital ? () => { if (window.VitalsWidget) window.VitalsWidget.openDetail(vital); } : undefined,
    });
  }

  // ── the escalation tick ──
  function tick() {
    if (!activated()) { teardown(); return; }
    mount();
    const pet = petCfg();
    const snap = window.VitalsWidget && window.VitalsWidget.snapshot ? window.VitalsWidget.snapshot() : null;
    if (!snap || !snap.enabled) return;
    const now = Date.now();

    // Mood mirrors the WORST meter; ghost when everything is dead.
    const lvls = snap.ids.map(id => snap.levels[id]);
    const worst = lvls.length ? Math.min.apply(null, lvls) : 1;
    const deadIds = snap.ids.filter(id => snap.levels[id] <= EMPTY);
    const allDead = snap.ids.length > 0 && deadIds.length === snap.ids.length;
    setMood(allDead ? 'ghost' : worst <= EMPTY ? 'angry' : worst <= LOW ? 'worried' : worst < 0.55 ? 'neutral' : 'happy');

    // Truce while gaming: keep quiet, keep receipts.
    const quiet = pet.quietInGame !== false && status.gaming === true;
    if (quiet) {
      if (deadIds.length) diedDuringGame = deadIds[0];
      closeGameOver();
      setDecay(false);
      prevGaming = true;
      return;
    }
    if (prevGaming && !status.gaming) {
      prevGaming = false;
      if (diedDuringGame && deadIds.length) {
        const roast = phrase('welcomeback', deadIds[0], now - (snap.zeroAt[deadIds[0]] || now));
        showBubble(roast);
        toast('warning', 'GG', roast, deadIds[0]);
        sound('angry');
      }
      diedDuringGame = '';
    }

    // Episodes end the moment a vital is no longer at zero.
    Object.keys(episodes).forEach((id) => {
      if (!deadIds.includes(id)) delete episodes[id];
    });

    let anyDecay = false;
    deadIds.forEach((id) => {
      const deadMs = Math.max(0, now - (snap.zeroAt[id] || now));
      const ep = episodes[id] || (episodes[id] = { nextNag: 0, nextGameover: 0, nextOverlay: 0, minWarnAt: 0, minimized: false, lockWarnAt: 0, locked: false, ledSent: false, first: true });
      const stages = core.stagesFor(deadMs, {
        effects: pet.effects !== false,
        monitors: pet.monitors === true,
        minimize: pet.minimize === true,
        lock: pet.lock === true,
        present: present(),
      });

      if (!ep.ledSent) { ep.ledSent = true; ledFlash(); }

      if (stages.includes('nag') && !snoozed() && now >= ep.nextNag && now - lastNagAt >= NAG_GLOBAL_GAP_MS) {
        const text = phrase(ep.first ? 'zero' : 'nag', id, deadMs);
        ep.first = false;
        ep.nextNag = now + core.repeatDelay('nag');
        lastNagAt = now;
        showBubble(text);
        toast('warning', vitalName(id) + ' — 0%', text, id);
        sound('angry');
      }

      if (stages.includes('decay')) anyDecay = true;

      if (stages.includes('gameover') && !snoozed() && now >= ep.nextGameover && !gameOverEl && !document.body.dataset.panel) {
        ep.nextGameover = now + core.repeatDelay('gameover');
        showGameOver(id, deadMs, allDead);
      }

      if (stages.includes('overlay') && !snoozed() && now >= ep.nextOverlay) {
        ep.nextOverlay = now + core.repeatDelay('overlay');
        serverNag('overlay', { text: phrase('nag', id, deadMs), mood: allDead ? 'ghost' : 'angry', all: deadIds.length >= 3 });
      }

      if (stages.includes('minimize') && !ep.minimized && !snoozed()) {
        if (!ep.minWarnAt) {
          ep.minWarnAt = now;
          const warn = phrase('minwarn', id, deadMs);
          showBubble(warn);
          toast('error', '!', warn, id);
          sound('warn');
        } else if (now - ep.minWarnAt >= MIN_WARN_MS) {
          ep.minimized = true;
          serverNag('minimize', { text: phrase('minimized', id, deadMs) });
        }
      }

      if (stages.includes('lock') && !ep.locked && !snoozed()) {
        if (!ep.lockWarnAt) {
          ep.lockWarnAt = now;
          const warn = phrase('lockwarn', id, deadMs);
          toast('error', '⏱', warn, id);
          sound('warn');
          startLockCountdown(id);
        } else if (now - ep.lockWarnAt >= LOCK_WARN_MS) {
          ep.locked = true;
          serverNag('lock', {});
        }
      }
    });

    setDecay(anyDecay);
    if (anyDecay && !snoozed()) glitchPulse(now);
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
      mount();
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
  function onRefill(id) {
    if (!activated()) return;
    delete episodes[id];
    if (lockCountTimer) { clearInterval(lockCountTimer); lockCountTimer = null; }
    closeGameOver();
    const snap = window.VitalsWidget && window.VitalsWidget.snapshot ? window.VitalsWidget.snapshot() : null;
    const stillDead = snap ? snap.ids.some(v => snap.levels[v] <= EMPTY) : false;
    if (!stillDead) setDecay(false);
    showBubble(phrase('praise', '', 0), 6000);
    sound('praise');
    tick();
  }

  document.addEventListener('DOMContentLoaded', sync);
  window.VitalsPet = { sync, onStatus, onRefill };
})();

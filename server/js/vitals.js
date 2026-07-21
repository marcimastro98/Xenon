'use strict';
// Vitals — game-HUD self-care meters (hydration, energy, stamina, focus,
// posture) that drain with time spent at the PC — and ONLY that time: while
// the user is away (no real input for 5+ min, via the server idle probe) the
// meters freeze and resume exactly where they were (see the away-pause block
// below). Tap a bar (widget) or a mini chip (topbar) to refill it; crossing
// 25% / 0% fires a game-style reminder toast. Everything is client-owned:
// levels derive from per-vital "last refill" timestamps persisted in
// hubSettings.vitals.state (they only move forward — the server keeps the
// newest one on save, so decay survives reloads and a stale surface can never
// un-drink your water). +25 XP per refill feeds a little self-care level,
// purely for fun.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const LOW = 0.25;         // reminder threshold
  const EMPTY = 0.02;       // "at zero" threshold
  const XP_PER_FILL = 25;

  // ── pixel art (static, trusted markup) ──
  // 12×12 grid, crispEdges — tiny multi-colour sprites, no external assets.
  const px = (fill, cells) => cells.map(c =>
    `<rect x="${c[0]}" y="${c[1]}" width="${c[2] || 1}" height="${c[3] || 1}" fill="${fill}"/>`).join('');
  const sprite = (inner) => `<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true">${inner}</svg>`;
  const SPRITES = {
    heart: sprite(
      px('#ff5a5f', [[2, 2, 2], [8, 2, 2], [1, 3, 4], [7, 3, 4], [1, 4, 10], [1, 5, 10], [2, 6, 8], [3, 7, 6], [4, 8, 4], [5, 9, 2]])
      + px('#ffd1d1', [[2, 3], [2, 4]])),
    hydration: sprite(
      px('#4fc3f7', [[5, 1, 2], [4, 2, 4], [4, 3, 4], [3, 4, 6], [3, 5, 6], [2, 6, 8], [2, 7, 8], [3, 8, 6], [4, 9, 4]])
      + px('#c9ecff', [[4, 5], [3, 6]])
      + px('#1c8fd6', [[8, 6, 1, 2], [7, 8]])),
    energy: sprite(
      px('#ffb74d', [[6, 1, 4], [5, 2, 6], [5, 3, 6], [5, 4, 6], [5, 5, 4]])
      + px('#ffe0b2', [[6, 2, 2]])
      + px('#e08a2e', [[10, 2, 1, 3], [8, 5]])
      + px('#f2f2f2', [[4, 6, 2], [3, 7, 2], [1, 8, 3, 2]])),
    stamina: sprite(
      px('#81c784', [[2, 4, 3], [2, 5, 4], [2, 6, 5], [2, 7, 8]])
      + px('#eaf7ea', [[4, 5], [5, 6], [9, 7]])
      + px('#f2f2f2', [[1, 8, 10]])
      + px('#2b4f2e', [[1, 9, 10]])),
    focus: sprite(
      px('#7e57c2', [[4, 3, 4], [3, 3], [8, 3]])
      + px('#f0ecff', [[3, 4, 6], [2, 5, 8], [2, 6, 8], [3, 7, 6]])
      + px('#b388ff', [[5, 5, 2, 2]])
      + px('#4527a0', [[5, 6]])
      + px('#ffffff', [[6, 5]])),
    posture: sprite(
      px('#f8bbd0', [[5, 1, 2, 2]])
      + px('#f48fb1', [[5, 4, 2, 3], [3, 5, 1, 2], [8, 5, 1, 2], [3, 7, 6], [2, 8, 8]])),
  };

  // ── config / state access (hubSettings.vitals, normalized in settings.js) ──
  function cfg() {
    const v = (typeof hubSettings === 'object' && hubSettings && hubSettings.vitals) ? hubSettings.vitals : null;
    const out = v || { enabled: false, topbar: false, reminders: true, items: {}, state: { last: {}, xp: 0, day: '', fills: 0 } };
    try {
      const islandItems = hubSettings && hubSettings.topbarClock && hubSettings.topbarClock.items;
      const item = Array.isArray(islandItems) ? islandItems.find((entry) => entry && entry.id === 'vitals') : null;
      if (item) return { ...out, topbar: item.hidden !== true };
    } catch { /* legacy settings fallback below */ }
    return out;
  }
  function enabledIds(v) {
    return VITALS_IDS.filter(id => v.items && v.items[id] && v.items[id].on !== false);
  }
  function level(v, id, now) {
    const it = (v.items && v.items[id]) || {};
    const last = Number(v.state && v.state.last && v.state.last[id]) || 0;
    if (!last) return 1;
    const span = Math.max(5, Number(it.min) || 60) * 60000;
    return Math.min(1, Math.max(0, 1 - (now - last) / span));
  }
  function saveState(patch) {
    const cur = cfg();
    hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, state: { ...cur.state, ...patch } } });
    saveHubSettings();
  }
  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayKey() { return dayKey(new Date()); }

  // Session timer — "play time" since this dashboard tab appeared. Survives
  // reloads in the same tab (sessionStorage), resets on a fresh open.
  let sessionStart = Date.now();
  try {
    const saved = Number(sessionStorage.getItem('xenonVitalsSessionStart'));
    if (Number.isFinite(saved) && saved > 0 && saved <= Date.now()) sessionStart = saved;
    else sessionStorage.setItem('xenonVitalsSessionStart', String(sessionStart));
  } catch { /* storage unavailable — per-load session is fine */ }
  function sessionText() {
    const m = Math.floor((Date.now() - sessionStart) / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
  }

  // Server boot fence — bootAt rides the status SSE (see main.js). A last-refill
  // stamp OLDER than the server's start time means the PC was off (or the
  // backend restarted) in between: that downtime is not neglect, so ensureFresh
  // reseeds the vital to full. Until the first status event lands we can't tell
  // a fresh boot from a plain reload, so reminders (and Bit's escalation, via
  // bootSynced) hold fire briefly instead of alarming over bars that are about
  // to be reseeded; the time fallback covers a dead SSE channel.
  let serverBootAt = 0;
  const loadedAt = Date.now();
  function onStatus(data) {
    const at = data ? Number(data.bootAt) : 0;
    if (Number.isFinite(at) && at > 0) serverBootAt = at;
    trackAway(data);
  }
  function bootSynced() {
    return serverBootAt > 0 || Date.now() - loadedAt > 30000;
  }

  // ── away-pause ──
  // Decay tracks time spent AT the PC, but the meters are pure wall-clock math
  // — so stepping away used to keep draining them. The server-global idleSec
  // (GetLastInputInfo, rides the status SSE) fixes that: once the user has been
  // away for core.AWAY_AFTER_MS every surface freezes its level math at
  // freezeStart (display only, no writes), and on the away→present transition
  // ONE forward shift of the last-refill stamps credits the frozen span
  // (core.awayCredit — deterministic targets + the persisted awayCreditAt
  // marker make a concurrent double-apply from two surfaces converge instead
  // of double-crediting; the server merge only ever moves stamps forward).
  // idleSec missing/null (probe off, helper failure, older server) = never
  // away: today's behavior, fail-open.
  let away = false;
  let freezeStart = 0;      // instant the meters froze (lastInputAt + AWAY_AFTER_MS)
  let lastIdleSampleAt = 0; // last time a non-null idleSec arrived
  function effectiveNow() {
    const now = Date.now();
    return (away && freezeStart > 0 && freezeStart < now) ? freezeStart : now;
  }
  function trackAway(data) {
    const core = window.VitalsPetCore; // loads right after this script; lazy by design
    if (!core) return;
    const v = cfg();
    const now = Date.now();
    const idleSec = (data && typeof data.idleSec === 'number' && data.idleSec >= 0) ? data.idleSec : null;
    if (idleSec === null) {
      // Probe went dark mid-away: after 90s of silence close the period at the
      // last known sample — never credit time we can't prove was away.
      if (away && lastIdleSampleAt && now - lastIdleSampleAt > 90000) endAway(lastIdleSampleAt);
      return;
    }
    lastIdleSampleAt = now;
    if (!v.enabled || v.awayPause === false) { away = false; freezeStart = 0; return; }
    const idleMs = idleSec * 1000;
    if (idleMs >= core.AWAY_AFTER_MS) {
      // lastInputAt (= now − idleMs) is constant for the whole away period, so
      // freezeStart is a stable identity every surface/reload recomputes alike.
      freezeStart = (now - idleMs) + core.AWAY_AFTER_MS;
      away = true;
    } else if (away) {
      endAway(now - idleMs); // returnAt = the input instant that ended the period
    }
  }
  function endAway(returnAt) {
    const fs = freezeStart;
    away = false;
    freezeStart = 0;
    const core = window.VitalsPetCore;
    const v = cfg();
    if (!core || !v.enabled || v.awayPause === false) return;
    const credit = core.awayCredit({
      last: (v.state && v.state.last) || {},
      ids: VITALS_IDS,
      freezeStart: fs,
      returnAt,
      now: Date.now(),
      creditedAt: Number(v.state && v.state.awayCreditAt) || 0,
    });
    if (!credit) return; // period already credited by another surface (or empty)
    const last = (v.state && v.state.last) || {};
    // The shift moves each credited vital's zeroAt forward — and Bit's persisted
    // episode entries (state.pet.ep[id].z) are keyed by that very instant. Move
    // them in lock-step, or a reload after returning would see a mismatched
    // identity, anchor a "new" episode and re-attempt a minimize/lock that
    // already fired. The server merge keeps the larger z, so this propagates.
    const ps = (v.state && v.state.pet && typeof v.state.pet === 'object') ? v.state.pet : null;
    let petPatch = null;
    if (ps && ps.ep && typeof ps.ep === 'object') {
      const ep = {};
      Object.keys(ps.ep).forEach((id) => {
        const e = ps.ep[id];
        if (!e || typeof e !== 'object') return;
        const shift = (id in credit.patch) ? credit.patch[id] - (Number(last[id]) || 0) : 0;
        ep[id] = shift > 0 ? { ...e, z: (Number(e.z) || 0) + shift } : e;
      });
      petPatch = { ...ps, ep };
    }
    saveState({
      last: { ...last, ...credit.patch },
      awayCreditAt: credit.awayCreditAt,
      ...(petPatch ? { pet: petPatch } : {}),
    });
    paint();
    // Bit greets the returning user — once, because only the crediting surface
    // gets here (the guard above short-circuits everyone else).
    const minsAway = Math.max(1, Math.round((returnAt - fs + core.AWAY_AFTER_MS) / 60000));
    if (window.VitalsPet && typeof window.VitalsPet.onReturn === 'function') window.VitalsPet.onReturn(minsAway);
  }

  // ── seeding, day rollover & boot reset ──
  // A vital that has never been refilled (last=0, or a clock-skewed future
  // stamp) seeds to "full now" so fresh installs start with full bars instead
  // of five ZERO alarms. Every new day is a fresh start: at rollover all bars
  // silently refill — on an always-on Xeneon Edge they'd otherwise all sit at
  // zero every morning, punishing the user for sleeping. And a PC boot is a
  // fresh start too (the boot fence above): decay is meant to track time spent
  // AT the PC, never hours the machine was powered off — without this, a
  // session that ran past midnight burned the day rollover and every meter
  // greeted the morning at zero.
  function ensureFresh(v) {
    const now = Date.now();
    const today = todayKey();
    const last = (v.state && v.state.last) || {};
    const newDay = v.state.day !== today; // '' (first run) counts as a new day
    const patch = {};
    let dirty = false;
    VITALS_IDS.forEach((id) => {
      const ts = Number(last[id]) || 0;
      if (newDay || ts <= 0 || ts > now + 60000 || (serverBootAt > 0 && ts < serverBootAt)) { patch[id] = now; dirty = true; }
    });
    if (dirty) {
      saveState({
        last: { ...last, ...patch },
        day: today,
        fills: newDay ? 0 : (Number(v.state.fills) || 0),
        log: newDay ? [] : (Array.isArray(v.state.log) ? v.state.log : []),
      });
    }
    return dirty;
  }

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="vitals"]')).filter(n => n.closest('.pager-page'));
  }

  // ── widget ──
  function buildWidget(mount, v) {
    const wrap = el('div', 'vt-wrap');
    const head = el('div', 'vt-head');
    const heart = el('span', 'vt-heart');
    heart.innerHTML = SPRITES.heart;                       // static, trusted SVG
    head.appendChild(heart);
    head.appendChild(el('span', 'vt-title', t('vitals_title', 'Vitals')));
    const lvl = el('span', 'vt-lvl', 'LV ' + (1 + Math.floor((Number(v.state.xp) || 0) / 100)));
    lvl.title = t('vitals_level_title', '+25 XP per refill');
    head.appendChild(lvl);
    const session = el('span', 'vt-session');
    session.title = t('vitals_session_title', 'Time at the PC this session');
    session.append('⏱ ', el('span', 'vt-session-time', sessionText()));
    head.appendChild(session);
    wrap.appendChild(head);

    const ids = enabledIds(v);
    if (!v.enabled || !ids.length) {
      wrap.appendChild(el('div', 'vt-state', t(!v.enabled ? 'vitals_disabled_hint' : 'vitals_none_hint', 'Enable Vitals in Settings')));
      mount.replaceChildren(wrap);
      return;
    }

    const rows = el('div', 'vt-rows');
    const now = effectiveNow();
    ids.forEach((id) => {
      const row = el('button', 'vt-row');
      row.type = 'button';
      row.dataset.vital = id;
      row.title = t('vitals_refill_hint', 'Tap to refill');
      const ico = el('span', 'vt-ico');
      ico.innerHTML = SPRITES[id];                         // static, trusted SVG
      row.appendChild(ico);
      const body = el('span', 'vt-body');
      body.appendChild(el('span', 'vt-name', t('vitals_' + id, id)));
      const bar = el('span', 'vt-bar');
      for (let i = 0; i < 10; i++) {
        const seg = el('span', 'vt-seg');
        seg.style.setProperty('--i', String(i));           // stagger index for the refill pop
        bar.appendChild(seg);
      }
      body.appendChild(bar);
      row.appendChild(body);
      row.appendChild(el('span', 'vt-pct', '0'));
      row.addEventListener('click', () => openDetail(id));
      rows.appendChild(row);
      paintRow(row, level(v, id, now));
    });
    wrap.appendChild(rows);

    // Footer: today's refill ribbon (one pixel square per refill, in order) —
    // or, before the very first refill ever, the discoverability nudge.
    const log = Array.isArray(v.state.log) ? v.state.log : [];
    if (log.length) {
      const today = el('div', 'vt-today');
      today.title = t('vitals_today', 'Today');
      today.appendChild(el('span', 'vt-today-label', t('vitals_today', 'Today')));
      const strip = el('span', 'vt-today-strip');
      log.slice(-24).forEach((vid) => {
        const dot = el('span', 'vt-dot');
        dot.dataset.vital = vid;
        strip.appendChild(dot);
      });
      today.appendChild(strip);
      today.appendChild(el('span', 'vt-today-count', '×' + log.length));
      wrap.appendChild(today);
    } else if (!(Number(v.state.xp) > 0)) {
      wrap.appendChild(el('div', 'vt-hint', t('vitals_refill_hint', 'Tap a bar to refill it')));
    }
    mount.replaceChildren(wrap);
  }

  function paintRow(row, lvl) {
    const pct = Math.round(lvl * 100);
    const filled = Math.max(lvl > 0 ? 1 : 0, Math.round(lvl * 10));
    row.querySelectorAll('.vt-seg').forEach((seg, i) => seg.classList.toggle('on', i < filled));
    const pctEl = row.querySelector('.vt-pct');
    if (pctEl && pctEl.textContent !== String(pct)) pctEl.textContent = String(pct);
    row.classList.toggle('is-low', lvl <= LOW && lvl > EMPTY);
    row.classList.toggle('is-empty', lvl <= EMPTY);
  }

  // ── topbar chips ──
  let chipSig = '';
  function syncTopbar(v) {
    const host = document.getElementById('clock-vitals');
    if (!host) return;
    const ids = (v.enabled && v.topbar) ? enabledIds(v) : [];
    // Bit's topbar mini chip (vitals-pet.js) shares this host so it rides the
    // minimal-island reparenting with the clock — it is NOT ours to remove:
    // the rebuild below must preserve it, and it alone keeps the host visible.
    const bitChip = host.querySelector('#clock-bit');
    const wasHidden = host.hidden;
    host.hidden = !ids.length && !bitChip;
    // When the vitals segment appears/disappears in the minimal island, recompute
    // the segment dividers so the first-visible "lead" (no hairline) stays correct.
    if (host.hidden !== wasHidden && window.TopbarMinimal && window.TopbarMinimal.applyIslandLayout) {
      window.TopbarMinimal.applyIslandLayout();
    }
    const sig = ids.join(',');
    if (sig !== chipSig) {
      chipSig = sig;
      if (bitChip) host.replaceChildren(bitChip);
      else host.replaceChildren();
      ids.forEach((id) => {
        const chip = el('button', 'clock-vital');
        chip.type = 'button';
        chip.dataset.vital = id;
        chip.title = t('vitals_' + id, id) + ' — ' + t('vitals_refill_hint', 'Tap to refill');
        const ico = el('span', 'cv-ico');
        ico.innerHTML = SPRITES[id];                       // static, trusted SVG
        chip.appendChild(ico);
        const bar = el('span', 'cv-bar');
        bar.appendChild(el('span', 'cv-fill'));
        chip.appendChild(bar);
        chip.addEventListener('click', (e) => { e.stopPropagation(); openDetail(id); });
        host.appendChild(chip);
      });
    }
    const now = effectiveNow();
    host.querySelectorAll('.clock-vital').forEach((chip) => {
      const lvl = level(v, chip.dataset.vital, now);
      const fill = chip.querySelector('.cv-fill');
      // Quantize to 25% steps — chunky pixel feel at chip size.
      if (fill) fill.style.width = (Math.max(lvl > 0 ? 1 : 0, Math.round(lvl * 4)) * 25) + '%';
      chip.classList.toggle('is-low', lvl <= LOW && lvl > EMPTY);
      chip.classList.toggle('is-empty', lvl <= EMPTY);
    });
  }

  // ── detail card ──
  // Tapping a vital opens a small glass card that explains what the meter
  // tracks and what to actually do about it; refilling is the user's explicit
  // "done" choice ("Fatto! +100"), never an accidental tap.
  let detailHost = null;
  let detailKeyHandler = null;
  function closeDetail() {
    if (detailKeyHandler) { document.removeEventListener('keydown', detailKeyHandler); detailKeyHandler = null; }
    if (detailHost) { detailHost.remove(); detailHost = null; }
  }
  function openDetail(id) {
    closeDetail();
    const v = cfg();
    if (!v.enabled || !VITALS_IDS.includes(id)) return;
    const overlay = el('div', 'vt-overlay');
    const card = el('div', 'vt-card');
    card.dataset.vital = id;                               // per-vital accent (--vt-rgb)
    const head = el('div', 'vt-card-head');
    const ico = el('span', 'vt-card-ico');
    ico.innerHTML = SPRITES[id];                           // static, trusted SVG
    head.appendChild(ico);
    head.appendChild(el('span', 'vt-card-name', t('vitals_' + id, id)));
    head.appendChild(el('span', 'vt-card-pct', Math.round(level(v, id, effectiveNow()) * 100) + '%'));
    const todayCount = (Array.isArray(v.state.log) ? v.state.log : []).filter(x => x === id).length;
    if (todayCount > 0) head.appendChild(el('span', 'vt-card-count', t('vitals_today', 'Today') + ' ×' + todayCount));
    const x = el('button', 'vt-card-close');
    x.type = 'button';
    x.setAttribute('aria-label', t('vitals_not_now', 'Not now'));
    x.textContent = '✕';
    x.addEventListener('click', closeDetail);
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(el('p', 'vt-card-desc', t('vitals_desc_' + id, '')));
    card.appendChild(el('p', 'vt-card-tip', t('vitals_tip_' + id, '')));
    const actions = el('div', 'vt-card-actions');
    const later = el('button', 'vt-btn vt-btn-ghost', t('vitals_not_now', 'Not now'));
    later.type = 'button';
    later.addEventListener('click', closeDetail);
    const done = el('button', 'vt-btn vt-btn-done', t('vitals_done_btn', 'Done! +25'));
    done.type = 'button';
    done.addEventListener('click', () => { closeDetail(); refill(id); });
    actions.append(later, done);
    card.appendChild(actions);
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDetail(); });
    detailKeyHandler = (e) => { if (e.key === 'Escape') closeDetail(); };
    document.addEventListener('keydown', detailKeyHandler);
    document.body.appendChild(overlay);
    detailHost = overlay;
  }

  // ── refill ──
  function refill(id) {
    const v = cfg();
    if (!v.enabled || !VITALS_IDS.includes(id)) return;
    const day = todayKey();
    const sameDay = v.state.day === day;
    const xp = (Number(v.state.xp) || 0) + XP_PER_FILL;
    const prevLevel = 1 + Math.floor((Number(v.state.xp) || 0) / 100);
    const newLevel = 1 + Math.floor(xp / 100);
    // Bit's memory: the first refill of a new day extends (or restarts) the
    // daily self-care streak. Computed before the save so the streak rides the
    // same settings write; `streakUp` > 0 tells Bit to celebrate it.
    const mem = (v.state && v.state.mem && typeof v.state.mem === 'object') ? v.state.mem : {};
    const lastFillDay = typeof mem.lastFillDay === 'string' ? mem.lastFillDay : '';
    let streak = Number(mem.streak) || 0;
    let streakUp = 0;
    if (lastFillDay !== day) {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      streak = lastFillDay === dayKey(y) ? streak + 1 : 1;
      if (streak >= 2) streakUp = streak;
    }
    saveState({
      last: { ...(v.state.last || {}), [id]: Date.now() },
      xp,
      day,
      fills: (sameDay ? Number(v.state.fills) || 0 : 0) + 1,
      log: (sameDay && Array.isArray(v.state.log) ? v.state.log : []).concat(id),
      mem: { ...mem, streak, bestStreak: Math.max(Number(mem.bestStreak) || 0, streak), lastFillDay: day },
    });
    delete notified[id];
    paint();
    // Juice: pop the bar segments back in, float the XP gain, pulse the chip.
    tiles().forEach((tile) => {
      const row = tile.querySelector('.vt-row[data-vital="' + id + '"]');
      if (!row) return;
      row.classList.remove('vt-burst');
      void row.offsetWidth;                                // restart the animation
      row.classList.add('vt-burst');
      const float = el('span', 'vt-float', '+' + XP_PER_FILL);
      // The timer fallback covers reduced-motion (animation:none never fires
      // animationend, and the float would sit there forever) — see greeting.js.
      const removeFloat = () => float.remove();
      float.addEventListener('animationend', removeFloat, { once: true });
      setTimeout(removeFloat, 1200);
      row.appendChild(float);
    });
    const chip = document.querySelector('.clock-vital[data-vital="' + id + '"]');
    if (chip) {
      chip.classList.remove('cv-pop');
      void chip.offsetWidth;
      chip.classList.add('cv-pop');
    }
    if (newLevel > prevLevel && window.XenonToast) {
      window.XenonToast.show({ type: 'success', kicker: 'VITALS', title: 'LEVEL UP!', message: 'LV ' + newLevel, duration: 4000 });
    }
    // Bit reacts to the refill (praise — or streak celebration —, episode
    // reset, effect cleanup).
    if (window.VitalsPet && typeof window.VitalsPet.onRefill === 'function') window.VitalsPet.onRefill(id, { streakUp });
  }

  // ── reminders ──
  // In-memory per-vital stage so each threshold fires once per drain cycle
  // (a refill resets it). A reload re-arms them — acceptable for a reminder.
  const notified = {};
  function popupsAllowed() {
    const n = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || {};
    return n.enabled !== false && n.popups !== false;
  }
  function checkReminders(v, now) {
    if (v.reminders === false || !popupsAllowed() || !window.XenonToast) return;
    enabledIds(v).forEach((id) => {
      const lvl = level(v, id, now);
      const stage = lvl <= EMPTY ? 'empty' : (lvl <= LOW ? 'low' : null);
      if (!stage) { delete notified[id]; return; }
      if (notified[id] === 'empty' || notified[id] === stage) return;
      notified[id] = stage;
      window.XenonToast.show({
        type: stage === 'empty' ? 'warning' : 'reminder',
        kicker: 'VITALS',
        title: t('vitals_' + id, id) + (stage === 'empty' ? ' — 0%' : ''),
        message: t('vitals_low_' + id, 'Time for a break'),
        duration: 9000,
        onClick: () => openDetail(id),
      });
    });
  }

  // The feature only "lives" while the user actually surfaced it: the widget
  // tile placed on a page (hidden tiles have no offsetParent), the topbar
  // chips turned on, or Bit the pet enabled (the pet IS a surface — it must
  // keep meters decaying even if the user never placed the widget). Without an
  // active surface nothing seeds, decays into toasts, or writes settings — so
  // shipping the feature never starts nagging users who haven't opted in.
  function hasActiveSurface(v) {
    return v.topbar === true || (v.pet && v.pet.enabled === true) || tiles().some(tile => tile.offsetParent !== null);
  }

  // ── ticking / public API ──
  function tick() {
    const v = cfg();
    if (!v.enabled || !hasActiveSurface(v)) { syncTopbar(v); return; }
    if (ensureFresh(v)) { paint(); return; }
    const now = effectiveNow(); // frozen at freezeStart while the user is away
    tiles().forEach((tile) => {
      const time = tile.querySelector('.vt-session-time');
      if (time) {
        const txt = sessionText();
        if (time.textContent !== txt) time.textContent = txt;
      }
      tile.querySelectorAll('.vt-row').forEach((row) => paintRow(row, level(v, row.dataset.vital, now)));
    });
    syncTopbar(v);
    // No reminder toasts while away — nobody is there to read them, and the
    // frozen level can't cross a threshold anyway.
    if (bootSynced() && !away) checkReminders(v, now);
  }

  function paint() {
    const v = cfg();
    tiles().forEach((tile) => {
      const mount = tile.querySelector('.vitals-widget-mount');
      if (mount) buildWidget(mount, v);
    });
    chipSig = '';                                          // config may have changed — rebuild chips
    syncTopbar(v);
  }

  function renderWidgets() { paint(); }

  // Read-only snapshot for Bit (vitals-pet.js): current level per enabled vital
  // plus the exact "hit zero at" instant (last refill + full span) — computed,
  // not sampled, so an escalation episode survives dashboard reloads.
  function snapshot() {
    const v = cfg();
    // `now` freezes with the meters while the user is away, so Bit's deadMs /
    // escalation math pauses in lock-step with the bars; `away` lets the pet
    // sleep instead of nagging an empty room.
    const now = effectiveNow();
    const newDay = !v.state || v.state.day !== todayKey();
    const out = { enabled: v.enabled !== false, ids: enabledIds(v), levels: {}, zeroAt: {}, now, away };
    out.ids.forEach((id) => {
      const it = (v.items && v.items[id]) || {};
      const last = Number(v.state && v.state.last && v.state.last[id]) || 0;
      // Mirror ensureFresh's reseed test: a stamp that predates the server boot,
      // sits in a past day, is unset, or is clock-skewed into the future is about
      // to be silently refilled to full — Bit must NOT read it as "dead". Without
      // this, right after a PC boot an old stamp makes deadMs look like hours, so
      // the pet would skip the whole ladder and go straight to minimize/lock.
      const pendingReseed = newDay || last <= 0 || last > now + 60000 || (serverBootAt > 0 && last < serverBootAt);
      if (pendingReseed) { out.levels[id] = 1; out.zeroAt[id] = 0; return; }
      out.levels[id] = level(v, id, now);
      out.zeroAt[id] = last + Math.max(5, Number(it.min) || 60) * 60000;
    });
    return out;
  }

  window.VitalsWidget = { renderWidgets, tick, refill, openDetail, snapshot, onStatus, bootSynced };
})();

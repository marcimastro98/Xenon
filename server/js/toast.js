'use strict';

// ── Unified notification system ───────────────────────────────────────────────
// One stacked, glassy, type-aware toast for every in-app notice — calendar
// reminders, finished timers, update prompts, Genesis/Guardian/backup messages.
// Replaces the old single shared #event-toast (which had a hard-coded clock icon
// regardless of context) and the separate timer "pill", which looked inconsistent.
//
// API:
//   XenonToast.show({ type, kicker, title, message, duration, important }) -> id
//   XenonToast.dismiss(id)
//   XenonToast.dismissAll()
// Types: info | success | warning | error | reminder | timer | update.
// duration: ms; 0 = sticky. Hovering a toast pauses its auto-dismiss + countdown ring.

(function () {
  // Each type carries an accent (rgb triplet or a CSS var indirection) and a
  // line-icon described as plain element descriptors, built via createElementNS
  // (no innerHTML anywhere — nothing here is ever interpolated from user input).
  const TYPES = {
    info:     { rgb: 'var(--accent-rgb)', icon: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5' }], ['path', { d: 'M12 8h.01' }]] },
    success:  { rgb: '76,175,120',        icon: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.6 2.6L16 9', class: 'xtoast-tick', pathLength: 1 }]] },
    warning:  { rgb: '240,180,70',        icon: [['path', { d: 'M12 3.2 21 19H3z' }], ['path', { d: 'M12 10v4' }], ['path', { d: 'M12 17h.01' }]] },
    error:    { rgb: '233,84,84',         icon: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M15 9l-6 6' }], ['path', { d: 'M9 9l6 6' }]] },
    reminder: { rgb: 'var(--accent-rgb)', icon: [['path', { d: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }], ['path', { d: 'M13.7 21a2 2 0 0 1-3.4 0' }]] },
    timer:    { rgb: '243,146,55',        icon: [['circle', { cx: 12, cy: 13, r: 8 }], ['path', { d: 'M12 9.5V13l2.4 1.6' }], ['path', { d: 'M9 2.5h6' }]] },
    update:   { rgb: 'var(--accent-rgb)', icon: [['path', { d: 'M12 3v11' }], ['path', { d: 'M7.5 10.5 12 15l4.5-4.5' }], ['path', { d: 'M5 20h14' }]] },
    notification: { rgb: 'var(--accent-rgb)', icon: [['path', { d: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }], ['path', { d: 'M13.7 21a2 2 0 0 1-3.4 0' }]] },
  };
  const CLOSE_ICON = [['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6 6 18' }]];
  const DEFAULT_DURATION = { reminder: 14000, timer: 12000 };
  const MAX_VISIBLE = 4;

  let container = null;
  let seq = 0;
  const toasts = new Map(); // id -> { el, timer, remaining, startedAt, dur, island, info }

  // Minimal chrome puts notifications on the clock island, one at a time
  // (js/toast-island.js); everywhere else they stack here.
  const island = window.XenonToastIsland ? window.XenonToastIsland.create({
    toasts,
    arm: (id) => arm(id),
    pause: (id) => pause(id),
    dismiss: (id) => dismiss(id),
    dismissAll: () => dismissAll(),
    sync: () => syncIsland(),
    t: (key, fallback) => {
      const v = typeof window.t === 'function' ? window.t(key) : '';
      return v && v !== key ? v : fallback;
    },
  }) : null;

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.className = 'xtoast-stack';
    document.body.appendChild(container);
    return container;
  }

  const NS = 'http://www.w3.org/2000/svg';
  function svg(descriptors, cls) {
    const wrap = document.createElement('span');
    wrap.className = cls;
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    (descriptors || []).forEach(([tag, attrs]) => {
      const node = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
      s.appendChild(node);
    });
    wrap.appendChild(s);
    return wrap;
  }

  // Optional per-toast accent override: only an "r,g,b" triple of 0–255 ints is
  // accepted, so a caller can't inject arbitrary CSS through the custom-property.
  function safeRgb(value) {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
    if (!m) return null;
    const c = [m[1], m[2], m[3]].map(Number);
    return c.every(n => n >= 0 && n <= 255) ? c.join(',') : null;
  }

  // The glyph colour on a tile filled with `rgb`: white, or near-black on a light
  // colour (a warning's amber). `var(--accent-rgb)` is resolved from the theme.
  const INK_LIGHT = '#fff';
  const INK_DARK = 'rgba(12, 12, 14, 0.88)';
  function inkFor(rgb) {
    const raw = rgb.startsWith('var(')
      ? getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb')
      : rgb;
    const c = safeRgb(raw);
    if (!c) return INK_LIGHT;
    const lin = c.split(',').map((n) => {
      const v = Number(n) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    // Contrast against white vs against black: whichever reads better.
    return (1.05 / (lum + 0.05)) >= ((lum + 0.05) / 0.05) ? INK_LIGHT : INK_DARK;
  }

  // The countdown: a ring that empties around the close button. The class stays
  // `xtoast-progress` (the island resumes it by that name).
  function progressRing(dur) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'xtoast-ring');
    s.setAttribute('viewBox', '0 0 32 32');
    s.setAttribute('aria-hidden', 'true');
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', 'xtoast-progress');
    c.setAttribute('cx', '16');
    c.setAttribute('cy', '16');
    c.setAttribute('r', '15');
    c.setAttribute('pathLength', '100');
    c.style.animationDuration = dur + 'ms';
    s.appendChild(c);
    return s;
  }

  // Dynamic-Island coupling: in minimal-topbar chrome a notification takes the
  // floating clock island's place (js/toast-island.js), and while its glass holds
  // it the body is tagged so the pill and the SDK capsule step aside (see
  // TopbarMinimal.css). No-op in the full topbar (there's no pill to replace).
  // Style "none" keeps the rails but drops the capsule (body.topbar-noisland), so
  // there is nothing for the toast to grow out of — fall back to the normal stack.
  // The same when the user chose a fixed place for notifications (Settings → Top
  // bar → Notifications sets data-tb-toast-place, js/topbar-look.js).
  function isMinimalChrome() {
    const body = document.body;
    return body.classList.contains('topbar-minimal')
      && !body.classList.contains('topbar-noisland')
      && !body.dataset.panel
      && !document.documentElement.hasAttribute('data-tb-toast-place');
  }
  function syncIsland() {
    const body = document.body;
    const holding = !!island && island.holding();
    const folded = !!island && island.folded();
    body.classList.toggle('xtoast-island', holding);
    // The tiles' cuts close while the card is out and reopen as it heads home,
    // so the pill lands in an open cut (js/topbar-minimal.js reads the class).
    if (body.classList.contains('xtoast-fold') !== folded) {
      body.classList.toggle('xtoast-fold', folded);
      if (window.TopbarMinimal && typeof window.TopbarMinimal.reflowIsland === 'function') {
        window.TopbarMinimal.reflowIsland();
      }
    }
    // Tell sandboxed SDK widgets whether a pop-up is currently on screen, so an
    // interactive one (a game, a teleprompter) can pause itself and resume after.
    // Deliberately content-FREE: a widget learns that something is showing, never
    // what it says. Windows notification mirroring puts real message text in these
    // cards, and a third-party widget in a sandbox has no business reading it.
    if (window.CustomWidget && typeof window.CustomWidget.onToastState === 'function') {
      try { window.CustomWidget.onToastState(toasts.size > 0); } catch { /* never break a toast */ }
    }
  }

  // ── Do not disturb ──────────────────────────────────────────────────────────
  // Settings → Notifiche → "Non disturbare". 'auto' (the default) holds routine
  // pop-ups back while the screen is immersive: a full-screen ambient scene, or
  // game mode. 'always' holds them back the whole time, 'off' never does.
  //
  // These four types are NEVER held back, on any setting: an error is a real
  // failure and must not be hidden behind a silent no-op, a warning needs
  // attention, and a reminder or a finished timer is something the user asked
  // for by name — silencing an alarm the user set is not "do not disturb", it is
  // a bug.
  // On top of the types, a caller may pass `important: true` for the RESULT of
  // something the user just did on this screen — a cleanup that has already
  // moved files to the Recycle Bin, a save that just landed. Do not disturb is
  // about unsolicited pop-ups; swallowing the answer to the user's own tap left
  // them with no confirmation that anything happened, which is the opposite of
  // "state changes must be obvious and immediate". Do NOT set it on anything
  // the user did not just trigger by hand.
  const QUIET_EXEMPT = new Set(['error', 'warning', 'reminder', 'timer']);
  function quietSuppressed(type, opts) {
    if (opts && opts.important === true) return false;
    if (QUIET_EXEMPT.has(type)) return false;
    const n = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) ? hubSettings.notifications : null;
    const mode = (n && (n.quiet === 'off' || n.quiet === 'always')) ? n.quiet : 'auto';
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    const c = document.body.classList;
    return c.contains('game-mode') || c.contains('ambient-scene-open');
  }

  function clearTimer(rec) { if (rec && rec.timer) { clearTimeout(rec.timer); rec.timer = null; } }

  function arm(id) {
    const rec = toasts.get(id);
    if (!rec || rec.timer || rec.dur <= 0 || rec.remaining <= 0) return;
    // A card waiting its turn on the island keeps the time it has left.
    if (rec.island && !island.mayRun(id)) return;
    rec.startedAt = Date.now();
    rec.timer = setTimeout(() => dismiss(id), rec.remaining);
  }

  // Pause the auto-dismiss (hover or press-hold), banking the time left. Idempotent:
  // a second pause (e.g. mouseenter then pointerdown) won't double-subtract.
  function pause(id) {
    const rec = toasts.get(id);
    if (!rec || rec.dur <= 0) return;
    clearTimer(rec);
    if (rec.startedAt) { rec.remaining -= (Date.now() - rec.startedAt); rec.startedAt = 0; }
  }

  // `dir` (-1 | 1), when given, flings the card off that side (swipe dismiss);
  // otherwise it settles out in place.
  function dismiss(id, dir) {
    const rec = toasts.get(id);
    if (!rec) return;
    clearTimer(rec);
    toasts.delete(id);
    if (rec.island) {
      island.remove(id, dir, rec.el);
      syncIsland();
      return;
    }
    syncIsland();
    leaveStack(rec.el);
    if (dir) {
      rec.el.classList.remove('is-dragging');
      rec.el.style.transition = 'transform 0.26s ease-in, opacity 0.24s ease-in';
      rec.el.style.transform = 'translateX(' + (dir * 130) + '%) rotate(' + (dir * 5) + 'deg)';
      rec.el.style.opacity = '0';
    } else {
      rec.el.classList.add('xtoast-out');
    }
    rec.el.addEventListener('transitionend', () => rec.el.remove(), { once: true });
    // Safety net if transitionend never fires (e.g. display change).
    setTimeout(() => { if (rec.el.parentNode) rec.el.remove(); }, 600);
  }

  function dismissAll() { Array.from(toasts.keys()).forEach(id => dismiss(id)); }

  // A live card already in the stack keeps new ones there too, so the two never
  // show at once (the chrome changed while it was up).
  function stackBusy() {
    return !!(container && container.querySelector(':scope > .xtoast:not(.xtoast-leaving)'));
  }

  // The chrome is no longer minimal (style changed, phone view) while cards are on
  // the island: move them to the stack, newest on top, with their timers running.
  function refresh() {
    if (island && !isMinimalChrome() && (island.holding() || Array.from(toasts.values()).some(r => r.island))) {
      ensureContainer();
      island.handBack().forEach((id) => {
        const rec = toasts.get(id);
        if (!rec) return;
        rec.island = false;
        glide(() => container.prepend(rec.el));
        rec.el.classList.add('xtoast-in');
        arm(id);
      });
    }
    syncIsland();
  }

  // Cards slide to their new place when one arrives or leaves, instead of jumping.
  // `mutate` changes the stack; each remaining card is then played from where it
  // was. The animation is additive, so two changes in one frame (a new card and the
  // oldest being trimmed) add up, and it uses `translate`, which the cards' own
  // transform (entrance, swipe) never touches.
  function glide(mutate) {
    const cards = Array.from(container.children).filter(c => !c.classList.contains('xtoast-leaving'));
    const from = new Map(cards.map(c => [c, c.offsetTop]));
    mutate();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // The same spring the cards arrive on (Toast.css --xt-settle).
    const easing = getComputedStyle(container).getPropertyValue('--xt-settle').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)';
    cards.forEach((c) => {
      if (!c.isConnected || c.classList.contains('xtoast-leaving') || typeof c.animate !== 'function') return;
      const d = from.get(c) - c.offsetTop;
      if (!d) return;
      c.animate([{ translate: '0 ' + d + 'px' }, { translate: '0 0' }],
        { duration: 480, easing, composite: 'add' });
    });
  }

  // A card on its way out leaves the layout at once, in the spot it holds, so the
  // ones under it close the gap while it fades instead of after it is gone.
  function leaveStack(el) {
    glide(() => {
      const top = el.offsetTop;
      el.classList.add('xtoast-leaving');
      Object.assign(el.style, { position: 'absolute', top: top + 'px', left: '0', right: '0' });
    });
  }

  function show(opts) {
    // A layer window shows no toasts (LayerHost.css hides them) and must not
    // play their sound: the main dashboard already shows the same one.
    if (typeof isLayerPage === 'function' && isLayerPage()) return 0;
    const o = opts || {};
    const type = TYPES[o.type] ? o.type : 'info';
    const cfg = TYPES[type];
    const dur = (o.duration != null) ? Number(o.duration) : (DEFAULT_DURATION[type] || 6000);
    // Held back by do-not-disturb. Returns 0, which dismiss() ignores, so a
    // caller that keeps the id to close its own toast later is unaffected.
    if (quietSuppressed(type, o)) return 0;
    ensureContainer();

    const id = ++seq;
    const el = document.createElement('div');
    el.className = 'xtoast xtoast-' + type;
    const rgb = safeRgb(o.rgb) || cfg.rgb;
    el.style.setProperty('--xt-rgb', rgb);
    el.style.setProperty('--xt-ink', inkFor(rgb));
    el.setAttribute('role', type === 'error' || type === 'reminder' || type === 'timer' ? 'alert' : 'status');

    // A caller may supply the source app's own icon (a data:image/ URI only — no
    // remote loads); otherwise fall back to the type's line-icon.
    if (typeof o.iconUrl === 'string' && o.iconUrl.startsWith('data:image/')) {
      const wrapImg = document.createElement('span');
      wrapImg.className = 'xtoast-icon xtoast-icon--img';
      const img = document.createElement('img');
      img.alt = ''; img.src = o.iconUrl;
      wrapImg.appendChild(img);
      el.appendChild(wrapImg);
    } else {
      el.appendChild(svg(cfg.icon, 'xtoast-icon'));
    }

    const body = document.createElement('div');
    body.className = 'xtoast-body';
    if (o.kicker) {
      const k = document.createElement('div');
      k.className = 'xtoast-kicker';
      k.textContent = String(o.kicker);          // dynamic → textContent
      body.appendChild(k);
    }
    const title = document.createElement('div');
    title.className = 'xtoast-title';
    title.textContent = String(o.title || '');
    body.appendChild(title);
    if (o.message) {
      const m = document.createElement('div');
      m.className = 'xtoast-msg';
      m.textContent = String(o.message);
      body.appendChild(m);
    }
    // Optional explicit actions, rendered under the message. Distinct from
    // `onClick` (which makes the WHOLE toast the action): use these when the
    // toast offers a second, non-obvious choice — "Skip this version" next to a
    // tap-to-install. Handlers run before the toast closes, and a click here
    // never bubbles into the tap action or the swipe gesture.
    if (Array.isArray(o.actions) && o.actions.length) {
      const row = document.createElement('div');
      row.className = 'xtoast-actions';
      o.actions.slice(0, 2).forEach((a) => {
        if (!a || typeof a.onClick !== 'function') return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'xtoast-action' + (a.primary ? ' is-primary' : '');
        b.textContent = String(a.label || '');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          try { a.onClick(); } catch { /* an action must not break the toast */ }
          if (a.keepOpen !== true) dismiss(id);
        });
        row.appendChild(b);
      });
      if (row.childElementCount) body.appendChild(row);
    }
    el.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'xtoast-close';
    close.setAttribute('aria-label', (typeof window.t === 'function' && window.t('close')) || 'Close');
    close.appendChild(svg(CLOSE_ICON, 'xtoast-x'));
    if (dur > 0) close.appendChild(progressRing(dur));
    close.addEventListener('click', () => dismiss(id));
    el.appendChild(close);

    const onIsland = !!island && isMinimalChrome() && !stackBusy();
    toasts.set(id, {
      el, timer: null, remaining: dur, startedAt: 0, dur, island: onIsland,
      info: { kicker: o.kicker ? String(o.kicker) : '', title: String(o.title || '') },
    });
    if (onIsland) {
      island.add(id);
    } else {
      // Newest at the top, near the anchor; older toasts pushed down.
      glide(() => container.prepend(el));
      // Entrance on the next frame so the transition runs.
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('xtoast-in')));
    }
    syncIsland();

    // Trim overflow (drop the oldest still-showing toast).
    while (toasts.size > MAX_VISIBLE) dismiss(toasts.keys().next().value);

    // Hover pauses both the dismiss timer and the countdown ring.
    el.addEventListener('mouseenter', () => pause(id));
    el.addEventListener('mouseleave', () => { if (!drag) arm(id); });

    // Swipe-to-dismiss (touch + pointer). Fling the card horizontally past a
    // threshold to dismiss; a small drag snaps back. The dismiss timer is paused
    // for the whole gesture, so a press-and-hold to read never auto-closes.
    let drag = null; // { startX, startY, dx, horizontal, surface }
    let wasDragged = false; // set on a horizontal swipe so it doesn't count as a tap
    // On the island the whole glass moves with the finger, not just the card.
    const dragSurface = () => {
      const rec = toasts.get(id);
      return (rec && rec.island && island.surface()) || el;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      // Let the toast's own controls work. The close button was exempted from
      // the start; the ACTION buttons were not, and that made them dead: the
      // drag below calls setPointerCapture on the toast, which retargets the
      // click away from the button it was aimed at, so the handler never ran.
      // Seen on the macOS permission toast, whose only button did nothing at
      // all — and it was worse on a toast that also has a tap action, because
      // the retargeted click ran THAT: "Skip this version" installed the
      // update it was declining.
      if (e.target.closest('.xtoast-close, .xtoast-action, .xisland-more')) return;
      wasDragged = false;
      drag = { startX: e.clientX, startY: e.clientY, dx: 0, horizontal: false, surface: dragSurface() };
      el.classList.add('is-held');
      pause(id);
      try { el.setPointerCapture(e.pointerId); } catch { /* older engine */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.horizontal) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;   // movement threshold
        if (Math.abs(dy) > Math.abs(dx)) { drag = null; el.classList.remove('is-held'); return; } // vertical scroll wins
        drag.horizontal = true;
        wasDragged = true;
        el.classList.add('is-dragging');
        drag.surface.classList.add('is-dragging');
      }
      drag.dx = dx;
      if (drag.surface !== el) {
        // Translate only: an opacity on the glass's parent would switch its blur off.
        drag.surface.style.transform = `translateX(${dx}px)`;
        return;
      }
      const fade = Math.max(0.35, 1 - Math.abs(dx) / (el.offsetWidth || 360));
      el.style.transform = `translateX(${dx}px) rotate(${dx * 0.02}deg)`;
      el.style.opacity = String(fade);
    });
    const endDrag = () => {
      if (!drag) return;
      const dx = drag.dx;
      const wide = el.offsetWidth || 360;
      el.classList.remove('is-held', 'is-dragging');
      drag.surface.classList.remove('is-dragging');
      if (drag.horizontal && Math.abs(dx) > wide * 0.32) { dismiss(id, Math.sign(dx)); drag = null; return; }
      // Snap back and resume.
      drag.surface.style.transform = '';
      el.style.transform = '';
      el.style.opacity = '';
      drag = null;
      arm(id);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    // Optional tap action: makes the whole toast actionable (e.g. "tap to
    // update"). A horizontal swipe or the close button never counts as a tap.
    if (typeof o.onClick === 'function') {
      el.classList.add('xtoast-clickable');
      el.addEventListener('click', (e) => {
        // `.xtoast-action` is named here as well as in the pointerdown exemption
        // above: the two guard different halves of the same mistake, and this
        // one keeps holding if a future change reintroduces the capture.
        if (wasDragged || e.target.closest('.xtoast-close, .xtoast-action, .xisland-more')) return;
        try { o.onClick(); } catch { /* action must not break the toast */ }
      });
    }

    arm(id);
    // Play the type's notification cue (Settings → Notifiche → sounds gates it;
    // info/success and other routine types are silent). Callers with their own
    // audio — Bit's 8-bit voice, governed by its separate pet.sounds toggle —
    // pass `silent: true` so the cue never doubles. Audio must never break a
    // toast, so any failure here is swallowed.
    if (!o.silent) { try { if (window.XenonSound) window.XenonSound.play(type); } catch { } }
    return id;
  }

  // refresh: re-check the chrome after it changes (js/topbar-minimal.js).
  window.XenonToast = { show, dismiss, dismissAll, refresh };
})();

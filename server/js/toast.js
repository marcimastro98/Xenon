'use strict';

// ── Unified notification system ───────────────────────────────────────────────
// One stacked, glassy, type-aware toast for every in-app notice — calendar
// reminders, finished timers, update prompts, Genesis/Guardian/backup messages.
// Replaces the old single shared #event-toast (which had a hard-coded clock icon
// regardless of context) and the separate timer "pill", which looked inconsistent.
//
// API:
//   XenonToast.show({ type, kicker, title, message, duration }) -> id
//   XenonToast.dismiss(id)
//   XenonToast.dismissAll()
// Types: info | success | warning | error | reminder | timer | update.
// duration: ms; 0 = sticky. Hovering a toast pauses its auto-dismiss + progress.

(function () {
  // Each type carries an accent (rgb triplet or a CSS var indirection) and a
  // line-icon described as plain element descriptors, built via createElementNS
  // (no innerHTML anywhere — nothing here is ever interpolated from user input).
  const TYPES = {
    info:     { rgb: 'var(--accent-rgb)', icon: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5' }], ['path', { d: 'M12 8h.01' }]] },
    success:  { rgb: '76,175,120',        icon: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.6 2.6L16 9' }]] },
    warning:  { rgb: '240,180,70',        icon: [['path', { d: 'M12 3.2 21 19H3z' }], ['path', { d: 'M12 10v4' }], ['path', { d: 'M12 17h.01' }]] },
    error:    { rgb: '233,84,84',         icon: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M15 9l-6 6' }], ['path', { d: 'M9 9l6 6' }]] },
    reminder: { rgb: 'var(--accent-rgb)', icon: [['path', { d: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }], ['path', { d: 'M13.7 21a2 2 0 0 1-3.4 0' }]] },
    timer:    { rgb: '243,146,55',        icon: [['circle', { cx: 12, cy: 13, r: 8 }], ['path', { d: 'M12 9.5V13l2.4 1.6' }], ['path', { d: 'M9 2.5h6' }]] },
    update:   { rgb: 'var(--accent-rgb)', icon: [['path', { d: 'M12 3v11' }], ['path', { d: 'M7.5 10.5 12 15l4.5-4.5' }], ['path', { d: 'M5 20h14' }]] },
  };
  const CLOSE_ICON = [['path', { d: 'M6 6l12 12' }], ['path', { d: 'M18 6 6 18' }]];
  const DEFAULT_DURATION = { reminder: 14000, timer: 12000 };
  const MAX_VISIBLE = 4;

  let container = null;
  let seq = 0;
  const toasts = new Map(); // id -> { el, timer, remaining, startedAt, dur }

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

  function clearTimer(rec) { if (rec && rec.timer) { clearTimeout(rec.timer); rec.timer = null; } }

  function arm(id) {
    const rec = toasts.get(id);
    if (!rec || rec.dur <= 0 || rec.remaining <= 0) return;
    rec.startedAt = Date.now();
    rec.timer = setTimeout(() => dismiss(id), rec.remaining);
  }

  function dismiss(id) {
    const rec = toasts.get(id);
    if (!rec) return;
    clearTimer(rec);
    toasts.delete(id);
    rec.el.classList.add('xtoast-out');
    rec.el.addEventListener('transitionend', () => rec.el.remove(), { once: true });
    // Safety net if transitionend never fires (e.g. display change).
    setTimeout(() => { if (rec.el.parentNode) rec.el.remove(); }, 600);
  }

  function dismissAll() { Array.from(toasts.keys()).forEach(dismiss); }

  function show(opts) {
    const o = opts || {};
    const type = TYPES[o.type] ? o.type : 'info';
    const cfg = TYPES[type];
    const dur = (o.duration != null) ? Number(o.duration) : (DEFAULT_DURATION[type] || 6000);
    ensureContainer();

    const id = ++seq;
    const el = document.createElement('div');
    el.className = 'xtoast xtoast-' + type;
    el.style.setProperty('--xt-rgb', cfg.rgb);
    el.setAttribute('role', type === 'error' || type === 'reminder' || type === 'timer' ? 'alert' : 'status');

    const rail = document.createElement('div');
    rail.className = 'xtoast-rail';
    el.appendChild(rail);                           // left accent rail (pure CSS)
    el.appendChild(svg(cfg.icon, 'xtoast-icon'));

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
    el.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'xtoast-close';
    close.setAttribute('aria-label', (typeof window.t === 'function' && window.t('close')) || 'Close');
    close.appendChild(svg(CLOSE_ICON, 'xtoast-x'));
    close.addEventListener('click', () => dismiss(id));
    el.appendChild(close);

    if (dur > 0) {
      const prog = document.createElement('div');
      prog.className = 'xtoast-progress';
      prog.style.animationDuration = dur + 'ms';
      el.appendChild(prog);
    }

    // Newest at the bottom, near the anchor; older toasts pushed up.
    container.appendChild(el);
    toasts.set(id, { el, timer: null, remaining: dur, startedAt: 0, dur });

    // Trim overflow (drop the oldest still-showing toast).
    while (toasts.size > MAX_VISIBLE) dismiss(toasts.keys().next().value);

    // Entrance on the next frame so the transition runs.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('xtoast-in')));

    // Hover pauses both the dismiss timer and the progress bar.
    el.addEventListener('mouseenter', () => {
      const rec = toasts.get(id);
      if (!rec || rec.dur <= 0) return;
      clearTimer(rec);
      rec.remaining -= (Date.now() - rec.startedAt);
    });
    el.addEventListener('mouseleave', () => arm(id));

    arm(id);
    return id;
  }

  window.XenonToast = { show, dismiss, dismissAll };
})();

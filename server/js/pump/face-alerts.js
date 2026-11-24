// What arrives over the face for a few seconds (pump-face.html): a notification,
// a Discord message, a call while it rings, a finished timer, a PC running hot.
// One at a time, the rest wait their turn. The words of a message show only when
// the screen allows them and never while live or recording (pump-face.js says
// which). Over a screen style that takes alerts (manifest pumpAlerts) there is no card: the style
// is told the kind and shows it its way, and the words go in the band below, in its colours.
// Joins window.PumpFaceKit as the part "alerts"; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const WAITING_MAX = 3;
  const OUT_MS = 240;
  const FOLLOW_MS = 1000;
  const GLYPHS = {
    notify: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
    discord: 'M4 6h16v10H9l-4 3.5V16H4z',
    call: 'M6.5 3.5l3 .5 1.2 3.6-2 1.4a11 11 0 0 0 6.3 6.3l1.4-2 3.6 1.2.5 3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z',
    timer: 'M12 7v5l3 2M9.5 2.5h5M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
    hot: 'M12 3a2.5 2.5 0 0 0-2.5 2.5v8.1a4.5 4.5 0 1 0 5 0V5.5A2.5 2.5 0 0 0 12 3zM12 9v7',
  };

  function glyph(kind, icon) {
    const box = Kit.el('div', 'pf-alert-icon');
    const pic = icon ? Kit.safeImage(icon) : '';
    if (pic.startsWith('data:image/')) {
      const img = Kit.el('img');
      img.alt = '';
      img.src = pic;
      box.append(img);
      return box;
    }
    const s = Kit.svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    s.append(Kit.svg('path', { d: GLYPHS[kind] || GLYPHS.notify }));
    box.append(s);
    return box;
  }

  // The card's three lines for one alert; `open` = the screen may show what it says.
  function linesOf(a, open) {
    const T = Kit.t;
    switch (a.kind) {
      case 'call': return [a.app || '', open && a.caller ? a.caller : T('pump_face_call', 'Incoming call'), ''];
      case 'timer': return ['', T('pump_face_timer_done', 'Timer done'), a.label || ''];
      case 'hot': return ['', T('pump_face_hot', 'Your PC is running hot'), a.text || ''];
      case 'discord': return ['Discord', open && a.title ? a.title : T('pump_face_notification', 'New notification'), open ? a.body || '' : ''];
      default: return [a.app || '', open && a.title ? a.title : T('pump_face_notification', 'New notification'), open ? a.body || '' : ''];
    }
  }

  // The line's colours on the band, so the words read as the style's own.
  function paintBand(card, look) {
    const [c1, c2] = look.colors;
    card.style.setProperty('--pf-c1', c1);
    card.style.setProperty('--pf-c2', c2);
    card.style.setProperty('--pf-hot', look.warn);
    card.style.setProperty('--pf-band', `${window.PumpFaces.ALERT_BAND * 100}%`);
  }

  Kit.add('part', 'alerts', (root, { style = () => null } = {}) => {
    const waiting = [];
    let current = null;
    let timer = 0;
    let follower = 0;

    // How the face showing now takes an alert: a style's own way (manifest pumpAlerts, face-widget.js)
    // with the words in the band it leaves free, or Xenon's card over everything.
    function takerOf() {
      const impl = style();
      const look = impl?.alertsLook?.() || null;
      return { impl: look ? impl : null, look };
    }

    function drawCard(a, open, seconds) {
      const [kicker, title, body] = linesOf(a, open);
      const card = Kit.el('div', `pf-alert pf-alert-${a.kind}`);
      const ring = Kit.svg('svg', { viewBox: '0 0 100 100', class: 'pf-rings pf-alert-ring', 'aria-hidden': 'true' });
      const left = Kit.gauge(ring, { r: 48, width: 1.6, start: 0, sweep: 359.9, slot: 1 });
      left.set(1, a.kind === 'hot' ? 'hot' : 'ok');
      const text = Kit.el('div', 'pf-alert-text');
      if (kicker) text.append(Kit.el('div', 'pf-alert-kicker', kicker));
      text.append(Kit.el('div', 'pf-alert-title', title));
      if (body) text.append(Kit.el('div', 'pf-alert-body', body));
      card.append(ring, glyph(a.kind, a.icon), text);
      card.setAttribute('role', 'status');
      root.append(card);
      // The ring empties over the seconds the card stays: how long it has left, at a glance.
      if (seconds > 0) {
        const fill = ring.querySelector('.pf-fill');
        fill.animate([{ strokeDasharray: '100 100' }, { strokeDasharray: '0 100' }], { duration: seconds * 1000, easing: 'linear', fill: 'forwards' });
      }
      return card;
    }

    // Over a style that takes alerts: no card and no icon (the style shows the alert its way), only
    // the words in the band below, the title in dots (face-alert-dots.js) or plain type.
    function drawBand(a, open, look) {
      const [kicker, title, body] = linesOf(a, open);
      const card = Kit.el('div', `pf-alert pf-alert-band pf-alert-${a.kind}`);
      paintBand(card, look);
      card.setAttribute('role', 'status');
      card.setAttribute('aria-label', [kicker, title, body].filter(Boolean).join('. '));
      root.append(card);
      if (kicker) card.append(Kit.el('div', 'pf-alert-kicker', kicker));
      const dots = look.mode === 'dots' ? Kit.get('part', 'alertDots') : null;
      if (!dots?.(card, title)) card.append(Kit.el('div', 'pf-alert-title', title));
      if (body) card.append(Kit.el('div', 'pf-alert-body', body));
      return card;
    }

    // Seconds the alert on show has left; a call has none, it stays while it rings.
    const left = (c) => (c.alert.kind === 'call' ? 0 : Math.max(1, c.seconds - (Date.now() - c.at) / 1000));

    // The alert over the face as that face takes it now; a style that takes it is told the kind.
    function put(c, fresh) {
      const { impl, look } = takerOf();
      c.card = look ? drawBand(c.alert, c.open, look) : drawCard(c.alert, c.open, left(c));
      if (!fresh) c.card.classList.add('pf-alert-still');
      c.told = impl;
      c.mode = look ? look.mode : 'card';
      impl?.alert({ kind: c.alert.kind, seconds: left(c) });
    }

    // Once a second while one shows: the face under it may have changed (a game started) or a
    // style's page come up since, and the alert follows how that face takes it.
    function follow() {
      if (!current) return;
      const { impl, look } = takerOf();
      if ((look ? look.mode : 'card') === current.mode && impl === current.told) return;
      current.told?.alert(null);
      current.card.remove();
      put(current, false);
    }

    function quiet() {
      clearTimeout(timer);
      clearInterval(follower);
      timer = 0;
      follower = 0;
      current?.told?.alert(null);
    }

    function end() {
      quiet();
      if (!current) return;
      const gone = current.card;
      gone.classList.add('pf-alert-out');
      setTimeout(() => gone.remove(), OUT_MS);
      current = null;
      next();
    }

    function next() {
      if (current || !waiting.length) return;
      const { alert, open, seconds } = waiting.shift();
      current = { alert, open, seconds, at: Date.now(), card: null, told: null, mode: '' };
      put(current, true);
      follower = setInterval(follow, FOLLOW_MS);
      // A call stays while it rings: calls() ends it.
      if (alert.kind !== 'call') timer = setTimeout(end, seconds * 1000);
    }

    return {
      // alert = { kind, app?, title?, body?, caller?, label?, text?, icon? }
      show(alert, { open, seconds }) {
        if (waiting.length >= WAITING_MAX) waiting.shift();
        waiting.push({ alert, open, seconds });
        next();
      },
      // The ringing list: a call that stopped ringing leaves the screen.
      calls(ringing) {
        if (current && current.alert.kind === 'call' && !ringing) end();
        for (let i = waiting.length - 1; i >= 0; i -= 1) if (!ringing && waiting[i].alert.kind === 'call') waiting.splice(i, 1);
      },
      busy: () => !!current,
      stop() { quiet(); waiting.length = 0; if (current) current.card.remove(); current = null; },
    };
  });
})();

// The card for a ring at the door (SSE `home_ring`, server/smart-home/doorbell.js): the door
// camera's picture, fetched again every 2 s while the card is up, Bit surprised beside the
// words, Bit's "Who is it?" and, where the page has room, the camera bigger. The dashboard
// (js/grid/data-stream.js) and the alerts window (js/alerts/screen-alerts.js) both build it here. The
// Deck key "Show camera" (SSE `home_camera`, server/smart-home/camera-show.js) opens the same big view.
(() => {
  'use strict';

  const REFRESH_MS = 2000;
  const SHOW_MS = 60000;
  const VIEW_REFRESH_MS = 1000;
  const VIEW_MS = 120000;
  // Only the two loopback camera proxies (server/smart-home/routes-cameras.js), never a URL in.
  const PIC = /^\/api\/(?:unifiprotect\/snapshot\/[A-Za-z0-9]{4,64}|ha\/camera\/snapshot\/camera\.[a-z0-9_]{1,120})$/;

  const picOf = (d) => (d && typeof d.pic === 'string' && PIC.test(d.pic) ? d.pic : '');
  const fresh = (pic) => pic + '?ts=' + Date.now();
  const say = (ctx, key, fb) => {
    const out = ctx && typeof ctx.t === 'function' ? ctx.t(key) : '';
    return out && out !== key ? out : fb;
  };

  // A new frame is loaded aside and swapped in whole, so the picture never blanks; a card the
  // island keeps out of sight skips its turn. Stops by itself after `ms`.
  function keepFresh(img, pic, every, ms) {
    const until = Date.now() + ms;
    let busy = false;
    const timer = setInterval(() => {
      if (Date.now() > until) { clearInterval(timer); return; }
      if (busy || !img.isConnected || document.hidden) return;
      busy = true;
      const next = new Image();
      next.onload = () => { img.src = next.src; busy = false; };
      next.onerror = () => { busy = false; };
      next.src = fresh(pic);
    }, every);
    return () => clearInterval(timer);
  }

  function addBit(card) {
    if (!window.BitApp || typeof window.BitApp.still !== 'function') return;
    const bit = document.createElement('span');
    bit.className = 'xtoast-door-bit';
    bit.setAttribute('aria-hidden', 'true');
    bit.innerHTML = window.BitApp.still('surprised', 56);   // the engine's own markup, no text in it
    card.appendChild(bit);
  }

  function mount(card, pic) {
    card.classList.add('xtoast--door');
    addBit(card);
    const img = pic ? card.querySelector('.xtoast-icon--shot img') : null;
    if (!img) { card.classList.add('is-bare'); return; }
    img.addEventListener('error', () => card.classList.add('is-bare'), { once: true });
    keepFresh(img, pic, REFRESH_MS, SHOW_MS);
  }

  /** The camera over the whole page, live for two minutes; a tap or Esc closes it. */
  function view(pic, name, ctx) {
    if (!PIC.test(String(pic)) || document.querySelector('.door-view')) return;
    const box = document.createElement('div');
    box.className = 'door-view';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', String(name || say(ctx, 'door_kicker', 'Doorbell')));
    const img = document.createElement('img');
    img.alt = '';
    img.src = fresh(pic);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'door-view-close';
    close.textContent = say(ctx, 'close', 'Close');
    box.append(img, close);
    const stop = keepFresh(img, pic, VIEW_REFRESH_MS, VIEW_MS);
    const onKey = (e) => { if (e.key === 'Escape') end(); };
    function end() { stop(); document.removeEventListener('keydown', onKey); box.remove(); }
    box.addEventListener('click', end);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    setTimeout(end, VIEW_MS);
    close.focus();
  }

  /**
   * The toast for one ring.
   * @param {{ name?: string, pic?: string }} d
   * @param {{ t?: Function }} ctx
   * @param {{ ask?: (text: string) => void, view?: boolean }} can what this page can do
   */
  function toast(d, ctx, can) {
    const pic = picOf(d);
    const name = d && typeof d.name === 'string' ? d.name.slice(0, 80) : '';
    const actions = [];
    if (typeof can?.ask === 'function') {
      const question = say(ctx, 'door_who_ask', 'Who is at the door?');
      actions.push({ label: say(ctx, 'door_who', 'Who is it?'), primary: true, onClick: () => can.ask(question) });
    }
    if (pic && can?.view) actions.push({ label: say(ctx, 'door_view', 'See it bigger'), onClick: () => view(pic, name, ctx) });
    return {
      type: 'notification',
      kicker: say(ctx, 'door_kicker', 'Doorbell'),
      title: say(ctx, 'door_title', 'Someone rang the doorbell'),
      message: name,
      image: pic ? fresh(pic) : '',
      duration: SHOW_MS,
      actions,
      onMount: (card) => mount(card, pic),
    };
  }

  /** The dashboard's two home events: a ring gets its card, a Deck key's camera the big view. */
  function onEvent(type, d, ctx, can) {
    if (type === 'home_ring') can.show(toast(d, ctx, can));
    else if (type === 'home_camera') view(picOf(d), d?.name, ctx);
  }

  window.DoorCard = { toast, view, picOf, onEvent };
})();

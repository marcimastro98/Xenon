'use strict';
// How Bit says something: a card at the top that steps aside into the clock and
// waits there, and a stage over the whole screen for the big announcements. This file only draws;
// what to show and when is js/bit-messages.js. Every string comes from a feed or a
// catalog, so all of it goes through textContent.
(function () {
  const FOLD_MS = 20000;    // an untouched card steps aside to Bit's face
  const THANKS_MS = 4000;
  const PLAIN_MAX = 160;    // a text this short fits the card: nothing to open
  const GREETING = 'hello';
  let folded = null;        // the card now waiting as Bit's face

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(cls, text, onClick) {
    const node = el('button', cls, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function stillNow() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }

  function clip(media) {
    const still = stillNow();
    const node = document.createElement('video');
    node.src = media.url;
    node.muted = true;
    node.loop = !still;
    node.autoplay = !still;
    node.playsInline = true;
    node.preload = 'metadata';
    node.setAttribute('aria-hidden', 'true');
    if (media.poster) node.poster = media.poster;
    return node;
  }

  // A catalog shot may exist only as .png; anything else that fails takes its
  // frame with it, so no empty box is left above the text.
  function picture(media, frame) {
    const node = document.createElement('img');
    node.alt = media.alt || '';
    node.decoding = 'async';
    node.addEventListener('error', () => {
      if (node.src.endsWith('.webp')) node.src = node.src.replace(/\.webp$/, '.png');
      else frame.remove();
    });
    node.src = media.url;
    return node;
  }

  function mediaFrame(media, cls) {
    if (!media || !media.url) return null;
    const frame = el('div', cls);
    if (media.type === 'video') {
      const node = clip(media);
      node.addEventListener('error', () => frame.remove(), { once: true });
      frame.append(node);
    } else {
      frame.append(picture(media, frame));
    }
    return frame;
  }

  // Folded, Bit waits in the clock, where it covers nothing. No clock on screen (the bar
  // turned off, the alerts window): it keeps a corner.
  function faceHome() {
    const slot = document.getElementById('clock-bit');
    const noClock = ['topbar-noisland', 'topbar-hidden'].some((name) => document.body.classList.contains(name));
    return slot && !noClock ? slot : document.body;
  }

  function seat(root, home) {
    const from = root.parentElement;
    if (from === home) return;
    home.append(root);
    const left = from && from !== document.body ? from : null;
    const joined = home !== document.body ? home : null;
    if (left) left.hidden = true;
    if (joined) joined.hidden = false;
    const bar = window.TopbarMinimal;
    if ((left || joined) && bar && bar.reflowIsland) bar.reflowIsland();
  }

  function refit() {
    if (folded) seat(folded, faceHome());
  }

  const textOf = (msg) => msg.body || msg.line || '';
  const lineOf = (msg) => msg.line || msg.body || '';
  const isPlain = (msg, h) => !msg.media && !msg.action && !h.extra && textOf(msg).length <= PLAIN_MAX;

  // ── The card ───────────────────────────────────────────────────
  // h: { tr, bit(parent, cls, clip), read(), run(), answer(option), done(),
  //      off: { label, run }, extra(body, foot, close) -> main button, openStage() }
  function card(msg, h) {
    const root = el('div', 'bm-card');
    root.setAttribute('aria-label', msg.title);
    let player = null;
    let timer = 0;

    function reset(cls) {
      clearTimeout(timer);
      if (player) player.destroy();
      player = null;
      root.replaceChildren();
      root.className = cls ? `bm-card ${cls}` : 'bm-card';
      if (folded === root) folded = null;
      seat(root, document.body);
    }

    function remove() {
      reset();
      root.remove();
    }

    function foldLater() {
      clearTimeout(timer);
      timer = setTimeout(drawFace, FOLD_MS);
    }

    function head(parent, line, overPicture) {
      const row = el('div', overPicture ? 'bm-head is-over' : 'bm-head');
      player = h.bit(row, 'bm-bit', GREETING);
      const words = el('div', 'bm-words');
      words.append(el('div', 'bm-title', msg.title));
      if (line) words.append(el('div', 'bm-line', line));
      row.append(words);
      parent.append(row);
      return row;
    }

    function drawClosed() {
      reset();
      root.setAttribute('role', 'status');
      const plain = isPlain(msg, h);
      const row = head(root, plain ? textOf(msg) : lineOf(msg));
      if (plain) {
        row.append(button('bm-go', h.tr('rn_ok'), () => { remove(); h.read(); }));
      } else {
        row.append(button('bm-go', h.tr('rn_see'), () => (h.openStage ? h.openStage() : drawOpen())));
        const close = button('bm-x', '×', () => { remove(); h.read(); });
        close.setAttribute('aria-label', h.tr('bm_close'));
        row.append(close);
      }
      foldLater();
    }

    function drawOpen() {
      reset('is-open');
      root.setAttribute('role', 'dialog');
      const frame = mediaFrame(msg.media, 'bm-media');
      if (frame) root.append(frame);
      head(root, '', !!frame);
      const body = el('div', 'bm-body');
      if (textOf(msg)) body.append(el('p', 'bm-text', textOf(msg)));
      root.append(body);
      const foot = el('div', 'bm-foot');
      if (h.off) foot.append(button('bm-off', h.off.label, () => { remove(); h.read(); h.off.run(); }));
      const close = () => { remove(); h.read(); };
      const main = h.extra ? h.extra(body, foot, close) : null;
      foot.append(button('bm-quiet', h.tr('rn_ok'), close));
      if (msg.action) foot.append(button('bm-go', msg.action.label, () => { remove(); h.run(); }));
      if (main) foot.append(main);
      root.append(foot);
    }

    function drawPoll() {
      reset('is-poll');
      root.setAttribute('role', 'dialog');
      const frame = mediaFrame(msg.media, 'bm-media');
      if (frame) root.append(frame);
      head(root, textOf(msg), !!frame);
      const answers = el('div', 'bm-answers');
      for (const option of msg.poll.options) {
        answers.append(button('bm-answer', option.label, () => { h.answer(option); drawThanks(option); }));
      }
      const foot = el('div', 'bm-foot');
      foot.append(button('bm-quiet', h.tr('bm_not_now'), drawFace));
      root.append(answers, foot);
      foldLater();
    }

    function drawThanks(option) {
      reset('is-thanks');
      root.setAttribute('role', 'status');
      const words = el('div', 'bm-head');
      player = h.bit(words, 'bm-bit', 'happy');
      const text = el('div', 'bm-words');
      text.append(el('div', 'bm-title', h.tr('bm_thanks')), el('div', 'bm-line', h.tr('bm_noted').replace('{answer}', option.label)));
      words.append(text);
      root.append(words);
      timer = setTimeout(() => { remove(); h.done(); }, THANKS_MS);
    }

    const drawFirst = () => (msg.poll ? drawPoll() : drawClosed());

    function drawFace() {
      reset('is-face');
      root.setAttribute('role', 'status');
      const face = button('bm-face', undefined, drawFirst);
      face.setAttribute('aria-label', msg.title);
      face.title = msg.title;
      player = h.bit(face, 'bm-bit', 'idle');
      root.append(face);
      folded = root;
      refit();
    }

    // Someone reading it is not someone ignoring it. The thank-you leaves by its own
    // timer: the card shrinks under the pointer, and a fold there would bring back a
    // poll already answered.
    const folds = () => !['is-face', 'is-open', 'is-thanks'].some((state) => root.classList.contains(state));
    root.addEventListener('pointerenter', () => { if (folds()) clearTimeout(timer); });
    root.addEventListener('pointerleave', () => { if (folds()) foldLater(); });

    drawFirst();
    return remove;
  }

  // ── A question ─────────────────────────────────────────────────
  // It is about this moment, so it neither folds nor waits in the clock: it stays until
  // its asker closes it, on an answer or with the moment gone. Nothing else takes the
  // top centre meanwhile (.bm-ask in BitMessage.css, quiet() in bit-messages.js).
  // parts: { title, off, quiet, go }, each key { label, run }.
  // h: { bit, lasts: { ms, over() } }; lasts only where it cannot wait, and never
  // running out under the pointer.
  function ask(parts, h) {
    const root = el('div', 'bm-card bm-ask');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-label', parts.title);
    const row = el('div', 'bm-head');
    const player = h.bit(row, 'bm-bit', GREETING);
    const words = el('div', 'bm-words');
    words.append(el('div', 'bm-title', parts.title));
    row.append(words);
    const foot = el('div', 'bm-foot');
    foot.append(
      button('bm-off', parts.off.label, parts.off.run),
      button('bm-quiet', parts.quiet.label, parts.quiet.run),
      button('bm-go', parts.go.label, parts.go.run),
    );
    root.append(row, foot);
    document.body.append(root);

    let timer = 0;
    const wait = () => { if (h.lasts) timer = setTimeout(h.lasts.over, h.lasts.ms); };
    root.addEventListener('pointerenter', () => clearTimeout(timer));
    root.addEventListener('pointerleave', wait);
    wait();
    return () => {
      clearTimeout(timer);
      if (player) player.destroy();
      root.remove();
    };
  }

  // ── The stage ──────────────────────────────────────────────────
  // h: { tr, bit, read(), run(), later() }. Closing it without reading leaves the
  // message as a card in the corner, so "later" never loses it.
  function stage(msg, h) {
    const root = el('div', 'bm-stage');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', msg.title);
    let player = null;
    const before = document.activeElement;

    function remove() {
      document.removeEventListener('keydown', onKey);
      if (player) player.destroy();
      root.remove();
      if (before && before.isConnected && typeof before.focus === 'function') before.focus();
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); remove(); h.later(); return; }
      if (e.key !== 'Tab') return;
      const all = [...root.querySelectorAll('button')];
      const at = all.indexOf(document.activeElement);
      e.preventDefault();
      all[(at + (e.shiftKey ? all.length - 1 : 1)) % all.length].focus();
    }

    const words = el('div', 'bm-stage-words');
    words.append(el('h2', 'bm-stage-title', msg.title));
    if (textOf(msg)) words.append(el('p', 'bm-stage-text', textOf(msg)));
    const left = el('div', 'bm-stage-left');
    left.append(words);
    player = h.bit(left, 'bm-stage-bit', GREETING);
    const frame = mediaFrame(msg.media, 'bm-stage-media');
    const main = el('div', frame ? 'bm-stage-main' : 'bm-stage-main is-text');
    main.append(left);
    if (frame) main.append(frame);

    const band = el('div', 'bm-stage-band');
    const close = () => { remove(); h.read(); };
    let first;
    if (msg.action) {
      band.append(button('bm-stage-later', h.tr('bm_later'), () => { remove(); h.later(); }));
      first = button('bm-stage-go', msg.action.label, () => { remove(); h.run(); });
    } else {
      first = button('bm-stage-go', h.tr('rn_ok'), close);
    }
    band.append(first);
    root.append(main, band);
    document.body.append(root);
    document.addEventListener('keydown', onKey);
    first.focus({ focusVisible: false });   // the ring is for Tab: the stage opens by itself
    return remove;
  }

  window.XenonBitCard = Object.freeze({ card, ask, stage, mediaFrame, refit });
})();

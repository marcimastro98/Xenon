// What a card of Bit's is drawn from besides its message: its elements and buttons, the card that
// asks a question, where Bit's face sits, and whether motion is switched off.
'use strict';

(() => {
  const GREETING = 'hello';

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
    if (left) left.hidden = !left.children.length; // the own Bit may stand there too (bit-companion)
    if (joined) joined.hidden = false;
    const bar = window.TopbarMinimal;
    if ((left || joined) && bar && bar.reflowIsland) bar.reflowIsland();
  }

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

  window.BitMessageCardPieces = { GREETING, el, button, stillNow, faceHome, seat, ask };
})();

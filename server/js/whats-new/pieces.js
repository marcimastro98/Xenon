// What the What's New screen is drawn from: its elements and buttons, the row that shows how to try
// a change, the closing sheet, the digits of the version, and Bit's face on it.
'use strict';

(() => {
  const CLOSING_COLOR = 'orange';

  const DIGITS = Object.freeze({
    0: ['.XXX.', 'X...X', 'X..XX', 'X.X.X', 'XX..X', 'X...X', '.XXX.'],
    1: ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
    2: ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'XXXXX'],
    3: ['XXXXX', '...X.', '..X..', '...X.', '....X', 'X...X', '.XXX.'],
    4: ['...X.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.'],
    5: ['XXXXX', 'X....', 'XXXX.', '....X', '....X', 'X...X', '.XXX.'],
    6: ['..XX.', '.X...', 'X....', 'XXXX.', 'X...X', 'X...X', '.XXX.'],
    7: ['XXXXX', '....X', '...X.', '..X..', '.X...', '.X...', '.X...'],
    8: ['.XXX.', 'X...X', 'X...X', '.XXX.', 'X...X', 'X...X', '.XXX.'],
    9: ['.XXX.', 'X...X', 'X...X', '.XXXX', '....X', '...X.', '.XX..'],
  });

  const stillNow = () => document.body.classList.contains('low-power-gpu')
    || document.body.classList.contains('perf-mode')
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  function tryRow(h, ctx) {
    const row = el('div', 'wn-try');
    if (h.scene === 'menu' && ctx.menuKey) {
      for (const key of ctx.menuKey.split('+')) row.append(el('span', 'wn-key', key.trim()));
    }
    if (h.section && ctx.canOpenMenu) {
      row.append(button('wn-tbtn', ctx.tr(`wn_try_${h.section}`), () => ctx.openMenu(h.section)));
    }
    if (h.go === 'look') row.append(button('wn-tbtn', ctx.tr('wn_try_look'), (e) => ctx.tryLook(e.currentTarget)));
    else if (h.go) row.append(button('wn-tbtn', ctx.tr(`wn_try_${h.go}`), () => ctx.leave(h.go)));
    return row.childElementCount ? row : null;
  }

  function closingSheet(wn, ctx) {
    const sheet = el('section', `wn-sheet wn-closing wn-c-${CLOSING_COLOR}`);
    const col = el('div', 'wn-col');
    col.append(el('h2', 'wn-s-title wn-s-title-big', ctx.text(wn.more.title)));
    if (wn.more.note) col.append(el('p', 'wn-text', ctx.text(wn.more.note)));
    const list = el('div', 'wn-more');
    for (const item of wn.more.items) list.append(el('p', 'wn-more-row', ctx.text(item)));
    if (wn.url) list.append(button('wn-link', ctx.tr('whatsnew_all'), () => ctx.openUrl(wn.url)));
    sheet.append(col, el('div', 'wn-spot'), list);
    sheet.dataset.color = CLOSING_COLOR;
    sheet.dataset.clip = 'celebrate';
    return sheet;
  }

  function mountBit(host) {
    const X = window.Xenon;
    if (!X || !X.bitPlayer) return null;
    return X.bitPlayer.mount(host, { mood: 'idle', fidgets: false, label: 'Bit', reducedMotion: stillNow() });
  }

  window.WhatsNewPieces = { DIGITS, stillNow, el, button, tryRow, closingSheet, mountBit };
})();

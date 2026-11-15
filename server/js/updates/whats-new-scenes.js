'use strict';
// The panels drawn beside the text of the full-screen What's New
// (js/whats-new.js). Drawn, not photographed: they stay sharp on every screen,
// speak the user's language and need nothing from the net.
(function () {
  const WAVE = [34, 52, 40, 66, 58, 74, 48, 60, 82, 70, 92, 64, 54, 76, 88, 96, 72, 60, 84, 68, 50, 62, 78, 44, 58, 36, 48, 30, 42, 26, 38, 22];
  const FRAMES = [22, 24, 21, 23, 26, 22, 21, 24, 23, 22, 25, 23, 21, 22, 24, 26, 23, 22, 21, 24, 28, 34, 92, 46, 30, 24, 22, 23, 21, 24, 22, 23, 25, 22, 21, 23, 24, 22, 26, 23, 21, 22, 24, 23];
  const SPIKE = 60;   // above this a frame bar is the stutter, in orange
  const MENU_SECTIONS = ['now', 'widgets', 'capture', 'keys', 'look', 'mode'];
  const SVG = 'http://www.w3.org/2000/svg';
  // A night road as stepped blocks: [x, y, width, height, colour] on a 64 x 24 grid.
  const PICTURE = [
    [0, 0, 64, 24, '#1f2a44'], [0, 12, 64, 12, '#2d3b5e'],
    [6, 3, 1, 1, '#ededed'], [19, 5, 1, 1, '#ededed'], [33, 2, 1, 1, '#ededed'], [52, 4, 1, 1, '#ededed'],
    [37, 2, 5, 5, '#ffd75e'],
    [0, 10, 10, 6, '#3f4f78'], [8, 7, 8, 9, '#3f4f78'], [15, 11, 9, 5, '#3f4f78'], [38, 9, 8, 7, '#3f4f78'], [45, 6, 9, 10, '#3f4f78'], [53, 10, 11, 6, '#3f4f78'],
    [0, 16, 64, 8, '#141414'], [4, 19, 6, 1, '#ffd75e'], [16, 19, 6, 1, '#ffd75e'], [28, 19, 6, 1, '#ffd75e'], [40, 19, 6, 1, '#ffd75e'], [52, 19, 6, 1, '#ffd75e'],
    [22, 15, 12, 2, '#ff5a5f'], [24, 13, 7, 2, '#ff5a5f'], [25, 14, 5, 1, '#8ab4f8'], [23, 17, 2, 1, '#ededed'], [31, 17, 2, 1, '#ededed'],
  ];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function panel(kind) {
    const node = el('div', `wn-panel wn-panel-${kind}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function row(label, where) {
    const node = el('div', 'wn-row');
    node.append(el('span', '', label), el('span', 'wn-dim', where));
    return node;
  }

  function menu(tr) {
    const node = panel('menu');
    const side = el('div', 'wn-side');
    side.append(el('div', 'wn-side-name', tr('xmenu_title')));
    for (const id of MENU_SECTIONS) {
      side.append(el('div', id === 'widgets' ? 'wn-side-row is-on' : 'wn-side-row', tr(`xmenu_sec_${id}`)));
    }
    const main = el('div', 'wn-menu-main');
    main.append(
      el('div', 'wn-search', tr('xmenu_search')),
      el('div', 'wn-group', tr('wn_s_desktop')),
      row(tr('wn_s_weather'), tr('wn_s_top_right')),
      row(tr('wn_s_system'), tr('wn_s_under_weather')),
      row(tr('wn_s_calendar'), tr('wn_s_bottom_left')),
      el('div', 'wn-group', tr('wn_s_over_game')),
      row('FPS', tr('wn_s_top_left')),
      el('div', 'wn-fake-main', tr('wn_s_add')),
    );
    node.append(side, main);
    return node;
  }

  function picture() {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'wn-picture');
    svg.setAttribute('viewBox', '0 0 64 24');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    svg.setAttribute('shape-rendering', 'crispEdges');
    for (const [x, y, width, height, fill] of PICTURE) {
      const block = document.createElementNS(SVG, 'rect');
      Object.entries({ x, y, width, height, fill }).forEach(([k, v]) => block.setAttribute(k, String(v)));
      svg.append(block);
    }
    return svg;
  }

  function bars(cls, heights, paint) {
    const node = el('div', cls);
    for (const h of heights) {
      const bar = el('div', paint(h));
      bar.style.setProperty('--h', `${h}%`);
      node.append(bar);
    }
    return node;
  }

  function capture(tr) {
    const node = panel('capture');
    const head = el('div', 'wn-clip-head');
    head.append(el('span', 'wn-clip-name', tr('wn_s_clip')), el('span', 'wn-dim', '0:27'));
    const trim = bars('wn-wave', WAVE, () => 'wn-bar');
    trim.append(el('div', 'wn-trim'));
    const actions = el('div', 'wn-clip-actions');
    actions.append(el('div', 'wn-fake-main', tr('wn_s_save')), el('div', 'wn-fake', tr('wn_s_phone')));
    const body = el('div', 'wn-clip');
    body.append(head, trim, actions);
    node.append(picture(), body);
    return node;
  }

  // The strip Xenon draws at the top of the screen, over a game.
  function strip(tr) {
    const node = el('div', 'wn-strip');
    const parts = [['FPS', '144'], ['1%', '97'], ['GPU', '62%'], ['CPU', '31%'], ['Ping', '18 ms'], [tr('perf_loss_short'), '0%']];
    for (const [label, value] of parts) {
      const part = el('span', 'wn-strip-part');
      part.append(el('span', 'wn-dim', label), el('b', '', value));
      node.append(part);
    }
    return node;
  }

  function fps(tr) {
    const node = panel('fps');
    const game = el('div', 'wn-game');
    game.append(picture(), strip(tr));
    const why = el('div', 'wn-why');
    why.append(el('div', 'wn-dim', tr('wn_s_why')), el('div', 'wn-why-answer', tr('wn_s_answer')));
    const foot = el('div', 'wn-fps-foot');
    foot.append(bars('wn-frames', FRAMES, (h) => (h > SPIKE ? 'wn-bar is-spike' : 'wn-bar')), why);
    node.append(game, foot);
    return node;
  }

  function bubble(cls, text) {
    const node = el('div', `wn-bubble ${cls}`);
    node.append(el('span', '', text));
    return node;
  }

  // What asking Bit looks like: one request, one finished thing on the screen.
  function bit(tr) {
    const node = panel('bit');
    const tile = el('div', 'wn-made');
    tile.append(el('div', 'wn-dim', tr('wn_s_bit_tile')), el('div', 'wn-made-value', tr('wn_s_bit_days')));
    const chat = el('div', 'wn-chat');
    chat.append(bubble('is-you', tr('wn_s_bit_ask')), bubble('is-bit', tr('wn_s_bit_done')), tile);
    node.append(chat, el('div', 'wn-search', tr('wn_s_bit_field')));
    return node;
  }

  window.XenonWhatsNewScenes = Object.freeze({ menu, capture, fps, bit });
})();

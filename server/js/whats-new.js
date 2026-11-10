'use strict';
// What's New of a major version: full screen, one coloured sheet per thing, with
// Bit walking the stops of the band at the bottom. js/update.js opens it on the
// dashboard, js/screen-release.js in the alerts window of "widgets only".
//
// Bit is mounted straight on the player, like the buy sheet: BitApp holds a Bit
// under overlay-frozen, which is the state this page is in. Nothing here runs
// forever on its own: the player stops with the stage, and on a low-power GPU,
// in Performance Mode or with reduced motion Bit stands still and sheets cut.
(function () {
  const WALK_MS = 950;
  const MENU_POLL_MS = 1200;
  const REST_ON = Object.freeze({ yellow: 'happy', orange: 'happy' });
  const OPENING_COLOR = 'green';
  const CLOSING_COLOR = 'orange';
  const MAKER_URL = 'https://xenon-app.com/maker/';
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

  function digitCells(number) {
    const box = el('div', 'wn-digits');
    box.setAttribute('aria-hidden', 'true');
    let order = 0;
    for (const ch of String(number)) {
      const digit = el('div', 'wn-digit');
      for (const line of DIGITS[ch] || DIGITS[0]) {
        for (const mark of line) {
          const cell = el('span', mark === 'X' ? 'wn-cell is-on' : 'wn-cell');
          if (mark === 'X') { cell.style.setProperty('--i', String(order)); order += 1; }
          digit.append(cell);
        }
      }
      box.append(digit);
    }
    return box;
  }

  function openingSheet(wn, text) {
    const number = Number.parseInt(wn.id, 10) || 0;
    const sheet = el('section', `wn-sheet wn-opening wn-c-${OPENING_COLOR}`);
    const name = el('h1', 'wn-name', 'Xenon');
    name.setAttribute('aria-label', `Xenon ${number}`);
    sheet.append(name, el('p', 'wn-intro', text(wn.intro)), digitCells(number), el('div', 'wn-spot'));
    sheet.dataset.color = OPENING_COLOR;
    sheet.dataset.clip = 'hello';
    return sheet;
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

  function still(src) {
    const img = el('img');
    img.src = src;
    img.alt = '';
    return img;
  }

  // A clip stays a still where nothing moves, and where the WebView has no
  // H.264 (a WebKitGTK without its GStreamer plugin): the poster is always there.
  function mediaPanel(h) {
    const panel = el('div', 'wn-panel wn-panel-media');
    panel.setAttribute('aria-hidden', 'true');
    if (h.mediaType === 'image' || (stillNow() && !h.poster)) { panel.append(still(h.media)); return panel; }
    if (stillNow()) { panel.append(still(h.poster)); return panel; }
    const video = el('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'none';
    video.poster = h.poster;
    video.src = h.media;
    video.addEventListener('error', () => { if (h.poster) video.replaceWith(still(h.poster)); });
    panel.append(video);
    return panel;
  }

  function highlightSheet(h, ctx) {
    const color = h.color || 'lavender';
    const sheet = el('section', `wn-sheet wn-c-${color}`);
    const col = el('div', 'wn-col');
    col.append(el('h2', 'wn-s-title', ctx.text(h.title)), el('p', 'wn-text', ctx.text(h.body)));
    const row = tryRow(h, ctx);
    if (row) col.append(row);
    sheet.append(col, el('div', 'wn-spot'));
    const draw = window.XenonWhatsNewScenes[h.scene];
    if (h.media) sheet.append(mediaPanel(h));
    else if (draw) sheet.append(draw(ctx.tr));
    sheet.dataset.color = color;
    sheet.dataset.clip = h.clip || 'happy';
    return sheet;
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

  // opts: { text, tr, onClose, openUrl, openMenu(section) → 'screen' when the
  // menu took the screen, menuIsOpen() → boolean, canOpenMenu, menuKey,
  // openStore('sparks' | 'supporters'), look: window.LookTrial where the person can try the new
  // look here, or nothing and its sheet is left out, onAside(out) when the sheets step away for it }
  function open(wn, opts) {
    const stage = el('div', 'wn-stage');
    const timers = new Set();
    const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };
    let step = 0;
    let closed = false;

    const ctx = {
      ...opts,
      openMenu: async (section) => {
        if ((await opts.openMenu(section)) === 'screen') stepAside();
      },
      leave: (target) => {
        close();
        if (target === 'maker') opts.openUrl(MAKER_URL);
        else opts.openStore(target);
      },
      tryLook: (key) => opts.look.run({
        tr: opts.tr,
        mountBit,
        stepOut: () => {
          stage.hidden = true;
          pauseClips();
          opts.onAside(true);
        },
        comeBack: (kept) => {
          stage.hidden = false;
          opts.onAside(false);
          key.hidden = kept;
          go(step + 1);
        },
      }),
    };
    const shown = wn.highlights.filter((h) => h.go !== 'look' || opts.look);
    const sheets = [openingSheet(wn, opts.text), ...shown.map((h) => highlightSheet(h, ctx))];
    if (wn.more) sheets.push(closingSheet(wn, ctx));

    const bitHost = el('div', 'wn-bit');
    const stops = sheets.map(() => el('span', 'wn-stop'));
    const stopRow = el('div', 'wn-stops');
    stopRow.setAttribute('aria-hidden', 'true');
    stopRow.append(...stops);
    const back = button('wn-quiet', opts.tr('wn_back'), () => go(step - 1));
    const skip = button('wn-quiet', opts.tr('wn_skip'), close);
    const main = button('wn-go', '', () => (step < sheets.length - 1 ? go(step + 1) : close()));
    const band = el('div', 'wn-band');
    band.append(stopRow, back, skip, main);

    stage.setAttribute('role', 'dialog');
    stage.setAttribute('aria-modal', 'true');
    stage.setAttribute('aria-label', opts.text(wn.title) || `Xenon ${wn.id}`);
    stage.append(...sheets, bitHost, band);
    document.body.append(stage);
    const player = mountBit(bitHost);

    function placeBit() {
      const box = stage.getBoundingClientRect();
      const width = bitHost.offsetWidth;
      const height = bitHost.offsetHeight;
      const walks = getComputedStyle(stage).getPropertyValue('--wn-walk').trim() === '1' && step > 0;
      const spot = sheets[step].querySelector('.wn-spot').getBoundingClientRect();
      const mark = stops[step].getBoundingClientRect();
      const x = walks ? mark.left + mark.width / 2 - width / 2 : spot.left + spot.width / 2 - width / 2;
      const feet = walks ? band.getBoundingClientRect().top + height * 0.044 : spot.bottom;
      bitHost.style.transform = `translate(${Math.round(x - box.left)}px, ${Math.round(feet - height - box.top)}px)`;
    }

    function restBit() {
      if (!player) return;
      player.setMood(REST_ON[sheets[step].dataset.color] || 'idle');
    }

    const clips = () => [...stage.querySelectorAll('video')];
    const pauseClips = () => clips().forEach((video) => video.pause());

    // The sheet in front only, from its start. A panel a short phone hides has
    // no box, so its clip never loads.
    function playClips() {
      pauseClips();
      const video = sheets[step].querySelector('video');
      if (!video || !video.offsetParent) return;
      video.currentTime = 0;
      video.play().catch(() => { /* the poster stays */ });
    }

    function arrive(index) {
      if (!player || closed || index !== step) return;
      player.play(sheets[index].dataset.clip).then(() => { if (!closed && index === step) restBit(); });
    }

    function paint() {
      sheets.forEach((sheet, i) => {
        sheet.classList.toggle('is-shown', i <= step);
        sheet.inert = i !== step;
      });
      stops.forEach((stop, i) => stop.classList.toggle('is-done', i <= step));
      const last = step === sheets.length - 1;
      back.hidden = step === 0;
      skip.hidden = last;
      main.textContent = opts.tr(step === 0 ? 'wn_go_start' : last ? 'wn_go_done' : 'wn_go_next');
      main.className = `wn-go wn-c-${sheets[step].dataset.color}`;
      placeBit();
      playClips();
    }

    function go(next) {
      if (next < 0 || next >= sheets.length || next === step) return;
      step = next;
      paint();
      main.focus();
      if (stillNow() || !player) { arrive(step); return; }
      player.play('hop');
      later(() => arrive(next), WALK_MS);
    }

    // The menu has its own window, and which one is on top is up to the OS: the
    // stage steps out of the way and comes back on the same sheet.
    function stepAside() {
      stage.hidden = true;
      pauseClips();
      const watch = async () => {
        if (closed) return;
        if (await opts.menuIsOpen()) { later(watch, MENU_POLL_MS); return; }
        stage.hidden = false;
        placeBit();
        playClips();
        main.focus();
      };
      later(watch, MENU_POLL_MS);
    }

    function trapTab(e) {
      const live = [...stage.querySelectorAll('button:not([hidden])')].filter((b) => !b.closest('[inert]'));
      if (!live.length) return;
      const first = live[0];
      const last = live[live.length - 1];
      if (document.activeElement === (e.shiftKey ? first : last) || !stage.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }

    function onKey(e) {
      if (stage.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(step + 1);
      else if (e.key === 'ArrowLeft') go(step - 1);
      else if (e.key === 'Tab') trapTab(e);
    }

    // A hidden stage has no box: Bit keeps its place and walks on from it when the stage is back.
    const resize = new ResizeObserver(() => { if (!stage.hidden) placeBit(); });

    function close() {
      if (closed) return;
      closed = true;
      timers.forEach(clearTimeout);
      timers.clear();
      resize.disconnect();
      pauseClips();
      document.removeEventListener('keydown', onKey);
      if (player) player.destroy();
      stage.remove();
      opts.onClose();
    }

    document.addEventListener('keydown', onKey);
    stage.classList.toggle('is-still', stillNow());
    // Bit starts on its spot: only a step between sheets is a walk.
    stage.classList.add('is-placing');
    paint();
    stage.getBoundingClientRect();
    stage.classList.remove('is-placing');
    resize.observe(stage);
    main.focus();
    arrive(0);
    return close;
  }

  window.XenonWhatsNewStage = Object.freeze({ open });
})();

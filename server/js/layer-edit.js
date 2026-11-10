// Edit mode of a layer window, loaded by js/layer-host.js the first time the
// mode is turned on (so a window that is never edited never carries it).
//
// Drag a widget to move it (js/layer-drag.js, the same drag as the menu's map). A tap
// picks it: its name, when it shows, its size and the way off the screen appear beside
// it (js/layer-edit-card.js, loaded with this file). "Done" ends the mode, "Undo" takes
// back one change, "Put it back" everything since the mode began, "Add" lists the
// widgets that can be placed; an attached window's bar puts it back on the desktop; the
// page chips are js/layer-edit-pages.js. Every change is a capability run on the server
// (layerMove, layerGroup, layerRemove, layerPlace, layersEdit, layersUndo, layerPage,
// layerPageEdit, layerAnchor): this page saves nothing itself, and the settings
// broadcast redraws every window from the saved result.
(function () {
  'use strict';

  const BIG_PX = 160;          // under this the corner to grab sits on the box's corner, not in it
  const SMALLEST_PX = 48;      // a box with no size of its own in the stylesheet
  const TINY_PX = 72;          // under this a box is all drag: its size goes by name
  // The box of the performance words: their letters go from 12 to 30 px at 5.5% of it
  // (PerfWidget.css), so they stay readable and nothing is left to pull past these.
  const WORDS_WIDTH = Object.freeze({ min: 218, max: 545 });
  const SNAP_PX = 10;          // a box is pulled onto a line this close
  const CLICK_PX = 4;          // less than this is a tap, not a drag
  const BAR_EDGE_PX = 12;      // the bar's distance from the edge of the screen
  const WORDS_EDGE_PX = 6;     // the frame around words, clear of them
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let api = null;
  let bar = null;
  let sheet = null;          // the list "Add" opens
  let drag = null;
  let pagesScript = null;
  let canAttach = false;     // the shell follows app windows (layerList says)
  let wordsWatch = null;     // follows the words of a tile while editing
  let picked = '';           // the key of the box whose choices are open
  let cardScript = null;
  let chromeWatch = null;    // the window's cut follows what edit mode adds to it
  const names = new Map();   // widget id -> the name the server gives it
  let desks = null;          // { current, count } where the shell says which desktop is shown
  const frames = new WeakMap();   // slot -> frame
  const entryOf = new WeakMap();  // frame -> the box it covers, as last drawn
  const guideLines = { x: null, y: null };

  const tr = (key, fallback) => {
    const text = typeof t === 'function' ? t(key) : '';
    return text && text !== key ? text : fallback;
  };

  // `tag` span inside a tab: a button may not hold another button.
  function cross(className, label, tag = 'button') {
    const btn = document.createElement(tag);
    if (tag === 'button') btn.type = 'button';
    else btn.setAttribute('role', 'button');
    btn.className = className;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M2 2L8 8M8 2L2 8');
    svg.appendChild(path);
    btn.appendChild(svg);
    return btn;
  }

  // Run one edit; a refused one puts the boxes back where the saved state says.
  async function run(action) {
    const res = await api.run(action);
    if (!(res && res.ok)) api.place();
    return res;
  }

  const HINT = () => tr('layer_edit_hint', 'Drag a widget. Tap it for its choices.');

  function ensureBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'layer-edit-bar';
    bar.setAttribute('data-layer-edit-chrome', '');
    const hint = document.createElement('span');
    hint.className = 'layer-edit-hint';
    hint.setAttribute('aria-live', 'polite');
    // An attached window cannot be dragged: its bar only says what failed.
    hint.textContent = api.surface === 'anchor' ? '' : HINT();
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'layer-edit-done';
    done.textContent = tr('layout_exit', 'Done');
    done.addEventListener('click', () => api.run({ type: 'layersEdit', mode: 'off' }));
    // An anchored window IS its widget: nothing to add to it, only to put back.
    if (api.surface !== 'anchor') bar.append(hint, addButton(), stepButton(), undoButton(), done);
    else bar.append(hint, detachButton(), done);
    api.root().appendChild(bar);
  }

  // Pages go on the bar of the desktop and overlay windows, once their script
  // is in (it loads the first time edit mode starts).
  function mountPages() {
    if (!bar || api.surface === 'anchor' || bar.querySelector('.layer-page-strip')) return;
    if (!window.LayerEditPages) {
      if (pagesScript) return;
      pagesScript = document.createElement('script');
      pagesScript.src = 'js/layer-edit-pages.js';
      pagesScript.addEventListener('load', () => { if (api && bar) refresh(); });
      document.head.appendChild(pagesScript);
      return;
    }
    const strip = window.LayerEditPages.mount({ run: (a) => run(a), say, tr, root: () => api.root(), closeOther: closeSheet, desks: () => desks });
    bar.insertBefore(strip, bar.querySelector('.layer-edit-add'));
  }

  // ── "Add": the widgets that can be placed, one tap puts one in the middle
  // of this screen, ready to drag ───────────────────────────────────────────
  function addButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-edit-add';
    btn.textContent = tr('layer_edit_add', 'Add');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => (sheet ? closeSheet() : openSheet(btn)));
    return btn;
  }

  async function stepBack() {
    closeSheet();
    const res = await run({ type: 'layersUndo', mode: 'step' });
    say(res && res.ok ? HINT() : tr('layer_edit_step_none', 'Nothing to undo'));
  }

  function stepButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-edit-undo layer-edit-step';
    btn.textContent = tr('layer_edit_step', 'Undo');
    btn.addEventListener('click', stepBack);
    return btn;
  }

  function undoButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-edit-undo';
    btn.textContent = tr('layer_edit_undo', 'Put it back');
    btn.addEventListener('click', async () => {
      closeSheet();
      const res = await run({ type: 'layersUndo' });
      say(res && res.ok ? HINT() : tr('layer_edit_undo_failed', 'It could not be put back'));
    });
    return btn;
  }

  function say(text) {
    const hint = bar && bar.querySelector('.layer-edit-hint');
    if (hint) hint.textContent = text;
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    const btn = bar && bar.querySelector('.layer-edit-add');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // A widget's picture; one with none, or one that does not load, shows its first
  // letter in the same box, as the menu's list does.
  function pickThumb(label, src) {
    const box = document.createElement('span');
    box.className = 'layer-edit-pick-thumb';
    const initial = () => { box.textContent = [...label][0] || ''; };
    if (!src) { initial(); return box; }
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', initial);
    img.src = src;
    box.appendChild(img);
    return box;
  }

  function pickRow(label, onPick, thumb) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'layer-edit-pick';
    if (thumb) row.appendChild(thumb);
    const name = document.createElement('span');
    name.textContent = label;   // a Store widget's name is untrusted text
    row.appendChild(name);
    row.addEventListener('click', onPick);
    return row;
  }

  async function openSheet(btn) {
    if (window.LayerEditPages) window.LayerEditPages.close();
    const list = await api.run({ type: 'layerList', pictures: 'yes', keys: 'yes' });
    if (!bar || sheet) return;   // edit mode ended, or a second tap, while it loaded
    if (!(list && list.ok)) { say(tr('layer_edit_add_failed', 'It could not be added')); return; }
    const choices = list.choices || {};
    const pictures = list.pictures || {};
    const row = (label, ref) => pickRow(label, () => add(ref), pickThumb(label, pictures[ref]));
    sheet = document.createElement('div');
    sheet.className = 'layer-edit-sheet';
    sheet.setAttribute('data-layer-edit-chrome', '');
    sheet.setAttribute('role', 'menu');
    for (const id of choices.tiles || []) sheet.appendChild(row(tr('layout_widget_' + id, id), id));
    for (const name of choices.widgets || []) sheet.appendChild(row(name, name));
    appendKeys(list.keys || []);
    btn.setAttribute('aria-expanded', 'true');
    api.root().appendChild(sheet);
  }

  function appendKeys(keys) {
    if (!keys.length) return;
    const note = document.createElement('p');
    note.className = 'layer-edit-sheet-note';
    note.textContent = tr('layer_key_add_heading', 'Your Deck keys');
    sheet.appendChild(note);
    for (const key of keys) {
      const label = key.title || tr(key.labelKey, key.id);
      sheet.appendChild(pickRow(label, () => addKey(key), pickThumb(label, key.shot)));
    }
  }

  function sayAddFailed(res) {
    say(res && res.error === 'too_many'
      ? tr('layer_edit_add_full', 'There are 24 widgets already: take one off first')
      : tr('layer_edit_add_failed', 'It could not be added'));
  }

  // The person picked this key from the list: that tap is their agreement.
  async function addKey(key) {
    closeSheet();
    const res = await run({ type: 'layerKey', key: key.id, surface: api.surface, position: 'center', monitor: api.monitor });
    if (!(res && res.ok)) { sayAddFailed(res); return; }
    await window.LayerKey.accept(res.id, res.fp);
    say(HINT());
  }

  async function add(ref) {
    closeSheet();
    const res = await run({
      type: 'layerPlace', widget: ref, position: 'top-right', size: 'medium', monitor: api.monitor, ...window.LayerSee.firstFor(ref),
    });
    if (res && res.ok) { say(HINT()); return; }
    sayAddFailed(res);
  }

  // ── "Attach to an app": the widget becomes a small window that follows one
  // app and hides with it ────────────────────────────────────────────────────
  async function openAttach(widgetId) {
    closeSheet();
    if (window.LayerEditPages) window.LayerEditPages.close();
    const res = await api.run({ type: 'layerAnchor', mode: 'apps' });
    if (!bar || sheet) return;   // edit mode ended, or another sheet opened, while it loaded
    const apps = res && res.ok && Array.isArray(res.apps) ? res.apps : null;
    if (!apps) { say(tr('layer_edit_attach_failed', 'It could not be attached')); return; }
    if (!apps.length) { say(tr('layer_edit_attach_none', 'No open app to attach it to')); return; }
    sheet = document.createElement('div');
    sheet.className = 'layer-edit-sheet';
    sheet.setAttribute('data-layer-edit-chrome', '');
    sheet.setAttribute('role', 'menu');
    // In the sheet, not the bar: the bar cuts it short on a phone-sized window.
    const note = document.createElement('p');
    note.className = 'layer-edit-sheet-note';
    note.textContent = tr('layer_edit_attach_hint', 'Pick the app: the widget follows it and hides when you minimize it');
    sheet.appendChild(note);
    // App names come from the PC's process list: pickRow sets them as text.
    for (const a of apps) sheet.appendChild(pickRow(a.app, () => attach(widgetId, a.app)));
    api.root().appendChild(sheet);
  }

  async function attach(widgetId, app) {
    closeSheet();
    const res = await run({ type: 'layerAnchor', widget: widgetId, app });
    say(res && res.ok ? HINT() : tr('layer_edit_attach_failed', 'It could not be attached'));
  }

  function detachButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-edit-detach';
    btn.textContent = tr('layer_edit_detach', 'Back on the desktop');
    btn.addEventListener('click', async () => {
      const entry = api.boxes()[0];
      if (!entry) return;
      const res = await run({ type: 'layerAnchor', mode: 'off', widget: entry.box.lead.id });
      if (!(res && res.ok)) say(tr('layer_edit_attach_failed', 'It could not be attached'));
    });
    return btn;
  }

  // ── Geometry: px inside the window's root, fractions on the wire ──────────
  function rootBox() {
    return api.root().getBoundingClientRect();
  }

  function boxOf(slot, origin) {
    const r = slot.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  }

  const wordsOf = (slot) => slot.querySelector(':scope > [data-dashboard-widget] [data-layer-fit]');

  // What the person sees of a box: its words when it is only words. Their box may be far
  // bigger (five times, on one line), and only a place on the screen can be measured.
  function seenBox(slot, origin) {
    const words = wordsOf(slot);
    const r = words ? words.getBoundingClientRect() : null;
    if (!r || r.width < 1 || r.height < 1) return boxOf(slot, origin);
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  }

  const smallestOf = (slot) => {
    const style = getComputedStyle(slot);
    return { w: parseFloat(style.getPropertyValue('--layer-min-w')) || SMALLEST_PX, h: parseFloat(style.getPropertyValue('--layer-min-h')) || SMALLEST_PX };
  };

  function showAt(slot, b, origin) {
    slot.style.setProperty('--layer-x', (b.x / origin.width * 100) + '%');
    slot.style.setProperty('--layer-y', (b.y / origin.height * 100) + '%');
    slot.style.setProperty('--layer-w', (b.w / origin.width * 100) + '%');
    slot.style.setProperty('--layer-h', (b.h / origin.height * 100) + '%');
    slot.style.setProperty('--layer-wn', String(b.w / origin.width));
    const share = window.LayersModel.shareOf({ x: b.x / origin.width, y: b.y / origin.height, w: b.w / origin.width, h: b.h / origin.height });
    slot.style.setProperty('--layer-px', String(share.x));
    slot.style.setProperty('--layer-py', String(share.y));
  }

  const fractionOf = (v, of) => Math.round(v / of * 10000) / 10000;

  function rectOf(b, origin) {
    return { x: fractionOf(b.x, origin.width), y: fractionOf(b.y, origin.height), w: fractionOf(b.w, origin.width), h: fractionOf(b.h, origin.height) };
  }

  function fractions(b, origin) {
    const r = rectOf(b, origin);
    return [r.x, r.y, r.w, r.h].join(',');
  }

  // A line the box sits on, across the screen, for as long as it does.
  function showGuide(axis, at, origin) {
    let line = guideLines[axis];
    if (at === null) {
      if (line) line.remove();
      guideLines[axis] = null;
      return;
    }
    if (!line) {
      line = document.createElement('div');
      line.className = 'layer-edit-guide layer-edit-guide--' + axis;
      guideLines[axis] = line;
      api.root().appendChild(line);
    }
    line.style.setProperty('--layer-edit-at', (at / (axis === 'x' ? origin.width : origin.height) * 100) + '%');
  }

  function hideGuides() {
    showGuide('x', null);
    showGuide('y', null);
  }

  // ── Dragging ──────────────────────────────────────────────────────────────
  function begin(e, entry, mode) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const origin = rootBox();
    const area = { w: origin.width, h: origin.height };
    const others = api.boxes().filter((b) => b.slot !== entry.slot).map((b) => seenBox(b.slot, origin));
    const { rect } = entry.box.lead;
    drag = {
      entry, mode, origin, area, seen: seenBox(entry.slot, origin), size: { w: rect.w * area.w, h: rect.h * area.h }, words: !!wordsOf(entry.slot),
      px: e.clientX, py: e.clientY, moved: false, frame: frames.get(entry.slot), lines: window.LayerDrag.linesFor(area, others),
    };
    if (drag.frame.setPointerCapture) drag.frame.setPointerCapture(e.pointerId);
    drag.frame.classList.add('is-dragging');
  }

  // A move writes the saved size back, never the drawn one: a box is drawn bigger than it
  // is saved (the words on one line, the smallest a tile can draw), and saving that grew
  // the widget with every drag.
  function moved(d, dx, dy) {
    if (!d.words) return window.LayerDrag.move({ ...d.seen, ...d.size }, dx, dy, d.area, d.lines, SNAP_PX);
    const step = window.LayerDrag.move(d.seen, dx, dy, d.area, d.lines, SNAP_PX);
    return { box: window.LayerDrag.holdWords(step.box, d.size, d.area), guides: step.guides };
  }

  function stretched(d, dx, dy) {
    if (d.words) return { box: window.LayerDrag.scaleWords(d.seen, d.size, dx, d.area, WORDS_WIDTH), guides: { x: null, y: null } };
    return window.LayerDrag.stretch(d.seen, dx, dy, d.area, d.lines, SNAP_PX, smallestOf(d.entry.slot));
  }

  function moveTo(e) {
    if (!drag) return;
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < CLICK_PX) return;
      drag.moved = true;
      api.wholeWindow(true);
      if (window.LayerEditCard) window.LayerEditCard.hide();
    }
    const step = drag.mode === 'move' ? moved(drag, dx, dy) : stretched(drag, dx, dy);
    drag.box = step.box;
    showAt(drag.entry.slot, step.box, drag.origin);
    // Words lean on the side they are on: seen now, not after the drop.
    api.lean(drag.entry.slot, rectOf(step.box, drag.origin));
    if (drag.words) hugWords(drag.entry.slot, drag.frame);
    showGuide('x', step.guides.x, drag.origin);
    showGuide('y', step.guides.y, drag.origin);
  }

  function end(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.frame.classList.remove('is-dragging');
    hideGuides();
    if (!d.moved) {
      if (e.type === 'pointerup') pick(d.entry);
      return;
    }
    api.wholeWindow(false);
    placeBar();
    if (d.box) run({ type: 'layerMove', target: d.entry.box.lead.id, position: 'keep', size: 'keep', rect: fractions(d.box, d.origin) });
  }

  // ── The choices of one widget (js/layer-edit-card.js) ─────────────────────
  function nameOf(w) {
    const known = names.get(w.id) || w.pkg || w.widget || '';
    return w.kind === 'sdk' ? known : tr('layout_widget_' + w.widget, known);
  }

  // "In game", "With the music", "On Spotify": what the tag on a frame says.
  function tagOf(w) {
    const say = window.LayerSee.labelOf(w);
    if (say.text) return say.text;
    const words = tr(say.key, say.key);
    return Object.entries(say.vars || {}).reduce((text, [name, value]) => text.replace('{' + name + '}', value), words);
  }

  function otherBoxes(entry) {
    return api.boxes().filter((b) => b.slot !== entry.slot);
  }

  const cardContext = () => ({
    api, run, tr, nameOf, tagOf, others: otherBoxes, canAttach: () => canAttach, attach: openAttach, closeSheet,
    entry: () => api.boxes().find((b) => b.key === picked) || null,
    closed: () => { picked = ''; refresh(); },
  });

  function pick(entry) {
    closeSheet();
    picked = picked === entry.key ? '' : entry.key;
    refresh();
  }

  function drawCard() {
    if (!window.LayerEditCard) {
      if (cardScript) return;
      cardScript = document.createElement('script');
      cardScript.src = 'js/layer-edit-card.js';
      cardScript.addEventListener('load', () => { if (api && bar) refresh(); });
      document.head.appendChild(cardScript);
      return;
    }
    window.LayerEditCard.draw(cardContext());
  }

  // The bar never sits on a widget: the first place on the screen that is free.
  function placeBar() {
    if (!bar || api.surface === 'anchor') return;
    const origin = rootBox();
    const size = bar.getBoundingClientRect();
    const boxes = api.boxes().map((e) => seenBox(e.slot, origin));
    bar.dataset.spot = window.LayerDrag.freeSpot({ w: origin.width, h: origin.height }, { w: size.width, h: size.height }, boxes, BAR_EDGE_PX);
    api.refreshRects();
  }

  // ── Frames over the boxes ─────────────────────────────────────────────────
  function frameFor(entry) {
    let frame = frames.get(entry.slot);
    if (!frame) {
      frame = document.createElement('div');
      frame.className = 'layer-edit-frame';
      frame.tabIndex = 0;
      frame.setAttribute('role', 'button');
      const tag = document.createElement('span');
      tag.className = 'layer-edit-tag';
      tag.setAttribute('data-layer-edit-chrome', '');
      const grip = document.createElement('span');
      grip.className = 'layer-edit-resize';
      grip.setAttribute('aria-hidden', 'true');
      // On a small box it sits on the corner, half outside: it has to be inside the cut.
      grip.setAttribute('data-layer-edit-chrome', '');
      frame.append(tag, grip);
      frames.set(entry.slot, frame);
      wire(frame);
    }
    const words = hugWords(entry.slot, frame);
    const [wide, tall] = words || [entry.slot.offsetWidth, entry.slot.offsetHeight];
    frame.classList.toggle('is-small', !!words || wide < BIG_PX || tall < BIG_PX);
    frame.classList.toggle('is-words', !!words);
    frame.classList.toggle('is-tiny', !words && (wide < TINY_PX || tall < TINY_PX));
    frame.classList.toggle('is-picked', picked === entry.key);
    const tag = tagOf(entry.box.lead);
    frame.querySelector('.layer-edit-tag').textContent = tag;
    frame.setAttribute('aria-label', nameOf(entry.box.lead) + ', ' + tag);
    // The entry changes with every redraw; the handlers read the current one.
    entryOf.set(frame, entry);
    return frame;
  }

  // Words in a bigger box (the game HUD): the frame shows what is on the screen,
  // not the box around it. Returns the frame's size, or null for a whole box.
  function hugWords(slot, frame) {
    const words = wordsOf(slot);
    const s = slot.getBoundingClientRect();
    const r = words ? words.getBoundingClientRect() : null;
    const on = !!r && r.width >= 1 && r.height >= 1;
    if (words) watchWords(words);
    // Past the box too: the same room on every side, or the words sit off centre in it.
    const gap = (side, value) => frame.style.setProperty('--layer-edit-' + side, on ? (value - WORDS_EDGE_PX) + 'px' : '0px');
    gap('left', on ? r.left - s.left : 0);
    gap('right', on ? s.right - r.right : 0);
    gap('bottom', on ? s.bottom - r.bottom : 0);
    if (on) gap('top', r.top - s.top);
    return on ? [r.width + 2 * WORDS_EDGE_PX, r.height + 2 * WORDS_EDGE_PX] : null;
  }

  // The words grow as their numbers arrive, with no redraw to move the frame.
  function watchWords(node) {
    if (!wordsWatch) {
      wordsWatch = new ResizeObserver(() => {
        if (!api) return;
        for (const entry of api.boxes()) {
          const frame = frames.get(entry.slot);
          if (frame) hugWords(entry.slot, frame);
        }
      });
    }
    wordsWatch.observe(node);
  }

  function wire(frame) {
    frame.addEventListener('pointerdown', (e) => {
      const resize = !!(e.target.closest && e.target.closest('.layer-edit-resize'));
      begin(e, entryOf.get(frame), resize ? 'resize' : 'move');
    });
    frame.addEventListener('pointermove', moveTo);
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);
    frame.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      pick(entryOf.get(frame));
    });
  }

  // A grouped box keeps its tab bar usable: the frame starts under it, and
  // each tab gets a small cross that takes it out of the box.
  function decorateTabs(entry, frame) {
    const tile = entry.slot.querySelector('.layer-tabs');
    const tabs = tile ? tile.querySelector('.tabgroup-bar') : null;
    frame.style.setProperty('--layer-edit-top', tabs ? (tabs.offsetTop + tabs.offsetHeight) + 'px' : '0px');
    if (!tabs) return;
    for (const tab of Array.from(tabs.children)) {
      if (tab.querySelector('.layer-edit-untab')) continue;
      const out = cross('layer-edit-untab', tr('layer_edit_untab', 'Take out of the tabs'), 'span');
      out.addEventListener('click', (e) => {
        e.stopPropagation();
        run({ type: 'layerGroup', widget: tab.dataset.member, mode: 'leave' });
      });
      tab.appendChild(out);
    }
  }

  function refresh() {
    if (!api) return;
    ensureBar();
    // An anchored window IS its widget: it follows its app, nothing to drag.
    if (api.surface === 'anchor') return;
    mountPages();
    if (window.LayerEditPages) window.LayerEditPages.refresh();
    for (const entry of api.boxes()) {
      const frame = frameFor(entry);
      if (frame.parentNode !== entry.slot) entry.slot.appendChild(frame);
      decorateTabs(entry, frame);
      hugWords(entry.slot, frame);
    }
    if (picked && !api.boxes().some((e) => e.key === picked)) picked = '';
    if (picked) drawCard();
    else if (window.LayerEditCard) window.LayerEditCard.hide();
    placeBar();
  }

  function onKey(e) {
    if (e.key === 'Escape' && picked) { picked = ''; refresh(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 'z') {
      e.preventDefault();
      stepBack();
    }
  }

  // Whatever edit mode adds to the window has to be inside its cut to be seen.
  function watchChrome() {
    if (typeof MutationObserver !== 'function') return;
    chromeWatch = new MutationObserver(() => { if (api) api.refreshRects(); });
    chromeWatch.observe(api.root(), { childList: true });
  }

  function start(hostApi) {
    api = hostApi;
    document.documentElement.dataset.layerEditing = 'true';
    refresh();
    document.addEventListener('keydown', onKey);
    if (api.surface === 'anchor') return;
    watchChrome();
    learnAttach();
  }

  // What the server knows and this page does not: whether the shell can follow an app,
  // the desktops, and the names of the Store widgets.
  async function learnAttach() {
    const list = await api.run({ type: 'layerList' });
    if (!api || !bar || !(list && list.ok)) return;
    canAttach = list.attach === true;
    desks = list.desks || null;
    for (const w of list.placed || []) names.set(w.id, w.widget);
    refresh();
  }

  function stop() {
    if (wordsWatch) wordsWatch.disconnect();
    wordsWatch = null;
    if (chromeWatch) chromeWatch.disconnect();
    chromeWatch = null;
    document.removeEventListener('keydown', onKey);
    if (drag && api) api.wholeWindow(false);
    drag = null;
    picked = '';
    hideGuides();
    closeSheet();
    if (window.LayerEditCard) window.LayerEditCard.hide();
    if (window.LayerEditPages) window.LayerEditPages.unmount();
    delete document.documentElement.dataset.layerEditing;
    if (bar) { bar.remove(); bar = null; }
    if (!api) return;
    for (const entry of api.boxes()) {
      const frame = frames.get(entry.slot);
      if (frame) frame.remove();
      frames.delete(entry.slot);
      for (const out of Array.from(entry.slot.querySelectorAll('.layer-edit-untab'))) out.remove();
    }
  }

  window.LayerEdit = Object.freeze({ start, stop, refresh });
})();

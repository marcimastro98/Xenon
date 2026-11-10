// Widget pages in the edit bar, loaded by js/layer-edit.js. One chip per page:
// a tap shows that page, a tap on the page shown opens what can be done with
// it ("When I play", the virtual desktop that brings it up, rename from a list,
// delete). "+" makes a new page and
// shows it. Every change is a capability (layerPage, layerPageEdit) run on the
// server; the chips redraw from the saved settings like the widgets do.
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // A small gamepad: the page a game brings up.
  const PAD_PATHS = ['M7 8h10a4 4 0 0 1 4 4v1.5a2.5 2.5 0 0 1-4.4 1.6L15 13H9l-1.6 2.1A2.5 2.5 0 0 1 3 13.5V12a4 4 0 0 1 4-4z', 'M8 10v3M6.5 11.5h3', 'M15.5 11h.01M17 12.5h.01'];

  let ctx = null;        // { run, say, tr, closeOther, root, desks }
  let strip = null;
  let sheet = null;
  let drawn = '';
  let armedDelete = '';  // the page id whose delete asks a second tap

  const tr = (key, fallback) => (ctx ? ctx.tr(key, fallback) : fallback);
  const current = () => window.LayersModel.normalize(typeof hubSettings === 'object' && hubSettings ? hubSettings.layers : null);
  const labelOf = (cur, p) => p.name || tr('layer_page_n', 'Page {n}').replace('{n}', String(cur.pages.indexOf(p) + 1));
  const onDesk = (n) => tr('layer_page_desktop_on', 'On desktop {n}').replace('{n}', String(n));
  // The desktop numbers to offer: those the shell counted, one more for a desktop
  // about to be made, 4 before it has said; never fewer than the page's own. Max 9.
  const DESKS_UNKNOWN = 4;
  const DESKS_MAX = 9;
  function deskChoices(desks, tied) {
    const count = desks && desks.count > 0 ? desks.count + 1 : DESKS_UNKNOWN;
    return Math.min(DESKS_MAX, Math.max(count, tied || 0));
  }

  function pad() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'layer-page-pad');
    for (const d of PAD_PATHS) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  async function run(action) {
    const res = await ctx.run(action);
    if (!(res && res.ok)) {
      ctx.say(res && res.error === 'too_many_pages'
        ? tr('layer_page_full', 'There are 8 pages already')
        : tr('layer_page_failed', 'The page could not be changed'));
    }
    return res;
  }

  function button(className, text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    if (text) btn.textContent = text;   // a page name is the user's own text
    return btn;
  }

  function chip(cur, p) {
    const active = p.id === cur.page;
    const btn = button('layer-page-chip', '');
    btn.setAttribute('aria-pressed', String(active));
    if (p.gaming) btn.appendChild(pad());
    const name = document.createElement('span');
    name.textContent = labelOf(cur, p);
    btn.appendChild(name);
    if (p.gaming) btn.title = tr('layer_page_gaming', 'When I play');
    else if (p.desktop) btn.title = onDesk(p.desktop);
    if (active) btn.setAttribute('aria-expanded', String(!!sheet));
    btn.addEventListener('click', () => (active ? toggleSheet() : run({ type: 'layerPage', page: p.id })));
    return btn;
  }

  function addChip(cur) {
    const first = !cur.pages.length;
    const btn = button('layer-page-new' + (first ? '' : ' is-icon'), first ? tr('layer_page_add', 'New page') : '+');
    if (!first) { btn.setAttribute('aria-label', tr('layer_page_add', 'New page')); btn.title = tr('layer_page_add', 'New page'); }
    btn.addEventListener('click', () => {
      closeSheet();
      if (cur.pages.length >= window.LayersModel.MAX_PAGES) { ctx.say(tr('layer_page_full', 'There are 8 pages already')); return; }
      run({ type: 'layerPageEdit', mode: 'create' });
    });
    return btn;
  }

  function draw(force) {
    if (!strip) return;
    const cur = current();
    const key = JSON.stringify([cur.page, cur.pages, cur.widgets.map((w) => w.page)]);
    if (!force && key === drawn) return;
    drawn = key;
    strip.replaceChildren(...cur.pages.map((p) => chip(cur, p)), addChip(cur));
    // A strip wider than the bar scrolls: keep the page shown in view.
    const on = strip.querySelector('[aria-pressed="true"]');
    if (on && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, on.offsetLeft - strip.offsetLeft - 8);
    const shown = cur.pages.find((p) => p.id === cur.page);
    if (sheet && (!shown || sheet.dataset.page !== shown.id)) closeSheet();
    else if (sheet && sheet.dataset.view === 'main') fillMain(cur, shown);
  }

  // ── What the page shown can do ─────────────────────────────────────────────
  function row(text, onClick, extra) {
    const btn = button('layer-edit-pick' + (extra ? ' ' + extra : ''), '');
    const span = document.createElement('span');
    span.textContent = text;
    btn.appendChild(span);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function fillMain(cur, p) {
    sheet.dataset.view = 'main';
    const gaming = row(tr('layer_page_gaming', 'When I play'), () => run({ type: 'layerPageEdit', mode: p.gaming ? 'notGaming' : 'gaming', page: p.id }), 'layer-page-toggle');
    gaming.setAttribute('role', 'menuitemcheckbox');
    gaming.setAttribute('aria-checked', String(!!p.gaming));
    gaming.prepend(pad());
    const count = cur.widgets.filter((w) => w.page === p.id).length;
    const armed = armedDelete === p.id && count > 0;
    const del = row(armed
      ? tr('layer_page_delete_confirm', 'Delete it and its {n} widgets').replace('{n}', String(count))
      : tr('layer_page_delete', 'Delete page'), () => {
      if (count > 0 && armedDelete !== p.id) { armedDelete = p.id; fillMain(current(), p); return; }
      armedDelete = '';
      closeSheet();
      run({ type: 'layerPageEdit', mode: 'delete', page: p.id });
    }, 'is-danger');
    const desks = ctx.desks ? ctx.desks() : null;
    const desk = desks
      ? [row(p.desktop ? onDesk(p.desktop) : tr('layer_page_desktop', 'Show on a desktop'), () => fillDesks(current(), p))]
      : [];
    sheet.replaceChildren(gaming, ...desk, row(tr('layer_page_rename', 'Rename'), () => fillNames(current(), p)), del);
  }

  // The virtual desktop that brings this page up: one page per desktop, and
  // "Every desktop" unties it (the page then shows wherever it is picked).
  function fillDesks(cur, p) {
    sheet.dataset.view = 'desks';
    armedDelete = '';
    const note = document.createElement('p');
    note.className = 'layer-edit-sheet-note';
    note.textContent = tr('layer_page_desktop_hint', 'The page appears by itself when you switch to that virtual desktop');
    const pick = (n, text) => {
      const btn = row(text, () => {
        closeSheet();
        if (n !== (p.desktop || 0)) run({ type: 'layerPageEdit', mode: 'desktop', page: p.id, desktop: String(n) });
      }, 'layer-page-toggle');
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', String(n === (p.desktop || 0)));
      return btn;
    };
    const rows = [pick(0, tr('layer_page_desktop_any', 'Every desktop'))];
    const max = deskChoices(ctx.desks ? ctx.desks() : null, p.desktop);
    for (let n = 1; n <= max; n++) rows.push(pick(n, tr('layer_page_desktop_n', 'Desktop {n}').replace('{n}', String(n))));
    sheet.replaceChildren(note, ...rows);
  }

  // Names to pick from: a layer window never takes the keyboard.
  function fillNames(cur, p) {
    sheet.dataset.view = 'names';
    armedDelete = '';
    const taken = new Set(cur.pages.filter((x) => x !== p).map((x) => x.name.toLowerCase()));
    const names = tr('layer_page_suggest', 'Work, Games, Study, Relax, Home, Music, Evening')
      .split(',').map((s) => s.trim()).filter((s) => s && !taken.has(s.toLowerCase()));
    sheet.replaceChildren(...names.map((name) => row(name, () => {
      closeSheet();
      run({ type: 'layerPageEdit', mode: 'rename', page: p.id, name });
    })));
  }

  function toggleSheet() {
    if (sheet) { closeSheet(); return; }
    const cur = current();
    const p = cur.pages.find((x) => x.id === cur.page);
    if (!p) return;
    ctx.closeOther();
    sheet = document.createElement('div');
    sheet.className = 'layer-edit-sheet layer-page-sheet';
    sheet.setAttribute('role', 'menu');
    sheet.dataset.page = p.id;
    fillMain(cur, p);
    ctx.root().appendChild(sheet);
    draw(true);
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    armedDelete = '';
    const open = strip && strip.querySelector('[aria-expanded="true"]');
    if (open) open.setAttribute('aria-expanded', 'false');
  }

  function mount(hostCtx) {
    ctx = hostCtx;
    strip = document.createElement('div');
    strip.className = 'layer-page-strip';
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', tr('layer_page_strip', 'Widget pages'));
    drawn = '';
    draw(true);
    return strip;
  }

  function unmount() {
    closeSheet();
    if (strip) strip.remove();
    strip = null;
    ctx = null;
    drawn = '';
  }

  window.LayerEditPages = Object.freeze({ mount, unmount, refresh: () => draw(false), close: closeSheet });
})();

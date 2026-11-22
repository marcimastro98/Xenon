'use strict';

// The Screens page of the Xenon menu, its home (row from server/menu/menu-screens.js), laid
// out like a widget's screen: the real screens where they stand on the desk on one side,
// each saying what it shows, the one tapped plays its scene, and its tabs sit beside it:
// what it shows, its widgets (js/menu/xenon-menu-widgets.js draws that list) and its
// background. A scene list is one answer per line, and passing over a line plays that scene
// in the screen's picture. Which screen and tab are open is this page's own; a tap redraws
// only this block. Under the desk, the pump screens (js/menu/xenon-menu-pumps.js, their rows
// js/menu/xenon-menu-pump-rows.js), the phones and tablets paired with this PC, and a card to pair one.
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./xenon-menu-map.js') : root.XenonMenuMap, node ? require('./xenon-menu-pumps.js') : root.XenonMenuPumps,
    node ? require('./xenon-menu-pump-rows.js') : root.XenonMenuPumpRows);
  if (node) module.exports = api;
  if (root) root.XenonMenuScreens = api;
})(typeof window !== 'undefined' ? window : globalThis, function (MenuMap, Pumps, PumpRows) {
  // The one shown: the screen (or pump) tapped before if it is still there, else the first.
  const pickedOf = (screens, key) => screens.find((m) => m.key === key) || screens[0] || null;
  const tabOf = (view, id) => (view.tabs || []).find((t) => t.id === id) || (view.tabs || [])[0] || null;
  // Pairing and the list of paired devices are on Settings → Phone.
  const PAIR = Object.freeze({ id: 'pair', act: Object.freeze({ open: 'settings:phone' }) });
  // The paired list changes only when someone pairs or removes one: read again at most this often.
  const PHONES_STALE_MS = 30 * 1000;

  // A phone paired again keeps its old record until it is removed on Telefono: a record
  // last used when another of the same name was paired is that same phone, not a second one.
  const when = (n) => (Number.isFinite(n) ? n : 0);
  const current = (list) => list.filter((d) => !list.some((o) => o !== d && o.name === d.name && o.createdAt >= d.lastSeenAt));

  // The home row as a place shows it (js/xenon-menu.js sectionsFor): `keep` drops what that
  // place cannot run, and a tab left with nothing there (the dashboard's tiles, seen from
  // the dashboard) is not drawn.
  function inPlace(row, keep) {
    const tabs = (v) => ({ ...v, tabs: (v.tabs || []).map((t) => (t.rows ? { ...t, rows: keep(t.rows) } : t)).filter((t) => t.widgets || !t.rows || t.rows.length) });
    const parts = Object.fromEntries(Object.entries(row.parts || {}).map(([id, rows]) => [id, keep(rows)]));
    return { ...row, screens: (row.screens || []).map(tabs), pumps: (row.pumps || []).map(tabs), parts, tune: keep(row.tune) };
  }

  // The phones and tablets paired with this PC, or null. The list is the PC's own: a
  // paired device is refused it (remote-access.js), and then the page shows none.
  async function pairedOn(server) {
    try {
      const res = await fetch(server + '/api/remote-access/status', { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.devices)) return null;
      return current(data.devices.filter((d) => d && typeof d.id === 'string')
        .map((d) => ({ id: d.id.slice(0, 64), name: typeof d.name === 'string' ? d.name.slice(0, 60) : '', createdAt: when(d.createdAt), lastSeenAt: when(d.lastSeenAt) })))
        .map(({ id, name }) => ({ id, name }));
    } catch (e) {
      return null;
    }
  }

  // ctx: { el, button, say, tt, DRAW, perform, icon, rowShell, widgetTab, server, doc, move, slot, hold, settle }
  //   widgetTab(view, row) → the nodes of that screen's Widgets tab
  //   server: the engine's origin ('' on the dashboard's own page); without it, no phones
  // → { draw, hold, settle }: the moving previews (scene, pump) wait out a rebuild of the menu.
  function create(ctx) {
    const { el, button, say, DRAW, perform, icon } = ctx;
    const host = typeof location !== 'undefined' ? location.hostname : '';
    const pumps = Pumps ? Pumps.create({ el, button, say, icon, server: ctx.server, doc: ctx.doc, move: ctx.move, host, perform: ctx.perform }) : null;
    const hold = () => { if (ctx.hold) ctx.hold(); if (pumps) pumps.hold(); };
    const settle = () => { if (ctx.settle) ctx.settle(); if (pumps) pumps.settle(); };
    if (Pumps && PumpRows) {
      const upload = (file) => Pumps.upload(ctx.server || '', file);
      Object.assign(DRAW, PumpRows.create({ el, button, say, perform, icon, DRAW, upload, types: Pumps.PICTURE_TYPES, tryFace: pumps.tryFace }).draw);
    }
    let picked = '';
    const chosenTab = new Map();   // screen key -> the tab left open
    let moreOpen = false;
    let phoneList = null;
    let phonesReadAt = 0;
    let shown = null;              // { box, r } painted last, for the list when it arrives

    function says(line) {
      const row = el('span', 'xm-scrsays');
      row.append(el('span', 'xm-scrsays-label', say(line.label)), el('span', 'xm-scrsays-value', say(line.value)));
      return row;
    }

    // A screen where it stands on the desk (--xm-s*, from js/menu/xenon-menu-map.js): the
    // button keeps a gutter around its face, so screens that touch on the desk stay apart.
    function screenNode(m, on, pick, live) {
      const b = button('xm-scrmon xm-scrpick');
      for (const n of ['left', 'top', 'width', 'height']) b.style.setProperty('--xm-s' + n, m[n] + '%');
      b.setAttribute('aria-pressed', String(on));
      b.dataset.keep = 'screen:' + m.key;
      const face = el('span', 'xm-scrface');
      if (on && live) face.appendChild(live);
      const words = el('span', 'xm-scrwords');
      words.append(el('span', 'xm-scrname', say(m.label)), ...(m.says || []).map(says));
      if (m.chip) words.appendChild(el('span', 'xm-scrchip' + (m.dashboard ? ' is-dashboard' : ''), say(m.chip)));
      face.appendChild(words);
      b.appendChild(face);
      b.addEventListener('click', () => pick(m.key));
      return b;
    }

    // A phone shows the dashboard; a tap, like the last card, leads to pairing. Phones are
    // not on the desk, so they sit under it, each drawn as a small phone.
    function phoneCard(name, chip, keep, add) {
      const b = button('xm-scrphone' + (add ? ' is-add' : ''));
      b.dataset.keep = keep;
      const shape = el('span', 'xm-scrphone-shape');
      if (add) shape.append(icon('plus') || '');
      const words = el('span', 'xm-scrwords');
      words.appendChild(el('span', 'xm-scrname', name));
      if (chip) words.appendChild(el('span', 'xm-scrchip is-dashboard', chip));
      b.append(shape, words);
      b.addEventListener('click', () => perform(PAIR, PAIR.act));
      return b;
    }

    function phonesNode() {
      if (!phoneList) return null;
      const box = el('div', 'xm-scrphones');
      const chip = ctx.tt('xmenu_scr_dashboard');
      box.append(...phoneList.map((p) => phoneCard(p.name || ctx.tt('settings_cat_phone'), chip, 'phone:' + p.id, false)),
        phoneCard(ctx.tt('xmenu_scr_add_phone'), '', 'phone:add', true));
      return box;
    }

    function readPhones() {
      if (typeof ctx.server !== 'string' || Date.now() - phonesReadAt < PHONES_STALE_MS) return;
      phonesReadAt = Date.now();
      pairedOn(ctx.server).then((list) => {
        const next = Array.isArray(list) ? list : null;
        if (JSON.stringify(next) === JSON.stringify(phoneList)) return;
        phoneList = next;
        if (shown) paint(shown.box, shown.r);
      }, () => {});
    }

    function moreItem(more, redraw) {
      const box = el('div', 'xm-scenemore');
      const b = button('xm-sceneopt xm-sceneopt--more');
      b.setAttribute('aria-expanded', String(moreOpen));
      b.dataset.keep = 'scenes:more';
      const words = el('span', 'xm-sceneopt-words');
      words.append(el('span', 'xm-sceneopt-name', say(more.label)), el('span', 'xm-sub', say(more.sub)));
      b.append(icon('plus') || '', words);
      b.addEventListener('click', () => { moreOpen = !moreOpen; redraw(); });
      box.appendChild(b);
      if (moreOpen && DRAW.button) box.appendChild(DRAW.button(more));
      return box;
    }

    // One scene per line, with a tick on the one in use.
    function sceneList(r, live, more, redraw) {
      const li = ctx.rowShell(r, 'xm-row--stack xm-scenes');
      const list = el('div', 'xm-scenelist');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', say(r.label));
      for (const o of r.options || []) {
        const on = String(o.value) === String(r.value);
        const b = button('xm-sceneopt');
        b.setAttribute('aria-pressed', String(on));
        b.dataset.keep = `${r.id}:${o.value}`;
        b.append(el('span', 'xm-sceneopt-name', say(o.label)), el('span', 'xm-sceneopt-tick'));
        b.addEventListener('click', () => { if (!on) perform(r, o.act); });
        if (live) live.follow(b, o.value);
        list.appendChild(b);
      }
      if (more) list.appendChild(moreItem(more, redraw));
      li.appendChild(list);
      return li;
    }

    // A lone tab is not drawn: it would read as a button that does nothing.
    function tabBar(view, current, choose) {
      if (view.tabs.length < 2) return null;
      const bar = el('div', 'xm-wtabs xm-scrtabs');
      bar.setAttribute('role', 'tablist');
      bar.append(...view.tabs.map((t) => {
        const b = button('xm-wtab');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(t.id === current.id));
        b.dataset.keep = `screen:${view.key}:${t.id}`;
        b.append(el('span', 'xm-wtab-name', say(t.label)), el('span', 'xm-wtab-value', say(t.value)));
        b.addEventListener('click', () => choose(t.id));
        return b;
      }));
      return bar;
    }

    // The tab's rows; a scene list carries the screen's moving preview (`live`).
    function panelOf(tab, r, redraw, view) {
      let live = null;
      if (tab?.widgets) {
        const box = el('div', 'xm-wpanel xm-scrrows xm-scrwidgets');
        box.setAttribute('role', 'tabpanel');
        for (const x of tab.rows || []) if (DRAW[x.kind]) box.appendChild(DRAW[x.kind](x));
        if (ctx.widgetTab) box.append(...ctx.widgetTab(view, r));
        return { panel: box, live };
      }
      const panel = el('div', 'xm-list xm-wpanel xm-scrrows');
      panel.setAttribute('role', 'tabpanel');
      for (const x of tab ? tab.rows : []) {
        if (x.scenes) {
          if (x.live && !live && ctx.slot) live = ctx.slot(x.value);
          panel.appendChild(sceneList(x, live, r.more, redraw));
        } else if (DRAW[x.kind]) panel.appendChild(DRAW[x.kind](x));
      }
      return { panel, live };
    }

    function paint(box, r) {
      const view = pickedOf([...(r.screens || []), ...(r.pumps || [])], picked);
      const redraw = (focus) => {
        hold();
        paint(box, r);
        settle();
        const again = focus && box.querySelector(`[data-keep="${CSS.escape(focus)}"]`);
        if (again) again.focus();
      };
      const pick = (key) => {
        if (key === picked) return;
        picked = key;
        moreOpen = false;
        redraw('screen:' + key);
      };
      const tab = view ? tabOf(view, chosenTab.get(view.key)) : null;
      const { panel, live } = panelOf(tab, r, () => redraw('scenes:more'), view);
      const shape = MenuMap.layout(r.screens || []);
      const map = el('div', 'xm-scrmap');
      map.style.setProperty('--xm-ratio', String(shape.ratio));
      map.append(...shape.screens.map((m) => screenNode(m, !!view && m.key === view.key, pick, live?.box)));
      const desk = el('div', 'xm-scrdesk');
      desk.appendChild(map);
      const pic = el('div', 'xm-detail-pic');
      pic.append(...[el('p', 'xm-cap xm-scrcap', say(r.sub)), desk, pumps?.cards(r.pumps, view?.key, pick), phonesNode()].filter(Boolean));
      const choices = el('div', 'xm-detail-choices');
      if (view) {
        const choose = (id) => { chosenTab.set(view.key, id); moreOpen = false; redraw(`screen:${view.key}:${id}`); };
        choices.append(...[el('h3', 'xm-scrtitle', say(view.label)), pumps?.slot(view), tabBar(view, tab, choose), panel].filter(Boolean));
      }
      const grid = el('div', 'xm-detail');
      grid.append(pic, choices);
      const parts = [grid];
      if (r.theme && DRAW.button) {
        const theme = el('div', 'xm-list xm-scrtheme');
        theme.appendChild(DRAW.button(r.theme));
        parts.push(theme);
      }
      box.replaceChildren(...parts);
      shown = { box, r };
    }

    function draw(r) {
      const li = el('div', 'xm-row xm-row--stack xm-scrrow');
      li.dataset.row = r.id;
      const box = el('div', 'xm-detailbox xm-scrbox');
      li.appendChild(box);
      paint(box, r);
      readPhones();
      return li;
    }

    return { draw, hold, settle };
  }

  return { create, pickedOf, tabOf, inPlace };
});

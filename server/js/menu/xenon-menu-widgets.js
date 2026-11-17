'use strict';

// The widgets of the Xenon menu, in two levels: on the Screens page the list of one
// screen's widgets on one page, split by when each is seen (its Widgets tab, drawn by
// js/menu/xenon-menu-screens.js), and from it one screen for a widget, for a page, or for
// adding one to that screen. The rows, their acts and their words all come from the
// server (server/menu/menu-widgets.js, carried by the home row of server/menu/menu-screens.js);
// this file only lays them out.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuWidgets = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const LIST = Object.freeze({ name: 'list' });
  const GROUP_WORDS = Object.freeze({ always: 'see_always', game: 'see_game', app: 'see_apps', desktop: 'see_desktop', other: 'see_other' });
  const VIEW_WORDS = Object.freeze({ now: 'see_view_now', always: 'see_always', game: 'see_game', app: 'see_apps', desktop: 'see_desktop' });
  const MORE = Object.freeze(['store', 'yourWidgets', 'ownWidget']);
  // The section that holds them, and the acts that place a widget on a screen.
  const HOST = 'screens';
  const PLACING = Object.freeze(['layerPlace', 'layerKey']);

  const byId = (rows, id) => rows.find((r) => r.id === id);
  const byKind = (rows, kind) => rows.find((r) => r.kind === kind);
  const widgetsOf = (rows) => rows.filter((r) => r.kind === 'widget');
  // Those of the page in view; with one page there is nothing to tell apart.
  const onPage = (rows, page) => widgetsOf(rows).filter((r) => !page || r.page === page);
  // The widget rows of a section: its home row carries them.
  const homeOf = (s) => (s && Array.isArray(s.rows) ? s.rows.find((r) => r.kind === 'home') : null);
  const rowsOf = (s) => { const home = homeOf(s); return home?.parts ? home.parts.widgets : null; };
  // A card's act, sent to the screen it was added from; without one it goes to the main screen.
  const onScreen = (act, monitor) => (monitor && act?.run && PLACING.includes(act.run.type) ? { ...act, run: { ...act.run, monitor } } : act);

  // ctx: { el, button, say, tt, fill, factLine, icon, switchFor, perform, redraw, server,
  //        DRAW, Place, Palette, pageEdit, peek, main, clearFind, show }
  function create(ctx) {
    const { el, button, say, tt, fill, factLine, icon, switchFor, perform, redraw, server, DRAW, Place, Palette, pageEdit, peek, main, clearFind, show } = ctx;
    let view = LIST;
    let addFilter = '';
    let addCat = 'all';
    let focusNext = '';
    let levelChanged = false;
    let seen = 'now';

    function go(next, focus = 'back') {
      view = next;
      levelChanged = true;
      focusNext = focus;
    }

    function open(next) {
      clearFind();
      show(HOST);
      go(next);
      redraw();
    }

    function stepBack() {
      if (view.name === 'list') return false;
      go(LIST, { widget: `${view.id}:open`, add: 'add', page: 'pageEdit' }[view.name]);
      return true;
    }

    function reset() {
      view = LIST;
      addFilter = '';
      addCat = 'all';
    }

    // ── Shared pieces ──
    // A shot of the tile where one shows the real thing, else its icon. The icons
    // are the app's own static SVG, never data from a widget.
    function addThumb(c) {
      const box = el('span', 'xm-addthumb');
      // Every card has a picture; a widget of your own, or a Store picture that
      // does not load, shows the first letter of its name in the same box.
      const initial = () => { box.textContent = [...say(c.label)][0] || ''; };
      if (!c.picture && !c.shot) { initial(); return box; }
      const img = el('img');
      img.alt = '';
      img.addEventListener('error', initial);
      img.src = c.shot || server + '/' + c.picture;
      box.appendChild(img);
      return box;
    }

    const map = window.XenonMenuMap.create({
      el, say, perform, thumb: addThumb,
      open: (r) => open({ name: 'widget', id: r.id }),
    });

    const widgetView = window.XenonMenuWidgetView.create({
      el, button, say, tt, perform, redraw, DRAW, Place, thumb: addThumb, icon, removed: () => go(LIST, ''), map,
    });

    function listOf(rows) {
      const box = el('div', 'xm-list');
      box.append(...rows.map((r) => DRAW[r.kind](r)));
      return box;
    }

    function backButton() {
      const b = button('xm-back');
      b.dataset.keep = 'back';
      b.append(icon('back') || '', tt('xmenu_back'));
      b.addEventListener('click', () => { if (stepBack()) redraw(); });
      return b;
    }

    // `monitor`: the screen it adds to, '' for the main one.
    function addButton(add, monitor = '', label = '') {
      const b = button('ui-btn ui-btn--primary xm-act', label || say(add.label));
      b.dataset.keep = 'add';
      b.prepend(icon('plus') || '');
      b.addEventListener('click', () => { go({ name: 'add', monitor }, 'addsearch'); redraw(); });
      return b;
    }

    // ── A widget in the list ──
    function rowFact(r) {
      const sub = el('span', 'xm-sub xm-wrow-sub');
      const pic = r.at.icon && Place ? Place.picture(el, r.at.icon) : null;
      if (pic) sub.appendChild(pic);
      sub.append(factLine(r.now ? [...r.value, r.now] : r.value, tt));
      return sub;
    }

    function drawRow(r) {
      const li = el('div', 'xm-row xm-row--widget xm-wrow' + (r.shown === false ? ' xm-row--off' : ''));
      li.dataset.row = r.id;
      const name = button('xm-label xm-wrow-open', say(r.label));
      name.dataset.keep = `${r.id}:open`;
      name.addEventListener('click', () => open({ name: 'widget', id: r.id }));
      const words = el('div', 'xm-words');
      words.append(name, rowFact(r));
      li.append(addThumb(r), words, switchFor(r, fill(tt('xmenu_widget_show'), { name: say(r.label) })), icon('chevron') || '');
      return li;
    }

    // ── The list of a page (its bar is js/xenon-menu-page-edit.js) ──
    const openPage = (id) => { go({ name: 'page', id }); redraw(); };
    const pageName = (pages, id) => say(pages.options.find((o) => o.value === id).label);

    // A screen, or a page of it, with nothing on it: what goes there, and the first one.
    function emptyScreen(add, pages, monitor) {
      const box = el('div', 'xm-pageempty');
      const title = pages ? fill(tt('xmenu_page_empty'), { name: pageName(pages, pages.value) }) : tt('xmenu_scr_no_widgets');
      box.append(el('p', 'xm-label', title), el('p', 'xm-sub', tt(pages ? 'xmenu_page_empty_hint' : 'xmenu_scr_no_widgets_sub')), addButton(add, monitor, tt('xmenu_add_first')));
      return box;
    }

    function footButton(row, label, act) {
      const b = button('ui-btn ui-btn--secondary xm-act', label);
      b.dataset.keep = row.id;
      b.disabled = !act;
      b.addEventListener('click', () => perform(row, act));
      return b;
    }

    function footer(rows) {
      const edit = byId(rows, 'edit');
      const shown = byId(rows, 'shown');
      if (!edit || !shown) return null;
      const box = el('div', 'xm-foot');
      box.append(
        footButton(edit, tt('xmenu_move_mouse'), edit.act),
        footButton(shown, tt(shown.on ? 'xmenu_hide_all' : 'xmenu_show_all'), shown.on ? shown.acts.off : shown.acts.on),
      );
      return box;
    }

    // ── What shows when ──
    const inView = (r) => window.LayerSee.VIEWS.includes(seen) && (seen === 'now' ? r.shown : r.group === seen || r.group === 'always');

    function viewChips(row) {
      const group = el('div', 'xm-choices xm-mapviews');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', say(row.label));
      group.append(...window.LayerSee.VIEWS.map((v) => {
        const b = button('xm-choice', tt(VIEW_WORDS[v]));
        b.dataset.keep = 'view:' + v;
        b.setAttribute('aria-pressed', String(v === seen));
        b.addEventListener('click', () => { seen = v; redraw(); });
        return b;
      }));
      return group;
    }

    // `screens`: the ones drawn, the screen whose tab this is.
    function mapBlock(row, mine, screens) {
      const shown = mine.filter(inView);
      const box = el('div', 'xm-mapblock');
      const line = el('div', 'xm-mapline');
      line.append(el('span', 'xm-sub', say(row.label)), viewChips(row));
      box.append(line, map.draw(screens, shown, ''), el('p', 'xm-sub xm-mapcount', fill(tt('see_count'), { n: shown.length, all: mine.length })));
      return box;
    }

    // The map's picture of this screen: the main one has no key there (menu-widgets.js).
    // With no screen known, every one the map has.
    function mapScreens(where, screen) {
      if (!screen.key) return where.screens;
      const one = where.screens.find((m) => (screen.main ? !m.key : m.key === screen.key)) || (screen.main ? where.screens[0] : null);
      return one ? [one] : null;
    }

    function groups(mine) {
      const box = el('div', 'xm-groups');
      for (const g of window.LayerSee.GROUPS) {
        const here = mine.filter((r) => r.group === g);
        if (here.length) box.append(el('h3', 'xm-tunehead', tt(GROUP_WORDS[g])), listOf(here));
      }
      return box;
    }

    function undoButton(rows) {
      const row = byId(rows, 'undoStep');
      if (!row) return null;
      const b = button('ui-btn ui-btn--secondary xm-act', say(row.label));
      b.dataset.keep = row.id;
      b.addEventListener('click', () => perform(row, row.act));
      return b;
    }

    function actions(...items) {
      const box = el('div', 'xm-actions');
      box.append(...items.filter(Boolean));
      return box;
    }

    // One screen's widgets, for its tab on the Screens page. `screen` is the home row's
    // view of it: whether it is the main one, its key and the ids of the widgets on it.
    function listFor(rows, screen) {
      const add = byId(rows, 'add');
      if (!add) return [listOf(rows.filter((r) => DRAW[r.kind]))];
      const pages = byId(rows, 'pages');
      const ids = new Set(screen.widgets || []);
      const mine = onPage(rows, pages ? pages.value : '').filter((r) => ids.has(r.id));
      const monitor = screen.main ? '' : screen.key;
      const lone = byId(rows, 'newPage');
      const guide = byKind(rows, 'guide');
      const where = byId(rows, 'map');
      const drawn = where && mine.length ? mapScreens(where, screen) : null;
      const body = [
        pages && pageEdit?.bar(pages, byKind(rows, 'pageEdit'), openPage),
        drawn && mapBlock(where, mine, drawn),
        mine.length ? groups(mine) : emptyScreen(add, pages, monitor),
        mine.length && actions(undoButton(rows), addButton(add, monitor)),
        lone && listOf([lone]),
        !widgetsOf(rows).length && guide && listOf([guide]),
        footer(rows),
      ];
      return body.filter(Boolean);
    }

    // ── Adding ──
    function addCard(c) {
      const b = button('xm-addchoice');
      b.append(addThumb(c), el('span', 'xm-addname', say(c.label)));
      if (c.tile && Palette?.forSupporters(c.tile)) b.appendChild(el('span', 'xm-addtag', tt('palette_supporters')));
      if (c.sub) b.appendChild(el('span', 'xm-sub xm-addsub', say(c.sub)));
      if (c.rec) b.appendChild(el('span', 'xm-sub xm-addsub', factLine([c.rec], tt)));
      return b;
    }

    // One tap places it, then its own screen opens so it can be moved at once. The rows
    // reach the page a moment later, so the new id is held until they do.
    function placed(res) {
      reset();
      go({ name: 'widget', id: res.placed?.id || res.id, fresh: true });
    }

    function paintCards(add, list) {
      const q = addFilter.trim().toLowerCase();
      const inCat = (c) => addCat === 'all' || (c.cats || []).includes(addCat);
      const says = (c) => `${say(c.label)} ${c.sub ? say(c.sub) : ''}`.toLowerCase();
      const items = (add.choices || []).filter(inCat).filter((c) => !q || says(c).includes(q));
      list.replaceChildren(...items.map((c) => {
        const b = addCard(c);
        b.addEventListener('click', () => perform(add, onScreen(c.act, view.monitor), placed));
        return b;
      }));
      if (!items.length) list.appendChild(el('p', 'xm-empty', tt('xmenu_add_none')));
    }

    // The kinds of widget to narrow the cards to. Only the cards repaint, so the
    // search keeps its focus and what was typed.
    function addCats(r, paint) {
      const group = el('div', 'xm-choices xm-addcats');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', say(r.label));
      const chips = (r.filters || []).map((f) => {
        const b = button('xm-choice', say(f.label));
        b.setAttribute('aria-pressed', String(f.value === addCat));
        b.dataset.keep = 'addcat:' + f.value;
        b.addEventListener('click', () => {
          addCat = f.value;
          for (const c of chips) c.setAttribute('aria-pressed', String(c === b));
          paint();
        });
        return b;
      });
      group.append(...chips);
      return group;
    }

    function addScreen(rows) {
      const add = byId(rows, 'add');
      const pages = byId(rows, 'pages');
      const search = el('input', 'xm-search');
      search.type = 'search';
      search.value = addFilter;
      search.placeholder = tt('xmenu_add_search');
      search.setAttribute('aria-label', tt('xmenu_add_search'));
      search.dataset.keep = 'addsearch';
      const list = el('div', 'xm-addlist');
      const paint = () => paintCards(add, list);
      search.addEventListener('input', () => { addFilter = search.value; paint(); });
      if (!(add.filters || []).some((f) => f.value === addCat)) addCat = 'all';
      paint();
      const more = MORE.map((id) => byId(rows, id)).concat(byKind(rows, 'guide')).filter(Boolean);
      return {
        back: backButton(),
        title: pages ? { text: fill(tt('xmenu_add_to'), { page: pageName(pages, pages.value) }) } : add.label,
        sub: { key: 'see_add_lead' },
        body: [search, addCats(add, paint), list, el('h2', 'xm-heading', tt('xmenu_more_widgets')), listOf(more)],
      };
    }

    // ── One widget, one page ──
    function widgetScreen(r, rows) {
      const where = byId(rows, 'map');
      const near = onPage(rows, r.page).filter((x) => x === r || inView(x));
      return {
        back: backButton(),
        title: r.label,
        sub: { text: factLine([peek?.held() && r.peek ? r.peek : r.now].filter(Boolean), tt) },
        action: actions(undoButton(rows), switchFor(r, fill(tt('xmenu_widget_show'), { name: say(r.label) }))),
        body: [widgetView.detail(r, where ? where.screens : [], near)],
      };
    }

    function pageScreen(rows, edit) {
      const name = pageName(byId(rows, 'pages'), edit.page);
      const parts = pageEdit.drawScreen(edit, name);
      const when = byId(rows, 'pageWhen');
      const key = byId(rows, 'pageKey');
      const body = [parts.name, when && listOf([when]), key && listOf([key]), parts.gone];
      return { back: backButton(), title: { text: name }, sub: { text: factLine(edit.says, tt) }, body: body.filter(Boolean) };
    }

    // What the section looks like now, or null for the section as the server gives it
    // (the Screens page itself, no widget layers on this machine, or any other section).
    function screen(s) {
      const own = viewOf(s);
      if (peek && !(own && view.name === 'widget')) peek.show(null);
      return own;
    }

    function viewOf(s) {
      const rows = rowsOf(s);
      if (!rows || !byId(rows, 'add')) return null;
      if (view.name === 'add') return addScreen(rows);
      if (view.name === 'widget') {
        const r = widgetsOf(rows).find((x) => x.id === view.id);
        if (r) {
          view = { name: 'widget', id: r.id };
          if (peek) peek.show(r.id);
          return widgetScreen(r, rows);
        }
        if (!view.fresh) view = LIST;
      }
      if (view.name === 'page') {
        const edit = byKind(rows, 'pageEdit');
        if (edit && edit.page === view.id) return pageScreen(rows, edit);
        view = LIST;
      }
      return null;
    }

    // After a redraw: back to the top on a new level, and the focus where it belongs.
    function settle() {
      if (levelChanged) main.scrollTop = 0;
      levelChanged = false;
      if (!focusNext) return;
      const keep = focusNext;
      focusNext = '';
      const node = [...main.querySelectorAll('[data-keep]')].find((n) => n.dataset.keep === keep);
      if (node) node.focus();
    }

    return {
      screen, drawRow, reset, stepBack, settle, listFor,
      holds: () => map.holds() || (view.name === 'page' && !!pageEdit && pageEdit.typing()),
      undo: (rows) => { const row = byId(rows, 'undoStep'); if (row) perform(row, row.act); },
    };
  }

  return { create, onPage, onScreen, rowsOf };
});

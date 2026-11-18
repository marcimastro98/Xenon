'use strict';

// The search of the Xenon window finds the rows of Settings too. This light page
// (menu.html) does not carry them, so the first search reads the dashboard's markup
// once (GET /, index.html) and indexes it the way Settings' own search does
// (js/settings-search/, loaded whole). The best rows follow the menu's own; a pick
// opens that page of Settings on the row (js/grid/dashboard-open.js, `id`).
(() => {
  const LIMIT = 8;
  let index = null;
  let reading = false;

  // The pages of Settings by their names in the rail (js/menu/xenon-pages.js).
  function catKeys() {
    const Pages = window.XenonPages;
    const rows = [...Pages.rows(['capture'], []), ...Pages.foot()].filter((r) => r.page && Pages.isCat(r.page));
    return Object.fromEntries(rows.map((r) => [r.page, r.label]));
  }

  async function read(server, redraw) {
    if (reading || index) return;
    reading = true;
    try {
      const res = await fetch(server + '/');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      index = window.FuzzyFind.createIndex(window.SettingsSearch.rowsIn(doc, catKeys()));
      redraw();
    } catch (e) {
      console.warn('[xenon-menu] Settings are not in the search:', e?.message);
    } finally {
      reading = false;
    }
  }

  function row(o, e) {
    const say = (key) => (key ? o.tt(key) : '');
    const li = o.el('div', 'xm-row');
    li.dataset.row = 'settings:' + e.id;
    const words = o.el('div', 'xm-words');
    const label = o.el('span', 'xm-label');
    window.FuzzyFind.renderHighlighted(label, say(e.labelKey), o.query);
    words.appendChild(label);
    const crumbs = [say(e.catKey), e.cardKey && e.cardKey !== e.labelKey ? say(e.cardKey) : ''];
    const crumb = e.kind === 'cat' ? '' : [...new Set(crumbs.filter(Boolean))].join(' › ');
    if (crumb) words.appendChild(o.el('span', 'xm-sub', crumb));
    const go = o.button('ui-btn ui-btn--secondary xm-act', o.tt('xmenu_open'));
    go.addEventListener('click', () => o.open(e.cat, e.kind === 'cat' ? '' : e.id));
    li.append(words, go);
    return li;
  }

  // `o`: { el, button, tt, query, server, hidden (pages left out here), none (the
  // menu found nothing), open(cat, id), redraw }. Until the rows are read only the
  // menu's own results show.
  function draw(o) {
    if (!index) {
      read(o.server, o.redraw);
      return [];
    }
    const hits = window.FuzzyFind.search(index, o.query, { limit: LIMIT * 2 })
      .map((r) => r.entry).filter((e) => !o.hidden.includes(e.cat)).slice(0, LIMIT);
    if (!hits.length) return o.none ? [o.el('p', 'xm-empty', o.tt('xmenu_search_none'))] : [];
    const list = o.el('div', 'xm-list');
    list.append(...hits.map((e) => row(o, e)));
    return [o.el('h2', 'xm-heading', o.tt('settings_title')), list];
  }

  window.XenonMenuSettingsFind = Object.freeze({ draw });
})();

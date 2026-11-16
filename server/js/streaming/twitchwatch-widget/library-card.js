// The library card of the Twitch tile as it is first built: its tabs, the search box and the list
// the channels go into.
'use strict';

window.TwitchwatchWidgetLibraryCard = (wrapper) => {
  const { lib, loadTab, runSearch, paintLibrary } = wrapper;

  const { el, TABS } = window.TwitchwatchWidgetKnown;
  const { ICONS, t, TAB_LABEL } = window.TwitchwatchWidgetLabels;

  function buildLibraryCard() {
    const card = el('section', 'tww-card tww-card--library');
    card.dataset.systemCard = 'library'; card.dataset.systemCardGroup = 'twitchwatch';

    const tabsRow = el('div', 'tww-tabs');
    tabsRow.appendChild(el('span', 'tww-logo', 'Twitch'));
    const TAB_ICON = { followed: ICONS.heart, top: ICONS.fire, search: ICONS.search };
    TABS.forEach(id => {
      const b = el('button', 'tww-tab'); b.type = 'button'; b.dataset.twwTab = id;
      const ico = el('span', 'tww-tab-ico'); ico.innerHTML = TAB_ICON[id];  // static, trusted SVG
      b.append(ico, el('span', 'tww-tab-lbl', TAB_LABEL[id]()));
      b.addEventListener('click', () => {
        lib.tab = id; lib.error = '';
        if (window.TileTabMemory) TileTabMemory.set('twitchwatch', id);
        paintLibrary();
        loadTab(id);
      });
      tabsRow.appendChild(b);
    });
    card.appendChild(tabsRow);

    const searchRow = el('div', 'tww-search-row');
    const inp = document.createElement('input');
    inp.type = 'search'; inp.className = 'tww-search-input'; inp.maxLength = 100;
    inp.placeholder = t('tww_search_ph', 'Search a channel');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(inp.value); });
    const go = el('button', 'tww-search-go'); go.type = 'button';
    go.innerHTML = ICONS.search;                                           // static, trusted SVG
    go.setAttribute('aria-label', t('tww_tab_search', 'Search'));
    go.addEventListener('click', () => runSearch(inp.value));
    searchRow.append(inp, go);
    card.appendChild(searchRow);

    card.appendChild(el('div', 'tww-list'));
    return card;
  }

  return { buildLibraryCard };
};

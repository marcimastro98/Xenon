// The YouTube tile's library card as it is first built: the tabs, the search row, the way back out
// of a playlist and the empty list.
'use strict';

window.YoutubeWidgetLibraryCard = (wrapper) => {
  const { lib, paintLibrary, loadTab, runSearch } = wrapper;

  const { ICONS, t, el, TABS, TAB_LABEL } = window.YoutubeWidgetLook;

  function buildLibraryCard() {
    const card = el('section', 'yt-card yt-card--library');
    card.dataset.systemCard = 'library'; card.dataset.systemCardGroup = 'youtube';

    const tabsRow = el('div', 'yt-tabs');
    tabsRow.appendChild(el('span', 'yt-logo', 'YouTube'));
    const TAB_ICON = { liked: ICONS.heart, playlists: ICONS.list, subs: ICONS.subs, search: ICONS.search };
    TABS.forEach(id => {
      const b = el('button', 'yt-tab'); b.type = 'button'; b.dataset.ytTab = id;
      const ico = el('span', 'yt-tab-ico'); ico.innerHTML = TAB_ICON[id];   // static, trusted SVG
      b.append(ico, el('span', 'yt-tab-lbl', TAB_LABEL[id]()));
      b.addEventListener('click', () => {
        lib.tab = id; lib.openPl = null; lib.plItems = null; lib.error = '';
        if (window.TileTabMemory) TileTabMemory.set('youtube', id);
        paintLibrary();
        loadTab(id);
      });
      tabsRow.appendChild(b);
    });
    card.appendChild(tabsRow);

    const searchRow = el('div', 'yt-search-row');
    const inp = document.createElement('input');
    inp.type = 'search'; inp.className = 'yt-search-input'; inp.maxLength = 100;
    inp.placeholder = t('youtube_search_ph', 'Search on YouTube');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(inp.value); });
    const go = el('button', 'yt-search-go'); go.type = 'button';
    go.innerHTML = ICONS.search;                       // static, trusted SVG
    go.setAttribute('aria-label', t('youtube_tab_search', 'Search'));
    go.addEventListener('click', () => runSearch(inp.value));
    searchRow.append(inp, go);
    card.appendChild(searchRow);

    const crumb = el('button', 'yt-crumb'); crumb.type = 'button';
    const ci = el('span', 'yt-crumb-ico'); ci.innerHTML = ICONS.back;      // static, trusted SVG
    crumb.append(ci, el('span', 'yt-crumb-txt'));
    crumb.addEventListener('click', () => { lib.openPl = null; lib.plItems = null; paintLibrary(); });
    card.appendChild(crumb);

    card.appendChild(el('div', 'yt-list'));
    return card;
  }

  return { buildLibraryCard };
};

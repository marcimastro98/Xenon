// The favorites bar of the Browser tiles: one list shared by every tile, kept in the settings, with
// a small editor that starts from the page on screen; a tap on a favorite opens it in the tab.
'use strict';

window.BrowserTileFavorites = (wrapper) => {
  const { ICONS, groups, activeTab, navigateActive } = wrapper;

  const { t, favLabelFromUrl } = window.BrowserTileSays;
  const { MAX_FAVORITES, getFavorites } = window.BrowserTileStore;

  // ── Favorites (global quick-access bar, shared by every Browser tile) ──────────
  function saveFavorites(list) {
    try {
      hubSettings.browserFavorites = list.slice(0, MAX_FAVORITES)
        .map((f) => ({ label: String(f.label || '').slice(0, 40), url: String(f.url || '').slice(0, 2048) }));
      if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
    } catch (e) { /* ignore */ }
    // The list is global — refresh the bar on every open tile, not just this one.
    groups.forEach((group) => renderFavorites(group));
  }
  function addFavorite(label, url) {
    const u = String(url || '').trim();
    if (!u) return;
    const list = getFavorites();
    if (list.length >= MAX_FAVORITES) {
      if (typeof showHubToast === 'function') showHubToast(t('browser_favorites', 'Favorites'), t('browser_fav_full', 'Maximum number of favorites reached.'), '');
      return;
    }
    list.push({ label: String(label || '').trim().slice(0, 40) || favLabelFromUrl(u), url: u });
    saveFavorites(list);
  }
  function removeFavorite(index) {
    const list = getFavorites();
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    saveFavorites(list);
  }

  // Render (or hide) a group's favorites bar. Shown only when there is at least one
  // favorite or the inline add-editor is open, so an unused bar never eats space on
  // a small tile.
  function renderFavorites(group) {
    const row = group.favRow;
    if (!row) return;
    const list = getFavorites();
    const editing = group.favEditor && !group.favEditor.hidden;
    if (!list.length && !editing) { group.favList.replaceChildren(); row.hidden = true; return; }
    row.hidden = false;
    const frag = document.createDocumentFragment();
    list.forEach((fav, i) => {
      const chip = document.createElement('div');
      chip.className = 'browser-fav';
      chip.setAttribute('role', 'button'); chip.tabIndex = 0;
      chip.title = fav.url;
      const label = document.createElement('span');
      label.className = 'browser-fav-label';
      label.textContent = fav.label || favLabelFromUrl(fav.url);
      chip.appendChild(label);
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'browser-fav-del'; del.innerHTML = ICONS.close;
      del.title = t('browser_fav_remove', 'Remove favorite');
      del.addEventListener('click', (e) => { e.stopPropagation(); removeFavorite(i); });
      chip.appendChild(del);
      const go = () => navigateActive(group, fav.url);
      chip.addEventListener('click', go);
      // Only the chip itself navigates on Enter/Space — not a bubbled keypress from
      // the × delete button (which would otherwise navigate and swallow the delete).
      chip.addEventListener('keydown', (e) => { if (e.target === chip && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); } });
      frag.appendChild(chip);
    });
    group.favList.replaceChildren(frag);
  }

  // Open the inline add-editor, prefilled with the active tab's current page so
  // "save this page" is one tap, while the fields stay editable for a manual entry.
  function openFavEditor(group) {
    const ed = group.favEditor;
    if (!ed) return;
    const tab = activeTab(group);
    const url = (tab && tab.url) || '';
    group.favUrlInput.value = url;
    group.favNameInput.value = url ? favLabelFromUrl(url) : '';
    ed.hidden = false;
    renderFavorites(group);   // ensure the row is visible even with no favorites yet
    try { group.favNameInput.focus(); group.favNameInput.select(); } catch (e) { /* ignore */ }
  }
  function closeFavEditor(group) {
    if (group.favEditor) group.favEditor.hidden = true;
    renderFavorites(group);
  }
  function commitFavEditor(group) {
    const url = group.favUrlInput.value;
    if (!String(url || '').trim()) { try { group.favUrlInput.focus(); } catch (e) { /* ignore */ } return; }
    addFavorite(group.favNameInput.value, url);
    closeFavEditor(group);
  }

  return { renderFavorites, openFavEditor, closeFavEditor, commitFavEditor };
};

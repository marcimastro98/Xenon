// What the Browser tile keeps in the settings: each tile's tabs and the favorites shared by every
// Browser tile, with how many of each it holds.
'use strict';

(() => {
  const MAX_TABS = 6;
  const MAX_FAVORITES = 16;

  // Stored as { tabs: [{ url }], active }. Back-compatible with the old single-URL
  // shape { url }, which becomes a one-tab list on first read. `legacyId` is the
  // enclosing tab-group's gs-id: instance ids used to be derived from it, so a
  // tile that was grouped before the per-atom id fix has its typed URLs saved
  // under the group's key — adopt that entry once rather than losing them (the
  // next saveTabs re-homes the state under the atom id).
  function getTabsConfig(id, legacyId) {
    let raw;
    try { raw = hubSettings.browserTiles && hubSettings.browserTiles[id]; } catch (e) { raw = null; }
    if (!raw && legacyId) {
      try { raw = hubSettings.browserTiles && hubSettings.browserTiles[legacyId]; } catch (e) { raw = null; }
    }
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs.map((tb) => ({ url: (tb && typeof tb.url === 'string') ? tb.url : '' }));
      if (!tabs.length) tabs.push({ url: '' });
      const active = Math.max(0, Math.min(tabs.length - 1, Number(raw.active) || 0));
      return { tabs: tabs.slice(0, MAX_TABS), active, chromeHidden: !!(raw && raw.chromeHidden) };
    }
    const legacyUrl = (raw && typeof raw.url === 'string') ? raw.url : '';
    return { tabs: [{ url: legacyUrl }], active: 0, chromeHidden: !!(raw && raw.chromeHidden) };
  }

  function saveTabs(group) {
    try {
      if (!hubSettings.browserTiles) hubSettings.browserTiles = {};
      hubSettings.browserTiles[group.id] = { tabs: group.tabs.map((tb) => ({ url: tb.url || '' })), active: group.active, chromeHidden: !!group.chromeHidden };
      if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
    } catch (e) { /* ignore */ }
  }

  // Stored as hubSettings.browserFavorites = [{ label, url }]. Kept global on
  // purpose: a favorite defined in one Browser tile is available in all of them.
  function getFavorites() {
    let raw;
    try { raw = hubSettings.browserFavorites; } catch (e) { raw = null; }
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((f) => f && typeof f === 'object' && typeof f.url === 'string' && f.url.trim())
      .slice(0, MAX_FAVORITES)
      .map((f) => ({ label: String(f.label || '').slice(0, 40), url: String(f.url).slice(0, 2048) }));
  }

  window.BrowserTileStore = { MAX_TABS, MAX_FAVORITES, getTabsConfig, saveTabs, getFavorites };
})();

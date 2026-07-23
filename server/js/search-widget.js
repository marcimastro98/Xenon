'use strict';
// Search widget — a real search surface living on a dashboard page. The tile
// embeds its own instance of the Spotlight engine (Spotlight.createSearchUI):
// you type IN the tile, results and the AI mode live IN the tile, nothing
// jumps to an overlay. At rest it still costs nothing — an idle input plus
// quick filter chips (Foto / Documenti / Recenti); the first fetch happens on
// the first keystroke. Past searches are deliberately NOT listed here: the
// tile sits on a dashboard other people can see, and a search phrase is
// private by default. (The Spotlight keeps recording them for its own use;
// nothing displays them.)
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function render(mount) {
    // Layout rebuilds re-render every mount: stop the previous instance's
    // pending fetch/debounce before dropping its DOM.
    if (mount._searchUI) { mount._searchUI.stop(); mount._searchUI = null; }
    mount.textContent = '';
    if (!window.Spotlight || typeof Spotlight.createSearchUI !== 'function') return;

    // The live surface (bar + chips + status + results) — state classes
    // (spot-expanded, spot-ai, …) land on this container, so the shared
    // Spotlight rules apply scoped to the tile.
    const live = document.createElement('div');
    live.className = 'searchw-live';
    // Idle content below the bar, hidden while results are showing.
    const idle = document.createElement('div');
    idle.className = 'searchw-idle';

    const ui = Spotlight.createSearchUI({
      host: live,
      stateHost: live,
      keyHost: live,
      withClose: false,
      onClose: () => ui.reset(),          // Escape clears the tile search
      onExpand: (expanded) => { idle.hidden = expanded; },
      // onOpened deliberately absent: after opening a file the tile keeps its
      // results — it is a persistent surface, not a transient overlay.
    });
    mount._searchUI = ui;
    mount.append(live, idle);

    const chips = document.createElement('div');
    chips.className = 'searchw-chips';
    for (const [labelKey, fb, q] of [
      ['spot_kind_image', 'Foto', 'foto'],
      ['spot_kind_document', 'Documenti', 'documenti'],
      ['spot_recent', 'Recenti', 'recenti'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'searchw-chip';
      b.textContent = t(labelKey, fb);
      b.addEventListener('click', () => { ui.setQuery(q); ui.focus(); });
      chips.appendChild(b);
    }
    idle.appendChild(chips);
  }

  function renderWidgets() {
    document.querySelectorAll('.search-widget-mount').forEach(render);
  }

  function init() { renderWidgets(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.SearchWidget = { renderWidgets };
})();

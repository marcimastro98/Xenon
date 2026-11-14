// Where each Deck stands: the folder it is in, its page and whether it is being edited, and the
// grid that fills its tile when the Deck fits itself.
'use strict';

(() => {
  const { computeAutoGrid, wellContentSize } = window.DeckGridFit;

  const nav = new Map();                      // instanceId -> { path:[], pageIndex }

  function navOf(instanceId) {
    if (!nav.has(instanceId)) nav.set(instanceId, { path: [], pageIndex: 0, editing: false });
    return nav.get(instanceId);
  }

  // Reshape `cfg` to auto-fill the tile. Measures the WELL (the available area),
  // not the grid — the grid letterboxes to a square block, so measuring it would
  // feed back. Normal view only: while editing, the grid is fitted against the
  // EDIT well by scheduleEditFit (caps keep their live size, the row count
  // adapts), so this normal-view fit must never run on the transient edit well.
  function applyAutoGrid(tile, instanceId, cfg) {
    if (!cfg.autoFit || !(window.DeckModel && window.DeckModel.reshapeDeckConfig)) return cfg;
    if (navOf(instanceId).editing) return cfg;
    const well = tile.querySelector('.deck-well');
    if (!well) return cfg;
    const { w, h } = wellContentSize(well);
    return computeAutoGrid(cfg, w, h);
  }

  window.DeckNav = { navOf, applyAutoGrid };
})();

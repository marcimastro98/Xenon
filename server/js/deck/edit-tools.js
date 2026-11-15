// The toolbar of a Deck being edited: the key that opens its look, the size of the keys, the grid
// by hand or fitted, and the music strip.
'use strict';

window.DeckEditTools = (wrapper) => {
  const { saveConfig, render, openDeckStyleModal } = wrapper;

  const { getConfig } = window.DeckStoreReads;
  const { tr, el } = window.DeckParts;
  const { applyAutoGrid } = window.DeckNav;

  // Edit-mode toolbar: key-size segmented control, auto-fit toggle, manual grid
  // steppers (only when auto-fit is off), and a now-playing dock toggle. Each
  // control mutates the persisted config and re-renders.

  function buildTools(tile, instanceId, cfg, profileId) {
    const tools = el('div', 'deck-tools');
    // The inline toolbar keeps only the structural grid controls (size, fit,
    // cols/rows, media). The whole-device LOOK (theme/shape/plate) and the
    // background/music styling live in a dedicated modal with a live preview —
    // opened by the "Customize" button below — so this bar stays uncluttered.
    const rowLayout = el('div', 'deck-tools-row');
    tools.appendChild(rowLayout);

    const sizeGrp = el('div', 'deck-tools-grp');
    sizeGrp.appendChild(el('span', 'deck-tools-cap', tr('deck_keysize', 'Tasti')));
    const seg = el('div', 'deck-seg');
    [['sm', tr('deck_keysize_sm', 'S')], ['md', tr('deck_keysize_md', 'M')], ['lg', tr('deck_keysize_lg', 'L')]].forEach(([val, label]) => {
      const b = el('button', cfg.keySize === val ? 'active' : '', label); b.type = 'button';
      b.addEventListener('click', () => {
        if (cfg.keySize === val) return;
        const next = applyAutoGrid(tile, instanceId, Object.assign({}, getConfig(instanceId), { keySize: val }));
        saveConfig(instanceId, next);
        render(tile, instanceId);
      });
      seg.appendChild(b);
    });
    sizeGrp.appendChild(seg);
    rowLayout.appendChild(sizeGrp);

    const fit = el('button', 'deck-pill' + (cfg.autoFit ? ' on' : ''), tr('deck_autofit', 'Auto')); fit.type = 'button';
    fit.addEventListener('click', () => {
      // Toggle the per-instance flag only; do NOT bake the current tile fit into the
      // durable grid. Turning auto-fit ON lets render() fit the DISPLAY next frame
      // (render-only); turning it OFF reveals the canonical saved grid as-is. Baking
      // the fit here is what seeded the cross-instance grid drift.
      const next = Object.assign({}, getConfig(instanceId), { autoFit: !cfg.autoFit });
      saveConfig(instanceId, next);
      render(tile, instanceId);
    });
    rowLayout.appendChild(fit);

    if (!cfg.autoFit) {
      const min = window.DeckModel.DECK_MIN, max = window.DeckModel.DECK_MAX;
      // The steppers act on the SHOWN profile's own grid — each profile keeps its
      // own cols/rows, so resizing this one never reflows the others.
      const grid = window.DeckModel.gridOf(cfg, profileId);
      const mkStepper = (dim, label) => {
        const grp = el('div', 'deck-tools-grp');
        grp.appendChild(el('span', 'deck-tools-cap', label));
        const dec = el('button', 'deck-step', '−'); dec.type = 'button'; dec.disabled = grid[dim] <= min;
        const val = el('span', 'deck-step-val', String(grid[dim]));
        const inc = el('button', 'deck-step', '+'); inc.type = 'button'; inc.disabled = grid[dim] >= max;
        const setDim = (n) => {
          const cur = getConfig(instanceId);
          const g = window.DeckModel.gridOf(cur, profileId);
          const cols = dim === 'cols' ? n : g.cols;
          const rows = dim === 'rows' ? n : g.rows;
          saveConfig(instanceId, window.DeckModel.reshapeDeckConfig(cur, cols, rows, { compact: false, profileId }));
          render(tile, instanceId);
        };
        dec.addEventListener('click', () => setDim(grid[dim] - 1));
        inc.addEventListener('click', () => setDim(grid[dim] + 1));
        grp.append(dec, val, inc);
        return grp;
      };
      rowLayout.appendChild(mkStepper('cols', tr('deck_cols', 'Col')));
      rowLayout.appendChild(mkStepper('rows', tr('deck_rows', 'Righe')));
    }

    const media = el('button', 'deck-pill' + (cfg.showMedia ? ' on' : ''), tr('deck_media_preview', 'Musica')); media.type = 'button';
    media.addEventListener('click', () => {
      saveConfig(instanceId, Object.assign({}, getConfig(instanceId), { showMedia: !cfg.showMedia }));
      render(tile, instanceId);
    });
    rowLayout.appendChild(media);

    // Open the appearance modal (theme/shape/plate + background + music, with a
    // live preview of the deck and its music bar).
    const custom = el('button', 'deck-pill deck-customize', tr('deck_style_open', 'Personalizza')); custom.type = 'button';
    custom.addEventListener('click', () => openDeckStyleModal(tile, instanceId, profileId));
    rowLayout.appendChild(custom);

    return tools;
  }

  return { buildTools };
};

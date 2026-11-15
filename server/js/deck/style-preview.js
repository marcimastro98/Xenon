// The Deck drawn small inside the window of its look: its keys, its backdrop and its music strip,
// with a key lit so Ring and Dim can be seen.
'use strict';

window.DeckStylePreview = (wrapper) => {
  const { buildWellBg, renderKey, buildNowPlaying } = wrapper;

  const { deckLookFor, stampDeckLitCues, stampDeckAlpha } = window.DeckLookStamps;
  const { keyMinFor } = window.DeckGridFit;
  const { el } = window.DeckParts;
  const { stateSnapshot } = window.DeckLiveState;

  // Ring and Dim act only on keys that follow a state, and a page often has none,
  // or none on right now: then the switches changed nothing in the preview. The
  // preview shows the page's own such keys at their live state, lighting the first
  // one if none is on; on a page with none, its first two keys stand in, one on
  // and one off. Preview only: the live Deck is never touched.
  function showLitCues(grid, look) {
    if (!look.litRing && !look.dimOff) return;
    const keys = Array.from(grid.querySelectorAll('.deck-key:not(.is-empty)'));
    let shown = keys.filter((k) => k.classList.contains('is-stateful'));
    if (shown.length) {
      shown.forEach((k) => { if (k._deckState) k.classList.toggle('is-on', window.DeckModel.evaluateKeyState(k._deckState, stateSnapshot)); });
      if (!shown.some((k) => k.classList.contains('is-on'))) shown[0].classList.add('is-on');
      return;
    }
    shown = keys.slice(0, 2);
    shown.forEach((k, i) => {
      k.classList.add('is-stateful');
      if (!k.querySelector('.deck-key-onfx')) k.appendChild(el('div', 'deck-key-onfx'));
      k.style.setProperty('--key-on', k.style.getPropertyValue('--key-accent') || 'var(--accent, #7aa2ff)');
      k.classList.toggle('is-on', i === 0);
    });
  }
  function buildDeckStylePreview(cfg, profileId) {
    const targetProfile = cfg.profiles.some((p) => p.id === profileId) ? profileId : cfg.activeProfile;
    const look = deckLookFor(cfg, targetProfile);
    const view = window.DeckModel.resolveView(cfg, { profileId: targetProfile, path: [], pageIndex: 0 });
    const shape = window.DeckModel.gridOf(cfg, targetProfile);
    const root = el('div', 'deck-root deck-style-preview-root');
    root.dataset.keysize = cfg.keySize;
    root.dataset.capstyle = look.capStyle;
    root.dataset.shape = look.keyShape;
    root.dataset.plate = look.plate;
    stampDeckAlpha(root, look);
    stampDeckLitCues(root, look);
    root.style.setProperty('--deck-cols', shape.cols);
    root.style.setProperty('--deck-rows', shape.rows);
    root.style.setProperty('--deck-key-min', keyMinFor(cfg) + 'px');
    const device = el('div', 'deck-device');
    const well = el('div', 'deck-well');
    const wl = buildWellBg(look.wellImage);
    if (wl) { well.classList.add('has-bgimg'); well.appendChild(wl); }
    const grid = el('div', 'deck-grid');
    (view.page.keys || []).forEach((key) => grid.appendChild(renderKey(key, { themeColors: look.themeColors })));
    showLitCues(grid, look);
    well.appendChild(grid);
    device.appendChild(well);
    device.appendChild(buildNowPlaying(look.mediaStyle, look.themeColors));   // always shown so music styling is visible
    root.appendChild(device);
    return root;
  }

  return { buildDeckStylePreview };
};

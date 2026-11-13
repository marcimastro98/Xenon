// The presets section of the editor, taking a tile into the grid, and the pictures a tile can wear:
// frame, overlays and fill.
'use strict';

// Build the "My presets" dock section: an insert chip (+ inline delete) per saved
// preset, plus a "save current page" action. Returns null when there's nothing to
// show AND nothing to save (kept always-visible so the save action is reachable).
function buildDashboardPresetsSection() {
  const wrap = document.createElement('div');
  wrap.className = 'layout-chip-list';
  getDashboardPresets().forEach(p => {
    const row = document.createElement('div');
    row.className = 'layout-preset-row';
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'layout-chip layout-preset-chip';
    chip.title = t('preset_insert');
    const label = document.createElement('span');
    label.textContent = (p.name || t('preset_kind_' + p.kind)) + ' · ' + t('preset_kind_' + p.kind);
    chip.appendChild(label);
    chip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); insertDashboardPreset(p.id); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'layout-preset-del';
    del.title = t('preset_delete');
    del.setAttribute('aria-label', t('preset_delete'));
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); deleteDashboardPreset(p.id); });
    row.append(chip, del);
    wrap.appendChild(row);
  });
  wrap.appendChild(createDashboardChip('preset_save_page', 'preset_save_page', DASHBOARD_LAYOUT_ICONS.savePreset, saveCurrentPagePreset));
  return wrap;
}

function refreshDashboardLayoutEditor() {
  const dock = ensureDashboardLayoutDock();
  const layout = getDashboardLayout();
  dock.replaceChildren();

  // Chrome state: collapsed body + free-drag position. In minimal-topbar mode
  // the dock floats OVER the tiles (TopbarMinimal.css), so it starts as a
  // collapsed slim capsule that blocks nothing and can be dragged anywhere;
  // in-flow (full topbar) mode it starts expanded and stays in the grid row.
  const floating = document.body.classList.contains('topbar-minimal');
  const dockState = getDashboardDockState();
  const collapsed = dockState.collapsed === null ? floating : dockState.collapsed;
  dock.classList.toggle('is-collapsed', collapsed);
  dock.appendChild(buildDashboardDockBar(dock, collapsed));
  applyDashboardDockPosition(dock, dockState, floating);

  const dockBody = document.createElement('div');
  dockBody.className = 'layout-dock-body';
  dock.appendChild(dockBody);

  // (Hidden top-level widgets are added back via the per-page "+" palette, not here.)
  // System & Network render together in one "Sistema" view (setSystemTab maps the
  // legacy 'net' tab onto 'main'), so the active tab is never 'net'. List hidden
  // cards from BOTH groups — otherwise a hidden Rete & Gaming card (ping/fps/
  // bandwidth) is orphaned with no way to restore it. (GitHub issue #106)
  const hiddenCards = document.createElement('div');
  hiddenCards.className = 'layout-chip-list';
  let hiddenCardCount = 0;
  ['main', 'net'].forEach(groupId => {
    DASHBOARD_CARD_IDS[groupId]
      .filter(cardId => !layout.cards[groupId][cardId].visible)
      .forEach(cardId => {
        hiddenCardCount += 1;
        hiddenCards.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', groupId, cardId)));
      });
  });
  if (hiddenCardCount) appendDashboardDockSection(dockBody, 'layout_hidden_cards', hiddenCards);

  const hiddenAudio = document.createElement('div');
  hiddenAudio.className = 'layout-chip-list';
  const hiddenAudioIds = DASHBOARD_CARD_IDS.audio.filter(cardId => !layout.cards.audio[cardId].visible);
  hiddenAudioIds.forEach(cardId => {
    hiddenAudio.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'audio', cardId)));
  });
  if (hiddenAudioIds.length) appendDashboardDockSection(dockBody, 'layout_hidden_audio', hiddenAudio);

  // The per-widget card sections (Twitch info/actions/chat, OBS preview/controls,
  // the two YouTube widgets, Twitch watching) hidden via their own card controls.
  // One section each, because a chip only says which CARD it restores and two
  // widgets share the ids "chat" and "actions" — a single merged list would show
  // two chips reading "Chat" with no way to tell them apart.
  // Every group with cards belongs here: a hidden card whose group is missing
  // from this list has no way back at all.
  ['twitch', 'obs', 'youtube', 'youtubelive', 'twitchwatch'].forEach(groupId => {
    const stored = layout.cards[groupId];
    const hiddenIds = (DASHBOARD_CARD_IDS[groupId] || []).filter(cardId => stored && stored[cardId] && !stored[cardId].visible);
    if (!hiddenIds.length) return;
    const chips = document.createElement('div');
    chips.className = 'layout-chip-list';
    hiddenIds.forEach(cardId => {
      chips.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', groupId, cardId)));
    });
    appendDashboardDockSection(dockBody, `layout_hidden_${groupId}`, chips);
  });

  // Page add/remove now lives next to the pager dots in the topbar (see
  // dashboard-pager.js renderDots), so the dock only carries hidden-item
  // restore chips and the Reset/Done actions.

  // Saved presets: reinsert a saved widget / tab-group / page, or save the
  // current page. Always shown so the "save page" action stays reachable.
  appendDashboardDockSection(dockBody, 'preset_my', buildDashboardPresetsSection());

  // Top-bar visibility toggle. While editing the bar is always shown; this chip
  // sets whether it stays hidden after "Done". When hidden, the floating Layout
  // button is the way back in.
  const topbarHidden = layout.topbarHidden === true;
  const topbarChips = document.createElement('div');
  topbarChips.className = 'layout-chip-list';
  topbarChips.appendChild(createDashboardChip(
    topbarHidden ? 'layout_topbar_show' : 'layout_topbar_hide',
    topbarHidden ? 'layout_topbar_show' : 'layout_topbar_hide',
    topbarHidden ? DASHBOARD_LAYOUT_ICONS.restore : DASHBOARD_LAYOUT_ICONS.hide,
    () => setTopbarHidden(!topbarHidden),
    topbarHidden ? 'active' : '',
  ));
  // The bar's look and buttons, edited right here (js/topbar-layout-panel.js).
  if (window.TopbarLayoutPanel) {
    topbarChips.appendChild(createDashboardChip('tbp_open', 'tbp_open', DASHBOARD_LAYOUT_ICONS.tune, () => window.TopbarLayoutPanel.open()));
  }
  appendDashboardDockSection(dockBody, 'layout_topbar', topbarChips);

  // (Reset/Done live in the dock's header bar — see buildDashboardDockBar.)

  // Re-render the pager dots so the add/remove-page controls reflect the
  // current edit state (they live next to the dots, in the topbar).
  if (window.DashboardPager && typeof window.DashboardPager.renderDots === 'function') {
    window.DashboardPager.renderDots();
  }
}

// Re-home a grid item into a (different) page grid. The item must FIRST be
// detached from the grid that currently owns it (engine node + drag/resize
// bindings): a bare appendChild leaves the source grid holding a phantom node
// for an element it no longer contains — its geometry maths count a ghost
// tile, and GridStack's removeAll (page rebuild) has no parent check, so
// tearing the source grid down later would strip the tile's FRESH bindings on
// its new page ("moved tile can't be dragged any more").
function adoptGridItem(targetGrid, item) {
  if (item.parentElement === targetGrid) return;
  const fromGrid = item.parentElement && item.parentElement.gridstack;
  if (fromGrid && fromGrid !== targetGrid.gridstack) {
    try { fromGrid.removeWidget(item, false, false); } catch (e) { /* ignore */ }
  }
  moveNode(targetGrid, item);   // not appendChild: that reloads every iframe in the tile
}

// ── Per-tile styling ────────────────────────────────────────────────────────
// A tile's saved `style` overrides just its own subtree by writing the SAME CSS
// custom properties the global theme uses onto the .grid-stack-item wrapper; the
// descendants already read them via var(), so the override is scoped. The font is
// the exception (--user-font-family is only read on <body>), so it rides a
// dedicated --tile-font consumed by a rule on the tile surface (DashboardGrid.css).
const TILE_FONT_STACKS = {
  inter: "'Inter', 'Segoe UI', system-ui, sans-serif",
  pressstart: "'Press Start 2P', 'Inter', system-ui, sans-serif",
  vt323: "'VT323', 'Inter', system-ui, sans-serif",
};
function tileStyleForId(layout, id) {
  if (!layout || !id) return null;
  if (layout.widgets && layout.widgets[id]) return layout.widgets[id].style || null;
  if (layout.groups && layout.groups[id]) return layout.groups[id].style || null;
  const copy = Array.isArray(layout.copies) ? layout.copies.find(c => c.id === id) : null;
  return copy ? (copy.style || null) : null;
}
// ── Per-tile DECOR (images + effects) ───────────────────────────────────────
// The image layer of a tile's style. Unlike the colour tokens (pure CSS vars on
// the wrapper), images/frames/overlays need real DOM layers inside the tile's
// content — mirroring the Deck's .deck-key-bgimg / .deck-key-anim pattern.
const TILE_OVERLAY_ANCHOR_CSS = {
  'top-left': { top: '0', left: '0' },
  'top': { top: '0', left: '50%', tx: '-50%' },
  'top-right': { top: '0', right: '0' },
  'left': { top: '50%', left: '0', ty: '-50%' },
  'center': { top: '50%', left: '50%', tx: '-50%', ty: '-50%' },
  'right': { top: '50%', right: '0', ty: '-50%' },
  'bottom-left': { bottom: '0', left: '0' },
  'bottom': { bottom: '0', left: '50%', tx: '-50%' },
  'bottom-right': { bottom: '0', right: '0' },
};
// Only local uploads, curated assets, and inline image data URIs may render. The
// allowlist is dashboard-instances.js's _tileImageSrc — the exact validator the
// normalizer runs — re-invoked here as the DOM-edge defence-in-depth layer (one
// definition, two checkpoints). Fails closed if the module is somehow absent.
function safeTileImageSrc(v) {
  const DI = (typeof window !== 'undefined' && window.DashboardInstances) || null;
  return (DI && DI.tileImageSrc) ? DI.tileImageSrc(v) : '';
}
// A normalized {c1,c2,angle} gradient → a CSS linear-gradient(), or '' if absent.
// Colours come pre-validated (#rrggbb) from normalizeTileDecor.
// tileGradCss() and paintDecorBgLayer() live in js/decor-bg.js (shared with deck.js).
// Curated preset ids resolve through the manifest (tile-decor-presets.js, loaded
// before this file) so the /assets/decor URL scheme lives in one place.
function tileFrameSrc(frame) {
  if (!frame) return '';
  if (frame.preset) return window.TileDecorPresets ? window.TileDecorPresets.tileFramePresetUrl(frame.preset) : '';
  return safeTileImageSrc(frame.src);
}
function tileOverlaySrc(ov) {
  if (!ov) return '';
  if (ov.preset) return window.TileDecorPresets ? window.TileDecorPresets.tileOverlayPresetUrl(ov.preset) : '';
  return safeTileImageSrc(ov.src);
}
// Strip any previously-built decor DOM + attributes/classes from a tile wrapper.
function clearTileDecor(el, content) {
  el.removeAttribute('data-tile-decor');
  el.removeAttribute('data-tile-bg');
  el.removeAttribute('data-tile-glow-outer');
  el.style.removeProperty('--tile-glow-outer');
  el.style.removeProperty('--tile-glow-c');
  if (content) {
    content.querySelectorAll(':scope > .tile-decor-bg, :scope > .tile-decor-frame, :scope > .tile-decor-overlays, :scope > .tile-decor-above')
      .forEach(n => n.remove());
    content.style.removeProperty('--tile-frame-inset');
  }
}
function tileFrameRepeat(frame) {
  const TDP = window.TileDecorPresets;
  const entry = frame && frame.preset && TDP ? TDP.TILE_DECOR_FRAMES.find(f => f.id === frame.preset) : null;
  return entry && entry.repeat;
}
// Overlays into one wrapper; `layer` picks the ones behind the widget or above it.
function buildTileOverlays(decor, behind) {
  const TDL = window.TileDecorLayers;
  const list = (Array.isArray(decor.overlays) ? decor.overlays : []).filter(ov => (ov.layer === 'behind') === behind);
  if (!TDL || !list.length) return null;
  const wrap = document.createElement('div');
  wrap.className = behind ? 'tile-decor-overlays is-behind' : 'tile-decor-overlays';
  wrap.setAttribute('aria-hidden', 'true');
  list.forEach((ov) => {
    const src = tileOverlaySrc(ov);
    if (src) wrap.appendChild(TDL.buildOverlayNode(ov, src, cssUrl, TILE_OVERLAY_ANCHOR_CSS));
  });
  return wrap.childElementCount ? wrap : null;
}
// The fill layer: the panel colour, then the picture, a pattern and the overlays
// that sit behind the widget. It takes over the panel's FILL (data-tile-bg makes
// the widget root transparent): left behind an opaque panel, none of it showed.
function buildTileFill(el, content, decor) {
  const TDL = window.TileDecorLayers;
  const bgSrc = decor.bg ? safeTileImageSrc(decor.bg.src) : '';
  const grad = decor.bg ? tileGradCss(decor.bg.grad) : '';
  const pattern = decor.pattern && decor.pattern.layer !== 'above' && TDL ? TDL.buildPatternLayer(decor.pattern) : null;
  const behind = buildTileOverlays(decor, true);
  if (!bgSrc && !grad && !pattern && !behind) return;
  const layer = document.createElement('div');
  layer.className = 'tile-decor-bg';
  layer.setAttribute('aria-hidden', 'true');
  if (bgSrc || grad) {
    const art = document.createElement('div');
    art.className = 'tile-decor-bg-art';
    paintDecorBgLayer(art, grad, bgSrc, decor.bg.fit || 'cover');
    if (typeof decor.bg.blur === 'number' && decor.bg.blur > 0) {
      art.style.filter = `blur(${decor.bg.blur}px)`;
      art.style.setProperty('--tile-bg-blur', `${decor.bg.blur}px`);
    }
    if (typeof decor.bg.opacity === 'number') art.style.opacity = String(decor.bg.opacity / 100);
    if (typeof decor.bg.dim === 'number' && decor.bg.dim > 0) layer.style.setProperty('--tile-bg-dim', String(decor.bg.dim / 100));
    layer.appendChild(art);
  }
  if (pattern) layer.appendChild(pattern);
  if (behind) layer.appendChild(behind);
  content.insertBefore(layer, content.firstChild);
  el.setAttribute('data-tile-bg', '');
}

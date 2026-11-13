// Applies the whole layout, and edit mode: moving a tile, changing its size, hiding it and bringing
// it back.
'use strict';

let dashboardLayoutEditing = false;

function applyDashboardLayout() {
  // A layer surface shows tiles the dashboard may have hidden: make them visible
  // in memory first, so hub-embedded ones extract like they do on a page.
  if (window.LayerHost && window.LayerHost.active) window.LayerHost.forceVisible();
  const layout = getDashboardLayout();
  // Self-heal corrupted layouts where two tiles overlap the same grid cell (e.g.
  // a duplicated Media+Chat tab-group stacked on the seeded one — its hidden
  // chat then bleeds through the front tile's playback). Skip while editing so a
  // live drag's transient overlap isn't reflowed mid-gesture; a healthy layout
  // never overlaps, so this is a no-op for everyone else. Persist once if moved.
  if (!dashboardLayoutEditing && window.DashboardGrid && typeof window.DashboardGrid.resolveLayoutOverlaps === 'function') {
    if (window.DashboardGrid.resolveLayoutOverlaps(layout)) {
      saveDashboardLayout(layout, { status: false });
    }
  }
  // Remove every control bar before the extraction sync runs. The sync moves a
  // panel's children into a hub pane (and back); if a previously-injected
  // `.layout-controls` is still present it would be carried along, leaving an
  // orphan control bar inside the hub (two stacked controls). Clearing first
  // guarantees there is nothing stray to move; controls are re-created below
  // only on the tiles/cards that should have them.
  document.querySelectorAll('.layout-controls').forEach(controls => controls.remove());
  // Each step is isolated: a failure in one widget sync / sub-apply must not
  // abort the whole pipeline (which would leave the edit toggle, dock and pager
  // page-set stale — e.g. "Done" appearing to do nothing). Errors are logged.
  const step = (label, fn) => { try { fn(); } catch (e) { console.error('dashboard layout step failed:', label, e); } };
  step('syncTasks', () => { if (typeof syncTasksWidgetPlacement === 'function') syncTasksWidgetPlacement(); });
  step('syncNotes', () => {
    if (typeof syncNotesWidgetPlacement === 'function') syncNotesWidgetPlacement();
    // Re-render so a freshly extracted panel or a duplicated instance shows the
    // current notes with live event handlers, not a stale/empty root.
    if (typeof renderNotes === 'function') renderNotes();
  });
  step('syncCalendar', () => { if (typeof syncCalendarWidgetPlacement === 'function') syncCalendarWidgetPlacement(); });
  step('syncTimer', () => { if (typeof syncTimerWidgetPlacement === 'function') syncTimerWidgetPlacement(); });
  step('syncAudio', () => { if (typeof syncAudioWidgetPlacement === 'function') syncAudioWidgetPlacement(); });
  step('syncMic', () => { if (typeof syncMicWidgetPlacement === 'function') syncMicWidgetPlacement(); });
  step('widgets', () => applyDashboardWidgets(layout));
  // Re-apply the last audio snapshot so a freshly-extracted or duplicated Volume /
  // Microphone tile shows its live level immediately. The 'audio' SSE stream is
  // change-gated (it only pushes when a value actually changes), so a tile mounted
  // after the initial push would otherwise stay blank until the next real change —
  // which on a quiet system may be never, forcing the user to refresh the page.
  step('audioReapply', () => {
    if (typeof audioData !== 'undefined' && audioData && typeof applyAudio === 'function') applyAudio(audioData);
  });
  // Same for 'media' and the mic mute state: both streams are change-gated on the
  // server too now (an idle "nothing playing" payload no longer re-broadcasts every
  // 2s), so a freshly-added Media/Mic tile re-paints from the cached last payload
  // here instead of waiting for the next real change.
  step('mediaReapply', () => {
    if (typeof mediaData !== 'undefined' && mediaData && typeof applyMedia === 'function') applyMedia(mediaData);
  });
  step('micStateReapply', () => {
    if (typeof muted !== 'undefined' && typeof applyUI === 'function') applyUI(muted);
  });
  step('weatherRender', () => { if (typeof renderWeatherTile === 'function') renderWeatherTile(); });
  step('deckRender', () => { if (window.Deck && typeof window.Deck.renderAll === 'function') window.Deck.renderAll(); });
  step('remoteRender', () => { if (window.RemoteControl && typeof window.RemoteControl.renderWidgets === 'function') window.RemoteControl.renderWidgets(); });
  step('streamRender', () => { if (window.StreamingPage && typeof window.StreamingPage.renderWidgets === 'function') window.StreamingPage.renderWidgets(); });
  step('obsRender', () => { if (window.ObsWidget && typeof window.ObsWidget.renderWidgets === 'function') window.ObsWidget.renderWidgets(); });
  step('ytRender', () => { if (window.YouTubeWidget && typeof window.YouTubeWidget.renderWidgets === 'function') window.YouTubeWidget.renderWidgets(); });
  step('ytlRender', () => { if (window.YouTubeLiveWidget && typeof window.YouTubeLiveWidget.renderWidgets === 'function') window.YouTubeLiveWidget.renderWidgets(); });
  step('twwRender', () => { if (window.TwitchWatchWidget && typeof window.TwitchWatchWidget.renderWidgets === 'function') window.TwitchWatchWidget.renderWidgets(); });
  step('discordRender', () => { if (window.DiscordWidget && typeof window.DiscordWidget.renderWidgets === 'function') window.DiscordWidget.renderWidgets(); });
  step('spotifyRender', () => { if (window.SpotifyWidget && typeof window.SpotifyWidget.renderWidgets === 'function') window.SpotifyWidget.renderWidgets(); });
  step('sbRender', () => { if (window.StreamerbotWidget && typeof window.StreamerbotWidget.renderWidgets === 'function') window.StreamerbotWidget.renderWidgets(); });
  step('wavelinkRender', () => { if (window.WaveLinkWidget && typeof window.WaveLinkWidget.renderWidgets === 'function') window.WaveLinkWidget.renderWidgets(); });
  step('lightingRender', () => { if (window.LightingWidget && typeof window.LightingWidget.renderWidgets === 'function') window.LightingWidget.renderWidgets(); });
  step('wnRender', () => { if (window.NotificationsWidget && typeof window.NotificationsWidget.renderWidgets === 'function') window.NotificationsWidget.renderWidgets(); });
  step('stocksRender', () => { if (window.StockWidget && typeof window.StockWidget.renderWidgets === 'function') window.StockWidget.renderWidgets(); });
  step('footballRender', () => { if (window.FootballWidget && typeof window.FootballWidget.renderWidgets === 'function') window.FootballWidget.renderWidgets(); });
  step('claudeRender', () => { if (window.ClaudeWidget && typeof window.ClaudeWidget.renderWidgets === 'function') window.ClaudeWidget.renderWidgets(); });
  step('codexRender', () => { if (window.CodexWidget && typeof window.CodexWidget.renderWidgets === 'function') window.CodexWidget.renderWidgets(); });
  step('chatgptRender', () => { if (window.ChatGPTWidget && typeof window.ChatGPTWidget.renderWidgets === 'function') window.ChatGPTWidget.renderWidgets(); });
  step('newsRender', () => { if (window.NewsWidget && typeof window.NewsWidget.renderWidgets === 'function') window.NewsWidget.renderWidgets(); });
  step('fansRender', () => { if (window.FansWidget && typeof window.FansWidget.renderWidgets === 'function') window.FansWidget.renderWidgets(); });
  step('searchRender', () => { if (window.SearchWidget && typeof window.SearchWidget.renderWidgets === 'function') window.SearchWidget.renderWidgets(); });
  step('diskRender', () => { if (window.DiskWidget && typeof window.DiskWidget.renderWidgets === 'function') window.DiskWidget.renderWidgets(); });
  step('devcleanRender', () => { if (window.DevCleanWidget && typeof window.DevCleanWidget.renderWidgets === 'function') window.DevCleanWidget.renderWidgets(); });
  step('lyricsRender', () => { if (window.LyricsWidget && typeof window.LyricsWidget.renderWidgets === 'function') window.LyricsWidget.renderWidgets(); });
  step('transferRender', () => { if (window.TransferWidget && typeof window.TransferWidget.renderWidgets === 'function') window.TransferWidget.renderWidgets(); });
  step('phoneRender', () => { if (window.PhoneWidget && typeof window.PhoneWidget.renderWidgets === 'function') window.PhoneWidget.renderWidgets(); });
  step('powerRender', () => { if (window.PowerWidget && typeof window.PowerWidget.renderWidgets === 'function') window.PowerWidget.renderWidgets(); });
  step('perfRender', () => { if (window.PerfWidget) window.PerfWidget.renderWidgets(); });
  step('batteryRender', () => { if (window.BatteryWidget && typeof window.BatteryWidget.renderWidgets === 'function') window.BatteryWidget.renderWidgets(); });
  step('vitalsRender', () => { if (window.VitalsWidget && typeof window.VitalsWidget.renderWidgets === 'function') window.VitalsWidget.renderWidgets(); });
  step('slideshowRender', () => { if (window.SlideshowWidget && typeof window.SlideshowWidget.renderWidgets === 'function') window.SlideshowWidget.renderWidgets(); });
  step('tickerApply', () => { if (window.Ticker && typeof window.Ticker.apply === 'function') window.Ticker.apply(); });
  step('customRender', () => { if (window.CustomWidget && typeof window.CustomWidget.renderWidgets === 'function') window.CustomWidget.renderWidgets(); });
  step('tileHandles', () => { if (window.DashboardGrid && window.DashboardGrid.ensureTileHandles) window.DashboardGrid.ensureTileHandles(); });
  // Seed any freshly-rendered chat copies with the current AI log + now-playing,
  // so a new copy isn't blank until the next media/AI event.
  step('chatMirror', () => {
    if (typeof mirrorChatCopies === 'function') mirrorChatCopies();
    if (typeof updateMediaChatPreview === 'function') updateMediaChatPreview();
  });
  step('cards', () => applyDashboardCards(layout));
  step('mediaView', () => applyDashboardMediaView(layout));
  step('calendarTabs', () => applyDashboardCalendarTabs(layout));
  step('tabs', () => applyDashboardTabs(layout));
  document.body.classList.toggle('layout-editing', dashboardLayoutEditing);
  if (!dashboardLayoutEditing && window.TopbarLayoutPanel) window.TopbarLayoutPanel.close();
  // Hide the top bar entirely when the user opted out of it — but never while
  // editing, so the full toolset (pager dots, page add/remove, Done) stays
  // reachable.
  document.body.classList.toggle('topbar-hidden', layout.topbarHidden === true);
  // Must run right after that class flip, and on BOTH edges of it: a hidden bar
  // now means "edge rails, no island" rather than "no chrome", so this call is
  // what builds the rails on the way out — and what reparents the quick actions
  // back into the bar on the way in, which would otherwise return empty.
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  ensureLayoutFab();
  const toggle = document.getElementById('layout-edit-toggle');
  if (toggle) {
    const label = t(dashboardLayoutEditing ? 'layout_exit' : 'layout_customize');
    toggle.classList.toggle('active', dashboardLayoutEditing);
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }
  refreshDashboardLayoutEditor();
  refreshDashboardPagerPages();
  // Fill the viewport height (GridStack uses fixed cell px; the dashboard is a
  // fixed-height surface). rAF so the grids have their final size first.
  if (window.DashboardGrid && window.DashboardGrid.fitGridHeights) {
    const fit = () => window.DashboardGrid.fitGridHeights();
    requestAnimationFrame(() => { fit(); requestAnimationFrame(fit); });
    setTimeout(fit, 220); // catch late layout (fonts/topbar settling)
  }
  // The glow's screens or the accent may have changed with the settings.
  if (window.AiEdgeGlow) step('aiEdgeGlow', () => window.AiEdgeGlow.refresh());
  // Last: every step above put tiles back into the page grids.
  if (window.LayerHost && window.LayerHost.active) step('layerHost', () => window.LayerHost.place());
  else if (window.LayersShell) step('layersShell', () => window.LayersShell.sync());
}

// Wrap layout mutations in a View Transition so panels fade/slide smoothly.
// Falls back to a direct call on browsers that don't support the API yet.
function applyDashboardLayoutWithTransition() {
  if (document.startViewTransition) {
    document.startViewTransition(() => applyDashboardLayout());
  } else {
    applyDashboardLayout();
  }
}

function setDashboardLayoutEditMode(enabled) {
  if (document.body.dataset.panel) return;
  dashboardLayoutEditing = !!enabled;
  // Leaving edit mode must dismiss the "+" add-widget palette immediately (it used
  // to linger until the next outside click).
  if (!dashboardLayoutEditing && window.DashboardPalette) window.DashboardPalette.close();
  if (window.DashboardGrid) window.DashboardGrid.setEditing(dashboardLayoutEditing);
  applyDashboardLayout();
}

function toggleDashboardLayoutEditor() {
  setDashboardLayoutEditMode(!dashboardLayoutEditing);
}

function moveDashboardLayoutItem(kind, groupId, itemId, direction) {
  const layout = getDashboardLayout();
  const collection = kind === 'widget' ? layout.widgets : layout.cards[groupId];
  if (!collection || !collection[itemId]) return;
  const orderedIds = sortDashboardIds(collection);
  const currentIndex = orderedIds.indexOf(itemId);
  const targetIndex = currentIndex + (direction < 0 ? -1 : 1);
  if (targetIndex < 0 || targetIndex >= orderedIds.length) return;
  const targetId = orderedIds[targetIndex];
  const currentOrder = collection[itemId].order;
  collection[itemId].order = collection[targetId].order;
  collection[targetId].order = currentOrder;
  saveDashboardLayout(layout);
  applyDashboardLayoutWithTransition();
}

function moveDashboardWidgetToPage(itemId) {
  const layout = getDashboardLayout();
  const widget = layout.widgets[itemId];
  if (!widget) return;
  const pageIds = layout.pages.map(p => p.id); // cycle across all user pages
  const destination = otherPage(widget.page, pageIds);
  if (destination === widget.page) return;
  widget.page = destination;
  widget.order = nextAppendOrder(layout.widgets, destination); // append on the destination page
  saveDashboardLayout(layout);
  applyDashboardLayoutWithTransition();
  refreshDashboardPagerPages();
}

// Recompute which pager pages are navigable (non-empty, or all while editing)
// and push the set to the pager. The active-page rule lives in dashboard-pager.
function refreshDashboardPagerPages() {
  if (!window.DashboardPager || typeof window.DashboardPager.setActivePages !== 'function') return;
  const layout = getDashboardLayout();
  // Show every page the user has — including empty ones — so a newly-added page
  // is immediately navigable and can be populated. Pages go away only when the
  // user removes them from the Pages manager.
  window.DashboardPager.setActivePages(layout.pages.map(p => p.id));
}

function cycleDashboardLayoutItemSize(kind, groupId, itemId) {
  const layout = getDashboardLayout();
  const collection = kind === 'widget' ? layout.widgets : layout.cards[groupId];
  const allowedSizes = kind === 'widget' ? DASHBOARD_WIDGET_SIZES : DASHBOARD_CARD_SIZES;
  if (!collection || !collection[itemId]) return;
  const currentIndex = Math.max(0, allowedSizes.indexOf(collection[itemId].size));
  collection[itemId].size = allowedSizes[(currentIndex + 1) % allowedSizes.length];
  saveDashboardLayout(layout);
  applyDashboardLayoutWithTransition();
}

function hideDashboardLayoutItem(kind, groupId, itemId) {
  const layout = getDashboardLayout();
  const collection = kind === 'widget' ? layout.widgets : layout.cards[groupId];
  if (!collection || !collection[itemId]) return;
  if (kind !== 'widget') {
    // Cards keep the legacy "at least one visible" guard (audio may be empty).
    const allowEmptyGroup = groupId === 'audio';
    if (!allowEmptyGroup && dashboardVisibleCount(collection) <= 1) return;
  }
  // Widgets: just flip visibility — geometry persists, restore via the "+" palette.
  collection[itemId].visible = false;
  saveDashboardLayout(layout);
  applyDashboardLayoutWithTransition();
}

function restoreDashboardLayoutItem(kind, groupId, itemId) {
  const layout = getDashboardLayout();
  const collection = kind === 'widget' ? layout.widgets : layout.cards[groupId];
  if (!collection || !collection[itemId]) return;
  collection[itemId].visible = true;
  saveDashboardLayout(layout);
  applyDashboardLayoutWithTransition();
}

function persistDashboardSystemTab(tabId) {
  if (!['main', 'net', 'volume', 'mic'].includes(tabId)) return;
  const layout = getDashboardLayout();
  layout.tabs.active = tabId;
  saveDashboardLayout(layout, { status: false });
  refreshDashboardLayoutEditor();
}

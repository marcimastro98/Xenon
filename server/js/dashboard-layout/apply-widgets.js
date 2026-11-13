// Puts the widgets, cards and tabs of the layout on the page.
'use strict';

// Whether the last placement pass used the vertical arrangement.
let lastPlacedVertical = false;

// Where each landscape tile goes: visible standalone widgets, groups and copies.
function landscapeTargets(layout, groupOf) {
  const out = {};
  DASHBOARD_WIDGET_IDS.forEach(id => {
    const w = layout.widgets[id];
    if (w && w.visible && !groupOf(id)) out[id] = w;
  });
  Object.keys(layout.groups || {}).forEach(gid => { out[gid] = layout.groups[gid]; });
  (Array.isArray(layout.copies) ? layout.copies : []).forEach(c => { if (c && c.id && !groupOf(c.id)) out[c.id] = c; });
  return out;
}

function applyDashboardWidgets(layout) {
  const groups = layout.groups || {};
  const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(groups, id) : null);
  // On a vertical screen every tile is placed by the vertical layout instead
  // (js/dashboard-portrait.js); the landscape geometry is not touched.
  const plan = window.DashboardPortrait ? window.DashboardPortrait.activePlan(layout) : null;
  const geometryOf = (id, landscape) => (plan && plan[id]) || landscape;
  // A vertical arrangement replaces the tiles' positions wholesale, and so does
  // the first landscape pass after one: park the tiles first so placing them one
  // by one cannot push the others down the page.
  if (window.DashboardGrid && (plan || lastPlacedVertical)) {
    window.DashboardGrid.parkForPlacement(plan || landscapeTargets(layout, groupOf));
  }
  lastPlacedVertical = !!plan;
  // 1) standalone widgets (not members of any group)
  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    const preferences = layout.widgets[widgetId];
    // The BASE atom only — never a copy's clone. Copies carry the same
    // data-dashboard-widget as their base (plus data-dashboard-instance), so an
    // unqualified query returns whichever comes first in the DOM. A copy on an
    // earlier page would then be handed the BASE's preferences and, when the base
    // is hidden (the normal case once you duplicate a tile), get stamped
    // dashboardHidden='true' — the copy vanished the moment layout apply ran, i.e.
    // on Done. Copies get their own visibility from applyDashboardCopies.
    const tile = document.querySelector(`[data-dashboard-widget="${widgetId}"]:not([data-dashboard-instance])`);
    if (!tile) return;
    const grouped = !!groupOf(widgetId);
    tile.dataset.dashboardHidden = (preferences.visible && !grouped) ? 'false' : 'true';
    if (grouped) return; // a group member's DOM is relocated into the group tile (step 2)
    // If the atom is currently nested inside a group body (it was just extracted
    // from a group) it is NOT in its own grid-stack-item, so tile.closest() would
    // grab the GROUP's item. Re-home it into its own wrapper first. (Hub widgets
    // such as calendar/notes live inside the agenda panel by design — leave those
    // alone: only re-home when the atom sits directly in a .tabgroup-body.)
    if (tile.parentElement && tile.parentElement.classList.contains('tabgroup-body')) {
      let own = document.querySelector(`.grid-stack-item[gs-id="${widgetId}"]`);
      if (!own) {
        own = document.createElement('div');
        own.className = 'grid-stack-item';
        own.setAttribute('gs-id', widgetId);
        const c = document.createElement('div'); c.className = 'grid-stack-item-content';
        own.appendChild(c);
        const pool = document.getElementById('widget-pool');
        if (pool) pool.appendChild(own);
      }
      const ownContent = own.querySelector(':scope > .grid-stack-item-content') || own;
      moveNode(ownContent, tile);
    }
    const item = tile.closest('.grid-stack-item') || tile;
    if (!preferences.visible) {
      const pool = document.getElementById('widget-pool');
      if (pool && item.parentElement !== pool) {
        const fromGrid = item.parentElement && item.parentElement.gridstack;
        if (fromGrid) { try { fromGrid.removeWidget(item, false); } catch (e) { /* ignore */ } }
        moveNode(pool, item);
      }
      return;
    }
    const targetGrid = dashboardPageGrid(preferences.page);
    if (!targetGrid) return; // page grid not built yet → leave in pool, place next pass
    adoptGridItem(targetGrid, item);
    if (window.DashboardGrid && targetGrid.gridstack) {
      window.DashboardGrid.applyWidgetGeometry(targetGrid.gridstack, item, geometryOf(widgetId, preferences));
    }
    createDashboardControls(tile, 'widget', null, widgetId);
  });
  // 2) groups — each is one grid item containing its members as tabs
  Object.keys(groups).forEach(gid => {
    const g = groups[gid];
    const targetGrid = dashboardPageGrid(g.page);
    // Skip if the page grid isn't built yet (early initDashboardLayout call):
    // building the group now would relocate member tiles into a DETACHED item,
    // making #media-panel unreachable. It renders on the next pass (rebuild).
    if (!targetGrid) return;
    let item = document.querySelector(`.grid-stack-item[gs-id="${gid}"]`);
    if (!item) {
      item = document.createElement('div');
      item.className = 'grid-stack-item';
      item.setAttribute('gs-id', gid);
      const c = document.createElement('div'); c.className = 'grid-stack-item-content';
      item.appendChild(c);
    }
    // Attach to the grid FIRST, so member relocation + i18n run while the subtree
    // is in the document (getElementById finds the tiles).
    adoptGridItem(targetGrid, item);
    if (window.DashboardTabGroups) window.DashboardTabGroups.renderGroupTile(item, g);
    if (window.DashboardGrid && targetGrid.gridstack) {
      window.DashboardGrid.applyWidgetGeometry(targetGrid.gridstack, item, geometryOf(gid, g));
    }
  });
  // 2.5) copies — deep clone of the base widget atom, stripped to the duplicable
  // subtree, placed on its page. Only widgets marked duplicable are ever cloned.
  (Array.isArray(layout.copies) ? layout.copies : []).forEach(copy => {
    if (!(window.DashboardInstances && window.DashboardInstances.isDuplicable(copy.widget))) return;
    // A copy that belongs to a tab-group is rendered INSIDE the group
    // (renderGroupTile), not as a standalone tile — skip it here.
    if (window.DashboardTabGroups && window.DashboardTabGroups.widgetGroupOf(layout.groups, copy.id)) return;
    const targetGrid = dashboardPageGrid(copy.page);
    if (!targetGrid) return;
    let item = document.querySelector('.grid-stack-item[gs-id="' + copy.id + '"]');
    if (!item) {
      const clone = createCopyAtom(copy.widget, copy.id);
      if (!clone) return;
      item = document.createElement('div');
      item.className = 'grid-stack-item';
      item.setAttribute('gs-id', copy.id);
      const content = document.createElement('div'); content.className = 'grid-stack-item-content';
      content.appendChild(clone);
      item.appendChild(content);
    }
    adoptGridItem(targetGrid, item);
    if (window.DashboardGrid && targetGrid.gridstack) {
      window.DashboardGrid.applyWidgetGeometry(targetGrid.gridstack, item, geometryOf(copy.id, copy));
    }
  });
  // 2.9) an instance that is now a group member must not also keep a standalone
  // tile (its atom/clone was relocated into the group body, leaving an empty
  // wrapper). Pool a primary's wrapper; drop a copy's empty wrapper.
  const groupedMembers = new Set();
  Object.keys(groups).forEach(gid => (groups[gid].members || []).forEach(m => groupedMembers.add(m)));
  if (groupedMembers.size) {
    const pool = document.getElementById('widget-pool');
    document.querySelectorAll('.grid-stack-item[gs-id]').forEach(it => {
      const id = it.getAttribute('gs-id');
      if (!groupedMembers.has(id)) return;
      const fromGrid = it.parentElement && it.parentElement.gridstack;
      if (DASHBOARD_WIDGET_IDS.includes(id)) {
        if (pool && it.parentElement !== pool) {
          if (fromGrid) { try { fromGrid.removeWidget(it, false); } catch (e) { /* ignore */ } }
          moveNode(pool, it);
        }
      } else if (fromGrid) {
        try { fromGrid.removeWidget(it, true, false); } catch (e) { it.remove(); }
      } else {
        it.remove();
      }
    });
  }
  // 3) drop orphaned group tiles. A dissolved group (e.g. after extracting a
  // member) leaves an empty grid-stack-item behind; its members were re-homed
  // into their own wrappers in step 1. A tile is valid only if its gs-id is a
  // known widget id OR a live group id; anything else is a leftover group tile.
  const validIds = new Set([
    ...DASHBOARD_WIDGET_IDS,
    ...Object.keys(groups),
    ...((Array.isArray(layout.copies) ? layout.copies : []).map(c => c.id)),
  ]);
  document.querySelectorAll('.grid-stack-item[gs-id]').forEach(it => {
    const id = it.getAttribute('gs-id');
    if (validIds.has(id)) return;
    const grid = it.parentElement && it.parentElement.gridstack;
    if (grid) { try { grid.removeWidget(it, true, false); } catch (e) { it.remove(); } }
    else it.remove();
  });
  // 4) paint per-tile style overrides onto every placed wrapper (no-op for tiles
  // that follow the global theme).
  applyAllTileStyles(layout);
}

function applyDashboardCards(layout) {
  Object.keys(DASHBOARD_CARD_IDS).forEach(groupId => {
    DASHBOARD_CARD_IDS[groupId].forEach(cardId => {
      const preferences = layout.cards[groupId][cardId];
      const element = document.querySelector(`[data-system-card="${cardId}"][data-system-card-group="${groupId}"]`);
      if (!element) return;
      element.dataset.systemCardOrder = String(preferences.order);
      element.dataset.systemCardSize = preferences.size;
      element.dataset.systemCardHidden = preferences.visible ? 'false' : 'true';
      createDashboardControls(element, 'card', groupId, cardId);
    });
  });

  const audioBlock = document.getElementById('audio-block');
  if (audioBlock && layout.cards.audio) {
    const hasVisibleAudio = DASHBOARD_CARD_IDS.audio.some(cardId => layout.cards.audio[cardId].visible);
    audioBlock.dataset.audioHidden = hasVisibleAudio ? 'false' : 'true';
    syncVolumeHiddenHint(audioBlock, !layout.cards.audio.volume.visible);
  }
}

// "Volume card hidden · Show", in the Volume tab where the card was. Only exists
// while the card is hidden, and only shows while Layout is being edited (CSS):
// the dock's chip under "Hidden audio controls" was the only way back, and a
// tab left with just the two device rows does not say that anything is gone.
// The button is an inline handler so a copy of the tile cloned from this
// content keeps working.
function syncVolumeHiddenHint(audioBlock, hidden) {
  let hint = audioBlock.querySelector(':scope > .vol-hidden-hint');
  if (!hidden) { if (hint) hint.remove(); return; }
  if (hint) return;
  hint = document.createElement('div');
  hint.className = 'vol-hidden-hint';
  const text = document.createElement('span');
  text.setAttribute('data-i18n', 'layout_volume_hidden');
  text.textContent = t('layout_volume_hidden');
  const show = document.createElement('button');
  show.type = 'button';
  show.setAttribute('data-i18n', 'layout_volume_show');
  show.textContent = t('layout_volume_show');
  show.setAttribute('onclick', "restoreDashboardLayoutItem('card', 'audio', 'volume')");
  hint.append(text, show);
  audioBlock.insertBefore(hint, audioBlock.firstChild);
}

function applyDashboardTabs(layout) {
  // Volume (audio) and Microphone live as System-hub tabs until extracted into
  // their own tiles; once extracted their tab buttons are hidden by the sync
  // functions. With only "Sistema" left, hide the tab bar entirely — counted
  // from the buttons themselves, so the History tab (owned by guardian-history)
  // is included instead of being silently dropped from the total.
  const audioExtracted = !!(layout.widgets.audio && layout.widgets.audio.visible);
  const micExtracted = !!(layout.widgets.mic && layout.widgets.mic.visible);
  if (typeof syncSystemTabBar === 'function') syncSystemTabBar();

  // Keep the active tab valid: fall back to "main" when the requested tab has
  // been extracted (or is the legacy "net" id).
  let active = layout.tabs.active;
  if (active === 'net') active = 'main';
  if (active === 'volume' && audioExtracted) active = 'main';
  if (active === 'mic' && micExtracted) active = 'main';
  if (typeof setSystemTab === 'function') setSystemTab(active, { silent: true });
}

function applyDashboardCalendarTabs(layout) {
  // Each agenda tab maps to a widget id; a tab is "in the hub" when its widget
  // is not extracted (not visible as a standalone tile).
  const inHub = ['calendar', 'tasks', 'timer', 'notes']
    .filter(id => !(layout.widgets[id] && layout.widgets[id].visible));
  // With one or zero items left in the hub, the tab bar is pointless — hide it.
  // Scoped like switchCalendarTaskView: a bare document query can land on an
  // agenda parked in the hidden pool during a pager rebuild, which would style a
  // bar nobody sees and leave the visible one untouched.
  const agendaScope = (typeof agendaScopeFor === 'function') ? agendaScopeFor(null) : document;
  const toggleBar = agendaScope.querySelector('.cal-task-toggle');
  if (toggleBar) toggleBar.style.display = inHub.length <= 1 ? 'none' : '';
  const active = layout.calendarTabs.active;
  const target = inHub.includes(active) ? active : (inHub[0] || null);
  if (target && typeof switchCalendarTaskView === 'function') {
    switchCalendarTaskView(target, { persist: false });
  }
}

function applyDashboardMediaView(layout) {
  if (typeof showCalendar === 'function') {
    showCalendar(layout.mediaView.active === 'calendar', true);
  }
}

function persistDashboardCalendarTab(tabId) {
  if (!['calendar', 'tasks', 'timer', 'notes'].includes(tabId)) return;
  const layout = getDashboardLayout();
  layout.calendarTabs.active = tabId;
  saveDashboardLayout(layout, { status: false });
  if (dashboardLayoutEditing) refreshDashboardLayoutEditor();
}

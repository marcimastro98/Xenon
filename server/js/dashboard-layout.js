'use strict';

let dashboardLayoutEditing = false;

const DASHBOARD_LAYOUT_ICONS = Object.freeze({
  previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5 8.5 12l7 7 1.4-1.4-5.6-5.6 5.6-5.6L15.5 5Z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 19 7-7-7-7-1.4 1.4 5.6 5.6-5.6 5.6L8.5 19Z"/></svg>',
  resize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h6v2H8.4l3.1 3.1-1.4 1.4L7 8.4V11H5V5Zm8 0h6v6h-2V8.4l-3.1 3.1-1.4-1.4L15.6 7H13V5ZM7 15.6l3.1-3.1 1.4 1.4L8.4 17H11v2H5v-6h2v2.6Zm6.9-3.1 3.1 3.1V13h2v6h-6v-2h2.6l-3.1-3.1 1.4-1.4Z"/></svg>',
  hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 3.7 3.7 2.3l18 18-1.4 1.4-3.2-3.2A11.5 11.5 0 0 1 12 20C5.5 20 2 12 2 12a18.4 18.4 0 0 1 4.1-5.6L2.3 3.7ZM12 6c6.5 0 10 6 10 6a17.3 17.3 0 0 1-2.8 4.1l-2.4-2.4A5 5 0 0 0 10.3 7.2L8.4 5.3A11.7 11.7 0 0 1 12 6Zm0 12a9.1 9.1 0 0 0 3.6-.8l-2-2A3.4 3.4 0 0 1 12 15.5 3.5 3.5 0 0 1 8.5 12c0-.6.1-1.1.4-1.6L7.5 9A14.9 14.9 0 0 0 4.3 12C5.2 13.6 7.8 18 12 18Z"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c6.5 0 10 7 10 7s-3.5 7-10 7S2 12 2 12s3.5-7 10-7Zm0 2c-4.4 0-7.1 3.8-7.8 5 .7 1.2 3.4 5 7.8 5s7.1-3.8 7.8-5c-.7-1.2-3.4-5-7.8-5Zm0 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.3 4H3l4-4 4 4H7.8A5 5 0 1 0 12 7V5Z"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 16.2-3.5-3.5L4.1 14.1 9 19 20.3 7.7l-1.4-1.4L9 16.2Z"/></svg>',
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10l-3-3 1.4-1.4L20.8 8l-5.4 5.4L14 12l3-3H7V7Zm10 10H7l3 3-1.4 1.4L3.2 16l5.4-5.4L10 12l-3 3h10v2Z"/></svg>',
});

function getDashboardLayout() {
  return normalizeDashboardLayout(hubSettings && hubSettings.dashboardLayout);
}

function getActiveDashboardCardGroup() {
  const layout = getDashboardLayout();
  return DASHBOARD_TAB_IDS.includes(layout.tabs.active) ? layout.tabs.active : 'main';
}

function getDashboardMediaView() {
  const layout = getDashboardLayout();
  return MEDIA_VIEW_IDS.includes(layout.mediaView.active) ? layout.mediaView.active : 'media';
}

function saveDashboardLayout(layout, options = {}) {
  hubSettings = normalizeSettings({ ...hubSettings, dashboardLayout: layout });
  saveHubSettings({ server: options.server !== false });
  if (options.status !== false && typeof setSettingsStatus === 'function') {
    setSettingsStatus('settings_saved', 'ok');
  }
}

function dashboardVisibleCount(collection) {
  return Object.keys(collection).filter(itemId => collection[itemId].visible).length;
}

function findDirectLayoutControls(parentElement, kind) {
  return Array.from(parentElement.children).find(child =>
    child.classList && child.classList.contains('layout-controls') && child.dataset.layoutKind === kind,
  );
}

function dashboardLabelKey(kind, itemId) {
  return kind === 'widget' ? `layout_widget_${itemId}` : `layout_card_${itemId}`;
}

function createLayoutIconButton(className, titleKey, iconMarkup, handler) {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.title = t(titleKey);
  button.setAttribute('aria-label', t(titleKey));
  button.innerHTML = iconMarkup;
  button.addEventListener('click', eventObject => {
    eventObject.preventDefault();
    eventObject.stopPropagation();
    handler();
  });
  return button;
}

function createDashboardControls(element, kind, groupId, itemId) {
  const existingControls = findDirectLayoutControls(element, kind);
  if (existingControls) existingControls.remove();
  const controls = document.createElement('div');
  controls.className = 'layout-controls';
  controls.dataset.layoutKind = kind;
  controls.append(
    createLayoutIconButton('layout-control-btn', 'layout_move_previous', DASHBOARD_LAYOUT_ICONS.previous, () => moveDashboardLayoutItem(kind, groupId, itemId, -1)),
    createLayoutIconButton('layout-control-btn', 'layout_resize', DASHBOARD_LAYOUT_ICONS.resize, () => cycleDashboardLayoutItemSize(kind, groupId, itemId)),
    createLayoutIconButton('layout-control-btn', 'layout_hide', DASHBOARD_LAYOUT_ICONS.hide, () => hideDashboardLayoutItem(kind, groupId, itemId)),
    createLayoutIconButton('layout-control-btn', 'layout_move_next', DASHBOARD_LAYOUT_ICONS.next, () => moveDashboardLayoutItem(kind, groupId, itemId, 1)),
  );
  element.appendChild(controls);
}

function createDashboardChip(labelKey, titleKey, iconMarkup, handler, extraClassName = '') {
  const chip = document.createElement('button');
  chip.className = extraClassName ? `layout-chip ${extraClassName}` : 'layout-chip';
  chip.type = 'button';
  chip.title = t(titleKey);
  chip.setAttribute('aria-label', `${t(titleKey)} ${t(labelKey)}`);
  if (iconMarkup) chip.innerHTML = iconMarkup;
  const label = document.createElement('span');
  label.textContent = t(labelKey);
  chip.appendChild(label);
  chip.addEventListener('click', eventObject => {
    eventObject.preventDefault();
    eventObject.stopPropagation();
    handler();
  });
  return chip;
}

function createDashboardEmptyLabel() {
  const label = document.createElement('span');
  label.className = 'layout-empty-label';
  label.textContent = t('layout_no_hidden');
  return label;
}

function ensureDashboardLayoutDock() {
  let dock = document.getElementById('dashboard-layout-dock');
  if (dock) return dock;
  dock = document.createElement('div');
  dock.id = 'dashboard-layout-dock';
  dock.className = 'layout-dock';
  document.body.appendChild(dock);
  return dock;
}

function appendDashboardDockSection(dock, titleKey, contentElement) {
  const section = document.createElement('div');
  section.className = 'layout-dock-section';
  const title = document.createElement('div');
  title.className = 'layout-dock-title';
  title.textContent = t(titleKey);
  section.append(title, contentElement);
  dock.appendChild(section);
}

function refreshDashboardLayoutEditor() {
  const dock = ensureDashboardLayoutDock();
  const layout = getDashboardLayout();
  dock.replaceChildren();

  const hiddenWidgets = document.createElement('div');
  hiddenWidgets.className = 'layout-chip-list';
  const hiddenWidgetIds = DASHBOARD_WIDGET_IDS.filter(widgetId => !layout.widgets[widgetId].visible);
  hiddenWidgetIds.forEach(widgetId => {
    hiddenWidgets.appendChild(createDashboardChip(dashboardLabelKey('widget', widgetId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('widget', null, widgetId)));
  });
  if (hiddenWidgetIds.length) appendDashboardDockSection(dock, 'layout_hidden_widgets', hiddenWidgets);

  const groupId = getActiveDashboardCardGroup();
  const hiddenCards = document.createElement('div');
  hiddenCards.className = 'layout-chip-list';
  const hiddenCardIds = DASHBOARD_CARD_IDS[groupId].filter(cardId => !layout.cards[groupId][cardId].visible);
  hiddenCardIds.forEach(cardId => {
    hiddenCards.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', groupId, cardId)));
  });
  if (hiddenCardIds.length) appendDashboardDockSection(dock, 'layout_hidden_cards', hiddenCards);

  const hiddenAudio = document.createElement('div');
  hiddenAudio.className = 'layout-chip-list';
  const hiddenAudioIds = DASHBOARD_CARD_IDS.audio.filter(cardId => !layout.cards.audio[cardId].visible);
  hiddenAudioIds.forEach(cardId => {
    hiddenAudio.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'audio', cardId)));
  });
  if (hiddenAudioIds.length) appendDashboardDockSection(dock, 'layout_hidden_audio', hiddenAudio);

  const actions = document.createElement('div');
  actions.className = 'layout-chip-list layout-action-list';
  actions.append(
    createDashboardChip('layout_reset', 'layout_reset', DASHBOARD_LAYOUT_ICONS.reset, resetDashboardLayout, 'danger'),
    createDashboardChip('layout_exit', 'layout_exit', DASHBOARD_LAYOUT_ICONS.done, () => setDashboardLayoutEditMode(false), 'primary'),
  );
  dock.appendChild(actions);
}

function applyDashboardWidgets(layout) {
  const dashboard = document.getElementById('dashboard-layout');
  const visibleWidgets = DASHBOARD_WIDGET_IDS.filter(widgetId => layout.widgets[widgetId].visible);
  if (dashboard) dashboard.dataset.visibleWidgets = String(visibleWidgets.length);

  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    const preferences = layout.widgets[widgetId];
    const element = document.querySelector(`[data-dashboard-widget="${widgetId}"]`);
    if (!element) return;
    element.dataset.dashboardOrder = String(preferences.order);
    element.dataset.dashboardSize = preferences.size;
    element.dataset.dashboardHidden = preferences.visible ? 'false' : 'true';
    // Only visible tiles get controls — a hidden tile can't be interacted with,
    // and skipping it avoids the control bar being swept into a hub pane.
    if (preferences.visible) createDashboardControls(element, 'widget', null, widgetId);
  });
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
  }
}

function applyDashboardTabs(layout) {
  // Volume (audio) and Microphone live as System-hub tabs until extracted into
  // their own tiles; once extracted their tab buttons are hidden by the sync
  // functions. With only "Sistema" left, hide the tab bar entirely.
  const audioExtracted = !!(layout.widgets.audio && layout.widgets.audio.visible);
  const micExtracted = !!(layout.widgets.mic && layout.widgets.mic.visible);
  const visibleSysTabs = 1 + (audioExtracted ? 0 : 1) + (micExtracted ? 0 : 1);
  const sysTabBar = document.querySelector('.system-tabs-left');
  if (sysTabBar) sysTabBar.style.display = visibleSysTabs <= 1 ? 'none' : '';

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
  const toggleBar = document.querySelector('.cal-task-toggle');
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

function persistDashboardMediaView(viewId) {
  if (!MEDIA_VIEW_IDS.includes(viewId)) return;
  const layout = getDashboardLayout();
  layout.mediaView.active = viewId;
  saveDashboardLayout(layout, { status: false });
}

function persistDashboardCalendarTab(tabId) {
  if (!['calendar', 'tasks', 'timer', 'notes'].includes(tabId)) return;
  const layout = getDashboardLayout();
  layout.calendarTabs.active = tabId;
  saveDashboardLayout(layout, { status: false });
  if (dashboardLayoutEditing) refreshDashboardLayoutEditor();
}

function swapDashboardCalendarTabs() {
  const layout = getDashboardLayout();
  layout.calendarTabs.order = layout.calendarTabs.order.slice().reverse();
  saveDashboardLayout(layout);
  applyDashboardCalendarTabs(layout);
  refreshDashboardLayoutEditor();
}

function applyDashboardLayout() {
  const layout = getDashboardLayout();
  // Remove every control bar before the extraction sync runs. The sync moves a
  // panel's children into a hub pane (and back); if a previously-injected
  // `.layout-controls` is still present it would be carried along, leaving an
  // orphan control bar inside the hub (two stacked controls). Clearing first
  // guarantees there is nothing stray to move; controls are re-created below
  // only on the tiles/cards that should have them.
  document.querySelectorAll('.layout-controls').forEach(controls => controls.remove());
  if (typeof syncTasksWidgetPlacement === 'function') syncTasksWidgetPlacement();
  if (typeof syncNotesWidgetPlacement === 'function') syncNotesWidgetPlacement();
  if (typeof syncCalendarWidgetPlacement === 'function') syncCalendarWidgetPlacement();
  if (typeof syncTimerWidgetPlacement === 'function') syncTimerWidgetPlacement();
  if (typeof syncAudioWidgetPlacement === 'function') syncAudioWidgetPlacement();
  if (typeof syncMicWidgetPlacement === 'function') syncMicWidgetPlacement();
  applyDashboardWidgets(layout);
  applyDashboardCards(layout);
  applyDashboardMediaView(layout);
  applyDashboardCalendarTabs(layout);
  applyDashboardTabs(layout);
  document.body.classList.toggle('layout-editing', dashboardLayoutEditing);
  const toggle = document.getElementById('layout-edit-toggle');
  if (toggle) {
    const label = t(dashboardLayoutEditing ? 'layout_exit' : 'layout_customize');
    toggle.classList.toggle('active', dashboardLayoutEditing);
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }
  refreshDashboardLayoutEditor();
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
  const allowEmptyGroup = kind === 'card' && groupId === 'audio';
  if (!collection || !collection[itemId]) return;
  if (!allowEmptyGroup && dashboardVisibleCount(collection) <= 1) return;
  collection[itemId].visible = false;
  if (kind === 'widget') {
    const visibleWidgetIds = DASHBOARD_WIDGET_IDS.filter(widgetId => layout.widgets[widgetId].visible);
    if (visibleWidgetIds.length === 1) layout.widgets[visibleWidgetIds[0]].size = 'full';
  }
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

function swapDashboardSystemTabs() {
  const layout = getDashboardLayout();
  layout.tabs.order = layout.tabs.order.slice().reverse();
  saveDashboardLayout(layout);
  applyDashboardLayout();
}

function resetDashboardLayout() {
  saveDashboardLayout(normalizeDashboardLayout(null));
  applyDashboardLayout();
}

function initDashboardLayout() {
  applyDashboardLayout();
}
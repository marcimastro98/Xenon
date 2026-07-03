'use strict';

// Pure helpers (exported for unit tests; no DOM access).
function nextAppendOrder(widgets, page) {
  let max = -1;
  Object.keys(widgets || {}).forEach(id => {
    const w = widgets[id];
    if (w && w.page === page && Number.isFinite(w.order)) max = Math.max(max, w.order);
  });
  return max + 1;
}
function otherPage(current, pageIds) {
  const list = Array.isArray(pageIds) ? pageIds : [];
  const i = list.indexOf(current);
  if (i < 0 || list.length < 2) return current;
  return list[(i + 1) % list.length];
}

// Map a page id to its (dynamically generated) grid container element, or null.
// NO "first page" fallback: returning another page's grid would silently dump a
// widget onto the wrong (e.g. previous) page. Callers skip placement when null;
// the widget then renders on the next pass once its page grid exists.
function dashboardPageGrid(pageId) {
  return document.querySelector('[data-page-grid="' + (pageId || '') + '"]') || null;
}

let dashboardLayoutEditing = false;

// Which widgets are safe to clone lives in DashboardInstances.DUPLICABLE_WIDGETS
// (single source of truth, shared with the add/tab flows).

// A System clone keeps its FULL structure — the Sistema / Volume / Microfono tab
// bar and all three panes — so a duplicate behaves like the original rather than a
// stats-only stub. Live values flow in automatically (stats, network, volume and
// mic all fan out across every instance via data-* hooks), but the tab SWITCHING
// must be re-wired per copy: the stock buttons call the global, id-based
// setSystemTab() which drives the PRIMARY tile. We drop those inline handlers and
// bind a handler scoped to this clone's own panes. gpu-caption is a singleton
// device line wired by id (no data hook) and is dropped.
function stripSystemClone(clone) {
  const cap = clone.querySelector('#gpu-caption');
  if (cap) cap.remove();
  wireSystemCloneTabs(clone);
}

// Bind Sistema/Volume/Microfono switching inside one cloned System tile. Panes are
// matched by class (ids are stripped from copies). 'main' shows the stats + the
// "Rete & Gaming" section + the Optimize button; 'volume'/'mic' show their pane.
function wireSystemCloneTabs(clone) {
  const tabs = Array.from(clone.querySelectorAll('.sys-tab'));
  const mainGrid = clone.querySelector('.system-grid:not(.sys-net-grid)');
  const netGrid = clone.querySelector('.sys-net-grid');
  const netLabel = clone.querySelector('.sys-subsection');
  const audioPane = clone.querySelector('.system-audio-pane');
  const micPane = clone.querySelector('.system-mic-pane');
  const optBtn = clone.querySelector('.sys-optimize-btn');
  const setTab = (name) => {
    const onMain = name === 'main';
    tabs.forEach(b => b.classList.toggle('active', b.dataset.systab === name));
    if (mainGrid) mainGrid.hidden = !onMain;
    if (netGrid) netGrid.hidden = !onMain;
    if (netLabel) netLabel.hidden = !onMain;
    if (optBtn) optBtn.hidden = !onMain;
    if (audioPane) audioPane.hidden = name !== 'volume';
    if (micPane) micPane.hidden = name !== 'mic';
  };
  tabs.forEach(b => {
    b.removeAttribute('onclick'); // stock handler targets the primary tile by id
    const name = b.dataset.systab;
    if (!['main', 'volume', 'mic'].includes(name)) { b.remove(); return; }
    b.addEventListener('click', () => setTab(name));
  });
  setTab('main');
}

// A Media clone drops the source picker (binds by id / holds singleton state).
function stripMediaClone(clone) {
  const picker = clone.querySelector('#media-source-picker');
  if (picker) picker.remove();
}
// A Mic clone drops the per-app mixer (singleton, wired by id).
function stripMicClone(clone) {
  const m = clone.querySelector('#mic-apps');
  if (m) m.remove();
}
// An Audio clone drops the per-app mixer (singleton, wired by id).
function stripAudioClone(clone) {
  const m = clone.querySelector('#speaker-apps');
  if (m) m.remove();
}
// A Tasks clone drops the add-row and controls-row (singleton inputs wired by id).
// Copies are display + per-item-action mirrors; adding tasks happens on the primary.
function stripTasksClone(clone) {
  const addRow = clone.querySelector('.tasks-add-row');
  if (addRow) addRow.remove();
  const ctrlRow = clone.querySelector('.tasks-controls-row');
  if (ctrlRow) ctrlRow.remove();
}
// A Timer clone drops the add-section (singleton inputs wired by id).
// Copies mirror the live timer list with full pause/resume/reset/delete per-item controls.
function stripTimerClone(clone) {
  const addSection = clone.querySelector('.timer-add-section');
  if (addSection) addSection.remove();
}
// A Chat clone drops the live AI session DOM that initMediaChat() MOVES into the
// primary chat pane at runtime (the message log, status line, attachment preview
// and the full input row with voice/capture/reset). Those are singletons wired by
// id to the one shared AI session. Copies instead get a read-only log mirror plus
// a thin forwarding input, injected by media.js (mirrorChatCopies). The now-playing
// preview / no-key notice (data-chatf) stay in the clone and are looped per-instance.
function stripChatClone(clone) {
  clone.querySelectorAll('.ai-chat, .ai-status, .ai-attach-preview, .ai-input-row, .ai-voice-view')
    .forEach(el => el.remove());
}
// An Agenda clone strips singleton sub-widget controls (task add-row, timer
// add-section) so the copy doesn't show broken form inputs. The sub-tab toggle
// bar is kept for visual fidelity but becomes inert once IDs are stripped.
// Sub-pane content (events, tasks, notes, timers) is a snapshot of the hub state
// at clone time: panes emptied by an extracted sub-widget show as empty in both
// the original and its copy — this is expected with a single-content model.
function stripAgendaClone(clone) {
  const addRow = clone.querySelector('.tasks-add-row');
  if (addRow) addRow.remove();
  const ctrlRow = clone.querySelector('.tasks-controls-row');
  if (ctrlRow) ctrlRow.remove();
  const timerAdd = clone.querySelector('.timer-add-section');
  if (timerAdd) timerAdd.remove();
}
// Calendar and Notes clones need no special stripping: calendar nav uses inline
// onclick globals, notes has no add-row.
// A Deck clone drops the base deck's rendered key grid (`.deck-root`). Each Deck
// instance now owns its OWN keys, so a copy must NOT inherit the base deck's keys
// from the clone — that's what made a freshly added Deck appear pre-filled. The
// emptied clone is rebuilt from the copy's own (empty) config by Deck.renderAll(),
// called right after copies are materialised, so a new Deck starts blank.
function stripDeckClone(clone) {
  clone.querySelectorAll('.deck-root').forEach(el => el.remove());
}
const CLONE_STRIPPERS = {
  system: stripSystemClone,
  media: stripMediaClone,
  mic: stripMicClone,
  audio: stripAudioClone,
  agenda: stripAgendaClone,
  tasks: stripTasksClone,
  timer: stripTimerClone,
  chat: stripChatClone,
  deck: stripDeckClone,
};
// Prepare a freshly-cloned widget atom for use as a copy: widget-specific strip,
// then remove EVERY id so a clone can never duplicate one (converted fields use
// data-* hooks, not ids).
function stripCloneFor(widget, clone) {
  const fn = CLONE_STRIPPERS[widget];
  if (fn) fn(clone);
  clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
}

// Hub-embedded widgets keep their single live content subtree inside a hub pane
// (System "Microfono"/"Audio" tab, Agenda sub-tabs) until extracted. While a
// widget still lives in its hub, its standalone shell is EMPTY — so a copy must
// be cloned from the live hub content, not from the empty shell, and the add
// flow must duplicate (leaving the hub intact) instead of relocating the
// singleton out of the hub. Maps widget id → hub pane element id.
const WIDGET_HUB_PANE = Object.freeze({
  mic: 'sys-grid-mic',
  audio: 'sys-grid-audio',
  tasks: 'cal-pane-tasks',
  notes: 'cal-pane-notes',
  calendar: 'cal-pane-calendar',
  timer: 'cal-pane-timer',
});
// The hub pane that currently holds a widget's live content, or null when the
// widget is standalone/extracted (content in its own shell). Shared by the add
// flow (dashboard-grid.js) and createCopyAtom.
function dashboardWidgetHubPane(widget) {
  const id = WIDGET_HUB_PANE[widget];
  return id ? document.getElementById(id) : null;
}

// Build a copy's cloned atom: deep clone of the base widget, tagged with its
// instance id and stripped of ids/singleton sub-controls. Shared by the copies
// render pass AND tab-group render (a copy can be a tab member). null if no base.
function createCopyAtom(widget, copyId) {
  const base = document.querySelector('[data-dashboard-widget="' + widget + '"]:not([data-dashboard-instance])');
  if (!base) return null;
  const clone = base.cloneNode(true);
  // If the shell is empty because this hub-embedded widget's live content is
  // still parked in its hub pane, clone that content in — otherwise the copy
  // would be blank.
  if (!clone.children.length) {
    const hub = dashboardWidgetHubPane(widget);
    if (hub) Array.from(hub.children).forEach(child => clone.appendChild(child.cloneNode(true)));
  }
  clone.removeAttribute('id');
  clone.setAttribute('data-dashboard-instance', copyId);
  clone.dataset.dashboardHidden = 'false';
  stripCloneFor(widget, clone);
  return clone;
}

const DASHBOARD_LAYOUT_ICONS = Object.freeze({
  previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5 8.5 12l7 7 1.4-1.4-5.6-5.6 5.6-5.6L15.5 5Z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 19 7-7-7-7-1.4 1.4 5.6 5.6-5.6 5.6L8.5 19Z"/></svg>',
  resize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h6v2H8.4l3.1 3.1-1.4 1.4L7 8.4V11H5V5Zm8 0h6v6h-2V8.4l-3.1 3.1-1.4-1.4L15.6 7H13V5ZM7 15.6l3.1-3.1 1.4 1.4L8.4 17H11v2H5v-6h2v2.6Zm6.9-3.1 3.1 3.1V13h2v6h-6v-2h2.6l-3.1-3.1 1.4-1.4Z"/></svg>',
  hide: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 3.7 3.7 2.3l18 18-1.4 1.4-3.2-3.2A11.5 11.5 0 0 1 12 20C5.5 20 2 12 2 12a18.4 18.4 0 0 1 4.1-5.6L2.3 3.7ZM12 6c6.5 0 10 6 10 6a17.3 17.3 0 0 1-2.8 4.1l-2.4-2.4A5 5 0 0 0 10.3 7.2L8.4 5.3A11.7 11.7 0 0 1 12 6Zm0 12a9.1 9.1 0 0 0 3.6-.8l-2-2A3.4 3.4 0 0 1 12 15.5 3.5 3.5 0 0 1 8.5 12c0-.6.1-1.1.4-1.6L7.5 9A14.9 14.9 0 0 0 4.3 12C5.2 13.6 7.8 18 12 18Z"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c6.5 0 10 7 10 7s-3.5 7-10 7S2 12 2 12s3.5-7 10-7Zm0 2c-4.4 0-7.1 3.8-7.8 5 .7 1.2 3.4 5 7.8 5s7.1-3.8 7.8-5c-.7-1.2-3.4-5-7.8-5Zm0 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a7 7 0 1 1-6.3 4H3l4-4 4 4H7.8A5 5 0 1 0 12 7V5Z"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 16.2-3.5-3.5L4.1 14.1 9 19 20.3 7.7l-1.4-1.4L9 16.2Z"/></svg>',
  savePreset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v16l9-4 9 4V5a2 2 0 0 0-2-2Z"/></svg>',
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
  if (kind === 'widget') {
    // Drag (move) + corner handle (resize) are GridStack's; keep only hide + move-page.
    controls.append(
      createLayoutIconButton('layout-control-btn', 'layout_hide', DASHBOARD_LAYOUT_ICONS.hide, () => hideDashboardLayoutItem(kind, groupId, itemId)),
      createLayoutIconButton('layout-control-btn', 'layout_move_page', DASHBOARD_LAYOUT_ICONS.swap, () => moveDashboardWidgetToPage(itemId)),
    );
  } else {
    controls.append(
      createLayoutIconButton('layout-control-btn', 'layout_move_previous', DASHBOARD_LAYOUT_ICONS.previous, () => moveDashboardLayoutItem(kind, groupId, itemId, -1)),
      createLayoutIconButton('layout-control-btn', 'layout_resize', DASHBOARD_LAYOUT_ICONS.resize, () => cycleDashboardLayoutItemSize(kind, groupId, itemId)),
      createLayoutIconButton('layout-control-btn', 'layout_hide', DASHBOARD_LAYOUT_ICONS.hide, () => hideDashboardLayoutItem(kind, groupId, itemId)),
      createLayoutIconButton('layout-control-btn', 'layout_move_next', DASHBOARD_LAYOUT_ICONS.next, () => moveDashboardLayoutItem(kind, groupId, itemId, 1)),
    );
  }
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
  // Insert into shell flow between topbar and pager so it never overlaps widget handles.
  const pager = document.getElementById('dashboard-pager');
  if (pager && pager.parentElement) {
    pager.parentElement.insertBefore(dock, pager);
  } else {
    document.body.appendChild(dock);
  }
  return dock;
}

// Floating Layout button — the only way back into the editor once the top bar
// is hidden. Created once; CSS shows it solely while `body.topbar-hidden` and not
// editing. Tapping enters edit mode, which re-reveals the bar for full editing.
function ensureLayoutFab() {
  let fab = document.getElementById('layout-fab');
  if (fab) {
    const label = t('layout_customize');
    fab.title = label;
    fab.setAttribute('aria-label', label);
    const span = fab.querySelector('span');
    if (span) span.textContent = t('ui_layout');
    return fab;
  }
  fab = document.createElement('button');
  fab.id = 'layout-fab';
  fab.type = 'button';
  fab.className = 'layout-fab';
  fab.title = t('layout_customize');
  fab.setAttribute('aria-label', t('layout_customize'));
  fab.setAttribute('data-i18n-title', 'layout_customize');
  fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v5H3V3Zm0 7h8v11H3V10Zm10-7h8v11h-8V3Zm0 13h8v5h-8v-5Z"/></svg>';
  const span = document.createElement('span');
  span.setAttribute('data-i18n', 'ui_layout');
  span.textContent = t('ui_layout');
  fab.appendChild(span);
  fab.addEventListener('click', eventObject => {
    eventObject.preventDefault();
    toggleDashboardLayoutEditor();
  });
  const shell = document.querySelector('.shell') || document.body;
  shell.appendChild(fab);
  return fab;
}

// Persist whether the top bar is shown, then re-apply. The bar is hidden as soon
// as the flag is set (CSS hides it even while editing), so "Nascondi" takes
// effect at once and you stay in the editor — the dock chip flips to "Mostra
// barra superiore". The floating Layout button is the way back in once you exit.
function setTopbarHidden(hidden) {
  const layout = getDashboardLayout();
  layout.topbarHidden = !!hidden;
  saveDashboardLayout(layout);
  applyDashboardLayoutWithTransition();
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

// ── Saved presets (widget / tab-group / page templates) ───────────
// Stored in hubSettings.dashboardPresets (server-backed). Capture/insert logic
// lives in DashboardPresets; this layer owns the settings round-trip + dock UI.
function getDashboardPresets() {
  return Array.isArray(hubSettings.dashboardPresets) ? hubSettings.dashboardPresets : [];
}
function setDashboardPresets(list) {
  hubSettings = normalizeSettings({ ...hubSettings, dashboardPresets: list });
  saveHubSettings({ server: true });
}
function _genPresetId() { return 'ps_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// Save THIS tile (a standalone widget/copy, or a whole tab-group) as a preset.
// Called from the per-tile "save" handle (window.saveTilePreset, see below).
function saveTilePreset(gsId) {
  const DP = window.DashboardPresets;
  if (!DP) return;
  const layout = getDashboardLayout();
  const kind = (layout.groups && layout.groups[gsId]) ? 'group' : 'widget';
  const data = DP.capture(layout, kind, gsId, null);
  if (!data) { if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_error', 'error'); return; }
  const fallback = t('preset_kind_' + kind);
  const name = (typeof prompt === 'function') ? prompt(t('preset_name_prompt'), fallback) : fallback;
  if (name === null) return;  // cancelled
  const list = getDashboardPresets().slice();
  list.push({ id: _genPresetId(), name: String(name || '').trim() || fallback, kind, createdAt: Date.now(), data });
  setDashboardPresets(list);
  refreshDashboardLayoutEditor();
}

function saveCurrentPagePreset() {
  const DP = window.DashboardPresets;
  if (!DP) return;
  const layout = getDashboardLayout();
  const pager = window.DashboardPager;
  const pageId = (pager && typeof pager.getCurrentPage === 'function' && pager.getCurrentPage())
    || (layout.pages[0] && layout.pages[0].id);
  const data = DP.capture(layout, 'page', null, pageId);
  if (!data) { if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_error', 'error'); return; }
  const fallback = t('preset_kind_page');
  const name = (typeof prompt === 'function') ? prompt(t('preset_name_prompt'), fallback) : fallback;
  if (name === null) return;
  const list = getDashboardPresets().slice();
  list.push({ id: _genPresetId(), name: String(name || '').trim() || fallback, kind: 'page', createdAt: Date.now(), data });
  setDashboardPresets(list);
  refreshDashboardLayoutEditor();
}

// Insert a saved preset onto the current page (page presets create a new page).
function insertDashboardPreset(presetId) {
  const DP = window.DashboardPresets;
  const preset = getDashboardPresets().find(p => p.id === presetId);
  if (!DP || !preset) return;
  const layout = getDashboardLayout();
  const pager = window.DashboardPager;
  const pageId = (pager && typeof pager.getCurrentPage === 'function' && pager.getCurrentPage())
    || (layout.pages[0] && layout.pages[0].id);
  const res = DP.insertPreset(layout, preset, pageId);
  if (!res || !res.ok) {
    if (res && res.full && typeof setSettingsStatus === 'function') setSettingsStatus('preset_page_limit', 'error');
    return;
  }
  saveDashboardLayout(layout);
  if (preset.kind === 'page' && window.DashboardPages && typeof window.DashboardPages.rebuild === 'function') {
    window.DashboardPages.rebuild();
    if (res.pageId && pager && typeof pager.goToPage === 'function') pager.goToPage(res.pageId);
  } else {
    applyDashboardLayoutWithTransition();
  }
}

function deleteDashboardPreset(presetId) {
  setDashboardPresets(getDashboardPresets().filter(p => p.id !== presetId));
  refreshDashboardLayoutEditor();
}

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

if (typeof window !== 'undefined') {
  window.saveTilePreset = saveTilePreset;
}

function refreshDashboardLayoutEditor() {
  const dock = ensureDashboardLayoutDock();
  const layout = getDashboardLayout();
  dock.replaceChildren();

  // (Hidden top-level widgets are added back via the per-page "+" palette, not here.)
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

  // Twitch widget sections (info / actions / chat) hidden via their card controls.
  const hiddenTwitch = document.createElement('div');
  hiddenTwitch.className = 'layout-chip-list';
  const hiddenTwitchIds = (DASHBOARD_CARD_IDS.twitch || []).filter(cardId => layout.cards.twitch && layout.cards.twitch[cardId] && !layout.cards.twitch[cardId].visible);
  hiddenTwitchIds.forEach(cardId => {
    hiddenTwitch.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'twitch', cardId)));
  });
  if (hiddenTwitchIds.length) appendDashboardDockSection(dock, 'layout_hidden_twitch', hiddenTwitch);

  // OBS widget sections (preview / controls / scenes) hidden via their card controls.
  const hiddenObs = document.createElement('div');
  hiddenObs.className = 'layout-chip-list';
  const hiddenObsIds = (DASHBOARD_CARD_IDS.obs || []).filter(cardId => layout.cards.obs && layout.cards.obs[cardId] && !layout.cards.obs[cardId].visible);
  hiddenObsIds.forEach(cardId => {
    hiddenObs.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'obs', cardId)));
  });
  if (hiddenObsIds.length) appendDashboardDockSection(dock, 'layout_hidden_obs', hiddenObs);

  // YouTube widget sections (status / actions) hidden via their card controls.
  const hiddenYt = document.createElement('div');
  hiddenYt.className = 'layout-chip-list';
  const hiddenYtIds = (DASHBOARD_CARD_IDS.youtube || []).filter(cardId => layout.cards.youtube && layout.cards.youtube[cardId] && !layout.cards.youtube[cardId].visible);
  hiddenYtIds.forEach(cardId => {
    hiddenYt.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'youtube', cardId)));
  });
  if (hiddenYtIds.length) appendDashboardDockSection(dock, 'layout_hidden_youtube', hiddenYt);

  // Page add/remove now lives next to the pager dots in the topbar (see
  // dashboard-pager.js renderDots), so the dock only carries hidden-item
  // restore chips and the Reset/Done actions.

  // Saved presets: reinsert a saved widget / tab-group / page, or save the
  // current page. Always shown so the "save page" action stays reachable.
  appendDashboardDockSection(dock, 'preset_my', buildDashboardPresetsSection());

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
  appendDashboardDockSection(dock, 'layout_topbar', topbarChips);

  const actions = document.createElement('div');
  actions.className = 'layout-chip-list layout-action-list';
  actions.append(
    createDashboardChip('layout_reset', 'layout_reset', DASHBOARD_LAYOUT_ICONS.reset, resetDashboardLayout, 'danger'),
    createDashboardChip('layout_exit', 'layout_exit', DASHBOARD_LAYOUT_ICONS.done, () => setDashboardLayoutEditMode(false), 'primary'),
  );
  dock.appendChild(actions);

  // Re-render the pager dots so the add/remove-page controls reflect the
  // current edit state (they live next to the dots, in the topbar).
  if (window.DashboardPager && typeof window.DashboardPager.renderDots === 'function') {
    window.DashboardPager.renderDots();
  }
}

function applyDashboardWidgets(layout) {
  const groups = layout.groups || {};
  const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(groups, id) : null);
  // 1) standalone widgets (not members of any group)
  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    const preferences = layout.widgets[widgetId];
    const tile = document.querySelector(`[data-dashboard-widget="${widgetId}"]`);
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
      ownContent.appendChild(tile);
    }
    const item = tile.closest('.grid-stack-item') || tile;
    if (!preferences.visible) {
      const pool = document.getElementById('widget-pool');
      if (pool && item.parentElement !== pool) {
        const fromGrid = item.parentElement && item.parentElement.gridstack;
        if (fromGrid) { try { fromGrid.removeWidget(item, false); } catch (e) { /* ignore */ } }
        pool.appendChild(item);
      }
      return;
    }
    const targetGrid = dashboardPageGrid(preferences.page);
    if (!targetGrid) return; // page grid not built yet → leave in pool, place next pass
    if (item.parentElement !== targetGrid) targetGrid.appendChild(item);
    if (window.DashboardGrid && targetGrid.gridstack) {
      window.DashboardGrid.applyWidgetGeometry(targetGrid.gridstack, item, preferences);
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
    if (item.parentElement !== targetGrid) targetGrid.appendChild(item);
    if (window.DashboardTabGroups) window.DashboardTabGroups.renderGroupTile(item, g);
    if (window.DashboardGrid && targetGrid.gridstack) {
      window.DashboardGrid.applyWidgetGeometry(targetGrid.gridstack, item, g);
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
    if (item.parentElement !== targetGrid) targetGrid.appendChild(item);
    if (window.DashboardGrid && targetGrid.gridstack) {
      window.DashboardGrid.applyWidgetGeometry(targetGrid.gridstack, item, copy);
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
          pool.appendChild(it);
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
  step('syncNotes', () => { if (typeof syncNotesWidgetPlacement === 'function') syncNotesWidgetPlacement(); });
  step('syncCalendar', () => { if (typeof syncCalendarWidgetPlacement === 'function') syncCalendarWidgetPlacement(); });
  step('syncTimer', () => { if (typeof syncTimerWidgetPlacement === 'function') syncTimerWidgetPlacement(); });
  step('syncAudio', () => { if (typeof syncAudioWidgetPlacement === 'function') syncAudioWidgetPlacement(); });
  step('syncMic', () => { if (typeof syncMicWidgetPlacement === 'function') syncMicWidgetPlacement(); });
  step('widgets', () => applyDashboardWidgets(layout));
  step('weatherRender', () => { if (typeof renderWeatherTile === 'function') renderWeatherTile(); });
  step('deckRender', () => { if (window.Deck && typeof window.Deck.renderAll === 'function') window.Deck.renderAll(); });
  step('remoteRender', () => { if (window.RemoteControl && typeof window.RemoteControl.renderWidgets === 'function') window.RemoteControl.renderWidgets(); });
  step('streamRender', () => { if (window.StreamingPage && typeof window.StreamingPage.renderWidgets === 'function') window.StreamingPage.renderWidgets(); });
  step('obsRender', () => { if (window.ObsWidget && typeof window.ObsWidget.renderWidgets === 'function') window.ObsWidget.renderWidgets(); });
  step('ytRender', () => { if (window.YouTubeWidget && typeof window.YouTubeWidget.renderWidgets === 'function') window.YouTubeWidget.renderWidgets(); });
  step('discordRender', () => { if (window.DiscordWidget && typeof window.DiscordWidget.renderWidgets === 'function') window.DiscordWidget.renderWidgets(); });
  step('spotifyRender', () => { if (window.SpotifyWidget && typeof window.SpotifyWidget.renderWidgets === 'function') window.SpotifyWidget.renderWidgets(); });
  step('sbRender', () => { if (window.StreamerbotWidget && typeof window.StreamerbotWidget.renderWidgets === 'function') window.StreamerbotWidget.renderWidgets(); });
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
  // Hide the top bar entirely when the user opted out of it — but never while
  // editing, so the full toolset (pager dots, page add/remove, Done) stays
  // reachable. A floating Layout button (below) re-opens the editor.
  document.body.classList.toggle('topbar-hidden', layout.topbarHidden === true);
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

function swapDashboardSystemTabs() {
  const layout = getDashboardLayout();
  layout.tabs.order = layout.tabs.order.slice().reverse();
  saveDashboardLayout(layout);
  applyDashboardLayout();
}

// Reset is scoped to the page the user is looking at — the old full-layout
// wipe also deleted every user-created page, which is real data loss.
// • Stock page → restore its default modules/geometry (other pages untouched).
// • User-created page → keep the page and its modules, re-pack them tidily.
// • Single stock page (no custom pages) → classic full reset, tabs included.
function resetDashboardLayout() {
  const layout = getDashboardLayout();
  const pageIds = layout.pages.map(p => p.id);
  const pager = window.DashboardPager;
  const focused = (pager && typeof pager.getCurrentPage === 'function') ? pager.getCurrentPage() : null;
  const pageId = pageIds.includes(focused) ? focused : pageIds[0];
  const defaultPageId = DEFAULT_DASHBOARD_LAYOUT.pages[0].id;

  if (pageId === defaultPageId && layout.pages.length <= 1) {
    saveDashboardLayout(normalizeDashboardLayout(null));
  } else if (pageId === defaultPageId) {
    // Drop copies and tab-groups living on this page, then restore the stock
    // geometry/visibility for the widgets currently here. Widgets the user
    // moved to other pages are deliberately left where they are.
    layout.copies = (Array.isArray(layout.copies) ? layout.copies : []).filter(c => c.page !== pageId);
    Object.keys(layout.groups || {}).forEach(gid => {
      if (layout.groups[gid] && layout.groups[gid].page === pageId) delete layout.groups[gid];
    });
    DASHBOARD_WIDGET_IDS.forEach(id => {
      if (layout.widgets[id] && layout.widgets[id].page === pageId) {
        layout.widgets[id] = Object.assign({}, DEFAULT_DASHBOARD_LAYOUT.widgets[id]);
      }
    });
    // Re-seed the default groups (e.g. the media/chat tab-group), but only
    // with members that actually live on this page right now.
    Object.keys(DEFAULT_DASHBOARD_LAYOUT.groups).forEach(gid => {
      const g = DEFAULT_DASHBOARD_LAYOUT.groups[gid];
      if (g.page !== pageId) return;
      const members = g.members.filter(m => layout.widgets[m] && layout.widgets[m].page === pageId);
      if (members.length >= 2) layout.groups[gid] = Object.assign({}, g, { members });
    });
    saveDashboardLayout(layout);
  } else {
    // Custom page: never delete it from a reset — just tidy its modules.
    if (window.DashboardGrid && typeof window.DashboardGrid.packPageItems === 'function') {
      window.DashboardGrid.packPageItems(layout, pageId);
    }
    saveDashboardLayout(layout);
  }
  // The page list may have changed — the pager sections must be regenerated,
  // or modules whose page no longer has a grid fall back to page 1.
  if (window.DashboardPages && typeof window.DashboardPages.rebuild === 'function') window.DashboardPages.rebuild();
  else applyDashboardLayout();
  if (pager && typeof pager.goToPage === 'function') pager.goToPage(pageId);
}

function initDashboardLayout() {
  applyDashboardLayout();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextAppendOrder, otherPage };
}
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
  // Tabs inherit the primary's hidden state, so a copy made while Volume and
  // Microfono are extracted would show a bar holding only "Sistema".
  // Queried off the bar (not the captured `tabs`) because the clone is still
  // detached here, so the removals above are only visible through the subtree.
  const cloneBar = clone.querySelector('.system-tabs-left');
  if (cloneBar && Array.from(cloneBar.querySelectorAll('.sys-tab')).filter(b => !b.hidden).length <= 1) {
    cloneBar.style.display = 'none';
  }
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
// add-section) so the copy doesn't show broken form inputs, then re-wires its
// sub-tab bar the same way a System copy gets one.
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
  wireAgendaCloneTabs(clone);
}

// Bind Calendario/Task/Timer/Appunti switching inside one cloned Agenda tile.
// The bar used to be left with its stock inline onclick, which resolves panes
// and buttons through getElementById — and stripCloneFor removes every id from a
// copy, so those lookups landed on the PRIMARY tile instead. Clicking a tab on a
// copy silently switched an Agenda that was off screen (pooled, or on another
// page) and persisted the choice, so the copy only ever caught up on the next
// reload, when it is re-cloned from the primary. Match panes by data-calpane,
// exactly as wireSystemCloneTabs matches by class.
function wireAgendaCloneTabs(clone) {
  const tabs = Array.from(clone.querySelectorAll('.cal-task-btn'));
  const panes = new Map();
  clone.querySelectorAll('.cal-pane').forEach(p => {
    if (p.dataset.calpane) panes.set(p.dataset.calpane, p);
  });
  if (!tabs.length || !panes.size) return;
  const setTab = (name) => {
    if (!panes.has(name)) return;
    panes.forEach((pane, key) => { pane.hidden = key !== name; });
    tabs.forEach(b => {
      const active = b.dataset.caltab === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
  };
  tabs.forEach(b => {
    b.removeAttribute('onclick'); // stock handler targets the primary tile by id
    const name = b.dataset.caltab;
    if (!panes.has(name)) { b.remove(); return; }
    b.addEventListener('click', () => setTab(name));
  });
  // Tabs inherit the primary's hidden state, so a copy made while Task/Timer/
  // Appunti are extracted would show a bar holding only "Calendario". Queried
  // off the bar (not the captured `tabs`) because the clone is still detached
  // here, so the removals above are only visible through the subtree.
  const bar = clone.querySelector('.cal-task-toggle');
  const visible = bar ? Array.from(bar.querySelectorAll('.cal-task-btn')).filter(b => !b.hidden) : [];
  if (bar && visible.length <= 1) bar.style.display = 'none';
  // Seed from the state the clone inherited. An extracted (hidden) active tab
  // falls back to the first tab still in the bar, never a blank pane.
  const seed = visible.find(b => b.classList.contains('active')) || visible[0];
  if (seed) setTab(seed.dataset.caltab);
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
// A Custom-widget clone must not inherit the base tile's built shell (or its
// live sandboxed iframe): reset the mount so the copy renders fresh for its own
// instance id / package assignment.
function stripCustomClone(clone) {
  clone.querySelectorAll('.custom-widget-mount').forEach(el => {
    el.replaceChildren();
    delete el.dataset.cwBuilt;
  });
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
  custom: stripCustomClone,
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
  collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 8.6 6 6-1.4 1.4-4.6-4.6-4.6 4.6L6 14.6l6-6Z"/></svg>',
  grip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5a1.6 1.6 0 1 1-3.2 0A1.6 1.6 0 0 1 9 5Zm0 7a1.6 1.6 0 1 1-3.2 0A1.6 1.6 0 0 1 9 12Zm0 7a1.6 1.6 0 1 1-3.2 0A1.6 1.6 0 0 1 9 19Zm9.2-14a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Zm0 7a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Zm0 7a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Z"/></svg>',
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10l-3-3 1.4-1.4L20.8 8l-5.4 5.4L14 12l3-3H7V7Zm10 10H7l3 3-1.4 1.4L3.2 16l5.4-5.4L10 12l-3 3h10v2Z"/></svg>',
});

function getDashboardLayout() {
  return normalizeDashboardLayout(hubSettings && hubSettings.dashboardLayout);
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
  // Widget controls must sit ABOVE the grid's drag hit-surface (.gs-edit-overlay,
  // z-index 40 inside .grid-stack-item-content). A widget panel isolates its own
  // stacking context (isolation: isolate), so controls appended INSIDE the panel
  // are trapped below that overlay and can't be clicked — the click lands on the
  // overlay and starts a drag instead (the "only the move hand" report). Host the
  // widget controls on the grid-item content, a sibling of the overlay just like
  // the other edit handles (gs-size-cycle, gs-add-tab…), so their z-index 60 wins.
  // Cards are not grid items and keep hosting their own controls.
  const host = (kind === 'widget' && element.closest('.grid-stack-item-content')) || element;
  const existingControls = findDirectLayoutControls(host, kind);
  if (existingControls) existingControls.remove();
  // Clean up any stale controls left directly on the panel by an earlier build.
  if (host !== element) {
    const strayControls = findDirectLayoutControls(element, kind);
    if (strayControls) strayControls.remove();
  }
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
  host.appendChild(controls);
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
  // A viewport change (rotation, window resize, another surface) can leave a
  // free-dragged capsule off-screen — pull it back in whenever that happens.
  window.addEventListener('resize', () => {
    if (dashboardLayoutEditing) clampDashboardDock(dock);
  });
  return dock;
}

// Device-local chrome for the edit dock: collapsed body + a free-dragged
// position for the floating (minimal-topbar) capsule. Kept in localStorage, not
// hubSettings — where the toolbar sits depends on the display and layout of THIS
// screen, so the choice must not sync across devices.
const DASHBOARD_DOCK_STATE_KEY = 'xeneonedge.layoutDock.v1';

function getDashboardDockState() {
  try {
    const raw = JSON.parse(localStorage.getItem(DASHBOARD_DOCK_STATE_KEY) || '{}') || {};
    return {
      collapsed: typeof raw.collapsed === 'boolean' ? raw.collapsed : null,
      // Free-drag position (px from viewport top-left); null → CSS default (centred, top).
      x: Number.isFinite(raw.x) ? raw.x : null,
      y: Number.isFinite(raw.y) ? raw.y : null,
    };
  } catch {
    return { collapsed: null, x: null, y: null };
  }
}

function saveDashboardDockState(patch) {
  const next = Object.assign(getDashboardDockState(), patch);
  try { localStorage.setItem(DASHBOARD_DOCK_STATE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
}

// Keep the floating capsule fully on-screen (it may have been dragged near an
// edge, or the viewport/expanded height may have changed since). Clamps the
// inline top/left; leaves the CSS-centred default untouched when unpositioned.
function clampDashboardDock(dock) {
  if (!dock.style.left && !dock.style.top) return; // still on the CSS default
  const margin = 8;
  const bottomInset = (document.body.classList.contains('xe-has-ticker')
    && document.body.classList.contains('xe-ticker-bottom')) ? 42 : margin;
  // Under the native interface-scale (CSS `zoom` on <html>, native-bridge.js)
  // getBoundingClientRect is in the rendered ×zoom space while inline px render
  // ×zoom — so clamp in the rendered space, then divide the result back to inline
  // px. `__pageZoom` is 1 (no-op) on every non-zoomed surface.
  const z = window.__pageZoom && window.__pageZoom > 0 ? window.__pageZoom : 1;
  const vpW = window.innerWidth, vpH = window.innerHeight;
  const r = dock.getBoundingClientRect();
  const maxLeft = Math.max(margin, vpW - r.width - margin);
  const maxTop = Math.max(margin, vpH - r.height - bottomInset);
  const left = Math.min(Math.max(r.left, margin), maxLeft);
  const top = Math.min(Math.max(r.top, margin), maxTop);
  dock.style.left = (left / z) + 'px';
  dock.style.top = (top / z) + 'px';
  // Safety net: if the toolbar still isn't on-screen (a zoom coordinate mismatch,
  // or a stored position from a different viewport), drop back to the CSS-centred
  // default — which is always reachable — rather than leave it stuck off-screen.
  const rr = dock.getBoundingClientRect();
  if (rr.right < 24 || rr.bottom < 24 || rr.left > vpW - 24 || rr.top > vpH - 24) {
    dock.style.left = dock.style.top = dock.style.right = dock.style.bottom = dock.style.margin = '';
    saveDashboardDockState({ x: null, y: null });
  }
}

// Apply the stored free-drag position. Only meaningful while the capsule floats
// (minimal topbar); in the in-flow full-topbar layout the grid row owns its
// placement, so any leftover inline positioning is cleared.
function applyDashboardDockPosition(dock, state, floating) {
  if (!floating || state.x === null || state.y === null) {
    dock.style.left = dock.style.top = dock.style.right = dock.style.bottom = dock.style.margin = '';
    return;
  }
  const z = (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
  dock.style.left = (state.x / z) + 'px';
  dock.style.top = (state.y / z) + 'px';
  dock.style.right = 'auto';
  dock.style.bottom = 'auto';
  dock.style.margin = '0';
  requestAnimationFrame(() => clampDashboardDock(dock));
}

// Make the capsule draggable by its header bar (pointer = mouse + touch). Buttons
// keep working — a press that starts on a button is ignored — and a tiny movement
// threshold means a tap never counts as a drag. Only active while floating.
function makeDashboardDockDraggable(dock, bar) {
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  bar.addEventListener('pointerdown', eventObject => {
    if (!document.body.classList.contains('topbar-minimal')) return; // floating only
    if (eventObject.target.closest('button')) return;                // let the chips work
    if (eventObject.button != null && eventObject.button !== 0) return;
    const r = dock.getBoundingClientRect();
    originLeft = r.left;
    originTop = r.top;
    startX = eventObject.clientX;
    startY = eventObject.clientY;
    dragging = true;
    moved = false;
    // Switch to explicit top/left so the margin-auto centring stops fighting the
    // drag. getBoundingClientRect is in the rendered ×zoom space; inline px render
    // ×zoom, so divide back (no-op at zoom 1).
    const z0 = (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
    dock.style.left = (originLeft / z0) + 'px';
    dock.style.top = (originTop / z0) + 'px';
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
    dock.style.margin = '0';
    dock.classList.add('is-dragging');
    try { bar.setPointerCapture(eventObject.pointerId); } catch { /* capture optional */ }
  });

  bar.addEventListener('pointermove', eventObject => {
    if (!dragging) return;
    const dx = eventObject.clientX - startX;
    const dy = eventObject.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    const r = dock.getBoundingClientRect();
    const z0 = (window.__pageZoom && window.__pageZoom > 0) ? window.__pageZoom : 1;
    const maxLeft = Math.max(8, window.innerWidth - r.width - 8);
    const maxTop = Math.max(8, window.innerHeight - r.height - 8);
    dock.style.left = (Math.min(Math.max(originLeft + dx, 8), maxLeft) / z0) + 'px';
    dock.style.top = (Math.min(Math.max(originTop + dy, 8), maxTop) / z0) + 'px';
  });

  const endDrag = eventObject => {
    if (!dragging) return;
    dragging = false;
    dock.classList.remove('is-dragging');
    try { bar.releasePointerCapture(eventObject.pointerId); } catch { /* ignore */ }
    if (moved) {
      const r = dock.getBoundingClientRect();
      saveDashboardDockState({ x: Math.round(r.left), y: Math.round(r.top) });
    }
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

// Slim header row that stays visible even when the dock body is collapsed:
// a drag grip, the expand/collapse toggle, and the Reset/Done actions — so
// ending an edit never needs a re-expand, and the capsule can be dragged clear
// of whatever you're editing.
function buildDashboardDockBar(dock, collapsed) {
  const bar = document.createElement('div');
  bar.className = 'layout-dock-bar';

  const grip = document.createElement('span');
  grip.className = 'layout-dock-grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.title = t('layout_dock_move');
  grip.innerHTML = DASHBOARD_LAYOUT_ICONS.grip;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'layout-chip layout-dock-toggle';
  const toggleLabel = t(collapsed ? 'layout_dock_expand' : 'layout_dock_collapse');
  toggle.title = toggleLabel;
  toggle.setAttribute('aria-label', toggleLabel);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.innerHTML = DASHBOARD_LAYOUT_ICONS.collapse;
  const toggleText = document.createElement('span');
  toggleText.textContent = t('layout_customize');
  toggle.appendChild(toggleText);
  toggle.addEventListener('click', eventObject => {
    eventObject.preventDefault();
    eventObject.stopPropagation();
    saveDashboardDockState({ collapsed: !collapsed });
    refreshDashboardLayoutEditor();
    // In-flow (full topbar) mode the dock height changes the pager row height.
    if (window.DashboardGrid && window.DashboardGrid.fitGridHeights) {
      requestAnimationFrame(() => window.DashboardGrid.fitGridHeights());
    }
  });

  const spacer = document.createElement('div');
  spacer.className = 'layout-dock-spacer';

  bar.append(
    grip,
    toggle,
    spacer,
    createDashboardChip('layout_reset', 'layout_reset', DASHBOARD_LAYOUT_ICONS.reset, resetDashboardLayout, 'danger'),
    createDashboardChip('layout_exit', 'layout_exit', DASHBOARD_LAYOUT_ICONS.done, () => setDashboardLayoutEditMode(false), 'primary'),
  );
  makeDashboardDockDraggable(dock, bar);
  return bar;
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

function appendDashboardDockSection(dockBody, titleKey, contentElement) {
  const section = document.createElement('div');
  section.className = 'layout-dock-section';
  const title = document.createElement('div');
  title.className = 'layout-dock-title';
  title.textContent = t(titleKey);
  section.append(title, contentElement);
  dockBody.appendChild(section);
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
  // gridCols stamps the geometry units — without it normalizePresets would
  // treat the entry as a legacy 12-column preset and double it. Read the value
  // from the SAME constant normalizePresets compares against, so the write and
  // read side of the invariant can never drift apart.
  list.push({ id: _genPresetId(), name: String(name || '').trim() || fallback, kind, createdAt: Date.now(), gridCols: DP.PRESET_GRID_COLUMNS, data });
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
  list.push({ id: _genPresetId(), name: String(name || '').trim() || fallback, kind: 'page', createdAt: Date.now(), gridCols: DP.PRESET_GRID_COLUMNS, data });
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
    return res || { ok: false };
  }
  saveDashboardLayout(layout);
  if (preset.kind === 'page' && window.DashboardPages && typeof window.DashboardPages.rebuild === 'function') {
    window.DashboardPages.rebuild();
    if (res.pageId && pager && typeof pager.goToPage === 'function') pager.goToPage(res.pageId);
  } else {
    applyDashboardLayoutWithTransition();
  }
  return res;
}

function deleteDashboardPreset(presetId) {
  setDashboardPresets(getDashboardPresets().filter(p => p.id !== presetId));
  if (window.forgetInstalledContentResource) window.forgetInstalledContentResource('pagePresetIds', presetId);
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
  // bandwidth) is orphaned with no way to restore it. (GitHub issue: Forlin-77)
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

  // Twitch widget sections (info / actions / chat) hidden via their card controls.
  const hiddenTwitch = document.createElement('div');
  hiddenTwitch.className = 'layout-chip-list';
  const hiddenTwitchIds = (DASHBOARD_CARD_IDS.twitch || []).filter(cardId => layout.cards.twitch && layout.cards.twitch[cardId] && !layout.cards.twitch[cardId].visible);
  hiddenTwitchIds.forEach(cardId => {
    hiddenTwitch.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'twitch', cardId)));
  });
  if (hiddenTwitchIds.length) appendDashboardDockSection(dockBody, 'layout_hidden_twitch', hiddenTwitch);

  // OBS widget sections (preview / controls / scenes) hidden via their card controls.
  const hiddenObs = document.createElement('div');
  hiddenObs.className = 'layout-chip-list';
  const hiddenObsIds = (DASHBOARD_CARD_IDS.obs || []).filter(cardId => layout.cards.obs && layout.cards.obs[cardId] && !layout.cards.obs[cardId].visible);
  hiddenObsIds.forEach(cardId => {
    hiddenObs.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'obs', cardId)));
  });
  if (hiddenObsIds.length) appendDashboardDockSection(dockBody, 'layout_hidden_obs', hiddenObs);

  // YouTube widget sections (status / actions) hidden via their card controls.
  const hiddenYt = document.createElement('div');
  hiddenYt.className = 'layout-chip-list';
  const hiddenYtIds = (DASHBOARD_CARD_IDS.youtube || []).filter(cardId => layout.cards.youtube && layout.cards.youtube[cardId] && !layout.cards.youtube[cardId].visible);
  hiddenYtIds.forEach(cardId => {
    hiddenYt.appendChild(createDashboardChip(dashboardLabelKey('card', cardId), 'layout_restore', DASHBOARD_LAYOUT_ICONS.restore, () => restoreDashboardLayoutItem('card', 'youtube', cardId)));
  });
  if (hiddenYtIds.length) appendDashboardDockSection(dockBody, 'layout_hidden_youtube', hiddenYt);

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
  targetGrid.appendChild(item);
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
function tileHexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return '';
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}` : '';
}
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
function tileGradCss(grad) {
  if (!grad || !grad.c1 || !grad.c2) return '';
  const ang = (typeof grad.angle === 'number') ? grad.angle : 135;
  return `linear-gradient(${ang}deg, ${grad.c1}, ${grad.c2})`;
}
// Paint a "gradient over optional image" background on a layer element, the
// image honouring a fit mode ('cover' | 'contain' | 'tile') while a present
// gradient always covers. Shared by the tile decor bg layer and the Deck well
// background (deck.js) so the two composition rules can't drift.
function paintDecorBgLayer(node, grad, src, fit) {
  const img = cssUrl(src);
  node.style.backgroundImage = [grad, img].filter(Boolean).join(', ');   // gradient over image
  const rep = fit === 'tile' ? 'repeat' : 'no-repeat';
  node.style.backgroundRepeat = grad && img ? `no-repeat, ${rep}` : rep;
  const sz = fit === 'tile' ? 'auto' : fit;
  node.style.backgroundSize = grad && img ? `cover, ${sz}` : (grad ? 'cover' : sz);
  node.style.backgroundPosition = 'center';
}
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
  if (content) {
    content.querySelectorAll(':scope > .tile-decor-bg, :scope > .tile-decor-frame, :scope > .tile-decor-overlays')
      .forEach(n => n.remove());
    content.style.removeProperty('--tile-frame-inset');
  }
}
// Build the decor layers for one tile from its (already-normalized) decor object.
function buildTileDecor(el, content, decor) {
  if (!content || !decor) return;
  el.setAttribute('data-tile-decor', '');
  // Background — first child so it sits behind the content stack. An image, a
  // colour gradient, or both (gradient layered over the image as a tint).
  if (decor.bg) {
    const bgSrc = safeTileImageSrc(decor.bg.src);
    const grad = tileGradCss(decor.bg.grad);
    if (bgSrc || grad) {
      const layer = document.createElement('div');
      layer.className = 'tile-decor-bg';
      layer.setAttribute('aria-hidden', 'true');
      paintDecorBgLayer(layer, grad, bgSrc, decor.bg.fit || 'cover');
      if (typeof decor.bg.blur === 'number' && decor.bg.blur > 0) layer.style.filter = `blur(${decor.bg.blur}px)`;
      if (typeof decor.bg.opacity === 'number') layer.style.opacity = String(decor.bg.opacity / 100);
      if (typeof decor.bg.dim === 'number' && decor.bg.dim > 0) layer.style.setProperty('--tile-bg-dim', String(decor.bg.dim / 100));
      content.insertBefore(layer, content.firstChild);
    }
  }
  // Ornamental frame — a 9-slice border-image so corners stay crisp on any tile
  // aspect ratio (curated art authors its border band at 1/3 of the viewBox).
  const frameSrc = tileFrameSrc(decor.frame);
  if (frameSrc) {
    const frame = document.createElement('div');
    frame.className = 'tile-decor-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.borderImageSource = cssUrl(frameSrc);
    const w = (decor.frame && typeof decor.frame.width === 'number' && decor.frame.width > 0) ? decor.frame.width : 16;
    frame.style.borderWidth = `${w}px`;
    content.appendChild(frame);
    // Inset the widget content so it doesn't collide with the frame band.
    content.style.setProperty('--tile-frame-inset', `${Math.round(w * 0.6)}px`);
  }
  // Decorative overlays — non-interactive, above the content.
  if (Array.isArray(decor.overlays) && decor.overlays.length) {
    const wrap = document.createElement('div');
    wrap.className = 'tile-decor-overlays';
    wrap.setAttribute('aria-hidden', 'true');
    decor.overlays.forEach((ov) => {
      const src = tileOverlaySrc(ov);
      if (!src) return;
      const img = document.createElement('img');
      img.className = 'tile-decor-overlay';
      img.alt = '';
      img.loading = 'lazy';
      img.src = src;
      img.style.width = `${ov.size || 40}%`;
      const tf = [];
      // Free placement (x/y percent, overlay centre) wins over the coarse anchor.
      if (typeof ov.x === 'number' && typeof ov.y === 'number') {
        img.style.left = `${ov.x}%`;
        img.style.top = `${ov.y}%`;
        tf.push('translate(-50%, -50%)');
      } else {
        const pos = TILE_OVERLAY_ANCHOR_CSS[ov.anchor] || TILE_OVERLAY_ANCHOR_CSS['bottom-right'];
        ['top', 'right', 'bottom', 'left'].forEach(p => { if (pos[p] != null) img.style[p] = pos[p]; });
        if (pos.tx || pos.ty) tf.push(`translate(${pos.tx || '0'}, ${pos.ty || '0'})`);
      }
      if (ov.flip) tf.push('scaleX(-1)');
      if (typeof ov.rotate === 'number' && ov.rotate) tf.push(`rotate(${ov.rotate}deg)`);
      if (tf.length) img.style.transform = tf.join(' ');
      if (typeof ov.opacity === 'number') img.style.opacity = String(ov.opacity / 100);
      wrap.appendChild(img);
    });
    if (wrap.childElementCount) content.appendChild(wrap);
  }
}

function applyTileStyle(el, style) {
  if (!el) return;
  delete el._xenonThemeOverrides;
  ['--bg', '--surface', '--surface-alt', '--surface-raised', '--surface-subtle', '--surface-strong',
    '--control-bg', '--input-bg', '--hover-bg', '--active-bg', '--selection-bg', '--selection-text',
    '--surface-rgb', '--surface-alt-rgb', '--control-rgb', '--accent', '--green', '--accent-rgb',
    '--panel-rgb', '--panel-soft-rgb', '--panel-alpha', '--text', '--text-muted', '--text-dim',
    '--muted-text', '--dim-text', '--line', '--line-rgb', '--border', '--divider', '--on-accent',
    '--color-success', '--color-warn', '--color-danger', '--color-info',
    '--success-rgb', '--warning-rgb', '--danger-rgb', '--info-rgb',
    '--success-bg', '--warning-bg', '--danger-bg', '--info-bg',
    '--on-success', '--on-warning', '--on-danger', '--on-info', '--red', '--amber', '--cyan',
    '--panel', '--panel-soft', '--panel-border', '--glass-bg', '--glass-border',
    '--oled-bg-rgb', '--oled-border', '--slider-fill', '--slider-track',
    '--tile-font', '--radius', '--radius-control', '--radius-tile', '--radius-modal',
    '--glass-blur', '--glass-saturate', '--panel-border-alpha', '--panel-shadow-alpha']
    .forEach(p => el.style.removeProperty(p));
  const content = el.querySelector(':scope > .grid-stack-item-content');
  // Decor layers are managed DOM, torn down and rebuilt every repaint.
  clearTileDecor(el, content);
  // Some tile content roots re-declare --text locally under the Light theme (the
  // "dark island" readability fix on .media-panel / .deck-root), which would
  // defeat a value merely inherited from the wrapper. Mirror ONLY --text onto
  // those roots as an inline value (inline wins over the stylesheet); accent /
  // panel stay on the wrapper so per-track album-art accent isn't disturbed.
  // Decor layers are excluded — they never carry widget text.
  const contentRoots = content
    ? Array.from(content.children).filter(c => !/^tile-decor/.test(c.className || ''))
    : [];
  // The widget's own root (panel/dashboard-widget) — where a panel gradient paints.
  const panelRoots = contentRoots.filter(c => /(?:^|\s)(?:panel|dashboard-widget)(?:\s|$)/.test(c.className || ''));
  contentRoots.forEach(r => ['--text', '--muted-text', '--dim-text', '--on-accent'].forEach(p => r.style.removeProperty(p)));
  // Clear any inline panel gradient from a previous paint (only ever set by us).
  panelRoots.forEach(r => r.style.removeProperty('background-image'));
  // Decor (images + effects) applies independently of the colour-token mode, so a
  // tile can carry a dragon overlay while still following the global theme colours.
  if (style && style.decor) buildTileDecor(el, content, style.decor);
  if (!style || style.mode !== 'custom') {
    if (style && style.decor) { el.setAttribute('data-tile-style', 'custom'); return; }
    el.removeAttribute('data-tile-style');
    return;
  }
  el.setAttribute('data-tile-style', 'custom');
  el._xenonThemeOverrides = [
    'accent', 'panel', 'surfaceAlt', 'controlColor', 'text', 'mutedText',
    'lineColor', 'accentText', 'successColor', 'warningColor',
    'dangerColor', 'infoColor',
  ].filter(key => !!style[key]);
  const globalPalette = (typeof window.getEffectiveThemePalette === 'function')
    ? window.getEffectiveThemePalette()
    : null;
  if (globalPalette && window.ThemePalette) {
    const tilePalette = ThemePalette.derive({
      background: globalPalette.background,
      surface: style.panel || globalPalette.surface,
      surfaceAlt: style.surfaceAlt || globalPalette.surfaceAlt,
      controlColor: style.controlColor || globalPalette.control,
      accent: style.accent || globalPalette.accent,
      text: style.text || globalPalette.text,
      mutedText: style.mutedText || globalPalette.muted,
      lineColor: style.lineColor || globalPalette.line,
      accentText: style.accentText || globalPalette.onAccent,
      successColor: style.successColor || globalPalette.success,
      warningColor: style.warningColor || globalPalette.warning,
      dangerColor: style.dangerColor || globalPalette.danger,
      infoColor: style.infoColor || globalPalette.info,
      contrastGuard: typeof style.contrastGuard === 'boolean' ? style.contrastGuard : globalPalette.guard,
    }, globalPalette.tone);
    Object.entries(ThemePalette.cssTokens(tilePalette)).forEach(([key, value]) => el.style.setProperty(key, value));
    const material = {
      '--surface-raised': 'var(--surface-alt)',
      '--surface-subtle': 'color-mix(in srgb, var(--surface), var(--text) 5%)',
      '--surface-strong': 'color-mix(in srgb, var(--surface), var(--text) 10%)',
      '--hover-bg': 'color-mix(in srgb, var(--surface), var(--text) 7%)',
      '--active-bg': 'color-mix(in srgb, var(--surface), var(--accent) 18%)',
      '--input-bg': 'var(--control-bg)',
      '--divider': 'color-mix(in srgb, var(--line), transparent 28%)',
      '--selection-bg': 'color-mix(in srgb, var(--accent), var(--surface) 76%)',
      '--selection-text': 'var(--text)',
      // These aliases must be rebuilt at tile scope. Inheriting their root
      // computed values would leave a custom widget painted with global colours.
      '--panel': 'rgba(var(--panel-rgb), var(--panel-alpha))',
      '--panel-soft': 'rgba(var(--panel-soft-rgb), var(--panel-soft-alpha))',
      '--panel-border': 'rgba(var(--line-rgb), var(--panel-border-alpha))',
      '--glass-bg': 'linear-gradient(135deg, color-mix(in srgb, var(--surface) 90%, white), var(--surface) 58%, var(--surface-alt))',
      '--glass-border': 'var(--line)',
      '--oled-bg-rgb': 'var(--surface-rgb)',
      '--oled-border': 'var(--line)',
      '--slider-fill': 'var(--accent)',
      '--slider-track': 'var(--control-bg)',
    };
    Object.entries(material).forEach(([key, value]) => el.style.setProperty(key, value));
  }
  // Panel background as a two-colour gradient (overrides the flat panel colour).
  // Set inline on the widget's own root(s) so it never clobbers a widget that uses
  // its own background-image when no gradient is chosen.
  const pg = tileGradCss(style.panelGrad);
  if (pg) panelRoots.forEach(r => r.style.setProperty('background-image', pg));
  if (typeof style.panelAlpha === 'number') el.style.setProperty('--panel-alpha', style.panelAlpha.toFixed(2));
  if (style.text) {
    const effectiveText = el.style.getPropertyValue('--text') || style.text;
    contentRoots.forEach(r => r.style.setProperty('--text', effectiveText));
  }
  if (style.font && TILE_FONT_STACKS[style.font]) el.style.setProperty('--tile-font', TILE_FONT_STACKS[style.font]);
  // Extended per-tile tokens, mirroring the global theme editor at tile scope.
  // Scoped to this wrapper's subtree via var() lazy substitution.
  if (style.mutedText) {
    const effectiveMuted = el.style.getPropertyValue('--muted-text') || style.mutedText;
    contentRoots.forEach(r => r.style.setProperty('--muted-text', effectiveMuted));
  }
  if (style.accentText) {
    const effectiveOnAccent = el.style.getPropertyValue('--on-accent') || style.accentText;
    contentRoots.forEach(r => r.style.setProperty('--on-accent', effectiveOnAccent));
  }
  if (typeof style.radius === 'number') {
    [['--radius', 8], ['--radius-control', 10], ['--radius-tile', 16], ['--radius-modal', 20]]
      .forEach(([prop, base]) => el.style.setProperty(prop, `${+(base * style.radius).toFixed(2)}px`));
  }
  if (typeof style.glassBlur === 'number') el.style.setProperty('--glass-blur', `${Math.round(style.glassBlur)}px`);
  if (typeof style.glassSaturate === 'number') el.style.setProperty('--glass-saturate', `${Math.round(style.glassSaturate)}%`);
  // Border/shadow use the same derivation the theme does, seeded from this tile's
  // own panel opacity (or the stock 0.94) so the strength reads consistently.
  const tp = (typeof style.panelAlpha === 'number') ? style.panelAlpha : 0.94;
  if (typeof style.borderStrength === 'number') el.style.setProperty('--panel-border-alpha', Math.min(0.4, (0.045 + tp * 0.08) * style.borderStrength).toFixed(3));
  if (typeof style.shadowStrength === 'number') el.style.setProperty('--panel-shadow-alpha', Math.min(0.6, (0.05 + tp * 0.18) * style.shadowStrength).toFixed(3));
}
function applyAllTileStyles(layout) {
  const lay = layout || getDashboardLayout();
  document.querySelectorAll('.grid-stack-item[gs-id]').forEach(el => {
    applyTileStyle(el, tileStyleForId(lay, el.getAttribute('gs-id')));
  });
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') {
    window.CustomWidget.refreshTheme();
  }
}

// Write a tile's style into whichever store owns it (primary / group / copy),
// paint it live, and persist. `style` null removes the override.
function setTileStyle(id, style) {
  const layout = getDashboardLayout();
  const target = (layout.widgets && layout.widgets[id]) ? layout.widgets[id]
    : (layout.groups && layout.groups[id]) ? layout.groups[id]
      : (Array.isArray(layout.copies) ? layout.copies.find(c => c.id === id) : null);
  if (!target) return;
  if (style) target.style = style; else delete target.style;
  // Repaint from the live layout (iterates by gs-id attribute — no fragile
  // selector escaping for copy ids that contain '~').
  applyAllTileStyles(layout);
  saveDashboardLayout(layout, { status: false });
}

// Downscale a raster image (shared rasterToCanvas core, utils.js) to keep
// uploaded tile assets small; GIFs are kept as-is so their animation survives
// (a canvas re-encode would flatten them). Any failure falls back to the
// original file — the /tile-asset endpoint enforces the hard size cap.
async function _tileDownscaleImage(file, maxEdge) {
  if (!file || file.type === 'image/gif') return file;
  const cv = await rasterToCanvas(file, maxEdge);
  if (!cv) return file;
  const type = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';
  return new Promise((resolve) => cv.toBlob(b => resolve(b || file), type, 0.9));
}
// Upload a tile decoration image and resolve its served /uploads/ URL.
async function uploadTileAsset(file, maxEdge) {
  const blob = await _tileDownscaleImage(file, maxEdge || 1280);
  const type = blob.type || file.type || 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('asset', blob, `tile.${ext}`);
  const res = await fetch('/tile-asset', { method: 'POST', body: form });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.url) throw new Error((j && j.error) || 'upload failed');
  return j.url;
}

let _tileStyleOverlay = null;
let _tileStyleFlush = null;
function closeTileStyleEditor() {
  // Flush a pending debounced persist so closing right after a drag never drops it.
  if (_tileStyleFlush) { const f = _tileStyleFlush; _tileStyleFlush = null; try { f(); } catch (_) {} }
  if (_tileStyleOverlay) { _tileStyleOverlay.remove(); _tileStyleOverlay = null; }
}
// Tabbed editor: give one tile its own colours, a background picture, ornamental
// frame + decorative overlays, and effects — or send it back to the global theme.
// Every change applies live and persists. `work.decor` is a loose working copy;
// normalizeTileStyle() is the single cleaner on commit (clamps, drops empties).
function openTileStyleEditor(id, anchor) {
  if (!id) return;
  closeTileStyleEditor();
  const DI = (typeof window !== 'undefined' && window.DashboardInstances) || {};
  // The manifest script loads before this file; the empty fallback only guards a
  // pathological load failure (no third copy of the /assets/decor URL scheme).
  const TDP = (typeof window !== 'undefined' && window.TileDecorPresets) || {
    TILE_DECOR_FRAMES: [], TILE_DECOR_OVERLAYS: [],
    tileFramePresetUrl: () => '', tileOverlayPresetUrl: () => '',
  };
  const cur = tileStyleForId(getDashboardLayout(), id) || {};
  const hs = (typeof hubSettings !== 'undefined') ? hubSettings : {};
  const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v)) ? v : d;
  const cd = cur.decor || {};
  const work = {
    mode: cur.mode === 'custom' ? 'custom' : 'inherit',
    accent: cur.accent || '', panel: cur.panel || '', text: cur.text || '',
    surfaceAlt: cur.surfaceAlt || '', controlColor: cur.controlColor || '',
    lineColor: cur.lineColor || '', accentText: cur.accentText || '',
    successColor: cur.successColor || '', warningColor: cur.warningColor || '',
    dangerColor: cur.dangerColor || '', infoColor: cur.infoColor || '',
    contrastGuard: typeof cur.contrastGuard === 'boolean' ? cur.contrastGuard : null,
    panelGrad: {
      c1: (cur.panelGrad && cur.panelGrad.c1) || '', c2: (cur.panelGrad && cur.panelGrad.c2) || '',
      angle: numOr(cur.panelGrad && cur.panelGrad.angle, 135),
    },
    mutedText: cur.mutedText || '',
    panelAlpha: typeof cur.panelAlpha === 'number' ? cur.panelAlpha : null,
    radius: typeof cur.radius === 'number' ? cur.radius : null,
    glassBlur: typeof cur.glassBlur === 'number' ? cur.glassBlur : null,
    glassSaturate: typeof cur.glassSaturate === 'number' ? cur.glassSaturate : null,
    borderStrength: typeof cur.borderStrength === 'number' ? cur.borderStrength : null,
    shadowStrength: typeof cur.shadowStrength === 'number' ? cur.shadowStrength : null,
    font: cur.font || 'inherit',
    decor: {
      bg: {
        src: (cd.bg && cd.bg.src) || '', fit: (cd.bg && cd.bg.fit) || 'cover',
        dim: numOr(cd.bg && cd.bg.dim, 35), blur: numOr(cd.bg && cd.bg.blur, 0), opacity: numOr(cd.bg && cd.bg.opacity, 100),
        grad: {
          c1: (cd.bg && cd.bg.grad && cd.bg.grad.c1) || '', c2: (cd.bg && cd.bg.grad && cd.bg.grad.c2) || '',
          angle: numOr(cd.bg && cd.bg.grad && cd.bg.grad.angle, 135),
        },
      },
      frame: { preset: (cd.frame && cd.frame.preset) || '', src: (cd.frame && cd.frame.src) || '', width: numOr(cd.frame && cd.frame.width, 16) },
      overlays: Array.isArray(cd.overlays) ? cd.overlays.map(o => ({
        preset: o.preset || '', src: o.src || '', anchor: o.anchor || 'bottom-right',
        x: (typeof o.x === 'number' ? o.x : null), y: (typeof o.y === 'number' ? o.y : null),
        size: numOr(o.size, 40), opacity: numOr(o.opacity, 100), rotate: numOr(o.rotate, 0), flip: !!o.flip,
      })) : [],
    },
  };
  const tt = (k, fb) => (typeof t === 'function' ? t(k) : fb) || fb;
  const mk = makeEl;   // shared DOM factory from utils.js
  const toast = (m) => { if (window.XenonToast) window.XenonToast.show({ type: 'error', kicker: tt('tile_style_title', 'Widget style'), message: String(m).slice(0, 200) }); };

  const buildStyle = () => {
    const raw = { mode: work.mode };
    if (work.accent) raw.accent = work.accent;
    if (work.panel) raw.panel = work.panel;
    if (work.panelGrad && work.panelGrad.c1 && work.panelGrad.c2) raw.panelGrad = work.panelGrad;
    if (work.text) raw.text = work.text;
    if (work.mutedText) raw.mutedText = work.mutedText;
    for (const key of ['surfaceAlt', 'controlColor', 'lineColor', 'accentText',
      'successColor', 'warningColor', 'dangerColor', 'infoColor']) {
      if (work[key]) raw[key] = work[key];
    }
    if (typeof work.contrastGuard === 'boolean') raw.contrastGuard = work.contrastGuard;
    if (work.panelAlpha != null) raw.panelAlpha = work.panelAlpha;
    if (work.radius != null) raw.radius = work.radius;
    if (work.glassBlur != null) raw.glassBlur = work.glassBlur;
    if (work.glassSaturate != null) raw.glassSaturate = work.glassSaturate;
    if (work.borderStrength != null) raw.borderStrength = work.borderStrength;
    if (work.shadowStrength != null) raw.shadowStrength = work.shadowStrength;
    if (work.font && work.font !== 'inherit') raw.font = work.font;
    raw.decor = work.decor;  // normalizeTileStyle cleans/clamps and drops empties
    return DI.normalizeTileStyle ? DI.normalizeTileStyle(raw) : raw;
  };
  // Continuous inputs (colour drags, ranges, the overlay pad) fire dozens of
  // times a second: repaint ONLY the edited tile immediately and debounce the
  // real persist (store write + all-tiles repaint + settings save) behind a
  // trailing timer — running the full pipeline per pointermove janks the
  // touchscreen and restarts every decorated tile's images. closeTileStyleEditor
  // flushes the timer so the last tweak always lands.
  let commitTimer = null;
  const editedTileEl = () => {
    // Iterate by attribute — copy ids contain '~', which breaks CSS selectors.
    for (const n of document.querySelectorAll('.grid-stack-item[gs-id]')) {
      if (n.getAttribute('gs-id') === id) return n;
    }
    return null;
  };
  const commit = () => {
    const style = buildStyle();
    const el = editedTileEl();
    if (el) applyTileStyle(el, style);
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => { commitTimer = null; setTileStyle(id, buildStyle()); }, 250);
  };
  _tileStyleFlush = () => {
    if (!commitTimer) return;
    clearTimeout(commitTimer); commitTimer = null;
    setTileStyle(id, buildStyle());
  };

  const overlay = mk('div', 'tile-style-overlay');
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeTileStyleEditor(); });
  const pop = mk('div', 'tile-style-pop wide');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', tt('tile_style_title', 'Widget style'));

  const head = mk('div', 'tile-style-head');
  head.textContent = tt('tile_style_title', 'Widget style');
  head.classList.add('tile-style-drag');
  pop.appendChild(head);
  // Drag the panel by its header so it can be moved off the widget being edited
  // (the panel floats over the LIVE dashboard, so you watch the change apply).
  let dragFrom = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const r = pop.getBoundingClientRect();
    // Pin the panel where it currently sits, then free it from the flex layout.
    pop.style.position = 'fixed'; pop.style.margin = '0';
    pop.style.left = `${r.left}px`; pop.style.top = `${r.top}px`;
    overlay.style.justifyContent = 'flex-start'; overlay.style.alignItems = 'flex-start';
    dragFrom = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    try { head.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const nl = Math.max(6, Math.min(window.innerWidth - w - 6, dragFrom.left + (e.clientX - dragFrom.x)));
    const nt = Math.max(6, Math.min(window.innerHeight - Math.min(h, window.innerHeight - 12) - 6, dragFrom.top + (e.clientY - dragFrom.y)));
    pop.style.left = `${nl}px`; pop.style.top = `${nt}px`;
  });
  const endDrag = (e) => { dragFrom = null; try { head.releasePointerCapture(e.pointerId); } catch (_) {} };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  // ── Tab bar ──
  const tabsBar = mk('div', 'tile-style-tabs');
  const panes = [];
  const showPane = (paneEl, btn) => {
    panes.forEach(p => { p.hidden = true; });
    paneEl.hidden = false;
    tabsBar.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
  };
  const mkTab = (key, fb, paneEl, first) => {
    const b = mk('button'); b.type = 'button'; b.textContent = tt(key, fb);
    panes.push(paneEl); paneEl.hidden = !first;
    if (first) b.classList.add('active');
    b.addEventListener('click', () => showPane(paneEl, b));
    tabsBar.appendChild(b);
  };
  pop.appendChild(tabsBar);

  // ═══ Pane: COLOURS (mode + colour/numeric/font tokens) ═══
  const paneColors = mk('div', 'tile-style-body');
  const seg = mk('div', 'tile-style-seg');
  const custom = mk('div', 'tile-style-body');
  custom.hidden = work.mode !== 'custom';
  const mkSeg = (mode, key, fb) => {
    const b = mk('button'); b.type = 'button'; b.textContent = tt(key, fb);
    if (work.mode === mode) b.classList.add('active');
    b.addEventListener('click', () => {
      work.mode = mode;
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      custom.hidden = work.mode !== 'custom';
      commit();
    });
    return b;
  };
  seg.append(mkSeg('inherit', 'tile_style_follow', 'Follow global'), mkSeg('custom', 'tile_style_custom', 'Customize'));
  paneColors.appendChild(seg);

  const colorRow = (labelKey, fb, field, seed) => {
    const row = mk('label', 'tile-style-row');
    const chk = mk('input'); chk.type = 'checkbox'; chk.checked = !!work[field];
    const span = mk('span', 'tile-style-label'); span.textContent = tt(labelKey, fb);
    const color = mk('input'); color.type = 'color';
    color.value = work[field] || seed || '#1ed760'; color.disabled = !work[field];
    if (window.ColorPicker) window.ColorPicker.bind(color);
    chk.addEventListener('change', () => { work[field] = chk.checked ? color.value : ''; color.disabled = !chk.checked; commit(); });
    color.addEventListener('input', () => { work[field] = color.value; commit(); });
    row.append(chk, span, color);
    return row;
  };
  // A gradient control (checkbox + two swatches + angle) bound to a {c1,c2,angle}
  // object — used for the panel background here (and mirrors the decor bg gradient).
  const gradRow = (labelKey, fb, gradObj, seed1, seed2, onChange) => {
    const wrap = mk('div', 'tile-style-gradblock');
    const row = mk('label', 'tile-style-row');
    const chk = mk('input'); chk.type = 'checkbox'; chk.checked = !!(gradObj.c1 && gradObj.c2);
    const span = mk('span', 'tile-style-label'); span.textContent = tt(labelKey, fb);
    const c1 = mk('input'); c1.type = 'color'; c1.className = 'tile-style-grad-sw'; c1.value = gradObj.c1 || seed1 || '#1ed760';
    const c2 = mk('input'); c2.type = 'color'; c2.className = 'tile-style-grad-sw'; c2.value = gradObj.c2 || seed2 || '#101216';
    if (window.ColorPicker) { window.ColorPicker.bind(c1); window.ColorPicker.bind(c2); }
    const angle = mk('input'); angle.type = 'range'; angle.className = 'tile-style-grad-angle';
    angle.min = '0'; angle.max = '360'; angle.step = '5'; angle.value = String(gradObj.angle || 135);
    angle.title = tt('decor_gradient_angle', 'Gradient angle');
    const setDisabled = () => { c1.disabled = c2.disabled = angle.disabled = !chk.checked; };
    setDisabled();
    const fire = () => { if (onChange) onChange(); commit(); };
    const sync = () => {
      if (chk.checked) { gradObj.c1 = c1.value; gradObj.c2 = c2.value; } else { gradObj.c1 = ''; gradObj.c2 = ''; }
      setDisabled(); fire();
    };
    chk.addEventListener('change', sync);
    c1.addEventListener('input', sync);
    c2.addEventListener('input', sync);
    angle.addEventListener('input', () => { gradObj.angle = Number(angle.value); fire(); });
    row.append(chk, span, c1, c2);
    wrap.append(row, angle);
    return wrap;
  };
  custom.append(
    colorRow('tile_style_accent', 'Accent', 'accent', hs.accent),
    colorRow('tile_style_panel', 'Panel', 'panel', hs.surface || hs.background),
    colorRow('tile_style_surface_alt', 'Secondary surface', 'surfaceAlt', hs.surfaceAlt || hs.surface || hs.background),
    colorRow('tile_style_control', 'Fields & controls', 'controlColor', hs.controlColor || hs.surfaceAlt || hs.background),
    gradRow('decor_gradient', 'Gradient', work.panelGrad, hs.accent, '#101216'),
    colorRow('tile_style_text', 'Text', 'text', hs.text),
    colorRow('tile_style_muted', 'Muted text', 'mutedText', hs.mutedText || '#8a8f98'),
    colorRow('tile_style_line', 'Lines & borders', 'lineColor', hs.lineColor || '#59615e'),
    colorRow('tile_style_accent_text', 'Text on accent', 'accentText', hs.accentText || '#111111'),
    colorRow('tile_style_success', 'Success', 'successColor', hs.successColor || '#45d483'),
    colorRow('tile_style_warning', 'Warning', 'warningColor', hs.warningColor || '#f0b84f'),
    colorRow('tile_style_danger', 'Danger', 'dangerColor', hs.dangerColor || '#ff6268'),
    colorRow('tile_style_info', 'Information', 'infoColor', hs.infoColor || '#62cbea'),
  );
  const opRow = mk('label', 'tile-style-row');
  const opChk = mk('input'); opChk.type = 'checkbox'; opChk.checked = work.panelAlpha != null;
  const opSpan = mk('span', 'tile-style-label'); opSpan.textContent = tt('tile_style_opacity', 'Panel opacity');
  const opRange = mk('input'); opRange.type = 'range'; opRange.min = '0.05'; opRange.max = '1'; opRange.step = '0.01';
  opRange.value = String(work.panelAlpha != null ? work.panelAlpha : (typeof hs.panelAlpha === 'number' ? hs.panelAlpha : 0.94));
  opRange.disabled = work.panelAlpha == null;
  opChk.addEventListener('change', () => { work.panelAlpha = opChk.checked ? Number(opRange.value) : null; opRange.disabled = !opChk.checked; commit(); });
  opRange.addEventListener('input', () => { work.panelAlpha = Number(opRange.value); commit(); });
  opRow.append(opChk, opSpan, opRange);
  custom.appendChild(opRow);

  const rangeRow = (labelKey, fb, field, min, max, step, fallback) => {
    const row = mk('label', 'tile-style-row');
    const chk = mk('input'); chk.type = 'checkbox'; chk.checked = work[field] != null;
    const span = mk('span', 'tile-style-label'); span.textContent = tt(labelKey, fb);
    const range = mk('input'); range.type = 'range'; range.min = String(min); range.max = String(max); range.step = String(step);
    range.value = String(work[field] != null ? work[field] : fallback); range.disabled = work[field] == null;
    chk.addEventListener('change', () => { work[field] = chk.checked ? Number(range.value) : null; range.disabled = !chk.checked; commit(); });
    range.addEventListener('input', () => { work[field] = Number(range.value); commit(); });
    row.append(chk, span, range);
    return row;
  };
  custom.append(
    rangeRow('tile_style_radius', 'Corner radius', 'radius', 0, 2, 0.05, 1),
    rangeRow('tile_style_glass_blur', 'Glass blur', 'glassBlur', 0, 40, 1, 22),
    rangeRow('tile_style_glass_saturate', 'Glass saturation', 'glassSaturate', 100, 220, 5, 160),
    rangeRow('tile_style_border', 'Panel border', 'borderStrength', 0, 2, 0.05, 1),
    rangeRow('tile_style_shadow', 'Panel shadow', 'shadowStrength', 0, 2, 0.05, 1),
  );
  const fontRow = mk('label', 'tile-style-row');
  const fontSpan = mk('span', 'tile-style-label'); fontSpan.textContent = tt('tile_style_font', 'Font');
  const fontSel = mk('select', 'tile-style-font');
  [['inherit', tt('tile_font_inherit', 'Default (global)')], ['inter', 'Inter'], ['pressstart', 'Press Start 2P'], ['vt323', 'VT323']]
    .forEach(([val, label]) => { const o = mk('option'); o.value = val; o.textContent = label; if (work.font === val) o.selected = true; fontSel.appendChild(o); });
  fontSel.addEventListener('change', () => { work.font = fontSel.value; commit(); });
  fontRow.append(fontSpan, fontSel);
  custom.appendChild(fontRow);
  paneColors.appendChild(custom);

  // Small labelled range helper for decor panes (value always active).
  const decorRange = (labelKey, fb, get, set, min, max, step) => {
    const row = mk('label', 'tile-style-row');
    const span = mk('span', 'tile-style-label'); span.textContent = tt(labelKey, fb);
    const range = mk('input'); range.type = 'range'; range.min = String(min); range.max = String(max); range.step = String(step);
    range.value = String(get());
    range.addEventListener('input', () => { set(Number(range.value)); commit(); });
    row.append(span, range);
    return row;
  };
  const busyPick = (btn, fn) => {
    btn.disabled = true;
    Promise.resolve().then(fn).catch(e => toast(tt('decor_upload_failed', 'Upload failed') + (e && e.message ? `: ${e.message}` : '')))
      .finally(() => { btn.disabled = false; });
  };

  // ═══ Pane: BACKGROUND ═══
  const paneBg = mk('div', 'tile-style-body');
  const bgPrev = mk('div', 'decor-preview');
  // Preview through the exact serializer the live tile uses (no private copy).
  const gradCss = () => tileGradCss(work.decor.bg.grad);
  const refreshBgPrev = () => {
    const s = work.decor.bg.src, g = gradCss();
    bgPrev.style.backgroundImage = [g, cssUrl(s)].filter(Boolean).join(', ');
    bgPrev.classList.toggle('empty', !s && !g);
  };
  refreshBgPrev();
  const bgBtns = mk('div', 'decor-btnrow');
  const bgFile = mk('input'); bgFile.type = 'file'; bgFile.accept = 'image/*'; bgFile.hidden = true;
  const bgUp = mk('button', 'tile-style-btn'); bgUp.type = 'button'; bgUp.textContent = tt('decor_choose_image', 'Choose image');
  bgUp.addEventListener('click', () => bgFile.click());
  bgFile.addEventListener('change', () => {
    const f = bgFile.files && bgFile.files[0]; bgFile.value = '';
    if (f) busyPick(bgUp, async () => { work.decor.bg.src = await uploadTileAsset(f, 1600); refreshBgPrev(); commit(); });
  });
  const bgClear = mk('button', 'tile-style-btn'); bgClear.type = 'button'; bgClear.textContent = tt('decor_remove', 'Remove');
  bgClear.addEventListener('click', () => { work.decor.bg.src = ''; refreshBgPrev(); commit(); });
  // Paste raw SVG markup instead of uploading a file (stored as a data: URI).
  const bgSvg = mk('button', 'tile-style-btn'); bgSvg.type = 'button'; bgSvg.textContent = tt('svg_paste', 'Paste SVG');
  bgSvg.addEventListener('click', async () => {
    const uri = await openSvgPasteDialog();
    if (uri) { work.decor.bg.src = uri; refreshBgPrev(); commit(); }
  });
  bgBtns.append(bgUp, bgClear, bgSvg, bgFile);
  const bgFitRow = mk('label', 'tile-style-row');
  const bgFitSpan = mk('span', 'tile-style-label'); bgFitSpan.textContent = tt('decor_fit', 'Fit');
  const bgFitSel = mk('select', 'tile-style-font');
  [['cover', tt('decor_fit_cover', 'Cover')], ['contain', tt('decor_fit_contain', 'Contain')], ['tile', tt('decor_fit_tile', 'Tile')]]
    .forEach(([v, l]) => { const o = mk('option'); o.value = v; o.textContent = l; if (work.decor.bg.fit === v) o.selected = true; bgFitSel.appendChild(o); });
  bgFitSel.addEventListener('change', () => { work.decor.bg.fit = bgFitSel.value; commit(); });
  bgFitRow.append(bgFitSpan, bgFitSel);
  // Gradient: a two-colour fill usable on its own or layered over the image.
  const bgGradHead = mk('div', 'tile-style-subhead'); bgGradHead.textContent = tt('decor_gradient', 'Gradient');
  paneBg.append(bgPrev, bgBtns, bgFitRow,
    decorRange('decor_dim', 'Dim', () => work.decor.bg.dim, v => { work.decor.bg.dim = v; }, 0, 100, 1),
    decorRange('decor_blur', 'Blur', () => work.decor.bg.blur, v => { work.decor.bg.blur = v; }, 0, 20, 1),
    decorRange('decor_opacity', 'Opacity', () => work.decor.bg.opacity, v => { work.decor.bg.opacity = v; }, 0, 100, 1),
    bgGradHead,
    gradRow('decor_gradient_use', 'Use gradient', work.decor.bg.grad, hs.accent, '#101216', refreshBgPrev),
  );

  // ═══ Pane: DECOR (frame + overlays) ═══
  const paneDecor = mk('div', 'tile-style-body');
  // Frame picker
  const frameHead = mk('div', 'tile-style-subhead'); frameHead.textContent = tt('decor_frame', 'Frame');
  const frameThumbs = mk('div', 'decor-thumbs');
  const markFrame = () => frameThumbs.querySelectorAll('.decor-thumb').forEach(el => {
    el.classList.toggle('active', el.dataset.preset === (work.decor.frame.preset || (work.decor.frame.src ? '__upload' : '__none')));
  });
  const addFrameThumb = (preset, bgUrl, label) => {
    const b = mk('button', 'decor-thumb'); b.type = 'button'; b.dataset.preset = preset; b.title = label || '';
    if (bgUrl) b.style.backgroundImage = cssUrl(bgUrl); else b.classList.add('none');
    b.addEventListener('click', () => {
      if (preset === '__none') { work.decor.frame.preset = ''; work.decor.frame.src = ''; }
      else { work.decor.frame.preset = preset; work.decor.frame.src = ''; }
      markFrame(); commit();
    });
    frameThumbs.appendChild(b);
  };
  addFrameThumb('__none', '', tt('decor_none', 'None'));
  (TDP.TILE_DECOR_FRAMES || []).forEach(f => addFrameThumb(f.id, TDP.tileFramePresetUrl(f.id), tt(f.labelKey, f.label)));
  const frameFile = mk('input'); frameFile.type = 'file'; frameFile.accept = 'image/*'; frameFile.hidden = true;
  const frameUp = mk('button', 'decor-thumb upload'); frameUp.type = 'button'; frameUp.dataset.preset = '__upload'; frameUp.textContent = '+'; frameUp.title = tt('decor_upload', 'Upload');
  frameUp.addEventListener('click', () => frameFile.click());
  frameFile.addEventListener('change', () => {
    const f = frameFile.files && frameFile.files[0]; frameFile.value = '';
    if (f) busyPick(frameUp, async () => { const u = await uploadTileAsset(f, 512); work.decor.frame.src = u; work.decor.frame.preset = ''; frameUp.style.backgroundImage = cssUrl(u); markFrame(); commit(); });
  });
  frameThumbs.appendChild(frameUp);
  // Paste raw SVG markup as a custom frame — fills the same "upload" slot.
  const frameSvg = mk('button', 'decor-thumb upload'); frameSvg.type = 'button'; frameSvg.textContent = '</>'; frameSvg.title = tt('svg_paste', 'Paste SVG');
  frameSvg.addEventListener('click', async () => {
    const uri = await openSvgPasteDialog();
    if (uri) { work.decor.frame.src = uri; work.decor.frame.preset = ''; frameUp.style.backgroundImage = cssUrl(uri); markFrame(); commit(); }
  });
  frameThumbs.appendChild(frameSvg);
  if (work.decor.frame.src) frameUp.style.backgroundImage = cssUrl(work.decor.frame.src);
  markFrame();
  paneDecor.append(frameHead, frameThumbs, frameFile,
    decorRange('decor_frame_width', 'Frame width', () => work.decor.frame.width, v => { work.decor.frame.width = v; }, 0, 40, 1));

  // Overlays
  const ovHead = mk('div', 'tile-style-subhead'); ovHead.textContent = tt('decor_overlays', 'Overlays');
  const ovList = mk('div', 'decor-overlay-list');
  const ovAdd = mk('div', 'decor-add');
  // Coarse anchor → centre coordinates, used for the initial marker of an overlay
  // that has no explicit x/y yet (and to seed a freshly-added one).
  const ANCHOR_XY = {
    'top-left': [12, 12], 'top': [50, 12], 'top-right': [88, 12],
    'left': [12, 50], 'center': [50, 50], 'right': [88, 50],
    'bottom-left': [12, 88], 'bottom': [50, 88], 'bottom-right': [88, 88],
  };
  const ovXY = (ov) => (typeof ov.x === 'number' && typeof ov.y === 'number')
    ? [ov.x, ov.y] : (ANCHOR_XY[ov.anchor] || ANCHOR_XY['bottom-right']);
  const overlaySrc = (ov) => ov.preset ? TDP.tileOverlayPresetUrl(ov.preset) : ov.src;
  // A drag pad for free overlay placement — the marker maps 1:1 to tile percent.
  const mkPosPad = (ov) => {
    const pad = mk('div', 'decor-pospad'); pad.title = tt('decor_pos_hint', 'Drag to place');
    const dot = mk('div', 'decor-pospad-dot');
    const s = overlaySrc(ov); if (s) dot.style.backgroundImage = cssUrl(s);
    pad.appendChild(dot);
    const place = () => { const [x, y] = ovXY(ov); dot.style.left = `${x}%`; dot.style.top = `${y}%`; };
    place();
    const setFromEvent = (e) => {
      const r = pad.getBoundingClientRect();
      ov.x = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
      ov.y = Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)));
      dot.style.left = `${ov.x}%`; dot.style.top = `${ov.y}%`; commit();
    };
    let dragging = false;
    pad.addEventListener('pointerdown', (e) => { dragging = true; try { pad.setPointerCapture(e.pointerId); } catch (_) {} setFromEvent(e); e.preventDefault(); });
    pad.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
    const stop = (e) => { dragging = false; try { pad.releasePointerCapture(e.pointerId); } catch (_) {} };
    pad.addEventListener('pointerup', stop);
    pad.addEventListener('pointercancel', stop);
    return pad;
  };
  const renderOverlays = () => {
    ovList.replaceChildren();
    work.decor.overlays.forEach((ov, idx) => {
      const item = mk('div', 'decor-overlay-item');
      const thumb = mk('div', 'decor-overlay-thumb');
      const s = overlaySrc(ov); if (s) thumb.style.backgroundImage = cssUrl(s);
      const ctr = mk('div', 'decor-overlay-ctrls');
      // Free placement: drag the marker anywhere on the pad.
      ctr.append(mkPosPad(ov),
        decorRange('decor_size', 'Size', () => ov.size, v => { ov.size = v; }, 5, 100, 1),
        decorRange('decor_opacity', 'Opacity', () => ov.opacity, v => { ov.opacity = v; }, 0, 100, 1),
        decorRange('decor_rotate', 'Rotate', () => ov.rotate, v => { ov.rotate = v; }, -180, 180, 5),
      );
      const flipRow = mk('label', 'tile-style-row');
      const flipChk = mk('input'); flipChk.type = 'checkbox'; flipChk.checked = !!ov.flip;
      const flipSpan = mk('span', 'tile-style-label'); flipSpan.textContent = tt('decor_flip', 'Flip');
      flipChk.addEventListener('change', () => { ov.flip = flipChk.checked; commit(); });
      flipRow.append(flipChk, flipSpan);
      const del = mk('button', 'decor-overlay-del'); del.type = 'button'; del.textContent = '×'; del.title = tt('decor_remove', 'Remove');
      del.addEventListener('click', () => { work.decor.overlays.splice(idx, 1); renderOverlays(); commit(); });
      ctr.appendChild(flipRow);
      item.append(thumb, ctr, del);
      ovList.appendChild(item);
    });
    ovAdd.hidden = work.decor.overlays.length >= 4;
  };
  const addOverlay = (partial) => {
    if (work.decor.overlays.length >= 4) return;
    work.decor.overlays.push(Object.assign({ preset: '', src: '', anchor: 'bottom-right', x: 50, y: 50, size: 40, opacity: 100, rotate: 0, flip: false }, partial));
    renderOverlays(); commit();
  };
  const addThumbs = mk('div', 'decor-thumbs');
  (TDP.TILE_DECOR_OVERLAYS || []).forEach(o => {
    const b = mk('button', 'decor-thumb'); b.type = 'button'; b.title = tt(o.labelKey, o.label);
    b.style.backgroundImage = `url("${TDP.tileOverlayPresetUrl(o.id)}")`;
    b.addEventListener('click', () => addOverlay({ preset: o.id }));
    addThumbs.appendChild(b);
  });
  const ovFile = mk('input'); ovFile.type = 'file'; ovFile.accept = 'image/*'; ovFile.hidden = true;
  const ovUp = mk('button', 'decor-thumb upload'); ovUp.type = 'button'; ovUp.textContent = '+'; ovUp.title = tt('decor_upload', 'Upload');
  ovUp.addEventListener('click', () => ovFile.click());
  ovFile.addEventListener('change', () => {
    const f = ovFile.files && ovFile.files[0]; ovFile.value = '';
    if (f) busyPick(ovUp, async () => { const u = await uploadTileAsset(f, 640); addOverlay({ src: u }); });
  });
  addThumbs.appendChild(ovUp);
  // Paste raw SVG markup as a custom overlay (stored as a data: URI).
  const ovSvg = mk('button', 'decor-thumb upload'); ovSvg.type = 'button'; ovSvg.textContent = '</>'; ovSvg.title = tt('svg_paste', 'Paste SVG');
  ovSvg.addEventListener('click', async () => {
    const uri = await openSvgPasteDialog();
    if (uri) addOverlay({ src: uri });
  });
  addThumbs.appendChild(ovSvg);
  ovAdd.append(addThumbs, ovFile);
  paneDecor.append(ovHead, ovList, ovAdd);
  renderOverlays();

  // Register panes/tabs.
  mkTab('tile_style_tab_colors', 'Colours', paneColors, true);
  mkTab('tile_style_tab_bg', 'Background', paneBg, false);
  mkTab('tile_style_tab_decor', 'Decor', paneDecor, false);
  pop.append(paneColors, paneBg, paneDecor);

  // Footer: reset (back to global) + done.
  const foot = mk('div', 'tile-style-foot');
  const reset = mk('button', 'tile-style-btn'); reset.type = 'button'; reset.textContent = tt('tile_style_reset', 'Reset');
  reset.addEventListener('click', () => {
    // Cancel any pending debounced commit FIRST — flushing it on close would
    // re-persist the style Reset just discarded.
    clearTimeout(commitTimer); commitTimer = null; _tileStyleFlush = null;
    setTileStyle(id, null);
    closeTileStyleEditor();
  });
  const done = mk('button', 'tile-style-btn primary'); done.type = 'button'; done.textContent = tt('tile_style_done', 'Done');
  done.addEventListener('click', () => closeTileStyleEditor());
  foot.append(reset, done);
  pop.appendChild(foot);

  overlay.appendChild(pop);
  document.body.appendChild(overlay);
  // Upgrade the native <select>s to the shared custom dropdown. A native select
  // opens an OS-level list Xenon cannot place, so near the bottom of the Edge it
  // drops off-screen; the custom panel is anchored, clamped to the viewport and
  // flips up when there is no room below. data-cs-fixed because this panel
  // scrolls, which would clip an absolutely-positioned list.
  if (typeof window.initCustomSelect === 'function') {
    pop.querySelectorAll('select').forEach((s) => {
      if (s.dataset.csInit) return;
      s.setAttribute('data-cs-fixed', '');
      window.initCustomSelect(s);
    });
  }
  _tileStyleOverlay = overlay;
}
if (typeof window !== 'undefined') {
  window.openTileStyleEditor = openTileStyleEditor;
}

function applyDashboardWidgets(layout) {
  const groups = layout.groups || {};
  const groupOf = (id) => (window.DashboardTabGroups ? window.DashboardTabGroups.widgetGroupOf(groups, id) : null);
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
    adoptGridItem(targetGrid, item);
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
    adoptGridItem(targetGrid, item);
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
    adoptGridItem(targetGrid, item);
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
  }
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
  step('discordRender', () => { if (window.DiscordWidget && typeof window.DiscordWidget.renderWidgets === 'function') window.DiscordWidget.renderWidgets(); });
  step('spotifyRender', () => { if (window.SpotifyWidget && typeof window.SpotifyWidget.renderWidgets === 'function') window.SpotifyWidget.renderWidgets(); });
  step('sbRender', () => { if (window.StreamerbotWidget && typeof window.StreamerbotWidget.renderWidgets === 'function') window.StreamerbotWidget.renderWidgets(); });
  step('wavelinkRender', () => { if (window.WaveLinkWidget && typeof window.WaveLinkWidget.renderWidgets === 'function') window.WaveLinkWidget.renderWidgets(); });
  step('lightingRender', () => { if (window.LightingWidget && typeof window.LightingWidget.renderWidgets === 'function') window.LightingWidget.renderWidgets(); });
  step('wnRender', () => { if (window.NotificationsWidget && typeof window.NotificationsWidget.renderWidgets === 'function') window.NotificationsWidget.renderWidgets(); });
  step('stocksRender', () => { if (window.StockWidget && typeof window.StockWidget.renderWidgets === 'function') window.StockWidget.renderWidgets(); });
  step('footballRender', () => { if (window.FootballWidget && typeof window.FootballWidget.renderWidgets === 'function') window.FootballWidget.renderWidgets(); });
  step('claudeRender', () => { if (window.ClaudeWidget && typeof window.ClaudeWidget.renderWidgets === 'function') window.ClaudeWidget.renderWidgets(); });
  step('newsRender', () => { if (window.NewsWidget && typeof window.NewsWidget.renderWidgets === 'function') window.NewsWidget.renderWidgets(); });
  step('fansRender', () => { if (window.FansWidget && typeof window.FansWidget.renderWidgets === 'function') window.FansWidget.renderWidgets(); });
  step('powerRender', () => { if (window.PowerWidget && typeof window.PowerWidget.renderWidgets === 'function') window.PowerWidget.renderWidgets(); });
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
  // Hide the top bar entirely when the user opted out of it — but never while
  // editing, so the full toolset (pager dots, page add/remove, Done) stays
  // reachable. A floating Layout button (below) re-opens the editor.
  document.body.classList.toggle('topbar-hidden', layout.topbarHidden === true);
  // Minimal chrome (edge rails + island pill) follows the settings; a fully
  // hidden bar wins over it — TopbarMinimal.apply() checks both.
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

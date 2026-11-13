// Reads and saves the layout, builds the controls a tile shows in edit mode and the layout dock,
// and remembers where the dock sits.
'use strict';

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
  tune: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17v2h6v-2H3Zm0-12v2h10V5H3Zm10 16v-2h8v-2h-8v-2h-2v6h2ZM7 9v2H3v2h4v2h2V9H7Zm14 4v-2H11v2h10Zm-6-4h2V7h4V5h-4V3h-2v6Z"/></svg>',
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
  // the other edit handles (the tile edit bar), so their z-index (50) wins over it.
  // Cards are not grid items and keep hosting their own controls.
  // Since the edit bar (dashboard-grid.js ensureTileHandles) exists, the pair
  // joins it, so every control of a tile is in one row above its content.
  const gridContent = kind === 'widget' ? element.closest('.grid-stack-item-content') : null;
  const host = (gridContent && gridContent.querySelector(':scope > .gs-edit-bar')) || gridContent || element;
  const existingControls = findDirectLayoutControls(host, kind);
  if (existingControls) existingControls.remove();
  // Clean up any stale controls left directly on the panel by an earlier build.
  if (host !== element) {
    const strayControls = findDirectLayoutControls(element, kind);
    if (strayControls) strayControls.remove();
  }
  if (gridContent && host !== gridContent) {
    const straySibling = findDirectLayoutControls(gridContent, kind);
    if (straySibling) straySibling.remove();
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
      // Free-drag position (px from viewport top-left); null → CSS default (centred, bottom).
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

// Dragging the dock, its bar, the floating layout button, hiding the top bar, and saving, inserting
// and deleting presets.
'use strict';

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

// Floating Layout button — the fallback way back into the editor once the top
// bar is hidden. Normally invisible: a hidden bar keeps the edge rails, which
// already carry Layout/Settings/App, so the CSS additionally requires
// `:not(.topbar-minimal)` and it surfaces only if the minimal chrome could not be
// built. Kept rather than deleted because without it that failure would leave no
// route into Settings at all. Tapping enters edit mode.
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
  // Tiles that name their Store package get it now; a bundle import runs this
  // before the package exists and binds again once it is installed.
  if (res.bind && res.bind.length && window.CustomWidget && typeof window.CustomWidget.bindPackages === 'function') {
    window.CustomWidget.bindPackages(res.bind);
  }
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

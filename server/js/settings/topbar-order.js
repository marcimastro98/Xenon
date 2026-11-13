// Reordering, showing and hiding the island items and action buttons of the top bar.
'use strict';

// Pointer-based vertical reorder for the island editor, delegated once on the
// list host. touch-action:none on the grip (CSS) lets the drag own the gesture
// without the settings panel scrolling. Same tap-vs-drag shape as app favorites.
// Bound once PER HOST — the two lists are separate elements with separate
// writers, so a single module-level flag would arm whichever rendered first and
// leave the other permanently undraggable.
const _islandDragBound = new WeakSet();
function initTopbarIslandDrag(host, onReorder) {
  if (_islandDragBound.has(host)) return;
  _islandDragBound.add(host);
  let row = null, fromIndex = -1, startY = 0, dragging = false;

  host.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.island-edit-handle');
    if (!handle) { row = null; return; }
    row = handle.closest('.island-edit-row');
    if (!row) return;
    fromIndex = Number(row.dataset.islandIndex);
    startY = e.clientY; dragging = false;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });

  host.addEventListener('pointermove', (e) => {
    if (!row) return;
    if (!dragging && Math.abs(e.clientY - startY) > 6) {
      dragging = true;
      row.classList.add('dragging');
      host.classList.add('reordering');
    }
  });

  const finish = (e, commit) => {
    if (!row) return;
    const r = row; row = null;
    r.classList.remove('dragging');
    host.classList.remove('reordering');
    if (!dragging || !commit) return;
    // Insertion index = how many other rows sit above the pointer's midpoint.
    let insert = 0;
    for (const s of host.querySelectorAll('.island-edit-row')) {
      if (s === r) continue;
      const rect = s.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) insert++;
    }
    onReorder(fromIndex, insert);
  };

  host.addEventListener('pointerup', (e) => finish(e, true));
  host.addEventListener('pointercancel', (e) => finish(e, false));
}

// Move an island segment to a new position (minimal island order).
function reorderTopbarIslandItem(fromIndex, toIndex) {
  const items = (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items))
    ? hubSettings.topbarClock.items.slice() : [];
  if (fromIndex < 0 || fromIndex >= items.length) return;
  const [moved] = items.splice(fromIndex, 1);
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, moved);
  _saveTopbarIslandItems(items);
}

// Show/hide a single island segment.
function toggleTopbarIslandItem(id) {
  const source = (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items))
    ? hubSettings.topbarClock.items : [];
  const items = source.map(it => ({ id: it.id, hidden: it.id === id ? it.hidden !== true : it.hidden === true }));
  _saveTopbarIslandItems(items);
}

// Move a chrome button to a new position. Order is a single list; which side a
// button ends up on is its own field, so a reorder never changes a side.
function reorderTopbarActionItem(fromIndex, toIndex) {
  const items = _topbarActionItems();
  if (fromIndex < 0 || fromIndex >= items.length) return;
  const [moved] = items.splice(fromIndex, 1);
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, moved);
  _saveTopbarActions(items);
}

// Show/hide a chrome button. The two doors back in — Settings and Layout — are
// refused here as well as in the normalizer: the editor disables their eyes, but
// this is the function a future caller would reach for.
function toggleTopbarActionItem(id) {
  if (id === 'settings' || id === 'layout') return;
  _saveTopbarActions(_topbarActionItems().map(it => (
    it.id === id ? { ...it, hidden: it.hidden !== true } : it
  )));
}

function setTopbarActionSide(id, side) {
  if (side !== 'left' && side !== 'right') return;
  _saveTopbarActions(_topbarActionItems().map(it => (it.id === id ? { ...it, side } : it)));
}

// The saved list plus any widget button on screen that is not in it yet (it
// sits at the end of the left side until then), so the editor's indices match
// the list it saves and moving such a button saves it.
function _topbarActionItems() {
  const saved = (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.actions))
    ? hubSettings.topbarClock.actions.map(it => ({ ...it })) : [];
  const live = window.SdkTopbarButton ? SdkTopbarButton.live() : [];
  for (const b of live) {
    if (!saved.some(it => it.id === b.id)) saved.push({ id: b.id, side: 'left', hidden: false });
  }
  return saved;
}

// A removed package takes its bar button with it: its place in the list and the
// look the user gave it. Returns the two keys to merge, unchanged when there is
// nothing to drop.
function withoutSdkTopbarButtons(settings, pkgIds) {
  const gone = new Set((Array.isArray(pkgIds) ? pkgIds : []).map(id => 'sdk:' + id));
  const clock = (settings && settings.topbarClock) || {};
  const look = (settings && settings.topbarLook) || {};
  const buttons = { ...(look.buttons || {}) };
  for (const id of gone) delete buttons[id];
  return {
    topbarClock: { ...clock, actions: (Array.isArray(clock.actions) ? clock.actions : []).filter(it => !(it && gone.has(it.id))) },
    topbarLook: { ...look, buttons },
  };
}

// A built-in button by its translated name; a widget's by the label it shows,
// or its package id while the widget is not running.
function topbarActionLabel(id) {
  if (typeof id === 'string' && id.startsWith('sdk:')) {
    const live = window.SdkTopbarButton ? SdkTopbarButton.live().find(b => b.id === id) : null;
    return live ? live.label : id.slice(4);
  }
  return t(TOPBAR_ACTION_LABELS[id] || id);
}

function _saveTopbarActions(actions) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), actions },
  });
  saveHubSettings();
  syncTopbarClockControls();
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

function _saveTopbarIslandItems(items) {
  const hidden = new Map(items.map((item) => [item.id, item.hidden === true]));
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), items },
    // Keep the old feature-local flags in sync for runtimes predating the
    // centralized editor. normalizeTopbarClock v2 owns migration thereafter.
    claudeWidget: { ...(hubSettings.claudeWidget || {}), topbar: !hidden.get('claude') },
    vitals: { ...(hubSettings.vitals || {}), topbar: !hidden.get('vitals') },
  });
  saveHubSettings();
  syncTopbarClockControls();
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// Push visibility onto both chromes and ordering/anchor onto Minimal.
function applyTopbarClockSettings() {
  const cfg = hubSettings.topbarClock || {};
  const align = ['center', 'left', 'right'].includes(cfg.align) ? cfg.align : 'center';
  if (hubSettings.topbarStyle === 'minimal') {
    document.body.dataset.topbarAlign = align;
    if (window.TopbarMinimal) {
      if (window.TopbarMinimal.applyIslandLayout) window.TopbarMinimal.applyIslandLayout();
      // The island moved (align) or its width changed (reorder/hide) — re-tuck any
      // tile now sitting under the pill so headers stay clear on the current page.
      if (window.TopbarMinimal.reflowIsland) window.TopbarMinimal.reflowIsland();
    }
  } else {
    delete document.body.dataset.topbarAlign;
    if (window.TopbarMinimal && window.TopbarMinimal.applyIslandLayout) window.TopbarMinimal.applyIslandLayout();
  }
}

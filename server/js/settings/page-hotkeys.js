// Keyboard shortcuts that jump to a dashboard page.
'use strict';

// ── Global page shortcuts ───────────────────────────────────────────────────
// A dashboard on a second screen is something you look at while working in
// something else, so the way to turn its page cannot be "click the dashboard".
// Each row is a key combination and where it goes: one of this layout's pages,
// or a relative move — `back` is what "toggle between my two pages" is really
// asking for, and it keeps meaning something once there are three.
//
// The combo is registered on the PC running the server (Xenon Helper on
// Windows and macOS, a desktop shortcut on GNOME); the press is broadcast and
// every dashboard watching turns its own page.
const PAGE_HOTKEY_MOVES_UI = ['next', 'prev', 'back'];

// A row whose combo has not been typed yet cannot be saved — the normalizer
// drops it, and rightly: an empty combination is not a shortcut. So the list
// being edited is held HERE while that is true, and not in the closure of the
// rendered rows: anything that re-renders Settings (a hydrate arriving from
// the server, a language switch) would otherwise make a half-finished row
// vanish under the user's hands. Cleared the moment the list is saved.
let _pendingPageHotkeys = null;

function getPageHotkeys() {
  if (_pendingPageHotkeys) return _pendingPageHotkeys.map((b) => ({ ...b }));
  return Array.isArray(hubSettings.pageHotkeys) ? hubSettings.pageHotkeys.map((b) => ({ ...b })) : [];
}

// Save the rows that ARE finished and keep the whole list on screen. Holding
// the finished ones back until every row is complete would mean an empty row
// somebody clicked "Add" on and wandered away from silently swallows the next
// edit they make to a different row.
function savePageHotkeys(list) {
  const complete = list.filter((b) => b.combo);
  _pendingPageHotkeys = complete.length === list.length ? null : list;
  hubSettings = normalizeSettings({ ...hubSettings, pageHotkeys: complete });
  saveHubSettings();
  renderPageHotkeyRows();
}

function addPageHotkey() {
  const list = getPageHotkeys();
  if (list.length >= MAX_PAGE_HOTKEYS) return;
  const pages = dashboardPagesForHotkeys();
  // A new row lands on a page rather than on nothing, so it does something the
  // moment a combo is typed into it. Nothing to save yet — an empty combo is
  // not a shortcut — so this only puts the row on screen.
  list.push({ combo: '', target: (pages[0] && pages[0].id) || 'next' });
  _pendingPageHotkeys = list;
  renderPageHotkeyRows();
}

function removePageHotkey(index) {
  const list = getPageHotkeys();
  list.splice(index, 1);
  savePageHotkeys(list);
}

function updatePageHotkey(index, patch) {
  const list = getPageHotkeys();
  if (!list[index]) return;
  list[index] = { ...list[index], ...patch };
  savePageHotkeys(list);
}

function dashboardPagesForHotkeys() {
  const pages = (hubSettings.dashboardLayout && Array.isArray(hubSettings.dashboardLayout.pages))
    ? hubSettings.dashboardLayout.pages : [];
  return pages;
}

function renderPageHotkeyRows() {
  const mount = $('settings-pagehk-rows');
  if (!mount) return;
  const tr = (k) => (typeof t === 'function' ? t(k) : k);
  const list = getPageHotkeys();
  const pages = dashboardPagesForHotkeys();
  const pageLabel = (p) => p.name || (p.nameKey ? tr(p.nameKey) : '') || p.id;
  const options = pages.map((p) => ({ value: p.id, label: pageLabel(p) }))
    .concat(PAGE_HOTKEY_MOVES_UI.map((m) => ({ value: m, label: tr('settings_pagehk_move_' + m) })));

  mount.textContent = '';
  let savedIndex = 0;
  list.forEach((binding, index) => {
    const row = document.createElement('div');
    row.className = 'settings-pagehk-row';

    const combo = document.createElement('input');
    combo.type = 'text';
    combo.className = 'settings-text-input settings-pagehk-combo';
    combo.autocomplete = 'off';
    combo.spellcheck = false;
    combo.placeholder = 'ctrl+alt+1';
    combo.value = binding.combo || '';
    combo.setAttribute('aria-label', tr('settings_search_combo'));
    combo.addEventListener('change', () => updatePageHotkey(index, { combo: combo.value }));
    row.appendChild(combo);

    const sel = document.createElement('select');
    sel.className = 'settings-select settings-pagehk-target';
    sel.setAttribute('data-custom-select', '');
    sel.setAttribute('data-cs-fixed', '');   // Settings body scrolls; anchor the panel
    sel.setAttribute('aria-label', tr('settings_pagehk_target'));
    let known = false;
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === binding.target) { opt.selected = true; known = true; }
      sel.appendChild(opt);
    }
    // A page this device does not have — the list is shared by every screen —
    // stays selectable so it can be seen and changed rather than silently
    // snapping to another page.
    if (!known && binding.target) {
      const opt = document.createElement('option');
      opt.value = binding.target;
      opt.textContent = binding.target;
      opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => updatePageHotkey(index, { target: sel.value }));
    row.appendChild(sel);

    const state = document.createElement('span');
    state.className = 'settings-pagehk-state';
    // The server numbers its slots over the SAVED shortcuts, which skip any row
    // still being filled in — so a row's slot is its position among the rows
    // that have a combo, not its position on screen.
    if (binding.combo) state.dataset.slot = 'page-' + savedIndex++;
    row.appendChild(state);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'settings-btn subtle settings-pagehk-del';
    del.textContent = '\u00d7';
    del.setAttribute('aria-label', tr('settings_pagehk_remove'));
    del.addEventListener('click', () => removePageHotkey(index));
    row.appendChild(del);

    mount.appendChild(row);
  });
  const add = $('settings-pagehk-add');
  if (add) add.disabled = list.length >= MAX_PAGE_HOTKEYS;
  if (typeof initAllCustomSelects === 'function') initAllCustomSelects(mount);
  refreshPageHotkeyStatus();
}

// Per-row state from the server: 'listening', or why not. A combo another app
// already owns is the common case and it is a property of ONE row, so it is
// reported on that row instead of as a verdict over the whole feature.
async function refreshPageHotkeyStatus() {
  const mount = $('settings-pagehk-rows');
  if (!mount || !mount.children.length) return;
  let slots = {};
  try {
    const r = await fetch('/pages/hotkey-status');
    if (!r.ok) return;
    slots = (await r.json()).slots || {};
  } catch { return; }
  mount.querySelectorAll('.settings-pagehk-state').forEach((el) => {
    const state = el.dataset.slot ? (slots[el.dataset.slot] || '') : '';
    const key = state === 'listening' ? 'settings_pagehk_ok'
      : state === 'taken' ? 'settings_pagehk_taken'
        : state === 'starting' ? 'settings_pagehk_starting'
          : state === 'unsupported_de' ? 'settings_pagehk_unsupported'
            : state ? 'settings_pagehk_error' : '';
    el.textContent = key ? (typeof t === 'function' ? t(key) : key) : '';
    el.classList.toggle('is-ok', state === 'listening');
    el.classList.toggle('is-bad', !!state && state !== 'listening' && state !== 'starting');
  });
}

window.addPageHotkey = addPageHotkey;

// The editors for the island and the action buttons of the top bar.
'use strict';

// Built-in island segment id → i18n label key (editor rows).
const TOPBAR_ISLAND_LABELS = { time: 'topbar_el_time', date: 'topbar_el_date', weather: 'topbar_el_weather', media: 'topbar_el_media', vitals: 'topbar_el_vitals', dots: 'topbar_el_dots', badges: 'topbar_el_badges', claude: 'topbar_el_claude', codex: 'topbar_el_codex', perf: 'topbar_el_perf' };
// Chrome-button id → i18n label key. Must stay in step with ACTION_SELECTORS in
// js/topbar-minimal.js and with the canonical list in BOTH normalizers
// (js/settings.js and its server.js twin) — pinned by test/topbar-island-sync.
const TOPBAR_ACTION_LABELS = {
  lock: 'topbar_btn_lock', ambient: 'topbar_btn_ambient', xenon: 'topbar_btn_xenon',
  search: 'topbar_btn_search', mini: 'topbar_btn_mini', layout: 'topbar_btn_layout',
  settings: 'topbar_btn_settings', apps: 'topbar_btn_apps', favorites: 'topbar_btn_favorites',
};
const EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C5 5 2 12 2 12s3 7 10 7 10-7 10-7-3-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 3.2 1.4 4.6l3.1 3.1A12.9 12.9 0 0 0 2 12s3 7 10 7a10.8 10.8 0 0 0 4.4-.9l3 3 1.4-1.4L2.8 3.2ZM12 16a4 4 0 0 1-3.9-4.9l1.7 1.7A2 2 0 0 0 12 14a2 2 0 0 0 .2 0l1.7 1.7A4 4 0 0 1 12 16Zm0-11c7 0 10 7 10 7a13 13 0 0 1-2.2 3.2l-2.9-2.9A4 4 0 0 0 12 8a4 4 0 0 0-.4 0L9.2 5.6A10.9 10.9 0 0 1 12 5Z"/></svg>';
const CARET_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Which segment option panels are open. View-only state: it survives the
// editor's full re-render but is deliberately never persisted.
const _islandOpenRows = new Set();
const GRIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Reflect the island anchor and (re)render the built-in visibility/order list.
function syncTopbarClockControls() {
  const cfg = hubSettings.topbarClock || {};
  const align = ['center', 'left', 'right'].includes(cfg.align) ? cfg.align : 'center';
  document.querySelectorAll('.settings-topbar-align[data-topbar-align]').forEach(btn => {
    const active = btn.dataset.topbarAlign === align;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderTopbarIslandEditor();
  renderTopbarActionsEditor();
  const takeovers = $('settings-island-takeovers');
  if (takeovers) takeovers.checked = cfg.takeovers !== false;
  // The look page reads the button sides too (a rail holding Settings or Layout).
  if (window.TopbarLookSettings) window.TopbarLookSettings.sync();
}

// Build one editor list: a row per item in display order, each with a drag handle
// (reorder) and an eye toggle (show/hide). Shared by the island-segment list and
// the chrome-button list so the two cannot drift apart; the caller supplies the
// host, the items, the label map and the two writers.
function renderTopbarSegmentEditor(opts) {
  const host = document.getElementById(opts.hostId);
  if (!host) return;
  const items = Array.isArray(opts.items) ? opts.items : [];
  host.replaceChildren();
  items.forEach((it, index) => {
    const row = document.createElement('div');
    row.className = 'island-edit-row';
    row.dataset.islandIndex = String(index);

    const handle = document.createElement('span');
    handle.className = 'island-edit-handle';
    handle.title = t('topbar_el_reorder');
    handle.innerHTML = GRIP_SVG; // static, trusted markup

    const label = document.createElement('span');
    label.className = 'island-edit-label';
    label.textContent = typeof opts.labelOf === 'function' ? opts.labelOf(it.id) : t(opts.labels[it.id] || it.id);

    const hidden = it.hidden === true;
    // A row may refuse to be hidden (Settings). The eye stays, disabled and
    // explained: a control that silently disappears reads as a fault, and the
    // user still needs to see that this one is deliberately always on.
    const locked = typeof opts.locked === 'function' && opts.locked(it.id);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'island-edit-eye';
    eye.classList.toggle('is-hidden', hidden);
    eye.classList.toggle('is-locked', locked);
    eye.disabled = locked;
    eye.setAttribute('aria-pressed', String(!hidden));
    eye.title = locked ? t('topbar_btn_always_hint') : t(hidden ? 'topbar_el_show' : 'topbar_el_hide');
    eye.innerHTML = hidden ? EYE_OFF_SVG : EYE_OPEN_SVG; // static, trusted markup
    if (!locked) eye.addEventListener('click', () => opts.onToggle(it.id));

    row.append(handle, label);
    if (typeof opts.buildSide === 'function') {
      const side = opts.buildSide(it);
      if (side) row.append(side);
    }
    // Segments that carry their own options get a chevron. The open/closed state
    // is view-only (never persisted) but must survive the full re-render every
    // settings change triggers, or toggling the option inside the panel would
    // slam the panel shut.
    const sub = typeof opts.buildOptions === 'function' ? opts.buildOptions(it.id) : null;
    if (sub) {
      const caret = document.createElement('button');
      caret.type = 'button';
      caret.className = 'island-edit-caret';
      caret.title = t('topbar_el_options');
      caret.setAttribute('aria-expanded', String(_islandOpenRows.has(it.id)));
      caret.innerHTML = CARET_SVG; // static, trusted markup
      caret.addEventListener('click', () => {
        const open = !_islandOpenRows.has(it.id);
        if (open) _islandOpenRows.add(it.id); else _islandOpenRows.delete(it.id);
        row.classList.toggle('is-open', open);
        sub.hidden = !open;
        caret.setAttribute('aria-expanded', String(open));
      });
      row.append(caret, eye, sub);
      row.classList.toggle('is-open', _islandOpenRows.has(it.id));
      sub.hidden = !_islandOpenRows.has(it.id);
    } else {
      row.append(eye);
    }
    host.appendChild(row);
  });
  initTopbarIslandDrag(host, opts.onReorder);
}

function renderTopbarIslandEditor() {
  renderTopbarSegmentEditor({
    hostId: 'topbar-island-editor',
    items: (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items))
      ? hubSettings.topbarClock.items : [],
    labels: TOPBAR_ISLAND_LABELS,
    onToggle: toggleTopbarIslandItem,
    onReorder: reorderTopbarIslandItem,
    buildOptions: islandItemOptions,
  });
}

// The chrome buttons. Same component, plus a left/right control per row: unlike
// an island segment, a button lives in one of two containers and the user gets to
// say which. Ordering is within the side it ends up on.
// Drawn in Settings → Top bar and, while it is open, in the bar panel of
// Layout mode (js/topbar-layout-panel.js): two views of the same list.
function renderTopbarActionsEditor() {
  ['topbar-actions-editor', 'tbp-actions-editor'].forEach(renderTopbarActionsEditorIn);
}

function renderTopbarActionsEditorIn(hostId) {
  renderTopbarSegmentEditor({
    hostId,
    items: _topbarActionItems(),
    labels: TOPBAR_ACTION_LABELS,
    labelOf: topbarActionLabel,
    locked: (id) => id === 'settings' || id === 'layout',
    onToggle: toggleTopbarActionItem,
    onReorder: reorderTopbarActionItem,
    buildSide: buildTopbarActionSide,
    // Each button's own icon, label and colours (js/topbar-button-options.js).
    buildOptions: (id) => (window.TopbarButtonOptions ? TopbarButtonOptions.panel(id) : null),
  });
}

// Left/right segmented control for one button row.
function buildTopbarActionSide(item) {
  const wrap = document.createElement('div');
  wrap.className = 'island-edit-side';
  [['left', 'topbar_btn_side_left'], ['right', 'topbar_btn_side_right']].forEach(([side, key]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'island-edit-side-btn' + (item.side === side ? ' active' : '');
    btn.textContent = t(key);
    btn.setAttribute('aria-pressed', String(item.side === side));
    btn.addEventListener('click', () => setTopbarActionSide(item.id, side));
    wrap.appendChild(btn);
  });
  return wrap;
}

// Build the options panel for a segment, or null when it has none.
function islandItemOptions(id) {
  if (id !== 'media' && id !== 'dots') return null;
  const cfg = hubSettings.topbarClock || {};
  const media = id === 'media';
  const sub = document.createElement('div');
  sub.className = 'island-edit-sub';
  const row = document.createElement('label');
  row.className = 'settings-toggle-row full';
  const input = document.createElement('input');
  input.className = 'settings-check';
  input.type = 'checkbox';
  input.checked = media ? cfg.mediaTakeover === true : cfg.pageLabels === true;
  input.addEventListener('change', () => (media
    ? updateIslandMediaTakeover(input.checked)
    : updateIslandPageLabels(input.checked)));
  const line = document.createElement('span');
  line.className = 'settings-label-line';
  const name = document.createElement('span');
  name.textContent = t(media ? 'topbar_el_media_full' : 'topbar_el_dots_labels');
  const hint = document.createElement('span');
  hint.className = 'settings-hint';
  hint.textContent = t(media ? 'topbar_el_media_full_hint' : 'topbar_el_dots_labels_hint');
  line.append(name, hint);
  row.append(input, line);
  sub.append(row);
  return sub;
}

// Page dots carry the page names instead of being anonymous circles. The option
// is filed under the island's "Page dots" row because that is where the element
// is configured, but it applies to BOTH chromes — the dots host lives in the
// topbar and Minimal only carries it into the pill.
function updateIslandPageLabels(checked) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), pageLabels: checked === true },
  });
  saveHubSettings();
  if (window.DashboardPager && typeof DashboardPager.renderDots === 'function') DashboardPager.renderDots();
  // Circles become pills, so the dots row changes width — and in Minimal that row
  // is INSIDE the island pill, whose width is what every top-row tile was tucked
  // clear of. Without this the pill grows over tile headers that keep their stale
  // inset until some unrelated event happens to reflow. Same rule sdk-badges.js
  // follows when a chip appears: a structural change re-runs the island layout.
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// While a track plays, hand the whole capsule to the player and step the other
// segments aside; they come back the moment it pauses or stops. The capsule
// keeps its own natural size either way — it hugs the player exactly as it hugs
// the clock, and never stretches to the width of the screen.
function updateIslandMediaTakeover(checked) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), mediaTakeover: checked === true },
  });
  saveHubSettings();
  if (window.TopbarMedia && typeof TopbarMedia.apply === 'function') TopbarMedia.apply();
  setSettingsStatus('settings_saved', 'ok');
}

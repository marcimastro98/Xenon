// Profiles that change the dashboard with the app in front, and proactive hints.
'use strict';

// ── Proactive moments (Settings → Performance) ────────────────────
// Per-type toggles for the briefing engine: sustained-thermal alerts and game
// session recaps are emitted server-side; the morning agenda enriches the
// greeting splash client-side. All default ON, all individually toggleable.
function updateProactive(type, enabled) {
  const cur = hubSettings.proactive || {};
  hubSettings = normalizeSettings({ ...hubSettings, proactive: { ...cur, [type]: !!enabled } });
  saveHubSettings();
  syncProactiveControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncProactiveControls() {
  const p = hubSettings.proactive || {};
  for (const type of ['thermal', 'recap', 'morning', 'anomaly']) {
    const el = $(`settings-proactive-${type}`);
    if (el) el.checked = p[type] !== false;
  }
}

// ── Smart context profiles (Settings → Performance) ───────────────
// Per-activity page/lighting/deck that auto-switch when the foreground activity
// changes; context-profiles.js applies them and reverts on exit. Opt-in.
function _saveContextProfiles(patch) {
  const prev = normalizeContextProfiles(hubSettings.contextProfiles);
  const next = { ...prev, ...patch, map: { ...prev.map, ...(patch.map || {}) } };
  hubSettings = normalizeSettings({ ...hubSettings, contextProfiles: next });
  saveHubSettings();
  if (window.ContextProfiles && typeof window.ContextProfiles.refresh === 'function') window.ContextProfiles.refresh();
}

function updateContextEnabled(enabled) {
  _saveContextProfiles({ enabled: !!enabled });
  syncContextProfileControls();
  setSettingsStatus('settings_saved', 'ok');
}

function updateContextRevert(revert) {
  _saveContextProfiles({ revertOnExit: !!revert });
  setSettingsStatus('settings_saved', 'ok');
}

// One dimension (page | lighting | deck | style) of one activity's profile
// changed. The custom-select updates its own visible label, so no full
// re-render is needed.
function updateContextMap(activity, dim, value) {
  if (!PERF_ACTIVITIES.includes(activity) || !['page', 'lighting', 'deck', 'style'].includes(dim)) return;
  const prev = normalizeContextProfiles(hubSettings.contextProfiles);
  const entry = { ...prev.map[activity], [dim]: value || '' };
  _saveContextProfiles({ map: { [activity]: entry } });
  setSettingsStatus('settings_saved', 'ok');
}

function resetContextProfiles() {
  const empty = {};
  for (const act of PERF_ACTIVITIES) empty[act] = { page: '', lighting: '', deck: '', style: '' };
  _saveContextProfiles({ map: empty });
  syncContextProfileControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncContextProfileControls() {
  const c = normalizeContextProfiles(hubSettings.contextProfiles);
  const en = $('settings-ctxprof-enabled');
  if (en) en.checked = c.enabled;
  const rev = $('settings-ctxprof-revert');
  if (rev) rev.checked = c.revertOnExit;
  const wrap = $('settings-ctxprof-options');
  if (wrap) wrap.hidden = !c.enabled;
  renderContextProfileRows(c);
}

// One closed row per detectable activity, with a Page / Lighting / Deck / Style
// list inside. Options come from the live layout + deck instances, so they always
// match what the user has. Saving re-renders nothing, but a settings sync does:
// what was open stays open.
function renderContextProfileRows(c) {
  const mount = $('settings-ctxprof-rows');
  if (!mount) return;
  const tr = (k) => (typeof t === 'function' ? t(k) : k);
  const open = new Set(Array.from(mount.querySelectorAll('details[open]'), d => d.dataset.activity));
  const pages = (hubSettings.dashboardLayout && Array.isArray(hubSettings.dashboardLayout.pages))
    ? hubSettings.dashboardLayout.pages : [];
  const pageLabel = (p) => p.name || (p.nameKey ? tr(p.nameKey) : '') || p.id;
  let deckProfiles = [];
  try { if (window.Deck && Deck.listProfiles) deckProfiles = Deck.listProfiles().map(p => p.name); } catch { deckProfiles = []; }
  const lightingOpts = [
    ['', 'context_none'], ['none', 'context_light_off'], ['solid', 'context_light_solid'],
    ['breathing', 'context_light_breathing'], ['cycle', 'context_light_cycle'],
  ];

  mount.textContent = '';
  for (const act of PERF_ACTIVITIES) {
    const entry = (c.map && c.map[act]) || { page: '', lighting: '', deck: '' };
    const row = contextExpander(act, tr('settings_perf_act_' + act));
    row.open = open.has(act);
    const grid = row.querySelector('.settings-grid');
    grid.appendChild(contextRow('settings_ctxprof_col_page', buildContextSelect(act, 'page', entry.page,
      [{ value: '', label: tr('context_none') }].concat(pages.map(p => ({ value: p.id, label: pageLabel(p) }))))));
    grid.appendChild(contextRow('settings_ctxprof_col_light', buildContextSelect(act, 'lighting', entry.lighting,
      lightingOpts.map(([value, key]) => ({ value, label: tr(key) })))));
    grid.appendChild(contextRow('settings_ctxprof_col_deck', buildContextSelect(act, 'deck', entry.deck,
      [{ value: '', label: tr('context_none') }].concat(deckProfiles.map(n => ({ value: n, label: n }))))));
    // Base styles PLUS every saved custom theme, so a profile can switch to a
    // full look (e.g. "when gaming → Cyberpunk"), not just the Glass/Retro skin.
    grid.appendChild(contextRow('settings_ctxprof_col_style', buildContextSelect(act, 'style', entry.style, [
      { value: '', label: tr('context_none') },
      { value: 'liquid', label: tr('settings_style_liquid') },
      { value: 'glass', label: tr('settings_style_glass') },
      { value: 'retro', label: tr('settings_style_retro') },
    ].concat(getCustomThemes().map(th => ({ value: th.id, label: themeName(th) }))))));
    syncContextSummary(row);
    mount.appendChild(row);
  }
  if (typeof initAllCustomSelects === 'function') initAllCustomSelects(mount);
}

function contextExpander(activity, name) {
  const details = document.createElement('details');
  details.className = 'settings-expander';
  details.dataset.activity = activity;
  const summary = document.createElement('summary');
  const line = document.createElement('span');
  line.className = 'settings-label-line';
  const title = document.createElement('span');
  title.setAttribute('data-i18n', 'settings_perf_act_' + activity);
  title.textContent = name;
  const picked = document.createElement('span');
  picked.className = 'settings-hint';
  line.appendChild(title);
  line.appendChild(picked);
  summary.appendChild(line);
  details.appendChild(summary);
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  details.appendChild(grid);
  return details;
}

function contextRow(labelKey, select) {
  const row = document.createElement('div');
  row.className = 'settings-row full';
  const line = document.createElement('span');
  line.className = 'settings-label-line';
  const name = document.createElement('span');
  name.setAttribute('data-i18n', labelKey);
  name.textContent = typeof t === 'function' ? t(labelKey) : labelKey;
  select.setAttribute('aria-label', name.textContent);
  line.appendChild(name);
  row.appendChild(line);
  row.appendChild(select);
  return row;
}

// The line under a closed activity: what it switches to, read off its lists.
function syncContextSummary(details) {
  const line = details.querySelector('summary .settings-hint');
  if (!line) return;
  line.textContent = Array.from(details.querySelectorAll('select'))
    .filter(sel => sel.value)
    .map(sel => sel.options[sel.selectedIndex].textContent)
    .join(', ');
}

// A closed list of switches still says which are on.
function syncExpanderSummary(details) {
  const line = details.querySelector('summary .settings-hint');
  if (!line) return;
  line.textContent = Array.from(details.querySelectorAll('input.settings-check'))
    .filter(box => box.checked)
    .map(box => box.closest('label').querySelector('[data-i18n]').textContent.trim())
    .join(', ');
}

function syncExpanderSummaries() {
  document.querySelectorAll('#settings-content details[data-on-summary]').forEach(syncExpanderSummary);
}

function buildContextSelect(activity, dim, current, options) {
  const sel = document.createElement('select');
  sel.className = 'settings-select';
  sel.setAttribute('data-custom-select', '');
  sel.setAttribute('data-cs-fixed', ''); // Settings body scrolls; anchor the panel
  let hasCurrent = false;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === current) { opt.selected = true; hasCurrent = true; }
    sel.appendChild(opt);
  }
  // A previously-picked page/deck that no longer exists stays selectable, so the
  // user can see and clear it instead of it silently snapping to "none".
  if (!hasCurrent && current) {
    const opt = document.createElement('option');
    opt.value = current; opt.textContent = current; opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    updateContextMap(activity, dim, sel.value);
    syncContextSummary(sel.closest('details'));
  });
  return sel;
}

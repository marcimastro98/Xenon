// Performance Mode and the sensor rate: their switches and what they show.
'use strict';

// ── Performance Mode (Settings → Performance) ─────────────────────
// The heavy lifting (apply/restore, auto-suggest banner, confirmation sheet)
// lives in performance.js (window.Performance). These handlers persist the
// user's choices and let the controller re-evaluate. Opt-in, off by default.
function _savePerformance(patch) {
  const prev = normalizePerformance(hubSettings.performance);
  const next = { ...prev, ...patch, opts: { ...prev.opts, ...(patch.opts || {}) } };
  hubSettings = normalizeSettings({ ...hubSettings, performance: next });
  saveHubSettings();
  if (window.PerfMode && typeof window.PerfMode.refresh === 'function') window.PerfMode.refresh();
}

// The cadence everything sensor-shaped runs at. Saving it is enough: the server
// reads the value per tick and per cache check, so the next reading uses it —
// there is nothing to restart and nothing to tell the dashboard.
function updateSensorRate(ms) {
  const next = SENSOR_RATE_MS.includes(Math.round(Number(ms))) ? Math.round(Number(ms)) : 5000;
  hubSettings = normalizeSettings({ ...hubSettings, sensorRateMs: next });
  saveHubSettings();
  syncSensorRateControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncSensorRateControls() {
  const rate = SENSOR_RATE_MS.includes(Math.round(Number(hubSettings.sensorRateMs)))
    ? Math.round(Number(hubSettings.sensorRateMs)) : 5000;
  const seg = $('settings-sensor-rate');
  if (seg) {
    seg.querySelectorAll('.settings-seg-btn').forEach((b) => {
      const on = Number(b.dataset.rate) === rate;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  // The note says what THIS step costs, not what the feature is. A faster
  // cadence is a real trade and the person choosing it should read the price at
  // the moment they choose, not in a manual.
  const note = $('settings-sensor-rate-hint');
  if (note) {
    const key = 'settings_sensorrate_note_' + rate;
    note.setAttribute('data-i18n', key);
    if (typeof t === 'function') note.textContent = t(key);
  }
}

function updatePerformanceEnabled(enabled) {
  _savePerformance({ enabled: !!enabled });
  syncPerformanceControls();
  setSettingsStatus('settings_saved', 'ok');
}

// Single 3-state mode selector (replaces the old autoSuggest + autoMode pair).
//   'manual'  → only acts on "Optimize now"        (autoSuggest off, autoMode 'suggest')
//   'suggest' → banner when a tracked activity starts (autoSuggest on, autoMode 'suggest')
//   'auto'    → applies by itself, restores on exit  (autoMode 'auto')
// Mapped onto the two persisted fields so existing installs stay compatible.
function updatePerformanceMode(mode) {
  if (mode === 'auto') _savePerformance({ autoMode: 'auto' });
  else _savePerformance({ autoSuggest: mode === 'suggest', autoMode: 'suggest' });
  syncPerformanceControls();
  setSettingsStatus('settings_saved', 'ok');
}

// Toggle which activity auto-suggests (any of PERF_ACTIVITIES).
function updatePerformanceActivity(activity, enabled) {
  if (!PERF_ACTIVITIES.includes(activity)) return;
  const cur = normalizePerformance(hubSettings.performance);
  _savePerformance({ autoActivities: { ...cur.autoActivities, [activity]: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformanceBarAlways(enabled) {
  _savePerformance({ barAlways: !!enabled });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformanceUseAi(enabled) {
  _savePerformance({ useAi: !!enabled });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformancePauseAnim(enabled) {
  _savePerformance({ opts: { pauseAnimations: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

// Phase 1 surfaces the power plan as a single high-performance toggle; the data
// model still supports 'ultimate' for later use.
function updatePerformancePowerPlan(enabled) {
  _savePerformance({ opts: { powerPlan: enabled ? 'high' : 'none' } });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformanceManageApps(enabled) {
  _savePerformance({ opts: { manageApps: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformancePriority(enabled) {
  _savePerformance({ opts: { priorityBoost: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

// Pause the heavy live tiles (Browser, future second screen) while gaming or an
// optimization session is active. Off = let them keep streaming during games.
function updatePerformancePauseStreams(enabled) {
  _savePerformance({ opts: { pauseStreams: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

// Core Shield: busy apps move off the game's cores when the PC runs out of them.
function updatePerformanceShield(enabled) {
  _savePerformance({ opts: { shield: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

// Whether a PC can run it depends on its cores and OS tools, so the server says, once.
let _shieldAvailable = null;
async function syncPerformanceShieldRow() {
  if (_shieldAvailable === null) {
    try {
      const res = await fetch(SERVER + '/api/performance/shield');
      const d = await res.json();
      _shieldAvailable = !!(d && d.ok && d.available);
    } catch { return; }
  }
  const row = $('settings-perf-shield-row');
  if (row) row.hidden = !_shieldAvailable;
}

function optimizePerformanceNow() {
  if (window.PerfMode && typeof window.PerfMode.optimize === 'function') window.PerfMode.optimize();
}

// The System tile's button: optimize when nothing runs, restore when a session
// does (performance.js relabels it to match).
function togglePerformanceFromSystem() {
  const p = normalizePerformance(hubSettings.performance);
  if (p.active) restorePerformance(); else optimizePerformanceNow();
}

function restorePerformance() {
  if (window.PerfMode && typeof window.PerfMode.restore === 'function') window.PerfMode.restore();
}

function syncPerformanceControls() {
  syncSensorRateControls();
  const p = normalizePerformance(hubSettings.performance);
  const setChecked = (id, checked) => { const el = $(id); if (el) el.checked = checked; };
  setChecked('settings-perf-enabled', p.enabled);
  // Derive the 3-state mode from the two persisted fields and reflect it onto
  // the segmented control + its dynamic description line.
  const mode = p.autoMode === 'auto' ? 'auto' : (p.autoSuggest ? 'suggest' : 'manual');
  const seg = $('settings-perf-mode');
  if (seg) {
    seg.querySelectorAll('.settings-seg-btn').forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  const modeHint = $('settings-perf-mode-hint');
  if (modeHint) {
    const key = 'settings_perf_mode_' + mode + '_hint';
    modeHint.setAttribute('data-i18n', key);
    if (typeof t === 'function') modeHint.textContent = t(key);
  }
  for (const act of PERF_ACTIVITIES) setChecked('settings-perf-act-' + act, p.autoActivities[act]);
  // Activities and their trigger apps only matter when an automatic mode is
  // active; both rows go in manual mode.
  for (const id of ['settings-perf-activities', 'settings-perf-apps']) {
    const row = $(id);
    if (row) row.hidden = (mode === 'manual');
  }
  renderPerformanceTriggerApps();
  setChecked('settings-perf-baralways', p.barAlways);
  setChecked('settings-perf-useai', p.useAi);
  setChecked('settings-perf-pauseanim', p.opts.pauseAnimations);
  setChecked('settings-perf-powerplan', p.opts.powerPlan !== 'none');
  setChecked('settings-perf-manageapps', p.opts.manageApps);
  setChecked('settings-perf-priority', p.opts.priorityBoost);
  setChecked('settings-perf-pausestreams', p.opts.pauseStreams);
  setChecked('settings-perf-shield', p.opts.shield);
  // The options mean nothing while the mode is off.
  const wrap = $('settings-perf-options');
  if (wrap) wrap.hidden = !p.enabled;
  if (p.enabled) syncPerformanceShieldRow();
  syncExpanderSummaries();
}

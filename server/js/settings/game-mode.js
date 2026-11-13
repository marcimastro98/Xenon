// Game mode, the performance overlay, sensor history and recorded game sessions.
'use strict';

// ── Game mode (auto-pause ambient FX during games) ────────────────
let _gamingActive = false; // last server-reported "a game is presenting" state
let _gameModeTimer = null;

// Minimum time the gaming state must hold before we fade the ambient layers in
// or out. Closing windows / Alt-Tabbing briefly flips the foreground through
// fullscreen-shaped windows, which would otherwise toggle body.game-mode rapidly
// and animate the aurora/grid opacity on and off — read as flicker, especially
// the neon grid over a custom background. A short dwell absorbs those blips.
const GAME_MODE_DWELL_MS = 900;

function _gameModeDesired() {
  return _gamingActive && hubSettings.gameMode !== false;
}

// Two classes, two meanings. `game-mode` is the LOOK (fade the background,
// pause effects) and honours the Game mode switch. `game-running` is the FACT
// that a game is in front, whatever that switch says: the native shell keeps
// the game focused off it (native-bridge.js), and that is the tray's own
// "Keep games focused" to switch off, not a side effect of a background
// preference. It used to follow `game-mode`, so turning Game mode off to keep
// the background during games silently let every tap on Xenon take the game's
// focus while the tray still showed the option ticked.
function _applyGameClasses() {
  document.body.classList.toggle('game-mode', _gameModeDesired());
  document.body.classList.toggle('game-running', _gamingActive);
}

// Apply the classes immediately — used for direct user actions (toggling the
// setting, reset, settings re-apply), which must take effect at once.
function _evalGameModeClass() {
  if (_gameModeTimer) { clearTimeout(_gameModeTimer); _gameModeTimer = null; }
  _applyGameClasses();
}

// Called from the SSE 'status' handler with the live gaming flag. Debounced so a
// transient foreground change doesn't visibly fade the ambient FX in/out.
function applyGameMode(gaming) {
  _gamingActive = !!gaming;
  const c = document.body.classList;
  // Already in the desired state (or a pending flip would land where we already
  // are): cancel any pending change and stop — nothing to animate.
  if (_gameModeDesired() === c.contains('game-mode') && _gamingActive === c.contains('game-running')) {
    if (_gameModeTimer) { clearTimeout(_gameModeTimer); _gameModeTimer = null; }
    return;
  }
  if (_gameModeTimer) clearTimeout(_gameModeTimer);
  _gameModeTimer = setTimeout(() => {
    _gameModeTimer = null;
    _applyGameClasses();
  }, GAME_MODE_DWELL_MS);
}

function updateGameMode(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, gameMode: !!enabled });
  saveHubSettings();
  _evalGameModeClass();
  syncGameModeControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncGameModeControls() {
  const el = $('settings-gamemode-enabled');
  if (el) el.checked = hubSettings.gameMode !== false;
}

// Local sensor-history opt-in (Settings → Performance). Independent of the AI
// Guardian feature: turning this on records CPU/GPU/RAM over time for the history
// charts, with or without any AI. Off by default; the data never leaves the PC.
function updateSensorHistory(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, sensorHistory: { ...hubSettings.sensorHistory, enabled: !!enabled } });
  saveHubSettings();
  syncSensorHistoryControls();
  // Let the System-tile History tab appear/disappear immediately.
  document.dispatchEvent(new CustomEvent('sensor-history-changed'));
  setSettingsStatus('settings_saved', 'ok');
}

// Game sessions log (Settings → Performance → Partite giocate). ON by default;
// the group shows only where the server can read a frame rate.
function updateGameSessions(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, gameSessions: { enabled: !!enabled } });
  saveHubSettings();
  syncGameSessionsControls();
  setSettingsStatus('settings_saved', 'ok');
}

// What the Game performance tile shows besides the FPS (js/perf-hud.js).
function updatePerfHud(part, on) {
  if (!window.PerfHud || !window.PerfHud.PERF_HUD_PARTS.includes(part)) return;
  const perfHud = window.PerfHud.applyPerfHudChange(hubSettings.perfHud, { [part]: !!on });
  hubSettings = normalizeSettings({ ...hubSettings, perfHud });
  saveHubSettings();
  syncPerfHudControls();
  if (window.PerfWidget) window.PerfWidget.renderWidgets();
  setSettingsStatus('settings_saved', 'ok');
}

function syncPerfHudControls() {
  const parts = window.PerfHud ? window.PerfHud.normalizePerfHud(hubSettings.perfHud) : null;
  if (!parts) return;
  for (const k of window.PerfHud.PERF_HUD_PARTS) {
    const el = $(`settings-perfhud-${k}`);
    if (el) el.checked = parts[k];
  }
  syncExpanderSummaries();
}

let _gameSessionsProbe = null;
let _gameSessionsClearArmed = 0;

function syncGameSessionsControls() {
  const el = $('settings-gamesess-enabled');
  if (el) el.checked = !(hubSettings.gameSessions && hubSettings.gameSessions.enabled === false);
  if (window.GameSessionsPane) window.GameSessionsPane.render();
  const group = $('settings-gamesess-group');
  if (!group || _gameSessionsProbe) return;
  _gameSessionsProbe = apiJson('/actions/catalog').then((d) => {
    if (!d) { _gameSessionsProbe = null; return; }   // asked again on the next render
    setSettingsCardAvailable(group, !!(d.capabilities && d.capabilities.gameSessions === true));
  });
}

// Two taps, not a dialog: the first arms the button for a few seconds and says
// what the second one does.
async function clearGameSessions() {
  const btn = $('settings-gamesess-clear');
  if (!btn) return;
  if (Date.now() - _gameSessionsClearArmed > 4000) {
    _gameSessionsClearArmed = Date.now();
    btn.textContent = t('settings_gamesess_clear_confirm');
    setTimeout(() => {
      if (Date.now() - _gameSessionsClearArmed >= 4000) btn.textContent = t('settings_gamesess_clear');
    }, 4100);
    return;
  }
  _gameSessionsClearArmed = 0;
  btn.textContent = t('settings_gamesess_clear');
  const res = await apiJson('/actions/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'gameSessionsSet', mode: 'clear' }),
  });
  setSettingsStatus(res && res.ok ? 'settings_gamesess_cleared' : 'settings_gamesess_clear_failed', res && res.ok ? 'ok' : 'error');
  if (window.GameSessionsPane) window.GameSessionsPane.render();
}

function syncSensorHistoryControls() {
  const el = $('settings-senshist-enabled');
  if (el) el.checked = !!(hubSettings.sensorHistory && hubSettings.sensorHistory.enabled === true);
  if (window.SensorHistoryEvery) window.SensorHistoryEvery.sync();
  // Keep the System-tile History tab's visibility in sync on every settings
  // render (initial hydrate included), not only on an explicit toggle.
  if (typeof window.syncSystemHistoryTab === 'function') window.syncSystemHistoryTab();
}

// ── Lighting settings (Settings → Illuminazione) ──────────────────
// The full RGB hub (master, brightness, manual colour, animation, reactive
// effects, event flashes, iCUE devices, external providers) renders dynamically
// via lighting-page.js into #settings-lighting-hub and persists through
// /api/lighting/*. syncSettingsControls() calls window.LightingPage.init().

// What this row says depends on which FPS reader the platform has.
//
// Windows: PresentMon is a download Xenon performs itself, so the row is purely
// a "missing → here is the button" prompt and disappears once installed.
//
// Linux: MangoHud is a package from the distro AND a per-launch decision
// (`mangohud %command%`), so there is no button to offer and the row stays
// visible even when it is installed — because installing it is only half of
// what the user has to do, and a row that vanishes on install would imply FPS
// now appear on their own. Saying nothing here is how someone concludes the
// FPS tile is broken.
async function refreshGameModeStatus() {
  const row = $('settings-gamemode-install-row');
  if (!row) return;
  const note = $('settings-gamemode-note');
  const btn = $('settings-gamemode-install');
  try {
    const res = await fetch(SERVER + '/api/gamemode/status');
    if (!res.ok) throw new Error('status unavailable');
    const data = await res.json();
    if (data.fpsBackend === 'mangohud') {
      const key = data.fpsAvailable ? 'settings_gamemode_mangohud_ready' : 'settings_gamemode_mangohud_missing';
      if (note) { note.setAttribute('data-i18n', key); note.textContent = t(key); }
      if (btn) btn.hidden = true;
      row.hidden = false;
      return;
    }
    if (note) { note.setAttribute('data-i18n', 'settings_gamemode_need_tool'); note.textContent = t('settings_gamemode_need_tool'); }
    if (btn) btn.hidden = false;
    row.hidden = !!data.presentMonAvailable;
  } catch {
    // If we can't tell, hide the button rather than nag — the server may be old.
    row.hidden = true;
  }
}

async function installPresentMon(btn) {
  if (!btn) return;
  btn.disabled = true;
  setSettingsStatus('settings_gamemode_installing', 'ok');
  try {
    const res = await fetch(SERVER + '/api/gamemode/install-presentmon', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error('install failed');
    setSettingsStatus('settings_gamemode_installed', 'ok');
    await refreshGameModeStatus();
  } catch {
    setSettingsStatus('settings_gamemode_install_failed', 'error');
    btn.disabled = false;
  }
}

// The second-screen settings: resolution, quality, touch and capture.
'use strict';

// ── Second-screen capture settings ────────────────────────────────
// fps/quality just tune the live stream (the tile reads them on its next start).
// Resolution + remove drive the virtual display itself via the server's elevated
// create-display / remove-display (UAC) — surfaced with a clear status line.
// Guards the onchange handlers against the synthetic 'change' events we dispatch
// to refresh the custom-select labels during a programmatic sync.
let _ssSyncing = false;

function _saveSecondScreen(patch) {
  const cur = normalizeSecondScreen(hubSettings.secondScreen);
  hubSettings = normalizeSettings({ ...hubSettings, secondScreen: { ...cur, ...patch } });
  saveHubSettings({ server: true });
  syncSecondScreenControls();
}

function updateSecondScreenFps(value) {
  if (_ssSyncing) return;
  _saveSecondScreen({ fps: parseInt(value, 10) });
  setSettingsStatus('settings_saved', 'ok');
}

function updateSecondScreenQuality(value) {
  if (_ssSyncing) return;
  _saveSecondScreen({ quality: parseInt(value, 10) });
  setSettingsStatus('settings_saved', 'ok');
}

function updateSecondScreenResolution(value) {
  if (_ssSyncing) return;
  const parts = String(value || '').split('x');
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  if (width && height) _saveSecondScreen({ width, height });
}

// Apply the chosen resolution to the virtual display. The server commits the mode
// live (no UAC in the common case); only first-time setup or a never-advertised
// mode falls back to the elevated, idempotent device (re)create. On success the
// tile is told to re-request its stream so the new size shows immediately.
async function applySecondScreenResolution(btn) {
  const s = normalizeSecondScreen(hubSettings.secondScreen);
  const status = $('settings-secondscreen-status');
  if (btn) btn.disabled = true;
  if (status) { status.hidden = false; status.textContent = t('second_screen_working'); }
  try {
    const res = await fetch('/second-screen/apply-resolution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: { width: s.width, height: s.height } }),
    }).then((r) => r.json());
    if (status) {
      if (res && res.code === 'display_needs_reboot') status.textContent = t('second_screen_reboot');
      else if (res && res.ok) status.textContent = t('second_screen_applied');
      else status.textContent = t('second_screen_install_failed');
    }
    if (res && res.ok && res.code !== 'display_needs_reboot') {
      window.dispatchEvent(new CustomEvent('second-screen-mode-changed'));
    }
  } catch (e) {
    if (status) status.textContent = t('second_screen_install_failed');
  }
  if (btn) btn.disabled = false;
}

// Remove the virtual display (disable / cleanup). Elevated, and destructive (the
// extra monitor and anything on it goes away), so confirm first — mirrors the
// page-delete confirmation pattern.
async function removeSecondScreenDisplay(btn) {
  const status = $('settings-secondscreen-status');
  const msg = (typeof t === 'function') ? t('second_screen_remove_confirm')
    : 'Remove the virtual second screen? Windows will close it and move any open windows back. You can re-create it anytime from here.';
  if (typeof confirm === 'function' && !confirm(msg)) return;
  if (btn) btn.disabled = true;
  if (status) { status.hidden = false; status.textContent = t('second_screen_working'); }
  try {
    const res = await fetch('/second-screen/remove-display', { method: 'POST' }).then((r) => r.json());
    if (status) status.textContent = res && res.ok ? t('second_screen_removed') : t('second_screen_install_failed');
  } catch (e) {
    if (status) status.textContent = t('second_screen_install_failed');
  }
  if (btn) btn.disabled = false;
}

// Persist the tile's fill mode ('contain' | 'cover'). Called from the second-screen
// tile's toolbar toggle; routed through here so it survives reloads/restarts like
// the other second-screen prefs. Exposed on window for the tile's separate scope.
function setSecondScreenFit(fit) {
  _saveSecondScreen({ fit: fit === 'cover' ? 'cover' : 'contain' });
}
window.setSecondScreenFit = setSecondScreenFit;

// Persist whether finger touch controls the virtual screen or scrolls the
// dashboard. Toggled from the tile's toolbar; exposed for the tile's scope.
function setSecondScreenTouchControl(on) {
  _saveSecondScreen({ touchControl: !!on });
}
window.setSecondScreenTouchControl = setSecondScreenTouchControl;

// Persist the quick FPS/quality presets picked from the tile's on-tile tune
// panel — same store the Settings selects use, so both UIs stay in sync
// (_saveSecondScreen re-syncs the selects). Exposed for the tile's scope.
function setSecondScreenCapture(fps, quality) {
  const patch = {};
  if (Number.isFinite(fps)) patch.fps = fps;
  if (Number.isFinite(quality)) patch.quality = quality;
  if (Object.keys(patch).length) _saveSecondScreen(patch);
}
window.setSecondScreenCapture = setSecondScreenCapture;

function syncSecondScreenControls() {
  const s = normalizeSecondScreen(hubSettings.secondScreen);
  _ssSyncing = true;
  // Set value then fire 'change' so the custom-select labels refresh; our own
  // onchange handlers no-op while _ssSyncing is set.
  const setVal = (id, val) => {
    const el = $(id);
    if (!el) return;
    el.value = String(val);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setVal('settings-secondscreen-fps', s.fps);
  setVal('settings-secondscreen-quality', s.quality);
  setVal('settings-secondscreen-resolution', s.width + 'x' + s.height);
  _ssSyncing = false;
}

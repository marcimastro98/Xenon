// The ad-blocking switch of the browser tile.
'use strict';

// ── Browser tile ad-blocker (Settings → Browser) ──────────────────────────────
let _browserAdblockBusy = false;   // guards against re-entrancy while installing

function setBrowserAdblockStatus(messageKey, mode) {
  const el = $('settings-browser-adblock-status');
  if (!el) return;
  if (!messageKey) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.classList.remove('ok', 'error');
  if (mode) el.classList.add(mode);
  el.textContent = t(messageKey);
}

function syncBrowserAdblockControl() {
  const check = $('settings-browser-adblock');
  if (!check) return;
  check.checked = hubSettings.browserAdblock === true;
  check.disabled = _browserAdblockBusy;
  if (!_browserAdblockBusy) setBrowserAdblockStatus('', '');
  // Reflect server state (Edge availability + an install in flight elsewhere). This
  // only mirrors the server transiently — it must NOT latch _browserAdblockBusy,
  // which is owned solely by this tab's own toggle, or the checkbox could stick
  // disabled forever after another dashboard's install finishes.
  fetch('/embedded-browser/adblock', { cache: 'no-store' })
    .then(r => r.json())
    .then(d => {
      if (!d || _browserAdblockBusy) return;   // this tab's own install owns the UI
      if (d.available === false) { check.disabled = true; setBrowserAdblockStatus('browser_unavailable', 'error'); }
      else if (d.busy) { check.disabled = true; setBrowserAdblockStatus('settings_browser_adblock_installing', ''); }
      else { check.disabled = false; setBrowserAdblockStatus('', ''); }
    })
    .catch(() => { /* old server / not restarted — leave the control as-is */ });
}

async function toggleBrowserAdblock(checked) {
  const check = $('settings-browser-adblock');
  const enabled = checked === true;
  if (_browserAdblockBusy) { if (check) check.checked = hubSettings.browserAdblock === true; return; }

  // Turning it on the first time downloads the extension. Show progress and revert
  // the toggle if the one-click install fails, so the user never ends up "enabled"
  // with nothing loaded.
  if (enabled) {
    _browserAdblockBusy = true;
    if (check) check.disabled = true;
    setBrowserAdblockStatus('settings_browser_adblock_installing', '');
    try {
      const res = await fetch('/embedded-browser/adblock/install', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!data || data.ok !== true || data.installed !== true) throw new Error('install_failed');
    } catch (e) {
      _browserAdblockBusy = false;
      if (check) { check.disabled = false; check.checked = hubSettings.browserAdblock === true; }
      setBrowserAdblockStatus('settings_browser_adblock_error', 'error');
      return;
    }
    _browserAdblockBusy = false;
    if (check) check.disabled = false;
  }

  hubSettings = normalizeSettings({ ...hubSettings, browserAdblock: enabled });
  saveHubSettings({ server: true });
  setBrowserAdblockStatus(enabled ? 'settings_browser_adblock_on' : 'settings_browser_adblock_off', 'ok');
  // Flush the save immediately (not just the 250 ms debounce) and WAIT for it: the
  // server tears the headless Edge down when browserAdblock changes, and that must
  // happen before we re-open the tiles — otherwise restart() would reopen against
  // the still-running old Edge and the toggle wouldn't take effect until next launch.
  // Cancel the debounced duplicate (and any retry chain) first, so a second
  // /settings POST can't land AFTER restart() and tear the freshly-relaunched
  // Edge back down.
  try { await flushHubSettingsToServer(); } catch { /* saveLocalHubSettings already persisted it locally */ }
  try { if (window.BrowserTile && typeof window.BrowserTile.restart === 'function') window.BrowserTile.restart(); } catch { /* ignore */ }
}

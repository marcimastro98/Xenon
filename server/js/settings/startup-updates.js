// Opening in the browser at start, update checks, and which messages the dashboard may show.
'use strict';

// ── "Open the dashboard in the browser at sign-in" switch ───────────────
// For a real browser on the PC only. A screen that embeds the dashboard loads
// it by itself, so the switch means nothing there and is hidden; the embedded
// case is read from window.top !== window.self (safe across origins: the
// access throws, which counts as embedded). The engine opens the tab, and says
// whether it can on this computer: where it cannot, the row stays hidden.
//
// The engine opens the tab only for someone who asked for it, and asking is a
// click on this switch, nothing else. The setting is on by default for everyone,
// so loading the page must never ask: it would ask for every person who merely
// opened the dashboard in a browser once. On load the page may take a request
// back (the switch is off here, the engine still holds one) and otherwise only
// shows what the engine holds: the switch reads off until somebody turns it on.
// What the engine said last: whether it can open the tab here, and whether it holds a
// request for it. null = not known until the reconcile with the engine has run.
const _autoOpenEngine = { supported: null, asked: null };

function isEmbeddedView() {
  try { return window.top !== window.self; } catch { return true; }
}

// Where the browser tab at sign-in is none of this page's business. The Xenon app
// counts: it is a top window, but it opens itself at sign-in, and taking it for a
// browser asked for the tab from the app with the default "on", so a browser
// opened at every sign-in beside the app. A paired device counts too: the tab
// opens on the PC, and the engine refuses the request from a phone anyway.
function autoOpenNotOurs() {
  return isEmbeddedView() || window.__XENON_NATIVE__ === true || window.isTauri === true || !!window.__xenonRemote;
}

function syncAutoOpenBrowserControl() {
  const row = $('settings-auto-open-row');
  const check = $('settings-auto-open');
  if (!row || !check) return;
  // Hide in an embedded view, the app and on a paired device, or where the engine says it cannot open the tab.
  // Use display (not the `hidden` attribute) because the settings category
  // switcher owns `hidden` to show/hide whole category groups — toggling it here
  // would fight that. display:none wins regardless of the category state.
  const hide = autoOpenNotOurs() || _autoOpenEngine.supported === false;
  row.style.display = hide ? 'none' : '';
  // On only when the setting is on and the engine holds a request (or has not said yet).
  check.checked = hubSettings.autoOpenBrowser !== false && _autoOpenEngine.asked !== false;
}

// The click on the switch: the one place a request for the tab is made.
function updateAutoOpenBrowser(checked) {
  const enabled = checked === true;
  hubSettings = normalizeSettings({ ...hubSettings, autoOpenBrowser: enabled });
  saveHubSettings();
  _autoOpenEngine.asked = enabled;
  syncAutoOpenBrowserControl();
  // Tell the engine, which is what opens the tab. The setting persists regardless;
  // if the call fails we surface it instead of pretending it worked.
  const failed = () => { _autoOpenEngine.asked = null; setSettingsStatus('settings_error', 'error'); };
  fetch('/startup/auto-open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(r => r.json()).then(data => {
    if (data && data.supported === false) { _autoOpenEngine.supported = false; _autoOpenEngine.asked = false; syncAutoOpenBrowserControl(); return; }
    if (!data || data.ok !== true) { failed(); return; }
    _autoOpenEngine.asked = data.enabled === true;
    syncAutoOpenBrowserControl();
    setSettingsStatus('settings_saved', 'ok');
  }).catch(failed);
}

// Claude Code widget: the approval cards and the topbar marker. Saved like any
// other preference, then handed to the widget so both surfaces change on the
// spot — a card already on screen when you switch them off must disappear, not
// wait for the next event. The approvals switch is ALSO read server-side: with
// it off, Claude Code's permission hook is answered immediately with "no
// decision", which puts the prompt back in the terminal instead of leaving the
// session blocked on a card that will never be drawn.
// Settings → Codex. Both values are also read server-side: with approvals off
// the Codex hook is answered at once with "no decision" (Codex asks itself),
// and waitSec is how long a card waits before the decision goes back to Codex.
function updateCodexWidgetCfg(patch) {
  const current = (hubSettings.codexWidget && typeof hubSettings.codexWidget === 'object') ? hubSettings.codexWidget : {};
  hubSettings = normalizeSettings({ ...hubSettings, codexWidget: { ...current, ...patch } });
  saveHubSettings();
  syncSettingsControls();
  if (window.CodexWidget && typeof CodexWidget.onSettingsChanged === 'function') CodexWidget.onSettingsChanged();
}

function updateClaudeWidgetCfg(patch) {
  const current = (hubSettings.claudeWidget && typeof hubSettings.claudeWidget === 'object') ? hubSettings.claudeWidget : {};
  hubSettings = normalizeSettings({ ...hubSettings, claudeWidget: { ...current, ...patch } });
  saveHubSettings();
  syncSettingsControls();
  if (window.ClaudeWidget && typeof ClaudeWidget.onSettingsChanged === 'function') ClaudeWidget.onSettingsChanged();
}

// Anonymous version ping. Purely a stored preference — the server reads it on
// the next update check and decides whether to send, so there is nothing to
// call here and nothing to undo if the user switches it straight back off.
function updateVersionPing(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, versionPing: checked === true });
  saveHubSettings();
  syncSettingsControls();
}

// Automatic self-update. On by default (server/updates/auto-update.js). Off means Xenon
// still checks and still shows the What’s New modal (js/update/update.js) — it just
// never downloads or applies a release on its own.
function updateAutoUpdate(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, autoUpdate: checked !== false });
  saveHubSettings();
  syncSettingsControls();
}

// Store widgets that update themselves. On by default (server/store-catalog/widget-auto-update.js).
// Off means the update is still offered, as it always was, and waits for the user.
function updateAutoUpdateWidgets(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, autoUpdateWidgets: checked !== false });
  saveHubSettings();
  syncSettingsControls();
}

// The line under that switch: what was last updated, and what is waiting for the
// user. Read from the server; a failed read just leaves the line empty.
async function refreshWidgetAutoUpdateLine() {
  const line = document.getElementById('settings-auto-update-widgets-line');
  if (!line) return;
  try {
    const res = await fetch(SERVER + '/api/widgets/auto-update');
    const st = res.ok ? await res.json() : null;
    const names = (list) => (Array.isArray(list) ? list : []).map((x) => String((x && x.name) || (x && x.id) || '').slice(0, 60)).filter(Boolean);
    const parts = [];
    if (st && st.last && Array.isArray(st.last.updated) && st.last.updated.length) {
      const when = st.last.at ? new Date(st.last.at).toLocaleDateString() : '';
      parts.push(t('settings_widget_auto_update_last').replace('{names}', names(st.last.updated).join(', ')).replace('{when}', when));
    }
    if (st && Array.isArray(st.waitingForYou) && st.waitingForYou.length) {
      parts.push(t('settings_widget_auto_update_wait').replace('{names}', names(st.waitingForYou).join(', ')));
    }
    line.textContent = parts.join(' · ');
    line.hidden = !parts.length;
  } catch { line.hidden = true; }
}

// Announcements / paid-drop card. Both were localStorage-only before v4.9.0, so
// turning one back ON here must also clear the legacy per-device flag — otherwise
// a user who once pressed "don't show me these again" would flip the switch and
// see nothing change, because the old flag still muted that surface. Turning OFF
// writes only the setting: it syncs to every surface on its own.
const LEGACY_MUTE_KEYS = { hubMessages: 'xeneonedge.hubMessagesMuted', catalogDrops: 'xeneonedge.catalogDropsMuted' };

function updateAnnouncementPref(key, checked) {
  const on = checked === true;
  if (on) { try { localStorage.removeItem(LEGACY_MUTE_KEYS[key]); } catch { /* ignore */ } }
  hubSettings = normalizeSettings({ ...hubSettings, [key]: on });
  saveHubSettings();
  syncSettingsControls();
}
function updateHubMessages(checked) { updateAnnouncementPref('hubMessages', checked); }
// No legacy flag to clear for this one — it never lived in localStorage.
function updateCatalogStats(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, catalogStats: checked === true });
  saveHubSettings();
  syncSettingsControls();
}
function updateRatingAsks(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, ratingAsks: checked === true });
  saveHubSettings();
  syncSettingsControls();
}
// Anonymous feature counts. A stored preference: the server reads it on each
// count and on the next update check; switching it off deletes what was waiting.
function updateUsageStats(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, usageStats: checked === true });
  saveHubSettings();
  syncSettingsControls();
}
function updateBatteryAsk(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, batteryAskDevices: checked === true });
  saveHubSettings();
  syncSettingsControls();
}
// The month's drops window. No legacy per-device flag: it is a new setting.
function updateMonthlyDrops(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, monthlyDrops: checked === true });
  saveHubSettings();
  syncSettingsControls();
}

// On load, learns what the engine holds, but only from a real browser on the PC:
// never from an embedded view, the app or a paired device. It never asks for the
// tab: that takes a click on the switch (updateAutoOpenBrowser). The one thing it
// may send is "no": the switch is off in these settings and the engine still
// holds a request, as after a backup restored with the switch off.
async function reconcileAutoOpenBrowser() {
  if (autoOpenNotOurs()) { syncAutoOpenBrowserControl(); return; }
  try {
    const res = await fetch('/startup/auto-open', { cache: 'no-store' });
    if (!res.ok) { syncAutoOpenBrowserControl(); return; } // old server / not yet restarted
    const data = await res.json().catch(() => ({}));
    if (!data || data.supported === false) { _autoOpenEngine.supported = false; syncAutoOpenBrowserControl(); return; }
    _autoOpenEngine.supported = true;
    _autoOpenEngine.asked = data.enabled === true;
    if (_autoOpenEngine.asked && hubSettings.autoOpenBrowser === false) {
      const off = await fetch('/startup/auto-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }).catch(() => null);
      if (off?.ok) _autoOpenEngine.asked = false;
    }
  } catch { /* leave row as-is; non-fatal */ }
  syncAutoOpenBrowserControl();
}

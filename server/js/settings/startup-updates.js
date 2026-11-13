// Opening in the browser at start, update checks, and which messages the dashboard may show.
'use strict';

// ── "Open dashboard in browser at logon" toggle ──────────────────────
// Real-browser-only: inside the Xeneon Edge iCUE iframe the iframe loads the
// dashboard itself, so the toggle is meaningless there and is hidden. We detect
// the embedded case with window.top !== window.self (cross-origin safe — access
// throws, which we treat as embedded). On non-Windows the server reports it
// unsupported and the row stays hidden.
let _autoOpenSupported = null; // null = unknown until the server reconcile runs

function isEmbeddedView() {
  try { return window.top !== window.self; } catch { return true; }
}

// Where the browser-at-logon task is none of this page's business. The Xenon app
// counts: it is a top window, but it opens itself at logon, and taking it for a
// browser registered the task from the app with the default "on", so Chrome
// opened at every logon beside the app.
function autoOpenNotOurs() {
  return isEmbeddedView() || window.__XENON_NATIVE__ === true || window.isTauri === true;
}

function syncAutoOpenBrowserControl() {
  const row = $('settings-auto-open-row');
  const check = $('settings-auto-open');
  if (!row || !check) return;
  // Hide inside the Edge iframe, or where the server says it isn't supported.
  // Use display (not the `hidden` attribute) because the settings category
  // switcher owns `hidden` to show/hide whole category groups — toggling it here
  // would fight that. display:none wins regardless of the category state.
  const hide = autoOpenNotOurs() || _autoOpenSupported === false;
  row.style.display = hide ? 'none' : '';
  check.checked = hubSettings.autoOpenBrowser !== false;
}

function updateAutoOpenBrowser(checked) {
  const enabled = checked === true;
  hubSettings = normalizeSettings({ ...hubSettings, autoOpenBrowser: enabled });
  saveHubSettings();
  syncAutoOpenBrowserControl();
  // Register/remove the actual logon task. The setting persists regardless; if
  // the task call fails we surface it instead of pretending it worked.
  fetch('/startup/auto-open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(r => r.json()).then(data => {
    if (data && data.supported === false) { _autoOpenSupported = false; syncAutoOpenBrowserControl(); return; }
    // The server refused because open-dashboard.vbs is not on disk — an antivirus
    // quarantine, or an install that never finished. Registering the task anyway
    // is what produces the "Can not find script file" box at every logon, so the
    // row goes away here exactly as it does where the feature is unsupported.
    if (data && data.reason === 'launcher_missing') {
      _autoOpenSupported = false;
      syncAutoOpenBrowserControl();
      setSettingsStatus('settings_error', 'error');
      return;
    }
    if (!data || data.ok !== true) { setSettingsStatus('settings_error', 'error'); return; }
    setSettingsStatus('settings_saved', 'ok');
  }).catch(() => setSettingsStatus('settings_error', 'error'));
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

// Automatic self-update. On by default (server/auto-update.js). Off means Xenon
// still checks and still shows the What’s New modal (js/update.js) — it just
// never downloads or applies a release on its own.
function updateAutoUpdate(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, autoUpdate: checked !== false });
  saveHubSettings();
  syncSettingsControls();
}

// Store widgets that update themselves. On by default (server/widget-auto-update.js).
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

// Brings the real scheduled task in line with the user's saved intent — but
// only from a standalone browser, never from the Edge iframe. So a pure-Edge
// install never registers a browser-open task (no surprise tab), while a
// browser user gets auto-open from their first visit onward.
async function reconcileAutoOpenBrowser() {
  if (autoOpenNotOurs()) { syncAutoOpenBrowserControl(); return; }
  try {
    const res = await fetch('/startup/auto-open', { cache: 'no-store' });
    if (!res.ok) { syncAutoOpenBrowserControl(); return; } // old server / not yet restarted
    const data = await res.json().catch(() => ({}));
    if (!data || data.supported === false) { _autoOpenSupported = false; syncAutoOpenBrowserControl(); return; }
    // Same as above, on the path that runs on every page load: with no launcher
    // on disk there is nothing to reconcile towards, and re-posting the request
    // each time would only keep asking for a task that cannot work.
    if (data.reason === 'launcher_missing') { _autoOpenSupported = false; syncAutoOpenBrowserControl(); return; }
    _autoOpenSupported = true;
    const want = hubSettings.autoOpenBrowser !== false;
    if (data.enabled !== want) {
      await fetch('/startup/auto-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: want }),
      }).catch(() => {});
    }
  } catch { /* leave row as-is; non-fatal */ }
  syncAutoOpenBrowserControl();
}

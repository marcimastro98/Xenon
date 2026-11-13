// Backup, restore and reset of the settings.
'use strict';

// Footer "Riavvia Xenon" (feature request): a clean restart to clear transient /
// stuck state — a widget that got wedged, a background probe that stalled — WITHOUT
// losing anything. Settings, dashboard layout, backgrounds and widgets are all
// persisted (settings.json + localStorage) and re-hydrate on launch, so nothing
// personal is touched. Native → full app relaunch (app.restart via native-bridge);
// a plain browser → dashboard reload. Confirmed first, since it interrupts the
// session.
function restartXenon() {
  const msg = t('settings_restart_confirm', 'Riavviare Xenon? Le tue impostazioni, i widget e gli sfondi restano: serve solo a ripulire eventuali blocchi.');
  if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
  setSettingsStatus('settings_restart_running', 'ok');
  if (typeof window.restartXenonApp === 'function') window.restartXenonApp();
  else { try { window.location.reload(); } catch (e) { /* nothing else to try */ } }
}

// Footer "Ripristina tutte le impostazioni": a full reset of every preference to
// its default. Only the dashboard layout and the external calendar feed
// subscriptions are preserved (they're structural/personal, not "settings" the
// user is trying to reset). Server-only secrets (Gemini key, integration
// passwords/tokens) are preserved server-side on save, so they survive this too.
// Confirmed, since v4.11.7, and the confirmation names what goes. This button
// used to fire on a single click — no dialog — from the accent-coloured PRIMARY
// slot at the bottom of the panel, directly under "Restart Xenon", whose own
// hint promises that nothing will be lost. Reported on Discord by a supporter
// who pressed it by mistake: "i resetted xenon by error and lost everything".
//
// "Settings" undersells it, which is the other half of the problem. The layout
// and the calendar feeds survive; every widget tile's ASSIGNMENT and permission
// grant, every install receipt, every saved page preset, every custom theme,
// background and Ambient scene do not. The packages stay on disk — nothing is
// uninstalled — but the dashboard comes back empty, which is what "everything"
// means to the person looking at it.
async function resetAllSettings() {
  const title = t('settings_reset_all', 'Reset all settings');
  const msg = t('settings_reset_all_confirm',
    'Reset every setting to its defaults? Your dashboard layout stays, but each tile loses the widget assigned to it, along with its permissions, your install list, your saved page presets, and your custom themes, backgrounds and Ambient scenes. Installed widgets stay on your PC and can be assigned again. This cannot be undone.');
  const ok = (typeof settingsPrompt === 'function')
    ? await settingsPrompt({ type: 'confirm', danger: true, title, message: msg, okLabel: title })
    : (typeof window.confirm !== 'function' || window.confirm(msg));
  if (!ok) return;
  hubSettings = normalizeSettings({
    ...DEFAULT_HUB_SETTINGS,
    dashboardLayout: hubSettings.dashboardLayout,
    calendarFeeds: hubSettings.calendarFeeds,
  });
  saveHubSettings();
  applyHubSettings();
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  renderSettingsModal();
  setSettingsStatus('settings_reset_all_done', 'ok');
}

// Aspetto "Ripristina default": resets ONLY the appearance/theme (the visual
// identity of the Aspetto tab — THEME_SETTING_KEYS is the single source of
// truth). Everything else — weather location, tickers, integrations, toggles,
// the uploaded background, topbar layout — is left untouched.
function resetAppearanceDefaults() {
  const patch = {};
  for (const key of THEME_SETTING_KEYS) patch[key] = DEFAULT_HUB_SETTINGS[key];
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_reset_done', 'ok');
}

function reloadHubSettingsFromStorage() {
  hubSettings = loadHubSettings();
  applyHubSettings();
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
}

// ── Configuration backup ──────────────────────────────────────────────────────
// Export: in a real browser, download the portable JSON (one file, no secrets);
// inside the Xeneon Edge iCUE WebView there is no download manager, so a blob
// download silently does nothing — there we ask the server (same PC) to write
// the file to the Downloads folder and toast the path. Import uploads one back,
// then reloads so every module re-hydrates the restored data.
function backupToast(titleKey, meta) {
  const title = (typeof window.t === 'function' && window.t(titleKey)) || titleKey;
  if (typeof showHubToast === 'function') showHubToast('Backup', title, meta || '');
}

// Server writes the backup to disk and returns the path. Used as the
// embedded-view path and as a fallback when a browser download is blocked.
// `pick`: the system folder dialog on the PC first (where the capture engine
// runs), Downloads when there is no dialog.
async function exportBackupToDisk(pick = false) {
  const res = await fetch('/backup/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick }),
  });
  const out = await res.json().catch(() => null);
  if (out && out.ok === true && out.cancelled === true) return;
  if (out && out.error === 'picking') { backupToast('settings_folder_busy'); return; }
  if (!out || out.ok !== true) throw new Error((out && out.error) || 'save_failed');
  backupToast('settings_backup_saved', out.path || '');
}

async function exportBackup() {
  const btn = document.querySelector('[onclick="exportBackup()"]');
  try {
    if (btn) btn.disabled = true;
    // Embedded WebView: no download manager, no save dialog — the server asks
    // where on the PC and saves the file there.
    if (isEmbeddedView()) { await exportBackupToDisk(true); return; }
    // Real browser: "Save as" where it has one (js/save-file.js), else a download.
    const make = async () => {
      const res = await fetch('/backup/export');
      if (!res.ok) throw new Error('export_failed');
      return res.blob();
    };
    const name = 'xenon-backup-' + window.XenonSaveFile.today() + '.json';
    const how = await window.XenonSaveFile.save({ name, types: [window.XenonSaveFile.JSON_TYPE], make });
    if (how !== 'cancelled') backupToast('settings_backup_exported');
  } catch (e) {
    console.error('Backup export failed:', e);
    // Last resort: try the server-side save so the user always gets a file.
    try { await exportBackupToDisk(); }
    catch { backupToast('settings_backup_error'); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function importBackupPick() {
  const f = document.getElementById('settings-backup-file');
  if (f) { f.value = ''; f.click(); }
}

// Human-readable labels for the `needsSetup` service keys the import reports
// (services the backup's owner had configured whose secrets can't travel in
// the file). Proper nouns — no translation needed.
const BACKUP_SERVICE_LABELS = {
  gemini: 'Gemini API', obs: 'OBS', streamerbot: 'Streamer.bot',
  homeAssistant: 'Home Assistant', sunshine: 'Sunshine (Remote)',
  twelveData: 'Twelve Data', finnhub: 'Finnhub', sportsDb: 'TheSportsDB',
  newsData: 'NewsData.io', spotify: 'Spotify', twitch: 'Twitch',
  youtube: 'YouTube', discord: 'Discord',
  lightingProviders: 'Hue / Nanoleaf',
};

// The import reloads the page, so the outcome summary (what needs re-linking,
// what failed) is parked in sessionStorage and toasted after the reload.
function showPendingBackupSummary() {
  let summary = null;
  try {
    summary = JSON.parse(sessionStorage.getItem('xenon.backupImportSummary') || 'null');
    sessionStorage.removeItem('xenon.backupImportSummary');
  } catch { summary = null; }
  if (!summary || typeof summary !== 'object') return;
  const tt = (k, fb) => (typeof window.t === 'function' && window.t(k)) || fb;
  const needs = (Array.isArray(summary.needsSetup) ? summary.needsSetup : [])
    .map((k) => BACKUP_SERVICE_LABELS[k] || k);
  const failed = Array.isArray(summary.failed) ? summary.failed : [];
  // Community widget / Ambient-scene packages the backup couldn't carry and that
  // aren't installed here — the user re-adds them from their gallery/share codes.
  const widgets = (Array.isArray(summary.needsWidgets) ? summary.needsWidgets : [])
    .map((w) => (w && typeof w === 'object') ? (w.name || w.id || '') : String(w || ''))
    .filter(Boolean);
  let meta = '';
  if (needs.length) meta = `${tt('settings_backup_needs_setup', 'Da ricollegare:')} ${needs.join(', ')}`;
  if (widgets.length) meta += `${meta ? ' — ' : ''}${tt('settings_backup_needs_widgets', 'Widget da reinstallare dai loro codici:')} ${widgets.join(', ')}`;
  if (failed.length) meta += `${meta ? ' — ' : ''}${tt('settings_backup_partial', 'Non ripristinato:')} ${failed.join(', ')}`;
  backupToast('settings_backup_imported', meta);
}

async function importBackupFile(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const btn = document.getElementById('settings-backup-import-btn');
  try {
    const text = await file.text();
    JSON.parse(text);   // sanity check locally before shipping it to the server
    const res = await fetch('/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    const out = await res.json();
    // A partial import (some sections restored, some failed) still reloads —
    // the applied sections are live server-side either way; the summary toast
    // after the reload tells the user exactly what didn't make it.
    const restoredAny = out && Array.isArray(out.restored) && out.restored.length > 0;
    if (!out || (out.ok !== true && !restoredAny)) throw new Error((out && out.error) || 'import_failed');
    try {
      sessionStorage.setItem('xenon.backupImportSummary', JSON.stringify({
        needsSetup: Array.isArray(out.needsSetup) ? out.needsSetup : [],
        needsWidgets: Array.isArray(out.needsWidgets) ? out.needsWidgets : [],
        failed: Array.isArray(out.failed) ? out.failed : [],
      }));
    } catch { /* summary toast is best-effort */ }
    location.reload();
  } catch (e) {
    console.error('Backup import failed:', e);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = (typeof window.t === 'function' && window.t('settings_backup_error')) || 'File non valido';
      setTimeout(() => { btn.textContent = orig; }, 3000);
    }
  }
}

window.exportBackup      = exportBackup;
window.importBackupPick  = importBackupPick;
window.importBackupFile  = importBackupFile;

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
  // What the backup had switched on and the import left as this PC has it: a file
  // cannot turn these on, so the person does it here. Each is [string key, fallback].
  const BACKUP_HERE_LABELS = {
    pcControl: ['aifeat_pccontrol', 'Controllo PC'],
    widgetPermissions: ['settings_backup_widget_permissions', 'permessi dei widget'],
  };
  const listed = Array.isArray(summary.needsSetup) ? summary.needsSetup : [];
  const heldBack = listed.includes('deckActions');
  const asked = listed.filter((k) => k !== 'deckActions');
  const needs = asked.filter((k) => !Object.hasOwn(BACKUP_HERE_LABELS, k)).map((k) => BACKUP_SERVICE_LABELS[k] || k);
  const here = asked.filter((k) => Object.hasOwn(BACKUP_HERE_LABELS, k)).map((k) => tt(BACKUP_HERE_LABELS[k][0], BACKUP_HERE_LABELS[k][1]));
  const failed = Array.isArray(summary.failed) ? summary.failed : [];
  // Community widget / Ambient-scene packages the backup couldn't carry and that
  // aren't installed here — the user re-adds them from their gallery/share codes.
  const widgets = (Array.isArray(summary.needsWidgets) ? summary.needsWidgets : [])
    .map((w) => (w && typeof w === 'object') ? (w.name || w.id || '') : String(w || ''))
    .filter(Boolean);
  let meta = '';
  if (needs.length) meta = `${tt('settings_backup_needs_setup', 'Da ricollegare:')} ${needs.join(', ')}`;
  if (here.length) meta += `${meta ? ' · ' : ''}${tt('settings_backup_needs_here', 'Da riattivare su questo PC:')} ${here.join(', ')}`;
  // Keys of the Deck that came in without the action the file gave them (settings/backup-keep.js),
  // when the question about them was not answered: the file is no longer in memory after a reload.
  if (heldBack) meta += `${meta ? ' · ' : ''}${tt('settings_backup_deck_actions', 'I tasti del Deck che avviano programmi, scrivono o inviano qualcosa sono arrivati senza azione: impostali di nuovo su questo PC.')}`;
  if (widgets.length) meta += `${meta ? ' · ' : ''}${tt('settings_backup_needs_widgets', 'Widget da reinstallare dai loro codici:')} ${widgets.join(', ')}`;
  if (failed.length) meta += `${meta ? ' · ' : ''}${tt('settings_backup_partial', 'Non ripristinato:')} ${failed.join(', ')}`;
  backupToast('settings_backup_imported', meta);
}

// The import, and its steps inside it: this script adds no name to the shared scope and runs nothing on load.
async function importBackupFile(input) {
  // One import of the file. The file goes inside the request, beside the answer about the Deck keys:
  // nothing the file says about itself is at the top, where the engine reads that answer.
  async function send(text, keepDeckActions) {
    const res = await fetch('/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{${keepDeckActions ? '"keepDeckActions":true,' : ''}"bundle":${text}}`,
    });
    const out = await res.json();
    // A partial import (some sections restored, some failed) still reloads —
    // the applied sections are live server-side either way; the summary toast
    // after the reload tells the user exactly what didn't make it.
    const restoredAny = out && Array.isArray(out.restored) && out.restored.length > 0;
    if (!out || (out.ok !== true && !restoredAny)) throw new Error((out && out.error) || 'import_failed');
    return out;
  }

  function park(out, leftOff) {
    const listed = Array.isArray(out.needsSetup) ? out.needsSetup : [];
    try {
      sessionStorage.setItem('xenon.backupImportSummary', JSON.stringify({
        needsSetup: leftOff ? listed.filter((k) => k !== 'deckActions') : listed,
        needsWidgets: Array.isArray(out.needsWidgets) ? out.needsWidgets : [],
        failed: Array.isArray(out.failed) ? out.failed : [],
      }));
    } catch { /* summary toast is best-effort */ }
  }

  // What the import says it held back of the Deck, read as an answer from outside: counts and short texts.
  function heldBack(out) {
    const held = out?.deckActions;
    if (!held || typeof held !== 'object' || !Number.isInteger(held.keys) || held.keys < 1) return null;
    const actions = (Array.isArray(held.actions) ? held.actions : []).slice(0, 12)
      .filter((a) => a && typeof a.type === 'string')
      .map((a) => ({ type: a.type.slice(0, 40), what: typeof a.what === 'string' ? a.what.slice(0, 160) : '' }));
    return { keys: held.keys, actions, more: Number.isInteger(held.more) && held.more > 0 ? held.more : 0 };
  }

  // The question at the PC: these keys start things, keep them? The list is plain text, and the
  // button in focus is the one that leaves them off. Closing the window leaves them off too.
  async function ask(held) {
    if (typeof settingsPrompt !== 'function') return null;
    const tt = (k, fb) => { const said = typeof window.t === 'function' ? window.t(k) : ''; return said && said !== k ? said : fb; };
    const lines = held.actions.map((a) => `${tt('deck_act_' + a.type, a.type)}${a.what ? ': ' + a.what : ''}`);
    if (held.more) lines.push(tt('settings_backup_deck_more', 'and {n} more').replace('{n}', String(held.more)));
    const yes = await settingsPrompt({
      type: 'confirm', cautious: true, lines,
      title: tt('settings_backup_deck_keep_title', 'Deck keys in this backup'),
      message: tt('settings_backup_deck_keep_ask', 'Keys in this backup that start programs, scripts or shortcuts: {n}. Keep them?').replace('{n}', String(held.keys)),
      okLabel: tt('settings_backup_deck_keep_yes', 'Keep them'),
      cancelLabel: tt('settings_backup_deck_keep_no', 'Leave them off'),
    });
    return yes === true;
  }

  const file = input && input.files && input.files[0];
  if (!file) return;
  const btn = document.getElementById('settings-backup-import-btn');
  try {
    const text = await file.text();
    JSON.parse(text);   // sanity check locally before shipping it to the server
    let out = await send(text, false);
    // Parked before the question: if the page reloads while it is open, the message after the
    // reload says to import the file again to keep the keys.
    park(out, false);
    const held = heldBack(out);
    const keep = held ? await ask(held) : null;
    if (keep === true) {
      // The same file again, with the yes. If that fails the first import still stands, and its message with it.
      try { out = await send(text, true); park(out, false); }
      catch (e) { console.error('Backup import (keeping Deck keys) failed:', e); }
    } else if (keep === false) park(out, true);
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

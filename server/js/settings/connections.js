// Connections to other apps and services: SDK widgets, stocks, sports and news feeds, OBS,
// Streamer.bot, Wave Link and Chroma.
'use strict';

// ── Third-party widget SDK (Settings → Widgets) ─────────────────────────────
// `patch` is a shallow patch of { enabled, assign, grants }; normalizeSettings
// re-validates the merged object, so a bad patch can never persist bad state.
function updateSdkWidgets(patch) {
  const cur = hubSettings.sdkWidgets || {};
  hubSettings = normalizeSettings({ ...hubSettings, sdkWidgets: { ...cur, ...(patch || {}) } });
  saveHubSettings();
  syncSdkWidgetsControls();
  if (window.CustomWidget && typeof window.CustomWidget.renderWidgets === 'function') window.CustomWidget.renderWidgets();
  setSettingsStatus('settings_saved', 'ok');
}

function syncSdkWidgetsControls() {
  const el = $('settings-sdk-enabled');
  // Reflect the STORED flag, not the safe-mode-effective one: the whole point
  // of safe mode is that the user's choices stay visibly intact underneath.
  if (el) el.checked = !!(hubSettings.sdkWidgets && hubSettings.sdkWidgets.enabled === true);
  const safe = $('settings-safe-mode');
  if (safe) safe.checked = hubSettings.safeMode === true;
}

// ── Master notifications switch (Settings → Notifiche) ──────────────────────
// `enabled` off silences every source and stops the background watchers (server
// re-arms on save); `popups` toggles the on-screen toasts only. Saving posts to
// the server so winNotifWanted()/discordNotifWanted() re-evaluate immediately.
// ── Stocks (Borsa) + ticker settings ──
function syncStocksTickerControls() {
  const s = hubSettings.stocks || {};
  const tk = hubSettings.ticker || {};
  const setVal = (id, v) => { const el = $(id); if (el && el.value !== String(v)) el.value = v; };
  const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  setVal('settings-stocks-provider', s.provider || 'auto');
  setVal('settings-stocks-refresh', s.refreshSec != null ? s.refreshSec : 60);
  setVal('settings-stocks-alert', s.alertPercent != null ? s.alertPercent : 2);
  // API keys are server-only (redacted on the wire): show a filled placeholder
  // when one is saved and keep the field blank, mirroring the OBS-password UX.
  const td = $('settings-stocks-twelvedata');
  if (td) { td.value = ''; td.placeholder = hubSettings.twelveDataKeySet ? '••••••••' : ''; }
  const fh = $('settings-stocks-finnhub');
  if (fh) { fh.value = ''; fh.placeholder = hubSettings.finnhubKeySet ? '••••••••' : ''; }
  // Football (Calcio)
  const f = hubSettings.football || {};
  setVal('settings-football-refresh', f.refreshSec != null ? f.refreshSec : 120);
  setChk('settings-football-alerts', f.alerts !== false);
  const ft = f.tile || {};
  setChk('settings-football-results', ft.results !== false);
  setChk('settings-football-standings', ft.standings !== false);
  const sk = $('settings-football-sportsdb');
  if (sk) { sk.value = ''; sk.placeholder = hubSettings.sportsDbKeySet ? '••••••••' : ''; }
  // News
  const nw = hubSettings.news || {};
  setVal('settings-news-refresh', nw.refreshSec != null ? nw.refreshSec : 600);
  setChk('settings-news-images', (nw.tile || {}).images !== false);
  const nk = $('settings-news-newsdata');
  if (nk) { nk.value = ''; nk.placeholder = hubSettings.newsDataKeySet ? '••••••••' : ''; }
  setChk('settings-ticker-enabled', tk.enabled);
  setVal('settings-ticker-position', tk.position || 'bottom');
  setVal('settings-ticker-speed', tk.speed != null ? tk.speed : 50);
  const src = tk.sources || {};
  setChk('settings-ticker-src-stocks', src.stocks !== false);
  setChk('settings-ticker-src-football', src.football !== false);
  setChk('settings-ticker-src-news', src.news !== false);
}

function updateStocksCfg(patch) {
  const cur = hubSettings.stocks || {};
  hubSettings = normalizeSettings({ ...hubSettings, stocks: { ...cur, ...patch } });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateFootballCfg(patch) {
  const cur = hubSettings.football || {};
  const next = { ...cur, ...patch };
  if (patch && patch.tile) next.tile = { ...(cur.tile || {}), ...patch.tile };
  hubSettings = normalizeSettings({ ...hubSettings, football: next });
  saveHubSettings();
  syncStocksTickerControls();
}

// The TheSportsDB Premium key is a server-only secret: an empty field means
// "leave the saved key untouched" (preserve-on-save), so only send a non-empty
// value. Blank input keeps the placeholder.
function setSportsDbKey(value) {
  const v = String(value || '').trim();
  if (!v) return;
  hubSettings = normalizeSettings({ ...hubSettings, sportsDbKey: v, sportsDbKeySet: true });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateNewsCfg(patch) {
  const cur = hubSettings.news || {};
  const next = { ...cur, ...patch };
  if (patch && patch.tile) next.tile = { ...(cur.tile || {}), ...patch.tile };
  hubSettings = normalizeSettings({ ...hubSettings, news: next });
  saveHubSettings();
  syncStocksTickerControls();
}

// The NewsData.io key is a server-only secret: an empty field means "leave the
// saved key untouched" (preserve-on-save), so only send a non-empty value.
function setNewsDataKey(value) {
  const v = String(value || '').trim();
  if (!v) return;
  hubSettings = normalizeSettings({ ...hubSettings, newsDataKey: v, newsDataKeySet: true });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateTickerCfg(patch) {
  const cur = hubSettings.ticker || {};
  const next = { ...cur, ...patch };
  if (patch && patch.sources) next.sources = { ...(cur.sources || {}), ...patch.sources };
  hubSettings = normalizeSettings({ ...hubSettings, ticker: next });
  saveHubSettings();
  syncStocksTickerControls();
  if (window.Ticker) window.Ticker.apply();   // show/hide/reposition the bar live
}

// API keys are server-only secrets: an empty field means "leave the saved key
// untouched" (preserve-on-save), so we only send a non-empty value.
function setStockApiKey(field, value) {
  if (field !== 'twelveDataKey' && field !== 'finnhubKey') return;
  const v = String(value || '').trim();
  if (!v) return;
  hubSettings = normalizeSettings({ ...hubSettings, [field]: v, [field + 'Set']: true });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateObsHost(value) {
  hubSettings = normalizeSettings({ ...hubSettings, obsHost: String(value || '').trim().slice(0, 200) });
  saveHubSettings();
}
function updateObsPort(value) {
  hubSettings = normalizeSettings({ ...hubSettings, obsPort: parseInt(value, 10) || 4455 });
  saveHubSettings();
}
function updateObsPassword(value) {
  hubSettings = normalizeSettings({ ...hubSettings, obsPassword: String(value || '').slice(0, 200) });
  saveHubSettings();
}
function updateObsAutoLaunch(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, obsAutoLaunch: !!checked });
  saveHubSettings();
}

function updateStreamerbotHost(value) {
  hubSettings = normalizeSettings({ ...hubSettings, streamerbotHost: String(value || '').trim().slice(0, 200) });
  saveHubSettings();
}
function updateStreamerbotPort(value) {
  hubSettings = normalizeSettings({ ...hubSettings, streamerbotPort: parseInt(value, 10) || 8080 });
  saveHubSettings();
}
function updateStreamerbotPassword(value) {
  hubSettings = normalizeSettings({ ...hubSettings, streamerbotPassword: String(value || '').slice(0, 200) });
  saveHubSettings();
}

// Probe the configured Streamer.bot WebSocket and report how many actions it
// exposes (or the failure). Flushes the pending settings save first so the
// server connects with the host/port/password the user just typed.
async function testStreamerbotConnection(btn) {
  const out = document.getElementById('settings-sb-status');
  const setStatus = (cls, msg) => { if (out) { out.className = 'settings-note settings-sb-status ' + cls; out.textContent = msg; } };
  if (btn) btn.disabled = true;
  setStatus('is-busy', (typeof t === 'function' ? t('settings_sb_testing') : 'Testing…'));
  try {
    await flushHubSettingsToServer().catch(() => {});
    const r = await fetch('/streamerbot/actions').then((res) => res.json()).catch(() => null);
    if (r && r.ok) {
      // The probe connects to 127.0.0.1 by default even when Host is left blank, but
      // the widget/stateful-keys only activate once a host is actually saved (that's
      // the "I use Streamer.bot" opt-in that keeps the live socket off for everyone
      // else). So a successful test with a blank host persists the default — turning
      // the integration on now that the user has confirmed it works.
      if (!hubSettings.streamerbotHost) {
        hubSettings = normalizeSettings({ ...hubSettings, streamerbotHost: '127.0.0.1' });
        const hostInput = document.getElementById('settings-sb-host');
        if (hostInput) hostInput.value = '127.0.0.1';
        saveHubSettings();
        await flushHubSettingsToServer().catch(() => {});
      }
      const n = (r.actions || []).length;
      setStatus('is-ok', (typeof t === 'function' ? t('settings_sb_ok') : 'Connected') + ' — ' + n + ' ' + (typeof t === 'function' ? t('settings_sb_actions') : 'actions'));
    } else {
      const base = (typeof t === 'function' ? t('settings_sb_fail') : 'Could not reach Streamer.bot');
      setStatus('is-err', (r && r.error) ? base + ' (' + r.error + ')' : base);
    }
  } catch (e) {
    setStatus('is-err', (typeof t === 'function' ? t('settings_sb_fail') : 'Could not reach Streamer.bot'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Local hardware SDKs: Elgato Wave Link + Razer Chroma (opt-in, no secrets) ──
function updateWavelinkEnabled(checked) {
  const cur = (hubSettings && hubSettings.wavelink) || {};
  hubSettings = normalizeSettings({ ...hubSettings, wavelink: { ...cur, enabled: checked === true } });
  saveHubSettings();
}
function updateChromaEnabled(checked) {
  const cur = (hubSettings && hubSettings.chroma) || {};
  hubSettings = normalizeSettings({ ...hubSettings, chroma: { ...cur, enabled: checked === true } });
  saveHubSettings();
}

// Probe the local Wave Link WebSocket and report the channel count (or failure).
// Flushes the pending save first so the server connects with the enable flag the
// user just toggled.
async function testWavelinkConnection(btn) {
  const out = document.getElementById('settings-wl-status');
  const setStatus = (cls, msg) => { if (out) { out.className = 'settings-note ' + cls; out.textContent = msg; } };
  if (btn) btn.disabled = true;
  setStatus('is-busy', t('settings_wl_testing', 'Testing…'));
  try {
    await flushHubSettingsToServer().catch(() => {});
    const r = await fetch('/api/wavelink/test', { method: 'POST' }).then((res) => res.json()).catch(() => null);
    if (r && r.ok) {
      // Name which Wave Link answered. Two protocols wear this name, they offer
      // different controls, and "Connected" alone left a user with no meters and
      // no way to tell whether that was a bug or their version.
      const which = r.version ? ' (Wave Link ' + r.version + ')' : (r.dialect ? ' (Wave Link ' + r.dialect + ')' : '');
      setStatus('is-ok', t('settings_wl_ok', 'Connected') + which + ' — ' + (r.count || 0) + ' ' + t('settings_wl_channels', 'channels'));
    }
    else {
      // Name the reason like the Streamer.bot test does: "is the app running?"
      // is wrong advice when the app IS running and answered under a name or on
      // a port we did not accept, and that is exactly what gets reported to us.
      const base = t('settings_wl_fail', 'Could not reach Wave Link: is the app running?');
      setStatus('is-err', (r && r.error) ? base + ' (' + r.error + ')' : base);
    }
  } catch (e) {
    setStatus('is-err', t('settings_wl_fail', 'Could not reach Wave Link: is the app running?'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Probe the local Razer Chroma SDK (init + immediate release). Independent of the
// enable flag so the user can verify Synapse before turning the integration on.
async function testChromaConnection(btn) {
  const out = document.getElementById('settings-chroma-status');
  const setStatus = (cls, msg) => { if (out) { out.className = 'settings-note ' + cls; out.textContent = msg; } };
  if (btn) btn.disabled = true;
  setStatus('is-busy', t('settings_chroma_testing', 'Testing…'));
  try {
    const r = await fetch('/api/chroma/test', { method: 'POST' }).then((res) => res.json()).catch(() => null);
    if (r && r.ok) setStatus('is-ok', t('settings_chroma_ok', 'Razer Chroma connected'));
    else setStatus('is-err', t('settings_chroma_fail', 'Could not reach Razer Chroma: is Synapse running?'));
  } catch (e) {
    setStatus('is-err', t('settings_chroma_fail', 'Could not reach Razer Chroma: is Synapse running?'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateSdkAiDailyCap(value) {
  hubSettings = normalizeSettings({ ...hubSettings, sdkAiDailyCap: Number(value) });
  saveHubSettings();
}

// The music visualizer, lyrics and swipe settings, and installing Xenon Helper for them.
'use strict';

// ── Swipe-to-page navigation ────────────────────────────────────────────────
// Reflects the checkbox and re-applies the gesture on the pager (native
// horizontal scroll + JS drag-pan). Default on; disabling keeps dot/keyboard
// navigation working.
// ── Media visualiser ────────────────────────────────────────────────────────
// The switch is the consent: turning it on is what starts the helper's peak
// metering, so there is no second place to enable anything (see the note on
// audioLevelsWanted in server.js). saveHubSettings reaches the server, which
// re-reads that gate on every save and starts or stops the meter child.
function mediaVisualizerMode() {
  const v = hubSettings && hubSettings.mediaVisualizer;
  return ['off', 'minimal', 'wave'].includes(v) ? v : 'off';
}

function syncMediaVisualizerControl() {
  const mode = mediaVisualizerMode();
  document.querySelectorAll('.settings-media-viz[data-media-viz]').forEach((btn) => {
    const active = btn.dataset.mediaViz === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  if (window.MediaViz) window.MediaViz.setStyle(mode);
  // Only while the line can be seen: this sync also runs on every settings
  // hydrate, and a status nobody is looking at is a request for nothing.
  const group = $('settings-media-viz-status') && $('settings-media-viz-status').closest('[data-settings-cat]');
  if (group && !group.hidden) refreshMediaVizStatus();
}

// Whether the wave CAN be drawn here, said next to the switch. Without Xenon
// Helper there is no measurement and no fallback, and the strip simply stayed
// empty: asked on Discord as "how do I install xenon helper for media
// visualization?" by someone who had turned it on and seen nothing happen.
// /audio/levels/status already knew why; nothing on screen was asking it.
let _mediaVizStatusSeq = 0;
// What is keeping a working wave off screen ('' when nothing is).
const MEDIA_VIZ_HOLDS = ['perf', 'game', 'overlay', 'lyrics', 'silent'];
function mediaVizHold() {
  const h = window.MediaViz && window.MediaViz.holdReason ? window.MediaViz.holdReason() : '';
  return MEDIA_VIZ_HOLDS.includes(h) ? h : '';
}

async function refreshMediaVizStatus(recheck) {
  const el = $('settings-media-viz-status');
  if (!el) return;
  const seq = ++_mediaVizStatusSeq;
  let st = null;
  try { const r = await fetch('/audio/levels/status'); st = r.ok ? await r.json() : null; } catch { st = null; }
  if (seq !== _mediaVizStatusSeq) return;
  const on = mediaVisualizerMode() !== 'off';
  let key = '', state = 'warn';
  if (!st) key = '';
  else if (st.platform && st.platform !== 'win32') key = 'settings_media_viz_st_platform';
  else if (!st.available || st.failure === 'no-helper') { key = 'settings_media_viz_st_missing'; state = 'bad'; }
  else if (st.failure === 'helper-too-old') { key = 'settings_media_viz_st_old'; state = 'bad'; }
  else if (st.failure === 'helper-failed') { key = 'settings_media_viz_st_failed'; state = 'bad'; }
  else if (on) {
    const hold = mediaVizHold();
    key = hold ? 'settings_media_viz_st_hold_' + hold : 'settings_media_viz_st_ok';
    state = hold ? 'warn' : 'ok';
  }
  el.textContent = key ? t(key).replace('{version}', (st && st.minVersion) || '') : '';
  el.dataset.state = state;
  el.hidden = !key;
  // Every one of the three problems is fixed by the same verified download, so
  // the fix sits right under the sentence that names it.
  const btn = $('settings-media-viz-install');
  if (btn && !btn.disabled) btn.hidden = state !== 'bad';
  // A helper too old for metering is only found out once it is started, which
  // switching the wave on has just asked for: look again in a moment.
  if (on && !recheck && st && st.available && !st.failure) setTimeout(() => refreshMediaVizStatus(true), 4000);
}

// "Install Xenon Helper": the verified download the setup does, from here. Asked
// for on Discord by someone on the setup .exe who was told to re-run INSTALL.bat,
// a file that install never shows anyone.
async function installXenonHelper() {
  const btn = $('settings-media-viz-install');
  const el = $('settings-media-viz-status');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = t('settings_media_viz_installing');
  let r = null;
  try { const res = await fetch('/audio/levels/install-helper', { method: 'POST' }); r = res.ok ? await res.json() : null; } catch { r = null; }
  btn.disabled = false;
  btn.textContent = t('settings_media_viz_install');
  if (r && r.ok) {
    await refreshMediaVizStatus();
    // With the wave off there is nothing else to say, so say this.
    if (el && el.hidden) { el.textContent = t('settings_media_viz_st_installed'); el.dataset.state = 'ok'; el.hidden = false; }
    return;
  }
  if (!el) return;
  const code = (r && r.status) || 'no_server';
  const key = (code === 'not-ready' || code === 'skip-not-latest') ? 'settings_media_viz_install_offline'
    : (code === 'signature-invalid' || code === 'mismatch') ? 'settings_media_viz_install_unverified'
    : 'settings_media_viz_install_failed';
  el.textContent = t(key) + ' (' + code + ')';
  el.dataset.state = 'bad';
  el.hidden = false;
  btn.hidden = false;
}

function updateMediaVisualizer(mode) {
  if (!['off', 'minimal', 'wave'].includes(mode)) return;
  hubSettings = normalizeSettings({ ...hubSettings, mediaVisualizer: mode });
  saveHubSettings();
  syncMediaVisualizerControl();
  setSettingsStatus('settings_saved', 'ok');
}

function syncSwipeNavigationControl() {
  const el = $('settings-swipe-nav');
  if (el) el.checked = hubSettings.swipeNavigation !== false;
}

function updateSwipeNavigation(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, swipeNavigation: checked === true });
  saveHubSettings();
  syncSwipeNavigationControl();
  if (window.DashboardPager && DashboardPager.refreshSwipe) DashboardPager.refreshSwipe();
}

// Song lyrics (Media tile button + Lyrics widget). Off means no LRCLIB lookup
// at all, so the views re-sync straight away instead of on the next media tick.
function syncMediaLyricsControl() {
  const el = $('settings-media-lyrics');
  if (el) el.checked = hubSettings.mediaLyrics !== false;
  if (window.MediaLyrics) window.MediaLyrics.sync();
  if (window.LyricsCore) window.LyricsCore.sync();
}

function updateMediaLyrics(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, mediaLyrics: checked === true });
  saveHubSettings();
  syncMediaLyricsControl();
}

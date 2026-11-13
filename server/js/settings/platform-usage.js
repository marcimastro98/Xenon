// What Settings shows on this operating system and install, and the choice of how Xenon is used.
'use strict';

// Settings sections that cannot exist on this platform, removed rather than
// left to fail when tapped.
//
// The README's promise is that anything unavailable is HIDDEN, not offered and
// then failed — and these two were the exceptions. Remote Control installs
// Sunshine and Tailscale through winget and drives them as Windows services;
// Second screen needs a Windows Indirect Display Driver. On Linux and macOS
// both panels rendered in full and every button led to a spawn failure, which
// reads as a broken feature rather than an absent one.
//
// Marked in the markup with data-settings-win-only so the list lives next to
// the panels themselves, and applied to the nav button and the pane together —
// hiding only one leaves either a dead button or an unreachable pane.
function applyPlatformGating(platform) {
  // Published for the parts of the dashboard that are NOT settings panes and so
  // cannot be gated by markup — the widget palette is the one that matters, since
  // a widget offered there is a promise the tile then has to break. Anything
  // reading it must treat undefined as "not known yet" and offer the widget: a
  // late answer is better than one wrong on Windows.
  window.XenonPlatform = platform || '';
  renderPlatformBeta(platform);
  syncAudioCommsControl();   // a Windows-only row inside a shared pane
  if (platform === 'win32') return;
  document.querySelectorAll('[data-settings-win-only]').forEach((el) => {
    const cat = el.dataset.settingsCat || el.dataset.settingsWinOnly;
    el.hidden = true;
    if (cat) {
      document.querySelectorAll(`.settings-nav-btn[data-settings-cat="${cat}"]`)
        .forEach((b) => { b.hidden = true; });
    }
  });
}

// macOS and Linux are beta, and the honest place to say so is where the build
// already names itself: next to the version, at the bottom of the Settings
// sidebar. It states what beta means here — the dashboard is the same, the part
// that reads the machine is what differs — and links to the table that says
// exactly what works where, so nobody has to discover a gap by hitting it.
// Windows renders nothing: a badge on the platform Xenon started on would be
// noise, and the box is only built when it has something true to say.
const PLATFORM_BETA_NAME = { darwin: 'macOS', linux: 'Linux' };
const PLATFORM_BETA_DOC = {
  darwin: 'https://github.com/marcimastro98/Xenon#macos',
  linux: 'https://github.com/marcimastro98/Xenon#linux',
};
function renderPlatformBeta(platform) {
  const box = document.getElementById('settings-platform-beta');
  if (!box) return;
  const name = PLATFORM_BETA_NAME[platform];
  box.textContent = '';
  box.hidden = !name;
  if (!name) return;

  const head = document.createElement('div');
  head.className = 'settings-platform-beta-head';
  const chip = document.createElement('span');
  chip.className = 'settings-platform-beta-chip';
  chip.textContent = (typeof t === 'function' ? t('settings_platform_beta') : 'Beta');
  const os = document.createElement('span');
  os.className = 'settings-platform-beta-os';
  os.textContent = name;
  head.append(chip, os);

  const note = document.createElement('p');
  note.className = 'settings-platform-beta-note';
  const tpl = (typeof t === 'function' ? t('settings_platform_beta_note') : '');
  note.textContent = (tpl || '{os} support is in beta.').replace('{os}', name);

  const link = document.createElement('a');
  link.className = 'settings-platform-beta-link';
  link.href = PLATFORM_BETA_DOC[platform];
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = (typeof t === 'function' ? t('settings_platform_beta_link') : 'What works where');

  box.append(head, note, link);
}

// Show the running build version at the bottom of the Settings sidebar. Read
// from the server (which sources it from package.json) so it always matches the
// shipped build; stays empty and unobtrusive if the request fails.
// The native app's own version, only when it differs from the dashboard's. The
// two update through separate channels, and a bare "Xenon v4.11.12" over an app
// still on 4.11.7 hid exactly the half that had not updated.
function shellVersionSuffix(version) {
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  const shell = String(caps.shellVersion || '').replace(/^v/i, '');
  if (!shell || shell === String(version).replace(/^v/i, '')) return '';
  return ' · ' + t('settings_version_app').replace('{v}', shell);
}

// The mirror needs a reader and not every system has one: the server says which.
// Where there is none, its two switches have nothing to turn on.
async function syncNotifMirrorSupport() {
  const d = await apiJson('/notifications/windows');
  if (!d || d.supported !== false) return;
  for (const id of ['settings-winnotif-row', 'settings-winnotif-hide-row']) {
    const row = $(id);
    if (row) row.hidden = true;
  }
}

async function initSettingsVersion() {
  const out = document.getElementById('settings-version');
  if (!out) return;
  try {
    const { version, platform } = await (await fetch('/version')).json();
    if (version) out.textContent = `Xenon v${version}${shellVersionSuffix(version)}`;
    if (platform) applyPlatformGating(platform);
  } catch { /* leave blank — no version indicator is better than a broken one */ }
  syncNotifMirrorSupport();
  // The update pill, the red notification dots and the "Check for updates"
  // button visibility are all driven by js/update.js (XenonUpdate.refresh()),
  // so there is a single source of truth for "is an update available".
}

// Why the native app cannot draw widget layers here (layers/linux.rs `probe`):
// the i18n key of the reason, or '' when it can or the shell does not say.
const LAYERS_WHY_KEYS = { wayland: 'settings_layers_why_wayland', no_compositor: 'settings_layers_why_compositor' };

function syncLayersWhy(caps) {
  const group = $('settings-layers-why-group');
  const line = $('settings-layers-why');
  const key = window.__XENON_NATIVE__ === true && caps.layers !== true ? LAYERS_WHY_KEYS[caps.layersWhy] || '' : '';
  // A category switch shows every group of its category: these two stay out of
  // it through `unavailable`, not just `hidden`.
  setSettingsCardAvailable(group, !!key);
  if (line && key) {
    line.dataset.i18n = key;
    line.textContent = t(key);
  }
}

// How this PC uses Xenon (js/usage-mode.js). Only the native app can drop the
// dashboard window for the widgets, so elsewhere the row is hidden; where the
// app cannot draw them, a line says why instead.
function syncMenuKeyHint() {
  const el = $('settings-menu-key');
  if (!el || !window.DeckShortcuts) return;
  const key = window.DeckShortcuts.formatShortcut(window.LayersModel.normalize(hubSettings.layers).menuKey);
  el.textContent = t('xmenu_key_opens').replace('{key}', key);
}

function syncUsageModeControl() {
  const group = $('settings-usage-mode-group');
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  setSettingsCardAvailable(group, window.__XENON_NATIVE__ === true && caps.layers === true);
  syncLayersWhy(caps);
  syncMenuKeyHint();
  const el = $('settings-usage-mode');
  if (!el) return;
  el.value = window.UsageMode.normalize(hubSettings.usageMode) || 'dashboard';
  if (typeof el._csSync === 'function') el._csSync();
}

// The row sits beside the mode above, so it exists only where the app draws the menu.
function openXenonMenu() {
  fetch(SERVER + '/screen-menu', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: true }),
  }).catch((e) => console.warn('[settings] the Xenon menu did not open', e));
}

async function updateUsageMode(value) {
  hubSettings = normalizeSettings({ ...hubSettings, usageMode: value });
  saveHubSettings();
  syncUsageModeControl();
  // The window trades itself for the driver page through the server (route
  // `/`), so the save has to land first; the settings stream retries anyway.
  try { await flushHubSettingsToServer(); } catch { /* retried by the stream */ }
  if (window.LayersShell) window.LayersShell.sync();
}

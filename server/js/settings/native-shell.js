// Settings only the desktop app has: the home gesture, hiding on remote desktop, see-through, the
// audio device, zoom and stack mode.
'use strict';

// ── Swipe-up home gesture (native app only) ─────────────────────────────────
// In the native kiosk a quick up-swipe from the bottom of the screen drops the
// dashboard to the Windows desktop (see native-bridge.js). The row only shows
// inside the native app — the gesture doesn't exist on the browser/iCUE
// surfaces — and the value is pushed to the bridge, which also reconciles the
// shell's Windows edge-swipe block.
function syncSwipeHomeControl() {
  const row = $('settings-swipe-home-row');
  const check = $('settings-swipe-home');
  const isNativeApp = !!(window.XenonNative && window.XenonNative.isNative);
  // display (not `hidden`): the settings category switcher owns `hidden`.
  if (row) row.style.display = isNativeApp ? '' : 'none';
  const on = hubSettings.swipeHomeGesture !== false;
  if (check) check.checked = on;
  if (window.XenonNative && typeof window.XenonNative.setHomeGestureEnabled === 'function') {
    window.XenonNative.setHomeGestureEnabled(on);
  }
}

function updateSwipeHomeGesture(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, swipeHomeGesture: checked === true });
  saveHubSettings();
  syncSwipeHomeControl();
}

// ── Hide during Remote Desktop (native app only) ────────────────────────────
// When the user is RDP'd into this PC (their own Windows Remote Desktop — not our
// Sunshine/Moonlight remote control), the borderless kiosk would cover the desktop
// they came in to use. With this on, the native shell hides the window while a
// Remote Desktop session is active and shows it again at the console. Opt-in; the
// row only shows inside the native app, and the value is pushed to the bridge,
// which signals the shell and persists the choice for the next launch.
function syncHideRdpControl() {
  const row = $('settings-hide-rdp-row');
  const check = $('settings-hide-rdp');
  const isNativeApp = !!(window.XenonNative && window.XenonNative.isNative);
  // display (not `hidden`): the settings category switcher owns `hidden`.
  if (row) row.style.display = isNativeApp ? '' : 'none';
  const on = hubSettings.hideOnRdp === true;
  if (check) check.checked = on;
  if (window.XenonNative && typeof window.XenonNative.setHideOnRdp === 'function') {
    window.XenonNative.setHideOnRdp(on);
  }
}

function updateHideOnRdp(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, hideOnRdp: checked === true });
  saveHubSettings();
  syncHideRdpControl();
}

// ── Native shell: see-through window (Settings → Background) ────────────────
// Not a hubSettings value: it belongs to this PC's app window, like the screen it
// opens on, so the shell keeps it in display.json and reports it in its caps
// (js/native-bridge.js). It is fixed when the window is created, so changing it
// relaunches the app, after asking.
function seeThroughWindowOn() {
  const native = window.XenonNative;
  return !!(native && typeof native.seeThroughState === 'function' && native.seeThroughState().on);
}

function syncSeeThroughControl() {
  const row = $('settings-see-through-row');
  const native = window.XenonNative;
  const state = (native && typeof native.seeThroughState === 'function')
    ? native.seeThroughState()
    : { offered: false, on: false, wanted: false, ready: false, why: '' };
  // display (not `hidden`): the settings category switcher owns `hidden`.
  // data-unavailable keeps it out of the Settings search where it is not offered.
  if (row) {
    row.style.display = state.offered ? '' : 'none';
    if (state.offered) delete row.dataset.unavailable; else row.dataset.unavailable = '1';
  }
  if (!state.offered) return;
  const check = $('settings-see-through');
  if (check) {
    check.checked = state.wanted;
    // Nothing to switch on where it cannot be drawn; switching OFF stays possible.
    check.disabled = !state.ready && !state.wanted;
  }
  const blocked = $('settings-see-through-blocked');
  if (blocked) {
    blocked.hidden = state.ready;
    // One line for each reason the shell can give: a graphics card (Windows)
    // or no compositor (Linux) need different things done about them.
    const key = state.why === 'compositor' ? 'settings_see_through_blocked_compositor' : 'settings_see_through_blocked';
    if (blocked.dataset.i18n !== key) {
      blocked.dataset.i18n = key;
      blocked.textContent = t(key);
    }
  }
  const onNote = $('settings-see-through-on');
  if (onNote) onNote.hidden = !state.on;
  // Wallpaper Engine runs on Windows only, and so does its pause rule.
  const tip = $('settings-see-through-tip');
  if (tip) {
    tip.hidden = !state.on || window.XenonPlatform !== 'win32';
    if (!tip.hidden) renderSeeThroughTip(tip);
  }
}

// The tip names a file the user types into Wallpaper Engine, so the name is its
// own element: in a monospace face, and never split at its hyphen across two
// lines. The sentence stays one translated string with an {exe} slot, because
// in Japanese or Korean the name sits in the middle of it. Rebuilt only when the
// language changed (renderSettingsModal runs this after every switch).
const SEE_THROUGH_EXE = 'xenon-native.exe';
function renderSeeThroughTip(tip) {
  const text = t('settings_see_through_tip');
  if (tip.dataset.text === text) return;
  tip.dataset.text = text;
  const parts = text.split('{exe}');
  tip.replaceChildren();
  parts.forEach((part, i) => {
    if (i > 0) {
      const code = document.createElement('code');
      code.className = 'settings-filename';
      code.textContent = SEE_THROUGH_EXE;
      tip.appendChild(code);
    }
    if (part) tip.appendChild(document.createTextNode(part));
  });
}

async function updateSeeThrough(input) {
  const native = window.XenonNative;
  if (!input || !native || typeof native.setSeeThrough !== 'function') return;
  const want = input.checked === true;
  if (native.seeThroughNeedsRestart(want)) {
    const title = t('settings_see_through_restart_title', 'Restart Xenon?');
    const message = t('settings_see_through_restart', 'Xenon restarts to apply this. Your settings, widgets and layout stay as they are.');
    const ok = (typeof settingsPrompt === 'function')
      ? await settingsPrompt({ type: 'confirm', title, message, okLabel: t('settings_restart_app', 'Restart Xenon') })
      : (typeof window.confirm !== 'function' || window.confirm(message));
    if (!ok) {
      input.checked = !want;
      return;
    }
    setSettingsStatus('settings_restart_running', 'ok');
  }
  native.setSeeThrough(want);
  syncSeeThroughControl();
}

// ── Audio: which Windows defaults a device switch moves ─────────────────────
// Windows keeps a separate default for calls. On, a switch from the Volume
// tile, a Deck key or the assistant moves that one too (as it always did);
// off, it moves only the Default Device and leaves Discord and Teams where
// they are. macOS and Linux have one default, so the row is not shown there.
function syncAudioCommsControl() {
  const row = $('settings-audio-comms-row');
  const check = $('settings-audio-comms');
  const platform = window.XenonPlatform;
  // display (not `hidden`): the settings category switcher owns `hidden`.
  if (row) row.style.display = (platform && platform !== 'win32') ? 'none' : '';
  if (check) check.checked = hubSettings.audioSetCommunications !== false;
}

function updateAudioSetCommunications(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, audioSetCommunications: checked === true });
  saveHubSettings();
  syncAudioCommsControl();
}

// ── Interface scale / zoom (native app only) ────────────────────────────────
// The native kiosk can scale its whole webview (WebView2 zoom factor),
// independent of the Windows display scale. The row only shows inside the
// native app; the value is pushed to the bridge, which applies and persists the
// zoom shell-side. The user can also zoom live with Ctrl + mouse wheel (enabled
// in the shell) — this slider is the persisted, explicit control.
function syncNativeZoomControl() {
  const row = $('settings-native-zoom-row');
  const slider = $('settings-native-zoom');
  const valueEl = $('settings-native-zoom-value');
  const isNativeApp = !!(window.XenonNative && window.XenonNative.isNative);
  // Shown on EVERY surface, which it was not.
  //
  // The scale applies to the native app, so the row used to appear only there —
  // and the one place people arrange their dashboard from is a browser on the big
  // monitor, where it simply was not in the list. Reported after a long hunt:
  // "the scale UI option appears only if you go in settings from edge screen, it
  // was not shown in the settings from my browser on main screen… I spent much
  // time trying to figure it out, and even coded a little upscale in my widgets".
  // A control that exists but is invisible from where you are looking is worse
  // than one that is greyed out, because nothing tells you to look elsewhere.
  //
  // It is not merely revealed: the value lives in hubSettings and reaches every
  // surface, and applyHubSettings now hands it to the native shell on arrival, so
  // moving this slider in a browser really does rescale the app on the Edge while
  // you watch it. The second note says so, since here it is not this window it
  // resizes.
  if (row) row.style.display = '';
  const remoteNote = $('settings-native-zoom-remote');
  if (remoteNote) remoteNote.hidden = isNativeApp;
  const scale = clampNumber(hubSettings.nativeZoom, 0.6, 2.5, 1);
  if (slider) slider.value = String(scale);
  if (valueEl) valueEl.textContent = formatPercent(scale);
  if (isNativeApp && window.XenonNative && typeof window.XenonNative.setNativeZoom === 'function') {
    window.XenonNative.setNativeZoom(scale);
  }
}

function updateNativeZoom(value) {
  hubSettings = normalizeSettings({ ...hubSettings, nativeZoom: value });
  saveHubSettings();
  syncNativeZoomControl();
}

// ── Stacked vs grid layout ──────────────────────────────────────────────────
// The dashboard stacks into one full-width column on a screen too narrow for the
// 24-column grid. `js/phone-view.js` decides that from the viewport; this is the
// override, and it is the only user-facing way to reach a decision that until now
// could only be measured.
//
// It is deliberately NOT a hubSettings key. The value answers "what suits THIS
// screen", which differs between the Edge, a phone and a vertically mounted
// monitor looking at the same dashboard, and hubSettings is mirrored to every
// surface — one of them would always be wrong. PhoneView owns the storage
// (localStorage, per device) and this reads it back rather than keeping a copy.
function syncStackModeControls() {
  const pref = (window.PhoneView && typeof window.PhoneView.getPreference === 'function')
    ? window.PhoneView.getPreference()
    : 'auto';
  const mode = ['auto', 'on', 'off'].includes(pref) ? pref : 'auto';
  document.querySelectorAll('.settings-stack-mode[data-stack-mode]').forEach(btn => {
    const active = btn.dataset.stackMode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function updateStackMode(mode) {
  if (!['auto', 'on', 'off'].includes(mode)) return;
  if (!window.PhoneView || typeof window.PhoneView.setPreference !== 'function') return;
  // setPreference re-runs the measurement, so the layout changes under the panel
  // as the button is pressed. Nothing is posted to the server on purpose.
  window.PhoneView.setPreference(mode);
  syncStackModeControls();
  setSettingsStatus('settings_saved', 'ok');
}

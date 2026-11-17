// Which kind of screen the dashboard runs on: the first-run answers, the window's rows
// under Schermi, the phone question on Telefono, and applying a choice.
'use strict';

// The last version of the guided tour taken, from before 5.2.0: above 0, this PC ran
// Xenon before (js/release-notice.js returningUser).
function getOnboardingSeen() {
  return (hubSettings && hubSettings.onboarding && Number(hubSettings.onboarding.seenVersion)) || 0;
}

// The chosen screen. Read by surface-picker.js to decide whether to ask, and by
// the rows below to render the current choice. Server-backed on
// purpose: the answer must reach every surface, and a paired phone — which has
// no channel to the native shell — writes it here and lets the shell's own
// dashboard page relay it (see js/paired/surface-picker.js).
function getSurfaceChoice() {
  const s = surfaceChoiceFrom(hubSettings) || {};
  return { kind: s.kind || 'auto', asked: s.asked === true, monitor: s.monitor || '', label: s.label || '' };
}
window.getSurfaceChoice = getSurfaceChoice;

function setSurfaceChoice(patch) {
  const next = { ...getSurfaceChoice(), ...(patch && typeof patch === 'object' ? patch : {}) };
  // An object left under the old `surface` key is cleared to null, which is the
  // theme's "derive this colour automatically". Leaving it would keep feeding
  // the colour reader something that is not a colour.
  const legacy = (hubSettings && typeof hubSettings.surface === 'object' && hubSettings.surface) ? { surface: null } : {};
  hubSettings = normalizeSettings({ ...hubSettings, ...legacy, surfaceChoice: next });
  saveHubSettings();
  return getSurfaceChoice();
}
window.setSurfaceChoice = setSurfaceChoice;

// ── What is left of the old Schermo page ────────────────────────────────
// The screen that shows the dashboard is chosen on Schermi, on the screen itself. What
// that page cannot say lives where it belongs: the dashboard window's own switch and
// warnings under Schermi (#settings-surface-body, only this page knows the window), and
// "on the phone or on this PC" on Telefono (#settings-surface-phone). Its pieces stay
// inside this function: the scripts of Settings share one scope.
function surfaceRows() {
  // A label line with its hint, translated here: a node built after the page's
  // translation sweep keeps whatever text it was created with.
  function surfaceLine(labelKey, hintKey) {
    const wrap = document.createElement('span');
    wrap.className = 'settings-label-line';
    for (const [key, cls] of [[labelKey, ''], [hintKey, 'settings-hint']]) {
      if (!key) continue;
      const s = document.createElement('span');
      if (cls) s.className = cls;
      s.dataset.i18n = key;
      s.textContent = t(key);
      wrap.appendChild(s);
    }
    return wrap;
  }

  function surfaceWarning(key) {
    const warn = document.createElement('p');
    warn.className = 'settings-hint settings-hint-warn';
    warn.dataset.i18n = key;
    warn.textContent = t(key);
    return warn;
  }

  // The dashboard's window, under the screens. Full screen means nothing on the Edge
  // panel (always borderless) or with the dashboard on the phone, so it is left out there.
  function renderSurfaceWindow(state, choice) {
    const host = document.getElementById('settings-surface-body');
    if (!host) return;
    const native = window.XenonNative;
    host.textContent = '';
    const chosen = state.displays.find((d) => d.id && d.id === choice.monitor);
    const onEdgePanel = choice.kind === 'screen' ? !!(chosen && chosen.edge) : state.displays.some((d) => d.edge);
    if (state.supported && state.displays.length && choice.kind !== 'phone' && !onEdgePanel) {
      const label = document.createElement('label');
      label.className = 'settings-toggle-row full';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'settings-check';
      input.checked = state.fullscreen;
      input.addEventListener('change', () => {
        if (native && typeof native.setScreenFullscreen === 'function') native.setScreenFullscreen(input.checked);
      });
      label.append(input, surfaceLine('surface_fullscreen', 'surface_fullscreen_hint'));
      host.appendChild(label);
    }
    // The chosen screen is unplugged: the window is hidden on purpose, and saying so is
    // the difference between a deliberate state and a broken one.
    if (state.missing) host.appendChild(surfaceWarning('surface_missing'));
    // The screens moved after the shell picked which GPU to render on, fixed for the life
    // of the process (apps/native/src-tauri/src/gpu.rs): only a restart helps, and the
    // footer's own restart confirms first and says nothing is lost.
    if (state.gpuMismatch) {
      host.appendChild(surfaceWarning('surface_gpu_mismatch'));
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'settings-btn';
      fix.dataset.i18n = 'settings_restart_app';
      fix.textContent = t('settings_restart_app');
      fix.addEventListener('click', () => restartXenon());
      host.appendChild(fix);
    }
    // Nothing to say: no empty card under the screens. The category switcher owns
    // `hidden`, so the page in view is asked too.
    const group = host.closest('.settings-group');
    if (!group) return;
    if (host.childElementCount) delete group.dataset.unavailable;
    else group.dataset.unavailable = '1';
    const shown = document.getElementById('settings-content')?.dataset.cat === group.dataset.settingsCat;
    group.hidden = !shown || group.dataset.unavailable === '1';
  }

  // Where the dashboard opens: this PC (on the screen chosen in Schermi), the phone as
  // well, or the phone alone. "This PC" keeps a screen already chosen.
  const SURFACE_PLACES = Object.freeze([
    ['pc', 'surface_mode_pc', 'surface_mode_pc_hint'],
    ['both', 'surface_mode_both', 'surface_mode_both_hint'],
    ['phone', 'surface_mode_phone', 'surface_mode_phone_hint'],
  ]);

  function renderSurfacePhone(choice) {
    const host = document.getElementById('settings-surface-phone');
    if (!host) return;
    host.textContent = '';
    const head = document.createElement('div');
    head.className = 'settings-group-head';
    head.appendChild(surfaceLine('surface_where', ''));
    const list = document.createElement('div');
    list.className = 'settings-radio-list';
    const now = choice.kind === 'both' || choice.kind === 'phone' ? choice.kind : 'pc';
    for (const [place, labelKey, hintKey] of SURFACE_PLACES) {
      const label = document.createElement('label');
      label.className = 'settings-toggle-row full';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'surface-place';
      input.className = 'settings-check';
      input.checked = now === place;
      input.addEventListener('change', () => { if (input.checked) applySurfaceKind(place === 'pc' ? 'auto' : place); });
      label.append(input, surfaceLine(labelKey, hintKey));
      list.appendChild(label);
    }
    host.append(head, list);
    // Until a device is paired the PC keeps showing the dashboard on purpose: said, so
    // "waiting for you" never reads as "did nothing".
    if (choice.kind !== 'phone') return;
    const pending = surfaceWarning('surface_phone_pending');
    pending.className = 'settings-hint';
    host.appendChild(pending);
    if (typeof window.__surfaceHasPairedDevice === 'function') {
      window.__surfaceHasPairedDevice().then((paired) => { if (paired && pending.isConnected) pending.remove(); });
    }
  }

  return { renderSurfaceWindow, renderSurfacePhone };
}

// Both parts, from the shell's state (a browser has none): drawn when Schermi or
// Telefono opens, and again when a screen is plugged in or out.
function renderSurfaceSection() {
  const native = window.XenonNative;
  const state = (native && typeof native.displayState === 'function')
    ? native.displayState()
    : { supported: false, displays: [], mode: 'auto', monitor: '', fullscreen: false, active: '', missing: false, gpuMismatch: false };
  const choice = getSurfaceChoice();
  const rows = surfaceRows();
  rows.renderSurfaceWindow(state, choice);
  rows.renderSurfacePhone(choice);
}
window.renderSurfaceSection = renderSurfaceSection;

// A place that names no screen; back to this PC is 'auto', and Schermi picks a screen.
function applySurfaceKind(kind) {
  const native = window.XenonNative;
  if (kind === 'phone') {
    // Intent only: the shell is told by SurfacePicker.reconcileShell, and only once a
    // device is actually paired. Applying it here would hide the window the user is
    // about to pair from (surface-picker.js).
    setSurfaceChoice({ kind: 'phone', asked: true, monitor: '', label: '' });
  } else if (kind === 'both') {
    // Phone AND this PC: the shell is told 'auto', because that is what it does here;
    // the difference is the answer remembered. Told now, so leaving 'phone' brings the
    // window back at once instead of at the next login.
    if (native && typeof native.chooseAutoScreen === 'function') native.chooseAutoScreen();
    setSurfaceChoice({ kind: 'both', asked: true, monitor: '', label: '' });
  } else {
    if (native && typeof native.chooseAutoScreen === 'function') native.chooseAutoScreen();
    setSurfaceChoice({ kind: 'auto', asked: true, monitor: '', label: '' });
  }
  renderSurfaceSection();
}

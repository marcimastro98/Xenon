// Which kind of screen the dashboard runs on: the first-run answers, the Display section and
// applying a choice.
'use strict';

// First-run tutorial state. The getter is read by onboarding.js to decide
// whether to auto-start the tour; the setter records the version the user just
// finished/skipped and persists it to the server so it survives a storage wipe.
function getOnboardingSeen() {
  return (hubSettings && hubSettings.onboarding && Number(hubSettings.onboarding.seenVersion)) || 0;
}
window.getOnboardingSeen = getOnboardingSeen;

function setOnboardingSeen(version) {
  const v = Math.max(0, Math.floor(Number(version) || 0));
  hubSettings = normalizeSettings({ ...hubSettings, onboarding: { seenVersion: v } });
  saveHubSettings();
}
window.setOnboardingSeen = setOnboardingSeen;

// The chosen screen. Read by surface-picker.js to decide whether to ask, and by
// the Settings → Schermo panel to render the current choice. Server-backed on
// purpose: the answer must reach every surface, and a paired phone — which has
// no channel to the native shell — writes it here and lets the shell's own
// dashboard page relay it (see js/surface-picker.js).
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

// ── Settings → Schermo ───────────────────────────────────────────────────
// Where Xenon lives. The same question the first-run picker asks, kept somewhere
// the user can change their mind — and the only place the answer is visible at
// all on a surface that cannot act on it (a paired phone shows the choice and
// can change it; the shell's own page relays it, see surface-picker.js).
function renderSurfaceSection() {
  const host = document.getElementById('settings-surface-body');
  if (!host) return;
  const native = window.XenonNative;
  const state = (native && typeof native.displayState === 'function')
    ? native.displayState()
    : { supported: false, displays: [], mode: 'auto', monitor: '', fullscreen: false, active: '', missing: false, gpuMismatch: false };
  const choice = getSurfaceChoice();
  host.textContent = '';

  const row = (labelKey, labelText, hintKey, hintText) => {
    const wrap = document.createElement('span');
    wrap.className = 'settings-label-line';
    const b = document.createElement('span');
    b.dataset.i18n = labelKey;
    // Translate HERE, like every other row in this panel does. data-i18n alone
    // is not enough: applyTranslations() sweeps the document when the language
    // changes, so a node built afterwards keeps whatever text it was created
    // with — and the literals below are Italian. That is why these four rows
    // were the only Italian thing on an English dashboard.
    b.textContent = t(labelKey, labelText);
    wrap.appendChild(b);
    if (hintKey) {
      const h = document.createElement('span');
      h.className = 'settings-hint';
      h.dataset.i18n = hintKey;
      h.textContent = t(hintKey, hintText);
      wrap.appendChild(h);
    }
    return wrap;
  };

  // The four answers, as radio rows.
  const modes = [
    ['auto', 'surface_mode_auto', 'Automatico', 'surface_mode_auto_hint', 'Xenon sceglie da sé: la Xeneon Edge se c’è, altrimenti una finestra sullo schermo principale.'],
    ['screen', 'surface_mode_screen', 'Uno schermo di questo PC', 'surface_mode_screen_hint', 'Scegli tu quale. Vale anche se hai una Xeneon Edge collegata.'],
    ['both', 'surface_mode_both', 'Sul telefono e anche su questo PC', 'surface_mode_both_hint', 'La dashboard si apre sul telefono accoppiato e continua ad aprirsi anche qui.'],
    ['phone', 'surface_mode_phone', 'Solo sul telefono o tablet', 'surface_mode_phone_hint', 'Su questo PC non compare niente, nemmeno all’avvio. La dashboard si apre sul telefono, una volta accoppiato.'],
  ];
  const list = document.createElement('div');
  list.className = 'settings-radio-list';
  modes.forEach(([kind, lk, lt, hk, ht]) => {
    const label = document.createElement('label');
    label.className = 'settings-toggle-row full';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'surface-kind';
    input.className = 'settings-check';
    input.checked = choice.kind === kind;
    input.addEventListener('change', () => {
      if (!input.checked) return;
      applySurfaceKind(kind, state);
    });
    label.appendChild(input);
    label.appendChild(row(lk, lt, hk, ht));
    list.appendChild(label);
  });
  host.appendChild(list);

  // The monitor list, when there is one to show.
  if (state.supported && state.displays.length) {
    const screens = document.createElement('div');
    screens.className = 'sp-screens settings-surface-screens';
    state.displays.forEach((d) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sp-screen' + (d.id && d.id === choice.monitor ? ' is-on' : '');
      btn.disabled = !d.id;
      const name = document.createElement('span');
      name.className = 'sp-screen-name';
      name.textContent = d.label;
      btn.appendChild(name);
      if (d.edge || d.primary || (d.id && d.id === state.active)) {
        const tag = document.createElement('span');
        tag.className = 'sp-screen-tag';
        tag.textContent = d.edge ? 'Xeneon Edge'
          : (d.id === state.active ? t('surface_in_use') : t('surface_primary'));
        btn.appendChild(tag);
      }
      btn.addEventListener('click', () => {
        if (!d.id) return;
        if (native && typeof native.chooseScreen === 'function') native.chooseScreen(d.id, state.fullscreen);
        setSurfaceChoice({ kind: 'screen', asked: true, monitor: d.id, label: d.label });
        renderSurfaceSection();
      });
      screens.appendChild(btn);
    });
    host.appendChild(screens);

    // Full-screen. Meaningless on the Edge panel (always borderless-fullscreen)
    // and in phone mode, so it is hidden rather than shown doing nothing.
    const chosen = state.displays.find((d) => d.id && d.id === choice.monitor);
    const onEdgePanel = choice.kind === 'screen' ? !!(chosen && chosen.edge)
      : state.displays.some((d) => d.edge);
    if (choice.kind !== 'phone' && !onEdgePanel) {
      const label = document.createElement('label');
      label.className = 'settings-toggle-row full';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'settings-check';
      input.checked = state.fullscreen;
      input.addEventListener('change', () => {
        if (native && typeof native.setScreenFullscreen === 'function') native.setScreenFullscreen(input.checked);
      });
      label.appendChild(input);
      label.appendChild(row('surface_fullscreen', 'A schermo intero',
        'surface_fullscreen_hint', 'Occupa tutto lo schermo scelto invece di stare in una finestra.'));
      host.appendChild(label);
    }
  } else {
    // A browser cannot move its own window to another display, and saying so is
    // better than showing a picker that would do nothing.
    const note = document.createElement('p');
    note.className = 'settings-hint';
    note.dataset.i18n = 'surface_browser_note';
    note.textContent = t('surface_browser_note');
    host.appendChild(note);
  }

  // The chosen screen is unplugged: the window is hidden on purpose, and saying
  // so is the difference between a deliberate state and a broken one.
  if (state.missing) {
    const warn = document.createElement('p');
    warn.className = 'settings-hint settings-hint-warn';
    warn.dataset.i18n = 'surface_missing';
    warn.textContent = t('surface_missing');
    host.appendChild(warn);
  }

  // The screens moved after the shell picked which GPU to render on, and that
  // choice is fixed for the life of the process (see apps/native/src-tauri/src/gpu.rs).
  // Said here because this panel is where the user is standing when it becomes
  // true — they have just replugged a screen — and because a cost only a restart
  // can remove is worse when nothing names it: the dashboard simply feels heavier
  // than it did an hour ago, with nothing to blame.
  //
  // The button is the footer's own restart, reused rather than reimplemented: it
  // confirms first, it already explains that nothing is lost, and it is already
  // translated. Telling the user to use the tray icon instead would be bad advice
  // on the surface this matters most on — in kiosk mode on the Edge the tray is
  // behind the swipe-up gesture, so the fix would be further away than the problem.
  if (state.gpuMismatch) {
    const warn = document.createElement('p');
    warn.className = 'settings-hint settings-hint-warn';
    warn.dataset.i18n = 'surface_gpu_mismatch';
    warn.textContent = t('surface_gpu_mismatch');
    host.appendChild(warn);
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'settings-btn';
    fix.dataset.i18n = 'settings_restart_app';
    fix.textContent = t('settings_restart_app', 'Riavvia Xenon');
    fix.addEventListener('click', () => restartXenon());
    host.appendChild(fix);
  }

  // Phone modes: the pairing panel is where the actual work happens.
  if (choice.kind === 'phone' || choice.kind === 'both') {
    // Until a device is paired the PC deliberately keeps showing the dashboard.
    // Saying so is the difference between "waiting for you" and "did nothing".
    // Only for 'phone': under 'both' the PC showing the dashboard IS the choice,
    // so there is nothing pending to explain.
    if (choice.kind === 'phone') {
      const pending = document.createElement('p');
      pending.className = 'settings-hint';
      pending.dataset.i18n = 'surface_phone_pending';
      pending.textContent = t('surface_phone_pending');
      host.appendChild(pending);
      if (typeof window.__surfaceHasPairedDevice === 'function') {
        window.__surfaceHasPairedDevice().then((paired) => {
          if (paired && pending.isConnected) pending.remove();
        });
      }
    }
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'settings-btn settings-surface-pair';
    go.dataset.i18n = 'surface_open_pairing';
    go.textContent = t('surface_open_pairing');
    // 'phone', not 'remote': pairing moved out of the Remote Control wizard's
    // category when the two were separated. A button that opens the wrong pane
    // is the one failure mode here — it looks like it worked.
    go.addEventListener('click', () => settingsSetCategory('phone'));
    host.appendChild(go);
  }
}
window.renderSurfaceSection = renderSurfaceSection;

// Applying a mode that names no screen. Picking 'screen' without having chosen
// one yet selects the display already in use, so the radio never leaves the user
// in a state that means nothing.
function applySurfaceKind(kind, state) {
  const native = window.XenonNative;
  if (kind === 'phone') {
    // Intent only — the shell is told by SurfacePicker.reconcileShell, and only
    // once a device is actually paired. Applying it here would hide the window
    // the user is about to pair from. See the note in surface-picker.js.
    setSurfaceChoice({ kind: 'phone', asked: true, monitor: '', label: '' });
  } else if (kind === 'both') {
    // Phone AND this PC. The shell is told 'auto' because that is what it does
    // here — the difference from 'auto' is the answer we remember, not the
    // placement. Told immediately, so leaving 'phone' brings the window back now
    // instead of at the next login.
    if (native && typeof native.chooseAutoScreen === 'function') native.chooseAutoScreen();
    setSurfaceChoice({ kind: 'both', asked: true, monitor: '', label: '' });
  } else if (kind === 'auto') {
    if (native && typeof native.chooseAutoScreen === 'function') native.chooseAutoScreen();
    setSurfaceChoice({ kind: 'auto', asked: true, monitor: '', label: '' });
  } else {
    const cur = getSurfaceChoice();
    const pick = state.displays.find((d) => d.id && d.id === cur.monitor)
      || state.displays.find((d) => d.id && d.id === state.active)
      || state.displays.find((d) => d.id && d.edge)
      || state.displays.find((d) => d.id);
    if (pick && native && typeof native.chooseScreen === 'function') native.chooseScreen(pick.id, state.fullscreen);
    setSurfaceChoice({ kind: 'screen', asked: true, monitor: pick ? pick.id : '', label: pick ? pick.label : '' });
  }
  renderSurfaceSection();
}

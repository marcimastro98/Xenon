'use strict';

// ─────────────────────────────────────────────────────────────────────────
// "Where do you want Xenon?" — asked once, on first run, before the tour.
//
// Until v4.11 nobody was ever asked. Without a Xeneon Edge attached the native
// app simply opened a window on the primary monitor, and the only way to change
// that was a tray submenu almost nobody finds. Someone who wanted the dashboard
// on their phone still got the app full-screen on the PC at every login.
//
// Two answers, and a third that keeps today's behaviour:
//   • a screen on this PC  → the shell places the window there and remembers it
//   • my phone or tablet   → this PC shows nothing; we land on the pairing panel
//   • decide later         → 'auto', and we never ask again
//
// The monitor list only exists inside the native shell (see native-bridge.js);
// in a plain browser the first card is simply "this screen", which is honest —
// a browser cannot move its own window to another display.
//
// State derived, no step cursor: the same shape as the Sunshine wizard in
// remote-control.js. There is nothing to get stuck halfway through.
// ─────────────────────────────────────────────────────────────────────────

(function () {
  // Translate via the global t() with a literal fallback (t returns the key when
  // it has no translation, so we never render a raw key to the user).
  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  let overlay = null;
  let selectedId = '';

  function surface() {
    return (typeof window.getSurfaceChoice === 'function')
      ? window.getSurfaceChoice()
      : { kind: 'auto', asked: false, monitor: '', label: '' };
  }

  function displays() {
    const native = window.XenonNative;
    if (!native || typeof native.displayState !== 'function') return { supported: false, displays: [] };
    return native.displayState();
  }

  // ── The dialog ───────────────────────────────────────────────────────
  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('surface-picker', false);
  }

  function finish(patch) {
    if (typeof window.setSurfaceChoice === 'function') window.setSurfaceChoice({ ...patch, asked: true });
    close();
  }

  function chooseScreen() {
    const state = displays();
    const picked = state.displays.find((d) => d.id === selectedId) || null;
    if (picked && window.XenonNative && typeof window.XenonNative.chooseScreen === 'function') {
      window.XenonNative.chooseScreen(picked.id, state.fullscreen);
    }
    finish({ kind: picked ? 'screen' : 'auto', monitor: picked ? picked.id : '', label: picked ? picked.label : '' });
  }

  function choosePhone() {
    // Recorded as 'both', NOT 'phone', and nothing on this PC changes.
    //
    // "This PC shows nothing" is only safe once the phone can show something,
    // and at this instant nothing is paired: applying it here hid the very
    // window carrying the QR code the user is about to scan, and took the app
    // out of the login entry at the same time — so a restart brought back
    // nothing either. It is also not what everyone wants: plenty of people want
    // the dashboard on the phone AND on the PC. So the hiding is not part of
    // this answer at all — the guide asks for it at the end, once there is a
    // paired device to hand the dashboard over to, and Settings → Screen moves
    // between the two afterwards.
    //
    // The network door also stays SHUT: choosing "my phone" says where the user
    // wants the dashboard, not that they authorise a LAN listener. That switch
    // has its own panel, and flipping it as a side effect of a wizard is what
    // the paired-device rules forbid. So we land them on it, one tap away, with
    // the step-by-step guide open on the switch itself.
    finish({ kind: 'both', monitor: '', label: '' });
    if (window.RemoteAccessGuide && typeof window.RemoteAccessGuide.open === 'function') {
      window.RemoteAccessGuide.open();
    }
    // 'phone', NOT 'remote'. 'remote' is the Sunshine/Moonlight wizard, which
    // pairing moved out of when the two were separated — so this landed the user
    // on a desktop-streaming panel while the highlight below aimed at a node in
    // a category that was hidden, and therefore did nothing at all. Measured on
    // the real dashboard. The same fix already lives on the Settings → Screen
    // button (settingsSetCategory('phone')).
    if (typeof window.openSettings === 'function') window.openSettings('phone');
    // Let the panel render before pointing at it.
    setTimeout(() => {
      const panel = document.getElementById('settings-remote-access');
      if (!panel) return;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      panel.classList.add('ra-highlight');
      setTimeout(() => panel.classList.remove('ra-highlight'), 2600);
    }, 260);
  }

  function screenCard(state) {
    const card = document.createElement('div');
    card.className = 'sp-card';

    const head = document.createElement('div');
    head.className = 'sp-card-head';
    head.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
    const title = document.createElement('b');
    title.textContent = tr('surface_pc_title', 'On this PC');
    head.appendChild(title);
    card.appendChild(head);

    const body = document.createElement('p');
    body.textContent = state.supported
      ? tr('surface_pc_body', 'Pick the screen Xenon should open on. You can change it any time.')
      : tr('surface_pc_body_browser', 'Xenon stays on this screen, in this window. To have it open full-screen on a display of its own, use the Xenon app.');
    card.appendChild(body);

    // Inside the shell but the monitor list has not been pushed yet — it arrives
    // a moment after the page loads. Say so, rather than fall through to the
    // browser text, which would tell someone running the app that their screens
    // cannot be chosen. The listener at the bottom of this file repaints.
    if (state.supported && !state.displays.length) {
      const wait = document.createElement('span');
      wait.className = 'sp-note';
      wait.textContent = tr('surface_reading', 'Reading the screens on this PC…');
      card.appendChild(wait);
    }

    if (state.supported && state.displays.length) {
      const list = document.createElement('div');
      list.className = 'sp-screens';
      state.displays.forEach((d) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sp-screen' + (d.id === selectedId ? ' is-on' : '');
        // A display the OS gave no name to can never be persisted, so it is
        // shown and refused rather than silently offered.
        btn.disabled = !d.id;
        const name = document.createElement('span');
        name.className = 'sp-screen-name';
        name.textContent = d.label;
        btn.appendChild(name);
        if (d.edge || d.primary) {
          const tag = document.createElement('span');
          tag.className = 'sp-screen-tag';
          tag.textContent = d.edge ? 'Xeneon Edge' : tr('surface_primary', 'primary');
          btn.appendChild(tag);
        }
        btn.addEventListener('click', () => {
          selectedId = d.id || '';
          render();
        });
        list.appendChild(btn);
      });
      card.appendChild(list);
    }

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'settings-btn primary sp-go';
    go.textContent = tr('surface_pc_cta', 'Use this PC');
    go.addEventListener('click', chooseScreen);
    card.appendChild(go);
    return card;
  }

  function phoneCard() {
    const card = document.createElement('div');
    card.className = 'sp-card';

    const head = document.createElement('div');
    head.className = 'sp-card-head';
    head.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18.5h2"/></svg>';
    const title = document.createElement('b');
    title.textContent = tr('surface_phone_title', 'On my phone or tablet');
    head.appendChild(title);
    card.appendChild(head);

    const body = document.createElement('p');
    body.textContent = tr('surface_phone_body', 'The dashboard opens in your phone’s browser over your own Wi-Fi. Nothing to install on the phone.');
    card.appendChild(body);

    const note = document.createElement('span');
    note.className = 'sp-note';
    note.textContent = tr('surface_phone_note', 'A step-by-step guide opens on this PC. Nothing is switched on until you do it there, and Xenon keeps opening here unless you ask it not to.');
    card.appendChild(note);

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'settings-btn primary sp-go';
    go.textContent = tr('surface_phone_cta', 'Set up my phone');
    go.addEventListener('click', choosePhone);
    card.appendChild(go);
    return card;
  }

  // The screen already in use — the Edge when there is one, because that is what
  // the shell would have chosen on its own.
  function preferredId(state) {
    const pick = state.displays.find((d) => d.edge)
      || state.displays.find((d) => d.id && d.id === state.active)
      || state.displays.find((d) => d.primary)
      || state.displays[0];
    return (pick && pick.id) || '';
  }

  function render() {
    const state = displays();
    // The list can arrive AFTER the dialog opened (the shell pushes it once the
    // page has loaded), so the preselection is made here too — otherwise the
    // monitors would appear with none of them chosen and "Use this PC" would
    // quietly mean "automatic".
    if (!selectedId) selectedId = preferredId(state);
    // `isConnected`, not just non-null: anything that removes the node without
    // going through close() would otherwise leave us re-rendering into a
    // detached element — a dialog that exists and is on nobody's screen.
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement('div');
      overlay.className = 'sp-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      document.body.appendChild(overlay);
      if (typeof window.ambientFreeze === 'function') window.ambientFreeze('surface-picker', true);
    }
    overlay.textContent = '';

    const box = document.createElement('div');
    box.className = 'sp-box';

    const h = document.createElement('h2');
    h.textContent = tr('surface_title', 'Where do you want Xenon?');
    box.appendChild(h);

    const sub = document.createElement('p');
    sub.className = 'sp-sub';
    sub.textContent = tr('surface_sub', 'Xenon lives on a screen you can leave on. Pick one now — Settings → Screen changes it whenever you like.');
    box.appendChild(sub);

    const cards = document.createElement('div');
    cards.className = 'sp-cards';
    cards.appendChild(screenCard(state));
    cards.appendChild(phoneCard());
    box.appendChild(cards);

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'sp-later';
    later.textContent = tr('surface_later', 'Decide later');
    later.addEventListener('click', () => finish({ kind: 'auto' }));
    box.appendChild(later);

    overlay.appendChild(box);
  }

  function start() {
    selectedId = preferredId(displays());
    render();
  }

  // Only where the question can be answered honestly:
  //   • a paired phone already IS the answer, and cannot move the PC's window
  //   • the iCUE iframe is a panel inside another app, not a screen choice
  //   • phone-view is a viewport, and the dialog would have nowhere to sit
  function shouldAsk() {
    if (surface().asked) return false;
    if (window.__xenonRemote) return false;
    if (window.PhoneView && typeof window.PhoneView.isActive === 'function' && window.PhoneView.isActive()) return false;
    try { if (window.self !== window.top) return false; } catch (e) { return false; }
    return true;
  }

  // Called after settings hydrate, like the tour, and BEFORE it: answering
  // "where" first means the tour that follows is about a dashboard the user has
  // already put where they want it.
  //
  // Opens immediately. It used to wait 600ms for the shell's first
  // `push_display_state` to land (the caps injected before the page loads carry
  // `displayPicker` but no monitor list), which on a first run is 600ms of a
  // finished-looking dashboard with no question on it. The list is not needed to
  // draw the dialog: `screenCard` says it is reading the screens until the push
  // arrives, and the display listener below repaints when it does.
  function maybeStart() {
    if (!shouldAsk()) return false;
    start();
    return true;
  }

  // ── Relay a choice made somewhere the shell cannot hear ──────────────
  // A paired phone can write the choice into settings, but it has no way to tell
  // the native shell: the only channel is a custom-scheme navigation, and that
  // exists solely inside the shell's own webview. So the dashboard page RUNNING
  // IN THE SHELL notices the settings change and fires the signal on the phone's
  // behalf. Called from settings.js on every settings apply, including the ones
  // that arrive over SSE from another surface.
  //
  // Idempotent by construction: it compares against what the shell reports and
  // sends nothing when they already agree, so a settings save for an unrelated
  // reason never re-places the window.
  // Has at least one phone or tablet actually been paired? Cached per call site
  // because phone mode is the only branch that asks, and only until it applies.
  async function hasPairedDevice() {
    try {
      const res = await fetch('/api/remote-access/status', { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      return Array.isArray(data && data.devices) && data.devices.length > 0;
    } catch (e) {
      // Unreachable status is not "no devices" — it is "we do not know", and
      // hiding this PC on a guess is the one thing this gate exists to prevent.
      return false;
    }
  }
  window.__surfaceHasPairedDevice = hasPairedDevice;

  let lastRelayed = '';
  function reconcileShell() {
    const native = window.XenonNative;
    if (!native || !native.isNative || typeof native.displayState !== 'function') return;
    const state = native.displayState();
    if (!state.supported) return;
    const want = surface();
    if (!want.asked) return;
    const key = want.kind + '|' + (want.monitor || '');
    if (key === lastRelayed) return;
    if (want.kind === 'phone') {
      if (state.mode === 'phone') { lastRelayed = key; return; }
      // Only once a device is paired. Applying it earlier hides the screen the
      // user is pairing FROM, and removes the app from the login entry, so
      // there is nothing on the PC and nothing on the phone either.
      hasPairedDevice().then((paired) => {
        if (!paired) return;                       // check again on the next settings apply
        if (surface().kind !== 'phone') return;    // they changed their mind meanwhile
        if (native.choosePhoneScreen()) lastRelayed = key;
      });
      return;
    }
    if (want.kind === 'screen' && want.monitor) {
      if (state.mode === 'screen' && state.monitor === want.monitor) { lastRelayed = key; return; }
      if (native.chooseScreen(want.monitor, state.fullscreen)) lastRelayed = key;
      return;
    }
    // 'both' is 'auto' as far as the shell is concerned: the phone is paired and
    // this PC keeps its window. The distinction lives in the settings, so the
    // Screen panel and the phone guide can tell "I chose both" from "I never
    // said" — the shell has no third placement to be told about.
    if (want.kind === 'auto' || want.kind === 'both') {
      if (state.mode === 'auto') { lastRelayed = key; return; }
      if (native.chooseAutoScreen()) lastRelayed = key;
    }
  }

  // The shell pushes a fresh list when a display is plugged in or out. Repaint
  // whatever is on screen: a picker showing a monitor that has just been
  // unplugged is worse than no picker at all.
  if (window.XenonNative && typeof window.XenonNative.setDisplayListener === 'function') {
    window.XenonNative.setDisplayListener(() => {
      if (overlay) render();
      if (typeof window.renderSurfaceSection === 'function') window.renderSurfaceSection();
    });
  }

  window.SurfacePicker = { start, maybeStart, shouldAsk, reconcileShell, isOpen: () => !!overlay };
})();

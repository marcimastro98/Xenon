'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Bridge between the shared dashboard and the native Tauri shell.
//
// This module is loaded on EVERY surface (browser, iCUE iframe, native app),
// but it only does something surface-specific:
//   • Inside the native shell (the shell's init script sets
//     `window.__XENON_NATIVE__`), it shows the "update available — tap to
//     install" toast when the shell reports a newer signed release. The tap
//     navigates to `xenon-update:install`, which the shell's navigation hook
//     turns into a download-and-relaunch (see apps/native/src-tauri/src/lib.rs).
//   • On the browser / iCUE surfaces, it powers the "install the native app"
//     promo in Settings → General: it asks the backend whether the native app
//     is already installed and, if not, reveals the promo and wires its button.
//
// It never assumes Tauri APIs exist; the only channel to the shell is the
// custom-scheme navigation, so nothing here breaks the plain web surfaces.
// ─────────────────────────────────────────────────────────────────────────

(function () {
  // Two independent signals so detection can't silently fail: our own marker,
  // set by the shell's init script, and Tauri's built-in `window.isTauri` global,
  // which Tauri core injects into the webview regardless of our shim (so this
  // still holds even on an older native build whose shim lacked the marker).
  const isNative = window.__XENON_NATIVE__ === true || window.isTauri === true;
  const SERVER = (window.Xenon && window.Xenon.constants && window.Xenon.constants.LOOPBACK_ORIGIN) || '';

  // Localized string with a plain-English fallback (the dashboard's own t()).
  function tr(key, fallback) {
    try {
      if (typeof window.t === 'function') {
        const s = window.t(key);
        if (s && s !== key) return s;
      }
    } catch (e) { /* i18n not ready yet */ }
    return fallback;
  }

  // ── Native shell: "update available" toast ───────────────────────────
  let updatePromptShown = false;
  function showUpdatePrompt(version) {
    if (!isNative || updatePromptShown) return;
    if (!window.XenonToast || typeof window.XenonToast.show !== 'function') return;
    updatePromptShown = true;
    const ver = version ? String(version) : '';
    const msg = tr('native_update_tap', 'Tap to install the latest version.') + (ver ? ' (v' + ver + ')' : '');
    window.XenonToast.show({
      type: 'info',
      duration: 0, // stays until tapped or dismissed
      title: tr('native_update_title', 'Update available'),
      message: msg,
      onClick: function () {
        // Handed to the native navigation hook, which downloads + relaunches.
        try { window.location.href = 'xenon-update:install'; } catch (e) { /* not native */ }
        try {
          window.XenonToast.show({
            type: 'info',
            title: tr('native_update_installing', 'Updating Xenon…'),
            message: tr('native_update_installing_hint', 'The app will restart when it is done.'),
          });
        } catch (e) { /* best effort */ }
      },
    });
  }

  // ── Browser / iCUE: "install the native app" promo ───────────────────
  // Reveals the compact #native-promo-chip in the settings header (hidden in
  // index.html) when the native app is not the current surface and is not already
  // installed; the chip toggles the #native-promo details dropdown, whose button
  // kicks off the install. Nothing is shown inside the native app.
  // The dashboard runs top-level in a real browser but inside an <iframe> in the
  // iCUE widget host. A cross-origin frame throws on window.top access, so treat
  // "can't reach top" as framed too — used to tailor the post-install guidance.
  const inIcueFrame = (function () {
    try { return window.top !== window.self; } catch (e) { return true; }
  })();

  async function initNativePromo() {
    if (isNative) return; // already running the native app
    const chip = document.getElementById('native-promo-chip');
    const card = document.getElementById('native-promo');
    if (!chip || !card) return;
    let status = null;
    try {
      const res = await fetch(SERVER + '/api/native/status');
      if (res.ok) status = await res.json();
    } catch (e) { /* backend older than this feature, or offline */ }
    // Key off `installed` (the server now checks the app is actually on disk), not
    // the chosen-surface marker — otherwise the promo stayed hidden after the user
    // uninstalled the native app (the marker keeps saying 'native').
    if (!status || status.installed) return; // already installed -> nothing to offer
    chip.hidden = false;

    // Toggle the dropdown from the pill; close on outside-click or Escape.
    function setOpen(open) {
      card.hidden = !open;
      chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(card.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!card.hidden && !card.contains(e.target) && e.target !== chip && !chip.contains(e.target)) {
        setOpen(false);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !card.hidden) setOpen(false);
    });

    const btn = document.getElementById('native-promo-install');
    const statusEl = document.getElementById('native-promo-status');
    if (!btn) return;

    function setStatus(key, fallback, extra) {
      if (!statusEl) return;
      let msg = tr(key, fallback);
      if (extra) msg += ': ' + extra;
      statusEl.textContent = msg;
    }

    // The install is silent (no installer window), so a friendly line for the raw
    // reason codes install-native.ps1 emits; unknown codes fall through verbatim so
    // they stay diagnosable.
    function reasonText(code) {
      const map = {
        no_installer: tr('native_promo_err_no_installer', 'the installer is not on the latest release yet'),
        download_failed: tr('native_promo_err_download', 'the download failed — check your connection'),
        launch_missing: tr('native_promo_err_launch', 'installed, but the app could not be started'),
      };
      return map[code] || code;
    }

    // A silent install shows no window, so without progress the button looked
    // frozen. Poll the server-side marker the installer writes and reflect
    // downloading -> installing -> done/error until a terminal state or timeout.
    let pollTimer = null;
    function pollInstallStatus() {
      const MAX_TRIES = 75; // ~90s at 1.2s between polls — covers a slow download+install
      let tries = 0;
      const tick = async () => {
        tries += 1;
        let st = null;
        try {
          const r = await fetch(SERVER + '/api/native/install-status', { cache: 'no-store' });
          if (r.ok) st = await r.json();
        } catch (e) { /* transient — keep waiting */ }
        const state = st && st.state;
        if (state === 'downloading') { setStatus('native_promo_st_downloading', 'Downloading the installer…'); }
        else if (state === 'installing') { setStatus('native_promo_st_installing', 'Installing…'); }
        else if (state === 'done') {
          // Terminal success. Make the button read as finished (it looked "stuck"
          // sitting disabled on the last progress line) and, crucially, tell the
          // user what to do next — the app opened on the Edge, so the guidance
          // differs by surface: inside iCUE they can close iCUE (the kiosk is
          // independent); in a browser it's simply now on the Edge display.
          btn.textContent = tr('native_promo_done_btn', 'Installed ✓');
          const done = tr('native_promo_st_done', 'Installed! The app is now on your Xeneon Edge.');
          const guide = inIcueFrame
            ? tr('native_promo_done_icue', 'It runs on the Edge on its own, independently of iCUE — you can close iCUE whenever you like. Reopen iCUE any time to come back to this widget.')
            : tr('native_promo_done_browser', 'It is now full-screen on your Edge display. This browser tab stays available too.');
          if (statusEl) statusEl.textContent = done + ' ' + guide;
          return;
        }
        else if (state === 'error') {
          btn.disabled = false;
          setStatus('native_promo_failed', 'Could not install', reasonText((st && st.error) || ''));
          return;
        }
        if (tries >= MAX_TRIES) {
          btn.disabled = false;
          setStatus('native_promo_st_timeout', 'This is taking longer than usual — check the Edge, or try again.');
          return;
        }
        pollTimer = setTimeout(tick, 1200);
      };
      if (pollTimer) clearTimeout(pollTimer);
      tick();
    }

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setStatus('native_promo_st_downloading', 'Downloading the installer…');
      try {
        const res = await fetch(SERVER + '/api/native/install', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok) {
          pollInstallStatus();
        } else {
          btn.disabled = false;
          setStatus('native_promo_failed', 'Could not start the install', data && data.error);
        }
      } catch (e) {
        btn.disabled = false;
        setStatus('native_promo_failed', 'Could not start the install');
      }
    });
  }

  // ── Native shell: swipe-up-to-desktop "home" gesture ─────────────────
  // Only in the native app. Swiping up from the bottom of the screen collapses
  // the kiosk to a slim home-bar strip (the Rust shell reshapes the OS window;
  // see monitor.rs); tapping or swiping up on that strip restores the dashboard.
  // The webview stays alive inside the strip, so the strip's own handle is what
  // catches the return gesture — a hidden webview couldn't. Both directions go
  // through the same custom-scheme channel the update flow uses.
  //
  // Toggleable from Settings → General (`swipeHomeGesture`); settings.js pushes
  // the value through setHomeGestureEnabled below, which also tells the shell to
  // apply/lift the Windows edge-swipe block and remember the choice.
  let homeGestureEnabled = true; // dashboard setting, pushed by settings.js
  let homeGestureShellSignal = null; // last state signalled to the shell

  // Fire the pending shell signal — but NEVER while the document is still
  // loading. Assigning location.href (even to a scheme the shell cancels)
  // during the initial load ABORTS the page load in WebView2: every script tag
  // after the assignment simply never runs, leaving a dead dashboard of "--"
  // placeholders. That exact corpse shipped once — this deferral is the fix.
  // Only the LATEST state is sent; a toggle that flips back before the timer
  // fires sends nothing.
  let homeGestureSignalTimer = null;
  function sendHomeGestureSignalSoon() {
    if (homeGestureSignalTimer) return; // already queued — it reads the latest state
    const fire = () => {
      homeGestureSignalTimer = setTimeout(() => {
        homeGestureSignalTimer = null;
        if (homeGestureShellSignal === homeGestureEnabled) return;
        homeGestureShellSignal = homeGestureEnabled;
        try {
          window.location.href = homeGestureEnabled ? 'xenon-home:gesture-on' : 'xenon-home:gesture-off';
        } catch (e) { /* not native */ }
      }, 1500);
    };
    if (document.readyState === 'complete') fire();
    else window.addEventListener('load', fire, { once: true });
  }

  function setHomeGestureEnabled(on) {
    homeGestureEnabled = on !== false;
    if (!isNative) return;
    // Only signal shells that declare the capability (the shell's init script
    // sets __XENON_NATIVE_CAPS__). An older shell reads ANY other xenon-home
    // path as "collapse to the desktop strip" — signalling it gesture-on would
    // shrink the kiosk to a stuck strip on every load. On old shells the toggle
    // still fully gates the JS gesture above; only the Windows edge-swipe
    // policy stays under the shell's own start/exit management.
    const caps = window.__XENON_NATIVE_CAPS__;
    if (!caps || caps.homeGestureToggle !== true) return;
    // Reconcile the shell side once per change: it toggles the Windows
    // edge-swipe policy and persists the choice for the next launch.
    if (homeGestureShellSignal === homeGestureEnabled) return;
    sendHomeGestureSignalSoon();
  }

  // ── Native shell: hide the kiosk during a Remote Desktop session ─────
  // Native-app-only. When the user RDPs into this PC (their own Windows Remote
  // Desktop, NOT our Sunshine/Moonlight remote control), the borderless kiosk
  // would cover the desktop they came in to use. With this on, the shell's
  // watchdog hides the window while a Terminal-Services session is active and
  // shows it again when they're back at the console. Opt-in; toggled from
  // Settings → General (`hideOnRdp`) and pushed through setHideOnRdp below, which
  // signals the shell and has it remember the choice for launch. Uses the same
  // load-safe deferred signalling as the home gesture above (assigning
  // location.href during the initial page load aborts it in WebView2).
  let hideOnRdpEnabled = false; // dashboard setting, pushed by settings.js
  let hideOnRdpShellSignal = null; // last state signalled to the shell
  let hideOnRdpSignalTimer = null;
  function sendHideOnRdpSignalSoon() {
    if (hideOnRdpSignalTimer) return; // already queued — it reads the latest state
    const fire = () => {
      hideOnRdpSignalTimer = setTimeout(() => {
        hideOnRdpSignalTimer = null;
        if (hideOnRdpShellSignal === hideOnRdpEnabled) return;
        hideOnRdpShellSignal = hideOnRdpEnabled;
        try {
          window.location.href = hideOnRdpEnabled ? 'xenon-home:rdp-on' : 'xenon-home:rdp-off';
        } catch (e) { /* not native */ }
      }, 1500);
    };
    if (document.readyState === 'complete') fire();
    else window.addEventListener('load', fire, { once: true });
  }

  function setHideOnRdp(on) {
    hideOnRdpEnabled = on === true;
    if (!isNative) return;
    // Only signal shells that declare the capability; an older shell reads any
    // other xenon-home path as "collapse to the desktop strip", so signalling it
    // would shrink the kiosk to a stuck strip. On such shells the toggle is a
    // harmless no-op (the feature simply isn't there yet).
    const caps = window.__XENON_NATIVE_CAPS__;
    if (!caps || caps.rdpToggle !== true) return;
    if (hideOnRdpShellSignal === hideOnRdpEnabled) return;
    sendHideOnRdpSignalSoon();
  }

  // ── Native shell: user-chosen interface scale (zoom) ─────────────────
  // Native-app-only. The kiosk can scale its whole dashboard independently of
  // the Windows display scale, set from the Settings slider or with
  // Ctrl + mouse-wheel / Ctrl +/- / Ctrl+0.
  //
  // WHY IN-PAGE CSS `zoom` (not WebView2's native browser zoom): the dashboard
  // fires custom-scheme signals on nearly every touch (`xenon-cursor:restore`
  // after each tap, focus/home gestures). WebView2 resets its zoom factor on
  // every navigation attempt — even the cancelled ones these signals use — so a
  // browser-zoom scale evaporated the instant the user touched the screen. A CSS
  // `zoom` on <html> is a style, immune to those navigations, and it lives
  // entirely in the dashboard, so it also works on already-installed shells
  // without a native rebuild. It mirrors the fractional-DPR compensation in
  // index.html (which is disabled in the native shell so the two never fight).
  const ZOOM_MIN = 0.6, ZOOM_MAX = 1.6, ZOOM_STEP = 0.1;
  let currentNativeZoom = 1; // last applied scale (also read by the wheel/keys)

  function clampZoom(value) {
    const n = Number(value);
    if (!isFinite(n)) return 1;
    return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)) * 100) / 100;
  }

  // `zoom` doesn't emit a `resize`, but the GridStack pages only refit their cell
  // heights on one (dashboard-grid.js → fitGridHeights) — without it the grid
  // keeps its pre-zoom pixel heights and spills under the ticker / off the right
  // edge. Debounced so a wheel drag refits once it settles.
  let relayoutTimer = null;
  function scheduleZoomRelayout() {
    if (relayoutTimer) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      relayoutTimer = null;
      try { window.dispatchEvent(new Event('resize')); } catch (e) { /* no-op */ }
    }, 160);
  }

  // Apply the scale via CSS `zoom` on <html> (magnifies everything ×z), with the
  // body counter-scaled to (100/z)vw × (100/z)vh so the page still fills EXACTLY
  // one screen instead of overflowing (in this WebView2 vw/vh are relative to the
  // unzoomed viewport). `__pageZoom` is the contract client-coordinate code reads
  // to divide out the magnification — draggables that clamp with
  // getBoundingClientRect (see clampDashboardDock) rely on it plus a safety reset.
  function applyNativeZoomCss(scale) {
    const z = clampZoom(scale);
    currentNativeZoom = z;
    const el = document.documentElement;
    const body = document.body;
    if (z === 1) {
      if (el) el.style.zoom = '';
      if (body) { body.style.width = ''; body.style.height = ''; body.style.minHeight = ''; }
    } else {
      if (el) el.style.zoom = String(z);
      if (body) { body.style.width = (100 / z) + 'vw'; body.style.height = (100 / z) + 'vh'; body.style.minHeight = '0'; }
    }
    window.__pageZoom = z;
    scheduleZoomRelayout();
  }

  // Called by settings.js (syncNativeZoomControl) with the persisted value.
  function setNativeZoom(scale) {
    if (!isNative) return;
    applyNativeZoomCss(scale);
  }

  // Nudge the scale and route it through settings.js so it persists and the
  // slider follows; that path calls setNativeZoom back, re-applying it.
  function bumpNativeZoom(next) {
    const z = clampZoom(next);
    if (z === currentNativeZoom) return;
    if (typeof window.updateNativeZoom === 'function') window.updateNativeZoom(z);
    else applyNativeZoomCss(z); // settings not ready yet — at least show it
  }

  function initNativeZoom() {
    if (!isNative) return;
    // Ctrl + wheel to zoom (WebView2's own zoom is left disabled, so this is the
    // only handler — no double zoom). preventDefault stops the page scrolling
    // while zooming; the pager ignores Ctrl+wheel so nothing else claims it.
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      bumpNativeZoom(currentNativeZoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }, { passive: false, capture: true });
    // Ctrl + / - / 0 keyboard zoom, mirroring a browser.
    window.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      let next = null;
      if (e.key === '+' || e.key === '=') next = currentNativeZoom + ZOOM_STEP;
      else if (e.key === '-' || e.key === '_') next = currentNativeZoom - ZOOM_STEP;
      else if (e.key === '0') next = 1;
      if (next == null) return;
      e.preventDefault();
      bumpNativeZoom(next);
    }, { capture: true });
  }

  // Apply the saved scale as early as possible (before settings.js runs) so the
  // page doesn't flash at 100% then jump. Reads the same localStorage store the
  // dashboard persists into; a missing/invalid value simply stays at 100%.
  if (isNative) {
    try {
      const raw = localStorage.getItem('xeneonedge.settings.v1');
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.nativeZoom != null) applyNativeZoomCss(saved.nativeZoom);
    } catch (e) { /* storage unavailable or corrupt — leave at 100% */ }
  }

  function initNativeHomeGesture() {
    if (!isNative) return;

    const HOME_CLASS = 'xenon-home-mode';
    // Windows reserves the outermost strip of the touchscreen for its own edge
    // swipe (taskbar reveal), and the `AllowEdgeSwipe` policy the shell writes
    // only takes hold at the next sign-in — so a touch swipe that starts at the
    // true edge may never reach us. The zone therefore extends well above the
    // reserved band: starting the swipe a finger-width from the bottom works
    // immediately, on every install.
    const EDGE_ZONE = 96;   // px from the bottom where an up-swipe means "go home"
    const TRIGGER = 56;     // px of upward travel needed to fire
    const MAX_MS = 600;     // must be a quick flick, not a slow drag

    // Native-only UI, so inject it here rather than shipping it in index.html.
    // In home mode the OS window itself IS a small round button (see the shell's
    // monitor.rs, which sizes it to a circle and clips it round) — so this
    // overlay just fills the whole window as one circular button face: every
    // pixel is tappable, showing only the Xenon logo mark. The accessible label
    // ("Tap to return to Xenon") stays on the element for screen readers.
    // The face adapts to the OS window the shell gives us: the current shell
    // shrinks to a small circle (round button, logo only), while an older shell
    // still uses a full-width strip — there the same element renders as a flat
    // bar with the label, instead of a grotesquely stretched "circle". A media
    // query on the viewport width is all it takes to tell them apart.
    const style = document.createElement('style');
    style.textContent = [
      '#xenon-home-bar{position:fixed;inset:0;z-index:2147483000;display:none;',
      'align-items:center;justify-content:center;gap:8px;box-sizing:border-box;',
      'touch-action:none;cursor:pointer;',
      '-webkit-user-select:none;user-select:none;color:#f3f5f7;',
      'font:600 12px/1 Inter,system-ui,-apple-system,sans-serif;',
      // Clean dark-slate face (not a muddy black orb) so the white/purple/blue
      // brand mark pops; a thin accent ring + top highlight read it as a button.
      'background:radial-gradient(125% 125% at 50% 30%,#1b2431,#0a0e13);',
      'box-shadow:inset 0 1px 0 rgba(255,255,255,0.10),',
      'inset 0 0 0 1.5px rgba(var(--accent-rgb,80,200,180),0.55);',
      'transition:transform .12s ease;}',
      '#xenon-home-bar:active{transform:scale(0.93);}',
      'body.' + HOME_CLASS + '{overflow:hidden;}',
      'body.' + HOME_CLASS + ' #xenon-home-bar{display:flex;}',
      // While collapsed to the round button, hide the dashboard entirely: the
      // OS window is a small circle but the bar fills it as a square with rounded
      // corners, so any fixed dashboard chrome (the floating "Layout" button, the
      // ticker…) would otherwise peek through the bar's transparent corners AND
      // stay clickable behind it. Hidden + non-interactive, nothing shows or can
      // be hit behind the button; the webview itself stays alive.
      'body.' + HOME_CLASS + ' .shell{visibility:hidden;pointer-events:none;}',
      '#xenon-home-bar .xhb-logo{flex:0 0 auto;object-fit:contain;pointer-events:none;',
      'filter:drop-shadow(0 2px 6px rgba(0,0,0,0.45));}',
      // Round-button window (current shell): circle, the logo fills most of it.
      '@media (max-width:200px){',
      '#xenon-home-bar{border-radius:50%;}',
      '#xenon-home-bar .xhb-logo{width:58%;height:58%;}',
      '#xenon-home-bar .xhb-label{display:none;}',
      '}',
      // Full-width strip window (older shell): flat bar, small logo + label.
      '@media (min-width:201px){',
      '#xenon-home-bar .xhb-logo{width:22px;height:22px;}',
      '}'
    ].join('');
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'xenon-home-bar';
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', tr('native_home_return', 'Tap to return to Xenon'));
    bar.setAttribute('title', tr('native_home_return', 'Tap to return to Xenon'));
    // The Xenon "X" brand mark (served PNG), so the round button is unmistakably
    // Xenon rather than a vague dark blob. It's injected at full-screen and cached
    // by the webview, so it's already painted by the time an up-swipe collapses
    // the window to the round handle.
    const barLogo = document.createElement('img');
    barLogo.className = 'xhb-logo';
    barLogo.src = SERVER + '/public/images/logo/logo-mark.png';
    barLogo.alt = '';
    barLogo.setAttribute('aria-hidden', 'true');
    bar.appendChild(barLogo);
    // Visible only on the old shell's full-width strip (hidden on the circle).
    const barLabel = document.createElement('span');
    barLabel.className = 'xhb-label';
    barLabel.textContent = tr('native_home_return', 'Tap to return to Xenon');
    bar.appendChild(barLabel);
    (document.body || document.documentElement).appendChild(bar);

    function inHome() { return document.body.classList.contains(HOME_CLASS); }
    function goHome() {
      if (inHome()) return;
      document.body.classList.add(HOME_CLASS); // show the strip handle before the shrink
      try { window.location.href = 'xenon-home:go'; } catch (e) { /* not native */ }
    }
    function goBack() {
      if (!inHome()) return;
      document.body.classList.remove(HOME_CLASS);
      // A finger tap fires pointerup → click. `goBack` runs on pointerup and hides
      // the bar (HOME_CLASS removed above), so the trailing click would land on
      // whatever dashboard control now sits under the finger — most damagingly the
      // floating "Layout" button, which dropped the dashboard into layout-edit mode
      // on every return. Swallow that one synthesized click (capture phase, brief
      // window) so returning from the desktop can never trigger anything behind.
      const swallowClick = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        document.removeEventListener('click', swallowClick, true);
      };
      document.addEventListener('click', swallowClick, true);
      setTimeout(() => document.removeEventListener('click', swallowClick, true), 500);
      try { window.location.href = 'xenon-home:return'; } catch (e) { /* not native */ }
    }

    // A drag that belongs to something else must never fire the gesture: a
    // scrollable list scrolling up, or a widget being moved in layout editing.
    function ownsVerticalDrag(target) {
      if (document.body.classList.contains('layout-editing')) return true;
      let el = (target && target.nodeType === 1) ? target : null;
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 1) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === 'auto' || oy === 'scroll') return true;
        }
        el = el.parentElement;
      }
      return false;
    }

    // Bottom-zone up-flick → home. Passive: we only act once travel clears the
    // threshold, so ordinary taps on bottom controls are never swallowed.
    //
    // Fingers are tracked with raw TOUCH events, not pointer events: as soon as
    // the browser claims a touch drag for panning (the pager's horizontal snap,
    // any scroll surface) it fires pointercancel and stops delivering
    // pointermove — which killed the gesture for touch while a mouse drag,
    // which never pans, sailed through. Passive touchmove keeps streaming even
    // while the browser pans, so the flick is detected reliably without taking
    // scrolling away from anything.
    let sx = 0, sy = 0, st = 0, tracking = false;
    function beginTrack(x, y, target) {
      if (!homeGestureEnabled || inHome()) return;
      if (y >= window.innerHeight - EDGE_ZONE && !ownsVerticalDrag(target)) {
        tracking = true; sx = x; sy = y; st = performance.now();
      }
    }
    function moveTrack(x, y) {
      if (!tracking) return;
      if (performance.now() - st > MAX_MS) { tracking = false; return; }
      if (sy - y >= TRIGGER && Math.abs(x - sx) < 90) {
        tracking = false;
        goHome();
      }
    }
    const stop = () => { tracking = false; };

    // Mouse / pen path (touch is handled below — ignore its pointer twins).
    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      beginTrack(e.clientX, e.clientY, e.target);
    }, { passive: true });
    document.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      moveTrack(e.clientX, e.clientY);
    }, { passive: true });
    document.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') stop(); }, { passive: true });
    document.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') stop(); }, { passive: true });

    // Finger path. Single-touch only, so pinches and rests never fire it.
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { stop(); return; }
      const t = e.touches[0];
      beginTrack(t.clientX, t.clientY, e.target);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      if (e.touches.length !== 1) { stop(); return; }
      const t = e.touches[0];
      moveTrack(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchend', stop, { passive: true });
    document.addEventListener('touchcancel', stop, { passive: true });

    // Return: ANY tap/click on the button restores the dashboard. `click` is
    // synthesized reliably from touch (the bar has touch-action:none, so the
    // browser never claims the gesture) — the old pointerup+"moved < 14px"
    // check made sloppy finger taps fail silently. Releasing the finger on the
    // button after a swipe-up still counts: pointerup is kept as a fallback so
    // even a drag that ends on the button goes home.
    bar.addEventListener('click', goBack);
    bar.addEventListener('pointerup', goBack);
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goBack(); }
    });

    // Self-heal: the HOME_CLASS lives in the page, but the strip shape lives in
    // the OS window — a page reload while collapsed (server restart, update)
    // loses the class and leaves a squeezed dashboard with no way back. If the
    // viewport is strip-sized without the class (or full-sized with it), adopt
    // the real window state. Debounced so the enter/exit transitions, which
    // flip class and window a beat apart, never fight it.
    const STRIP_MAX = 160; // CSS px — the round button is ~84px; fullscreen is ≥240
    let healTimer = null;
    function reconcileHomeMode() {
      if (healTimer) clearTimeout(healTimer);
      healTimer = setTimeout(() => {
        healTimer = null;
        const inStrip = window.innerHeight <= STRIP_MAX;
        if (inStrip && !inHome()) document.body.classList.add(HOME_CLASS);
        else if (!inStrip && inHome()) document.body.classList.remove(HOME_CLASS);
      }, 600);
    }
    window.addEventListener('resize', reconcileHomeMode);
    reconcileHomeMode();

    // One-time discoverability hint: the gesture is invisible, so tell the user
    // it exists the first time the native app runs. Delayed so it doesn't land
    // on top of the startup toasts, and skipped if the setting was turned off
    // in the meantime.
    try {
      if (!localStorage.getItem('xenonHomeHintShown')) {
        setTimeout(() => {
          if (!homeGestureEnabled || inHome()) return;
          if (!window.XenonToast || typeof window.XenonToast.show !== 'function') return;
          window.XenonToast.show({
            type: 'info',
            duration: 14000,
            title: tr('native_home_hint_title', 'Quick gesture'),
            message: tr('native_home_hint', 'Swipe up quickly from the lower part of the screen to reach the Windows desktop. Tap the bar at the top to come back. You can turn this off in Settings → General.'),
          });
          try { localStorage.setItem('xenonHomeHintShown', '1'); } catch (e) { /* storage full */ }
        }, 6000);
      }
    } catch (e) { /* localStorage unavailable */ }
  }

  // ── Native shell: keep the desktop mouse on its own screen ────────────
  // Windows promotes every touchscreen tap to mouse input and teleports the
  // system cursor to the touched point — mid-game that yanks the mouse onto
  // the Edge. Once the LAST touch pointer lifts (short debounce so multi-touch
  // and quick re-taps settle first), tell the shell the interaction ended; the
  // Rust side (cursor_guard.rs) puts the cursor back where it was, on the
  // monitor it came from. Real mouse clicks on the dashboard never signal —
  // only pointerType 'touch'/'pen' does — and the shell no-ops when the
  // feature is toggled off in the tray, so this stays a cancelled navigation
  // on the same custom-scheme channel the update/home flows use.
  function initNativeCursorGuard() {
    if (!isNative) return;

    const SETTLE_MS = 120;
    let activeTouches = 0;
    let settleTimer = null;

    function isTouchLike(e) {
      return e.pointerType === 'touch' || e.pointerType === 'pen';
    }

    document.addEventListener('pointerdown', (e) => {
      if (!isTouchLike(e)) return;
      activeTouches += 1;
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    }, { capture: true, passive: true });

    const onTouchEnd = (e) => {
      if (!isTouchLike(e)) return;
      activeTouches = Math.max(0, activeTouches - 1);
      if (activeTouches > 0) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (activeTouches !== 0) return;
        try { window.location.href = 'xenon-cursor:restore'; } catch (err) { /* not native */ }
      }, SETTLE_MS);
    };
    document.addEventListener('pointerup', onTouchEnd, { capture: true, passive: true });
    document.addEventListener('pointercancel', onTouchEnd, { capture: true, passive: true });
  }

  // ── Native shell: don't steal the game's focus ────────────────────────
  // Tapping the kiosk normally activates its window, so a foreground game
  // loses focus (exclusive-fullscreen titles minimize outright). While the
  // dashboard is in game mode (settings.js toggles `body.game-mode` off the
  // same detector that pauses ambient FX), tell the shell to arm its focus
  // guard (WS_EX_NOACTIVATE + give-back, see focus_guard.rs). Typing is the
  // deliberate exception: focusing a text field (AI chat, notes, search)
  // signals type-start so the shell lifts the guard and takes real focus —
  // the keyboard works exactly as before — and leaving the field signals
  // type-end so the game gets its focus back.
  function initNativeFocusGuard() {
    if (!isNative) return;

    const TYPE_END_MS = 250; // grace so hopping between fields isn't an off/on
    let guardOn = null;      // null → first sync always reports current state
    let typing = false;
    let typeEndTimer = null;

    function send(signal) {
      try { window.location.href = 'xenon-focus:' + signal; } catch (e) { /* not native */ }
    }

    function isEditable(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag !== 'INPUT') return false;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].includes(type);
    }

    // Always report the initial state (the shell may still be armed from
    // before a dashboard reload) and every change after.
    function syncGameMode() {
      const on = document.body.classList.contains('game-mode');
      if (on === guardOn) return;
      guardOn = on;
      if (!on) {
        typing = false;
        if (typeEndTimer) { clearTimeout(typeEndTimer); typeEndTimer = null; }
      }
      send(on ? 'guard-on' : 'guard-off');
    }
    new MutationObserver(syncGameMode)
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    syncGameMode();

    document.addEventListener('focusin', (e) => {
      if (!guardOn || !isEditable(e.target)) return;
      if (typeEndTimer) { clearTimeout(typeEndTimer); typeEndTimer = null; }
      if (!typing) { typing = true; send('type-start'); }
    });
    document.addEventListener('focusout', (e) => {
      if (!typing || !isEditable(e.target)) return;
      if (typeEndTimer) clearTimeout(typeEndTimer);
      typeEndTimer = setTimeout(() => {
        typeEndTimer = null;
        if (isEditable(document.activeElement)) return; // moved to another field
        typing = false;
        send('type-end');
      }, TYPE_END_MS);
    });

    // Clicking straight back into the game leaves the DOM focus on the field
    // (no focusout), but the kiosk window blurs — end the typing exception so
    // the guard re-arms. A focus that returns within the grace window (focus
    // can bounce between WebView2 hosts) cancels it, so real typing is safe.
    window.addEventListener('blur', () => {
      if (!typing) return;
      if (typeEndTimer) clearTimeout(typeEndTimer);
      typeEndTimer = setTimeout(() => {
        typeEndTimer = null;
        typing = false;
        send('type-end');
      }, TYPE_END_MS);
    });
    window.addEventListener('focus', () => {
      if (typing && typeEndTimer) { clearTimeout(typeEndTimer); typeEndTimer = null; }
    });
  }

  window.XenonNative = {
    isNative: isNative,
    showUpdatePrompt: showUpdatePrompt,
    initNativePromo: initNativePromo,
    initNativeHomeGesture: initNativeHomeGesture,
    setHomeGestureEnabled: setHomeGestureEnabled,
    setHideOnRdp: setHideOnRdp,
    setNativeZoom: setNativeZoom,
  };

  function init() {
    initNativePromo();
    initNativeHomeGesture();
    initNativeCursorGuard();
    initNativeFocusGuard();
    initNativeZoom();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

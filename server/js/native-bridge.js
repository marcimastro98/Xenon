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
    if (!status || status.installed || status.mode === 'native') return; // nothing to offer
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
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      if (statusEl) statusEl.textContent = tr('native_promo_installing', 'Downloading the installer…');
      try {
        const res = await fetch(SERVER + '/api/native/install', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok) {
          if (statusEl) statusEl.textContent = tr('native_promo_launched', 'Installer launched — follow the prompts, then the app opens on the Edge.');
        } else {
          btn.disabled = false;
          const reason = (data && data.error) ? (': ' + data.error) : '';
          if (statusEl) statusEl.textContent = tr('native_promo_failed', 'Could not start the install') + reason;
        }
      } catch (e) {
        btn.disabled = false;
        if (statusEl) statusEl.textContent = tr('native_promo_failed', 'Could not start the install');
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
      'align-items:center;justify-content:center;gap:9px;box-sizing:border-box;',
      'touch-action:none;cursor:pointer;',
      '-webkit-user-select:none;user-select:none;color:#fff;',
      'font:600 12px/1 Inter,system-ui,-apple-system,sans-serif;',
      'background:radial-gradient(120% 120% at 50% 22%,rgba(30,38,35,0.99),rgba(8,12,11,0.99));',
      'box-shadow:0 6px 20px rgba(0,0,0,0.55),',
      'inset 0 0 0 2px rgba(var(--accent-rgb,80,200,180),0.65);}',
      '#xenon-home-bar:active{',
      'background:radial-gradient(120% 120% at 50% 22%,rgba(42,52,48,0.99),rgba(14,20,18,0.99));}',
      'body.' + HOME_CLASS + '{overflow:hidden;}',
      'body.' + HOME_CLASS + ' #xenon-home-bar{display:flex;}',
      '#xenon-home-bar svg{width:34px;height:34px;flex:0 0 auto;max-height:80%;',
      'color:rgb(var(--accent-rgb,80,200,180));}',
      // Round-button window (current shell): circle, logo only.
      '@media (max-width:200px){',
      '#xenon-home-bar{border-radius:50%;}',
      '#xenon-home-bar:active{transform:scale(0.94);}',
      '#xenon-home-bar .xhb-label{display:none;}',
      '}',
      // Full-width strip window (older shell): flat bar, logo + label.
      '@media (min-width:201px){',
      '#xenon-home-bar svg{width:18px;height:18px;}',
      '}'
    ].join('');
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'xenon-home-bar';
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', tr('native_home_return', 'Tap to return to Xenon'));
    bar.setAttribute('title', tr('native_home_return', 'Tap to return to Xenon'));
    // Static, trusted SVG — the Xenon 4-point star logo mark, so the round button
    // is unmistakably "Xenon" rather than a generic chevron.
    bar.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C12.7 6.1 17.9 11.3 24 12C17.9 12.7 12.7 17.9 12 24C11.3 17.9 6.1 12.7 0 12C6.1 11.3 11.3 6.1 12 0Z"/></svg>';
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
  };

  function init() {
    initNativePromo();
    initNativeHomeGesture();
    initNativeCursorGuard();
    initNativeFocusGuard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

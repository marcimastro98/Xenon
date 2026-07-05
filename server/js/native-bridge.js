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
  // Only in the native app. Swiping up from the very bottom edge collapses the
  // kiosk to a slim home-bar strip (the Rust shell reshapes the OS window; see
  // monitor.rs); tapping or swiping up on that strip restores the dashboard.
  // The webview stays alive inside the strip, so the strip's own handle is what
  // catches the return gesture — a hidden webview couldn't. Both directions go
  // through the same custom-scheme channel the update flow uses.
  function initNativeHomeGesture() {
    if (!isNative) return;

    const HOME_CLASS = 'xenon-home-mode';
    const EDGE_ZONE = 24;   // px from the bottom where an up-swipe means "go home"
    const TRIGGER = 44;     // px of upward travel needed to fire

    // Native-only UI, so inject it here rather than shipping it in index.html.
    const style = document.createElement('style');
    style.textContent = [
      '#xenon-home-bar{position:fixed;inset:0;z-index:2147483000;display:none;',
      'align-items:center;justify-content:center;touch-action:none;cursor:pointer;',
      '-webkit-user-select:none;user-select:none;',
      'background:linear-gradient(0deg,rgba(9,13,12,0.97),rgba(9,13,12,0.86));}',
      'body.' + HOME_CLASS + '{overflow:hidden;}',
      'body.' + HOME_CLASS + ' #xenon-home-bar{display:flex;}',
      '#xenon-home-bar .xhb-grip{position:absolute;top:5px;left:50%;',
      'transform:translateX(-50%);width:120px;height:4px;border-radius:999px;',
      'background:rgba(255,255,255,0.55);}',
      '#xenon-home-bar .xhb-pill{display:inline-flex;align-items:center;gap:8px;',
      'padding:5px 16px;border-radius:999px;',
      'font:600 12px/1 Inter,system-ui,-apple-system,sans-serif;color:#fff;',
      'background:rgba(var(--accent-rgb,80,200,180),0.24);',
      'border:1px solid rgba(var(--accent-rgb,80,200,180),0.5);}',
      '#xenon-home-bar .xhb-pill svg{width:14px;height:14px;flex:0 0 auto;}'
    ].join('');
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'xenon-home-bar';
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    const grip = document.createElement('div');
    grip.className = 'xhb-grip';
    const pill = document.createElement('div');
    pill.className = 'xhb-pill';
    // Static, trusted SVG chevron; the label is user-facing text via textContent.
    pill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>';
    const label = document.createElement('span');
    label.textContent = tr('native_home_return', 'Tap to return to Xenon');
    pill.appendChild(label);
    bar.appendChild(grip);
    bar.appendChild(pill);
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

    // Bottom-edge up-swipe → home. Passive: we only act once travel clears the
    // threshold, so ordinary taps on bottom controls are never swallowed.
    let sx = 0, sy = 0, tracking = false;
    document.addEventListener('pointerdown', (e) => {
      if (inHome()) return;
      if (e.clientY >= window.innerHeight - EDGE_ZONE) {
        tracking = true; sx = e.clientX; sy = e.clientY;
      }
    }, { passive: true });
    document.addEventListener('pointermove', (e) => {
      if (!tracking) return;
      if (sy - e.clientY >= TRIGGER && Math.abs(e.clientX - sx) < 90) {
        tracking = false;
        goHome();
      }
    }, { passive: true });
    const stop = () => { tracking = false; };
    document.addEventListener('pointerup', stop, { passive: true });
    document.addEventListener('pointercancel', stop, { passive: true });

    // Return: a tap or an up-swipe anywhere on the strip.
    let bx = 0, by = 0, bdown = false;
    bar.addEventListener('pointerdown', (e) => { bdown = true; bx = e.clientX; by = e.clientY; });
    bar.addEventListener('pointerup', (e) => {
      if (!bdown) return;
      bdown = false;
      const moved = Math.hypot(e.clientX - bx, e.clientY - by);
      if (by - e.clientY >= 20 || moved < 14) goBack(); // swipe up, or a tap
    });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goBack(); }
    });
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

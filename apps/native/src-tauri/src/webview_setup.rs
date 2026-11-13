// What every page in the app's windows starts with: the browser arguments and the script that sends outside links to the browser.

/// WebView2 browser arguments shared by EVERY webview in this process.
///
/// WebView2 requires all webviews on the same user-data folder to be created
/// with IDENTICAL environment options: a second webview created with different
/// `additional_browser_args` fails its (asynchronous) creation SILENTLY — the
/// OS window appears, the web content never does. That was exactly the blank
/// Spotlight bar. Any new `WebviewWindowBuilder` in this app MUST pass
/// `.additional_browser_args(&browser_args(...))` with the same flag set.
///
/// The switches: wry's default `--disable-features` set (replaced wholesale by
/// this override, so it is re-included), the three anti-throttling switches
/// that keep the unfocused kiosk renderer alive, and the hybrid-GPU pin, which
/// MUST come from `gpu::applied()` — the flag this process launched with — and
/// never from a fresh decision. Re-deciding is how the blank Spotlight bar came
/// back: the answer changes the moment a display is plugged in or out.
#[cfg(windows)]
pub(crate) fn browser_args(gpu_flag: Option<&str>) -> String {
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows",
    );
    if let Some(flag) = gpu_flag {
        args.push(' ');
        args.push_str(flag);
    }
    args
}

/// Injected into every page the kiosk webview loads (the splash and, after it
/// hands over, the loopback dashboard). In a Tauri webview a `target="_blank"`
/// link — and `window.open()` — spawns a new *webview* window instead of the OS
/// browser, and both bypass the Rust `on_navigation` hook below. This funnels
/// those external opens into a top-level navigation so the hook can catch the
/// URL and redirect it to the default browser, keeping the kiosk on the
/// dashboard. Internal/loopback and relative links are left untouched.
pub(crate) const EXTERNAL_LINK_SHIM: &str = r#"
(function () {
  // Let the shared dashboard know it is running inside the native shell (used to
  // offer app updates here, and to hide the "install the native app" promo that
  // the browser/iCUE surfaces show).
  try { window.__XENON_NATIVE__ = true; } catch (e) {}
  // What this shell build understands, so the dashboard never sends a signal an
  // older shell would misread (an unknown xenon-home path used to mean "go home",
  // which collapsed the kiosk to the desktop strip on load). Runtime-only caps
  // (shellVersion, updateEvents, lowPowerGpu) are merged in by the second init
  // script built in setup() — keep this literal so old-shell semantics stay
  // greppable.
  try { window.__XENON_NATIVE_CAPS__ = { homeGestureToggle: true, rdpToggle: true }; } catch (e) {}
  function isExternal(u) {
    try {
      var url = new URL(u, location.href);
      if (url.protocol === 'mailto:' || url.protocol === 'tel:') return true;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      var h = url.hostname;
      // tauri.localhost is the app's own origin on Windows (bundled assets).
      return h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]' && h !== 'tauri.localhost';
    } catch (e) { return false; }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var t = (a.target || '').toLowerCase();
    if ((t === '_blank' || t === '_new') && isExternal(a.href)) {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = a.href;
    }
  }, true);
  var nativeOpen = window.open;
  window.open = function (u) {
    if (isExternal(u)) { window.location.href = u; return null; }
    return nativeOpen.apply(window, arguments);
  };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F11') {
      e.preventDefault();
      // Signals carry the launch nonce (nav_policy.rs); __xenonSignal is
      // defined by a later initialization script, before any key can be pressed.
      var sig = 'xenon-fullscreen:toggle';
      window.location.href = typeof window.__xenonSignal === 'function' ? window.__xenonSignal(sig) : sig;
    }
  });
})();
"#;

// The page a layer window loads: its address and the scripts it starts with.

use super::spec;

/// Links and `window.open` to external sites become top-level navigations, so
/// the hook below hands them to the OS browser instead of opening a webview
/// window. `__XENON_LAYER_SHELL__` tells layer-host.js to report its tiles.
pub(super) const LAYER_SHIM: &str = r#"(function () {
  try { window.__XENON_LAYER_SHELL__ = true; } catch (e) {}
  function external(u) {
    try {
      var url = new URL(u, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return url.hostname !== '127.0.0.1' && url.hostname !== 'localhost';
    } catch (e) { return false; }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && external(a.href)) { e.preventDefault(); window.location.href = a.href; }
  }, true);
  var open = window.open;
  window.open = function (u) {
    if (external(u)) { window.location.href = u; return null; }
    return open.apply(window, arguments);
  };
})();"#;

/// The alerts window only: it may light the edges for Bit (glow_from_alerts),
/// so js/ai-edge-glow.js may send there. No other native capability: the
/// window takes no other signal.
pub(super) const ALERTS_CAPS: &str = "try { window.__XENON_NATIVE_CAPS__ = Object.assign(window.__XENON_NATIVE_CAPS__ || {}, { aiGlow: true }); } catch (e) {}";

/// Windows cuts what the alerts window shows, so a card closes under the cut
/// (roll.rs, js/alert-roll.js). Elsewhere the window has real alpha and cards fade.
#[cfg(windows)]
pub(super) const ALERTS_ROLL: &str = "window.__XENON_ROLL_CARDS__ = true;";

pub(super) fn port() -> u16 {
    std::env::var("XENON_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3030)
}

/// A widget layer loads the dashboard in `?layer=<key>` mode; the alerts window
/// loads its own page, which is not a layer page: it shows the pop-ups the
/// layer pages keep quiet (utils.js isLayerPage).
pub(super) fn layer_url(key: &str) -> Option<tauri::Url> {
    let base = format!("http://127.0.0.1:{}/", port());
    if spec::is_alerts(key) {
        return tauri::Url::parse(&(base + "screen-alerts")).ok();
    }
    if spec::is_draw(key) {
        return tauri::Url::parse(&(base + "draw")).ok();
    }
    if spec::is_menu(key) {
        return tauri::Url::parse(&(base + "menu")).ok();
    }
    if spec::is_scene(key) {
        let mut url = tauri::Url::parse(&(base + "scene")).ok()?;
        url.query_pairs_mut().append_pair("key", key);
        return Some(url);
    }
    let mut url = tauri::Url::parse(&base).ok()?;
    url.query_pairs_mut().append_pair("layer", key);
    Some(url)
}

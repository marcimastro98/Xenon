// Which page a layer window shows: alerts, scene, drawing sheet, menu, and what the menu may open.

use super::Spec;

/// The on-screen alerts window (server/js/screen-alerts.js), not a widget layer.
pub fn is_alerts(key: &str) -> bool {
    key.starts_with("alerts:")
}

/// The Ambient scene's windows, which load /scene instead of a layer page.
pub fn is_scene(key: &str) -> bool {
    key.starts_with("wallpaper:") || key.starts_with("saver:")
}

/// The drawing sheet's window, which loads /draw.
pub fn is_draw(key: &str) -> bool {
    key.starts_with("draw:")
}

/// The Xenon menu's window, which loads /menu.
pub fn is_menu(key: &str) -> bool {
    key.starts_with("menu:")
}

/// Whether a window stays out of screenshots and recordings. The alerts window
/// always: Bit looking at the screen must see the game, not its own card. The
/// menu only while Xenon records: otherwise it is the user's to photograph. A
/// drawing is meant to be seen, in a recording too. The setting is for the widgets:
/// a scene left out would turn the whole desktop black in a screenshot.
pub fn out_of_captures(key: &str, spec: &Spec) -> bool {
    if is_menu(key) {
        return spec.capturing;
    }
    is_alerts(key) || (spec.exclude && !is_draw(key) && !is_scene(key))
}

/// Settings categories the Xenon menu opens (server/xenon-menu.js), the same
/// list as SETTINGS_CATS in server/js/dashboard-open.js.
const SETTINGS_CATS: [&str; 11] = [
    "ambient", "appearance", "capture", "general", "notifications", "ai", "smarthome", "spotify", "streaming", "unifi",
    "slideshow",
];

/// A dashboard screen a window may ask for, `(open, cat)`: the alerts window's
/// update card (`xenon-app:open-dashboard?open=update`), the plain dashboard
/// (that window's card when Bit needs it, and the Xenon menu), the Sparks and the
/// supporter pass (a sheet of What's New there), the menu's gallery, Store or
/// Settings category (`menu`). Anything else asks nothing; an unknown category
/// opens Settings as it was.
pub fn dashboard_page(path: &str, open: Option<&str>, cat: Option<&str>, menu: bool) -> Option<(&'static str, Option<&'static str>)> {
    if path != "open-dashboard" {
        return None;
    }
    match open {
        Some("update") => Some(("update", None)),
        Some("gallery") if menu => Some(("gallery", None)),
        Some("dashboard") => Some(("dashboard", None)),
        Some("store") if menu => Some(("store", None)),
        Some("sparks") => Some(("sparks", None)),
        Some("supporters") => Some(("supporters", None)),
        Some("settings") if menu => Some(("settings", SETTINGS_CATS.iter().find(|c| Some(**c) == cat).copied())),
        _ => None,
    }
}

/// What Settings reads about the shell to show the right rows when it opens in
/// the Xenon menu's window (js/sheet-page.js). Facts only: the switches of the
/// main window (see-through, display, zoom) stay out, because this window takes
/// none of their signals.
const MENU_CAPS: [&str; 12] = [
    "shellVersion",
    "shellSelfUpdate",
    "layers",
    "layersWhy",
    "aiGlow",
    "scene",
    "wallpaperBehindIcons",
    "draw",
    "menu",
    "anchor",
    "desks",
    "pad",
];

/// The script that gives the menu's window those facts, out of the main window's.
pub fn menu_caps_script(caps: &serde_json::Value) -> String {
    let picked: serde_json::Map<String, serde_json::Value> = MENU_CAPS
        .iter()
        .filter_map(|k| caps.get(*k).map(|v| ((*k).to_string(), v.clone())))
        .collect();
    format!(
        "try{{window.__XENON_NATIVE__=true;window.__XENON_NATIVE_CAPS__=Object.assign(window.__XENON_NATIVE_CAPS__||{{}},{});}}catch(e){{}}",
        serde_json::Value::Object(picked)
    )
}

/// A tile's Set up button on a widget on the screen (utils.js
/// openSettingsCategory): Settings on a known category of the dashboard, and
/// nothing else, so a layer page cannot ask for the update or gallery screens.
pub fn tile_settings(path: &str, open: Option<&str>, cat: Option<&str>) -> Option<(&'static str, Option<&'static str>)> {
    if path != "open-dashboard" || open != Some("settings") {
        return None;
    }
    Some(("settings", SETTINGS_CATS.iter().find(|c| Some(**c) == cat).copied()))
}

/// An executable name (Windows) or app name, never a path: the same rule as
/// APP_RE in layers-model.js.
pub(super) fn valid_app(app: &str) -> bool {
    !app.is_empty()
        && app.chars().count() <= 128
        && !app.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
}

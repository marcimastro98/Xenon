// Shows the window for the first time and loads the dashboard into it.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};
use crate::prefs::Placement;
use super::{DRIVER, HOME_MODE, place_windowed_on, primary_or_first, SHOW_OVERRIDE, show_window, VISIT, window_is_on};
use super::ids::fingerprint;
use super::screens::{monitors_of, placement_cache};
use super::target::{apply_target, NoScreen, resolve, Target};

/// One crash-log line per launch: how it started, what was asked, which screens
/// were there and where the window went. A report of "it opened on the wrong
/// screen after a restart" then carries the answer instead of a guess.
pub fn note_startup(window: &WebviewWindow, autostarted: bool) {
    let cache = placement_cache();
    let asked = match cache.mode {
        Placement::Auto => "automatic".to_string(),
        Placement::Phone => "phone".to_string(),
        Placement::Screen => format!(
            "screen {} ({})",
            cache.monitor.as_deref().unwrap_or("-"),
            cache.fingerprint.as_deref().unwrap_or("-")
        ),
    };
    let placed = match resolve(window, &cache) {
        Target::Kiosk(m) => format!("kiosk on {}", fingerprint(&m)),
        Target::Windowed(m, fs) => format!(
            "{} on {}",
            if fs { "full screen" } else { "window" },
            fingerprint(&m)
        ),
        Target::Nothing(NoScreen::Phone) => "nothing (phone)".to_string(),
        Target::Nothing(NoScreen::ChosenMissing) => "hidden until its screen is connected".to_string(),
    };
    crate::crash_log::note(
        "display",
        &format!(
            "started {}; show on: {asked}; screens: {}; placed: {placed}",
            if autostarted { "at login" } else { "by hand" },
            screens_text(window)
        ),
    );
}

/// The connected screens as the crash log lists them: name, size, scale, origin.
pub(super) fn screens_text(window: &WebviewWindow) -> String {
    let screens = monitors_of(window)
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position();
            format!("{} {} at {},{}", m.name().map(String::as_str).unwrap_or("?"), fingerprint(m), p.x, p.y)
        })
        .collect::<Vec<_>>();
    if screens.is_empty() { "none readable".to_string() } else { screens.join(", ") }
}

/// Xenon opened again while it is already running.
///
/// It used to only un-hide the window, wherever it was, which could leave the
/// dashboard as a small window on the main screen. When the window is already
/// visible where it belongs this only brings it forward (re-placing the kiosk
/// would make it flash); otherwise it does what the tray's "Show Xenon" does.
pub fn reveal(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    // The round home button is a place the user chose; just bring it forward.
    let settled = HOME_MODE.load(Ordering::SeqCst)
        || (window.is_visible().unwrap_or(false)
            && match resolve(&window, &placement_cache()) {
                Target::Kiosk(m) | Target::Windowed(m, _) => window_is_on(&window, &m),
                Target::Nothing(_) => false,
            });
    if settled {
        show_window(&window);
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else {
        show_now(app);
    }
}

/// Tray "Show Xenon": reveal the window now even when a rule wants it hidden
/// (phone mode, or the chosen screen unplugged). Writes nothing — the user asked
/// to see it, not to move house — so the next topology change re-evaluates.
pub fn show_now(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    crate::layers::keep_focus_here(app);
    // "Widgets only": the window holds the driver, an empty page, and this person
    // chose not to have the dashboard, so Xenon opens as its menu. A shell that
    // cannot draw the menu has only the dashboard to show: `full=1` skips the
    // server's redirect, and its page load starts the visit and places the window.
    if DRIVER.load(Ordering::SeqCst) {
        if crate::layers::draws_menu() {
            let _ = window.eval(crate::tray::OPEN_MENU_JS);
        } else {
            load_dashboard(&window, "");
        }
        return;
    }
    // Already open: leave it where the user put it.
    if VISIT.load(Ordering::SeqCst) {
        show_window(&window);
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    SHOW_OVERRIDE.store(true, Ordering::SeqCst);
    let cache = placement_cache();
    match resolve(&window, &cache) {
        Target::Nothing(_) => {
            // Nowhere legitimate to put it: land on the primary, this session only.
            show_window(&window);
            if let Some(m) = primary_or_first(&window) {
                place_windowed_on(&window, &m, true);
            }
        }
        target => apply_target(&window, target, true),
    }
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Show the dashboard on one of its screens (layers::spec::dashboard_page:
/// only allowlisted words reach here). In "widgets only" the driver page
/// becomes the dashboard with `open=<page>`, which it reads once at boot;
/// otherwise the dashboard is already loaded and is asked directly.
pub fn open_dashboard(app: &AppHandle, page: &'static str, cat: Option<&'static str>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let cat_query = cat.map(|c| format!("&cat={c}")).unwrap_or_default();
    if DRIVER.load(Ordering::SeqCst) {
        crate::layers::keep_focus_here(app);
        load_dashboard(&window, &format!("&open={page}{cat_query}"));
        return;
    }
    show_now(app);
    let cat_arg = cat.map(|c| format!(", cat: '{c}'")).unwrap_or_default();
    let _ = window.eval(&format!("window.DashboardOpen && window.DashboardOpen.run({{ open: '{page}'{cat_arg} }})"));
}

/// The driver page leaves for the dashboard; its page load ends the driver.
fn load_dashboard(window: &WebviewWindow, extra: &str) {
    load_local(window, &format!("/?shell=main&full=1{extra}"));
}

pub fn backend_port() -> u16 {
    std::env::var("XENON_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3030)
}

pub(super) fn load_local(window: &WebviewWindow, path: &str) {
    let port = backend_port();
    if let Ok(url) = tauri::Url::parse(&format!("http://127.0.0.1:{port}{path}")) {
        let _ = window.navigate(url);
    }
}

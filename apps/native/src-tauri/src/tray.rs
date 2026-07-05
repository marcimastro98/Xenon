//! System-tray icon for the Xenon kiosk: show / hide the window, restart, exit —
//! plus, when there is no Xeneon Edge attached, controls to run the window
//! full-screen and to pick which monitor it lives on (remembered across launches).
//!
//! The dashboard keeps running in the backend service regardless of this window,
//! so "Hide" just parks the kiosk and "Exit" only closes the native shell — the
//! browser and iCUE iframe surfaces stay available.

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    App, Manager,
};

use crate::{monitor, prefs};

pub fn build(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Xenon", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;

    // Display controls only make sense off the Edge — on the Edge the kiosk owns
    // the panel, so they are shown disabled there (and guarded again at runtime).
    let window = app.get_webview_window("main");
    let on_edge = window.as_ref().map(monitor::edge_present).unwrap_or(false);
    let labels = window
        .as_ref()
        .map(monitor::monitor_labels)
        .unwrap_or_default();
    let saved = prefs::load(app.handle());

    let fullscreen = CheckMenuItem::with_id(
        app,
        "fullscreen",
        "Fullscreen",
        !on_edge,
        saved.fullscreen && !on_edge,
        None::<&str>,
    )?;

    // "Show on ▸ <display>" — only when more than one monitor is connected.
    let displays = Submenu::new(app, "Show on", !on_edge)?;
    for (i, label) in labels.iter().enumerate() {
        let item = MenuItem::with_id(app, format!("mon-{i}"), label, true, None::<&str>)?;
        displays.append(&item)?;
    }

    // Windows moves the mouse to every touch; this puts it back on the monitor
    // it was on once the touch ends (see cursor_guard.rs). Windows-only.
    #[cfg(windows)]
    let cursor_guard = CheckMenuItem::with_id(
        app,
        "cursor-guard",
        "Keep mouse on its screen",
        true,
        saved.cursor_guard,
        None::<&str>,
    )?;

    // While a game runs, touches on the kiosk no longer steal the game's focus
    // (see focus_guard.rs). Windows-only.
    #[cfg(windows)]
    let focus_guard = CheckMenuItem::with_id(
        app,
        "focus-guard",
        "Keep games focused",
        true,
        saved.focus_guard,
        None::<&str>,
    )?;

    let menu = Menu::new(app)?;
    menu.append(&show)?;
    menu.append(&hide)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&fullscreen)?;
    if labels.len() > 1 {
        menu.append(&displays)?;
    }
    #[cfg(windows)]
    menu.append(&cursor_guard)?;
    #[cfg(windows)]
    menu.append(&focus_guard)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&restart)?;
    menu.append(&quit)?;

    // The check items are toggled from inside the event handler, so they need their
    // own clones (menu-item handles are cheap, reference-counted clones).
    let fullscreen_toggle = fullscreen.clone();
    #[cfg(windows)]
    let cursor_guard_toggle = cursor_guard.clone();
    #[cfg(windows)]
    let focus_guard_toggle = focus_guard.clone();

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Xenon")
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
                "hide" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                "fullscreen" => {
                    let next = !fullscreen_toggle.is_checked().unwrap_or(false);
                    monitor::set_fullscreen_pref(app, next);
                    let _ = fullscreen_toggle.set_checked(next);
                }
                #[cfg(windows)]
                "cursor-guard" => {
                    let next = !cursor_guard_toggle.is_checked().unwrap_or(true);
                    crate::cursor_guard::set_enabled(app, next);
                    let _ = cursor_guard_toggle.set_checked(next);
                }
                #[cfg(windows)]
                "focus-guard" => {
                    let next = !focus_guard_toggle.is_checked().unwrap_or(true);
                    crate::focus_guard::set_enabled(app, next);
                    let _ = focus_guard_toggle.set_checked(next);
                }
                "restart" => app.restart(),
                "quit" => app.exit(0),
                other => {
                    if let Some(idx) = other.strip_prefix("mon-").and_then(|n| n.parse().ok()) {
                        monitor::move_to_monitor(app, idx);
                    }
                }
            }
        });

    // Reuse the app icon for the tray so we don't ship a second asset.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

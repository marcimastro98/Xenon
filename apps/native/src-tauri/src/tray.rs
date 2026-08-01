//! System-tray icon for the Xenon kiosk: show / hide the window, restart, exit —
//! plus the screen controls (full-screen, which monitor, or "on my phone"),
//! remembered across launches.
//!
//! The dashboard keeps running in the backend service regardless of this window,
//! so "Hide" just parks the kiosk and "Exit" only closes the native shell — the
//! browser, phone and iCUE iframe surfaces stay available.

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    App, Manager,
};

use crate::prefs::Placement;
use crate::{monitor, prefs};

pub fn build(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Xenon", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;

    let window = app.get_webview_window("main");
    let saved = prefs::load(app.handle());
    let displays_now = window.as_ref().map(monitor::displays).unwrap_or_default();

    // Full-screen is meaningless in exactly two states: on the Edge panel, which
    // is always borderless-fullscreen, and in phone mode, where there is no
    // window. It is NOT disabled merely because an Edge is attached — that was
    // the old rule, and it greyed the control out for anyone who had an Edge but
    // had chosen to put Xenon on another screen.
    let on_edge_panel = match saved.placement {
        Placement::Auto => window.as_ref().map(monitor::edge_present).unwrap_or(false),
        Placement::Screen => displays_now
            .iter()
            .any(|d| d.edge && d.id.is_some() && d.id == saved.monitor),
        Placement::Phone => false,
    };
    let phone = saved.placement == Placement::Phone;
    let placement_controls = !on_edge_panel && !phone;

    let fullscreen = CheckMenuItem::with_id(
        app,
        "fullscreen",
        "Fullscreen",
        placement_controls,
        saved.fullscreen && placement_controls,
        None::<&str>,
    )?;

    // "Show on ▸ <display>" — only when more than one monitor is connected.
    //
    // The item id carries the monitor's OS NAME, not its index. This menu is
    // built once at startup and never rebuilt, and on Windows the index is the
    // unstable half (`\\.\DISPLAYn` is assigned by order), so an id keyed on the
    // index would quietly point at a different physical screen after a replug.
    // A stale name simply no longer resolves, and the pick is refused.
    let displays = Submenu::new(app, "Show on", !phone)?;
    for d in &displays_now {
        let Some(id) = d.id.as_deref() else { continue };
        let item = MenuItem::with_id(app, format!("mon:{id}"), d.tray_label(), true, None::<&str>)?;
        displays.append(&item)?;
    }

    // The two screen choices that name no monitor.
    let auto = MenuItem::with_id(app, "place-auto", "Automatic", true, None::<&str>)?;
    let on_phone = MenuItem::with_id(app, "place-phone", "On my phone / tablet", true, None::<&str>)?;

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

    // Render the dashboard on the GPU that drives its screen (see gpu.rs). Offered
    // ONLY on a machine that actually has an integrated and a discrete adapter,
    // because anywhere else it is inert and a control that does nothing is worse
    // than no control. The check is on the HARDWARE, never on what we pinned, so
    // switching it off cannot make the switch vanish. The label says "next launch"
    // because it is a WebView2 environment option and genuinely cannot apply sooner.
    #[cfg(windows)]
    let hybrid_gpu = crate::gpu::is_hybrid();
    #[cfg(windows)]
    let gpu_pin = CheckMenuItem::with_id(
        app,
        "gpu-pin",
        "Match render GPU to screen (next launch)",
        true,
        saved.gpu_pin,
        None::<&str>,
    )?;

    let menu = Menu::new(app)?;
    menu.append(&show)?;
    menu.append(&hide)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&fullscreen)?;
    if displays_now.len() > 1 {
        menu.append(&displays)?;
    }
    menu.append(&auto)?;
    menu.append(&on_phone)?;
    #[cfg(windows)]
    menu.append(&cursor_guard)?;
    #[cfg(windows)]
    menu.append(&focus_guard)?;
    #[cfg(windows)]
    if hybrid_gpu {
        menu.append(&gpu_pin)?;
    }
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
    #[cfg(windows)]
    let gpu_pin_toggle = gpu_pin.clone();

    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Xenon")
        .on_menu_event(move |app, event| {
            let id = event.id.as_ref();
            match id {
                // The escape hatch, and the reason phone mode is not a trap: it
                // reveals the window even when a rule wants it hidden, and it
                // writes nothing — the user asked to see it now, not to move house.
                "show" => monitor::show_now(app),
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
                // Recorded only: the GPU pin is a WebView2 environment option fixed
                // when this process created its first webview, so there is nothing
                // to apply now and nothing here pretends otherwise. `gpu::arm` reads
                // it at the next launch.
                #[cfg(windows)]
                "gpu-pin" => {
                    let next = !gpu_pin_toggle.is_checked().unwrap_or(true);
                    prefs::update(app, |p| p.gpu_pin = next);
                    let _ = gpu_pin_toggle.set_checked(next);
                }
                "place-auto" => monitor::set_placement(app, Placement::Auto, false),
                // Not applied now: the tray item is reached FROM the window, so
                // hiding it under the menu that was just used reads as a crash.
                // It takes effect at the next launch, as it always has.
                "place-phone" => monitor::set_placement(app, Placement::Phone, false),
                // The backend is stopped first: this handler runs on the main
                // thread, where restart() execs WITHOUT emitting RunEvent::Exit,
                // so the run loop's own teardown never gets to run.
                "restart" => {
                    crate::stop_owned_backend();
                    app.restart()
                }
                "quit" => app.exit(0),
                other => {
                    if let Some(name) = other.strip_prefix("mon:") {
                        monitor::move_to_named_monitor(app, name);
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

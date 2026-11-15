// What starts once the main window exists: its place on a screen, the guards around it, the tray icon and the login entry.

use crate::*;

/// The rest of `setup`, after the window is built, in the order it always had.
pub(super) fn after_window(app: &tauri::App, window: tauri::WebviewWindow, autostarted: bool, port: u16) {
    // Place the kiosk window on the Xeneon Edge (if connected) and keep a
    // watchdog running so it returns there after display reorders, replug
    // or resume from standby.
    monitor::place_now(&window);
    monitor::note_startup(&window, autostarted);
    // Seed the watchdog's Remote-Desktop-hide flag from the saved pref so a
    // launch that starts inside an RDP session already knows to hide (the
    // dashboard's toggle updates it live once the page loads).
    monitor::HIDE_ON_RDP.store(
        prefs::load(app.handle()).hide_on_rdp,
        std::sync::atomic::Ordering::SeqCst,
    );
    // Hide right away if we're launching INSIDE an RDP session, so the kiosk
    // never flashes over the remote desktop for a watchdog interval first.
    monitor::apply_rdp_hide_now(&window);
    monitor::start_watchdog(app.handle().clone());

    // Win+D raises the desktop over every ordinary window, the kiosk on
    // its own screen included (issue #143). Lift it above the desktop
    // while the desktop is in front, without focusing it.
    #[cfg(windows)]
    show_desktop::start(app.handle());

    // Remember where the desktop mouse is so it can be put back after a
    // touch on the kiosk yanks it onto the Edge (tray-toggleable).
    #[cfg(windows)]
    cursor_guard::start(&window);

    // While Windows has the screens off, Xenon's windows on them draw
    // nothing, and come back a moment after the screens do.
    #[cfg(windows)]
    layers::watch_screens(app.handle(), &window);

    // While a game runs, stop kiosk touches from stealing its focus; if
    // an activation slips through anyway, hand the focus straight back.
    #[cfg(windows)]
    {
        focus_guard::start(&window);
        let focused = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(true) = event {
                focus_guard::on_focused();
                // Safety net for a show that bypassed `monitor::show_window`.
                memory_level::set_low(&focused, false);
            }
        });
    }

    // The X of a dashboard visited from "widgets only" ends the visit: the
    // widgets stay and the app must not quit with them on the screen.
    let visited = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if monitor::end_visit(&visited) {
                api.prevent_close();
            }
        }
    });

    // WebKit renders the page in its own process; when that one dies the
    // window keeps its last frame, every timer in the page stops, and the
    // next repaint is white until the app is restarted by hand. Write the
    // reason down and bring the page back. Linux only — Windows and macOS
    // recover from this themselves.
    #[cfg(target_os = "linux")]
    webview_guard::start(&window);

    // System-tray icon (show / hide / restart / exit).
    if let Err(err) = tray::build(app) {
        eprintln!("failed to build tray icon: {err}");
    }

    // If the local backend never comes up, heal it once (Windows: its
    // logon task; macOS: its LaunchAgent, or the first-run bootstrap).
    spawn_backend_nudge(app.handle(), port);

    // Register — or REMOVE — the kiosk's own login entry, to match the
    // screen the user chose. This used to enable unconditionally on every
    // launch, so someone who had chosen their phone and then opened Xenon
    // once from the Start menu silently got the window back at every login.
    sync_autostart(app.handle());

    // Stop Windows from stealing edge touch swipes (taskbar/Start reveal)
    // so the "swipe up to the desktop" gesture reaches the dashboard —
    // unless the user turned the gesture off in Settings (mirrored into
    // prefs by the xenon-home:gesture-* signals above). Best-effort: the
    // policy lives in HKLM and is normally written by the elevated
    // installer; this only takes over when the app itself runs elevated.
    // Never reverted on exit — that would undo the installer's work
    // (uninstall.ps1 is what gives Windows its edge swipes back).
    #[cfg(windows)]
    if prefs::load(app.handle()).swipe_home {
        edge_swipe::disable();
    }
}

use tauri::Manager;

mod monitor;
mod tray;

/// Entry point shared by the desktop `main.rs` (and a future mobile target).
///
/// The window itself — borderless, full-screen kiosk pointed at the bundled
/// splash — is declared in `tauri.conf.json`. The splash waits for the local
/// backend service and then navigates the same webview to
/// `http://127.0.0.1:3030/`, so the native window renders the exact same
/// dashboard as the browser and the iCUE iframe (single source of UI). Keeping
/// one live webview also means the SSE/WebSocket streams stay open, so the
/// presence-aware features (wake word, FPS) behave just like an open browser tab.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        // Only one kiosk instance may own the Edge. A second launch re-focuses
        // the existing window instead of opening a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));

    // Autostart at login (desktop only).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        .setup(|app| {
            // Place the kiosk window on the Xeneon Edge (if connected) and keep a
            // watchdog running so it returns there after display reorders, replug
            // or resume from standby.
            if let Some(window) = app.get_webview_window("main") {
                monitor::place_now(&window);
            }
            monitor::start_watchdog(app.handle().clone());

            // System-tray icon (show / hide / restart / exit).
            if let Err(err) = tray::build(app) {
                eprintln!("failed to build tray icon: {err}");
            }

            // Launch the kiosk automatically at login (idempotent).
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Xenon native app");
}

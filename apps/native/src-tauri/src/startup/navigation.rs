// Every address the main window is asked to open: a signal from the dashboard, one of our own pages, or a link for the browser.

use crate::*;
use super::signals;

/// The navigation hook of the main window. `true` lets the page load; a signal is
/// acted on and never loaded.
pub(super) fn allowed(nav_handle: &tauri::AppHandle, signal_nonce: &str, port: u16, raw: &tauri::Url) -> bool {
    // Every `xenon-*` scheme is a signal, and a signal is obeyed
    // only with this launch's nonce (nav_policy.rs): on macOS and
    // Linux this hook also sees navigations inside the sandboxed
    // widget frames, which must not be able to restart the app,
    // move it between screens or run the updater. A signal without
    // it is dropped here, never passed on to the OS opener below.
    let checked;
    let url: &tauri::Url = if nav_policy::is_signal(raw) {
        match nav_policy::verified_signal(raw, signal_nonce) {
            Some(u) => {
                checked = u;
                &checked
            }
            None => return false,
        }
    } else {
        raw
    };
    let scheme = url.scheme();
    // The update toast taps navigate here: install the pending
    // update and relaunch. Never a real navigation.
    #[cfg(desktop)]
    if scheme == "xenon-update" {
        spawn_update_install(nav_handle.clone());
        return false;
    }
    // The Settings "Restart Xenon" button navigates here (never a
    // real page): a full, clean relaunch — clears transient/stuck
    // state (a wedged widget, a stalled probe) WITHOUT touching the
    // user's saved settings, layout, backgrounds or widgets, which
    // are all persisted and re-hydrate on launch. Same call the tray
    // "Restart" item uses.
    #[cfg(desktop)]
    if scheme == "xenon-app" {
        signals::app(nav_handle, url);
        return false;
    }
    // The splash's "Complete setup" button navigates here (never
    // a real page) when no backend answers and this build
    // carries the bootstrap: install the dashboard engine, in a
    // visible console, because the user asked for it. This
    // deliberately replaced the installer's silent post-install
    // spawn — see run_backend_bootstrap.
    if scheme == "xenon-setup" {
        // "Install" and "Repair" with the engine this build
        // carries: no console, progress on the splash. Builds
        // without one keep the bootstrap below.
        if url.path() == "run" && engine_install::packaged(nav_handle).is_some() {
            engine_install::spawn(nav_handle, port);
            return false;
        }
        #[cfg(windows)]
        match url.path() {
            // Also the "Repair Xenon" button: the same script
            // starts an installed engine first and reinstalls
            // it only when it still does not start.
            "run" => run_backend_bootstrap(nav_handle),
            // The other half of the same panel: the engine IS
            // installed here, its startup task is simply
            // switched off (see spawn_backend_nudge).
            "enable-task" => repair_startup_task(nav_handle),
            // Installed and switched on, just not running.
            "start" => start_backend_task(nav_handle, port),
            _ => {}
        }
        return false;
    }
    // The home-bar gesture taps navigate here (never a real page):
    //   xenon-home:go          → collapse to the desktop strip
    //   xenon-home:return      → restore the kiosk on the Edge
    //   xenon-home:gesture-on  → the Settings toggle: block Windows'
    //   xenon-home:gesture-off   edge swipe (or give it back) now,
    //                            and remember the choice for launch.
    //   xenon-home:rdp-on      → the Settings toggle: hide the kiosk
    //   xenon-home:rdp-off       while a Windows Remote Desktop
    //                            session is active (or stop), and
    //                            remember the choice for launch.
    if scheme == "xenon-home" {
        signals::home(nav_handle, url);
        return false;
    }
    // Settings → Schermo, and the first-run screen picker:
    //   xenon-display:auto                    → the historical rule
    //   xenon-display:screen?id=…&fullscreen= → this display, deliberately
    //   xenon-display:phone                   → nothing on this PC
    //   xenon-display:fullscreen?on=0|1       → assert (not toggle)
    //
    // Each verb touches disk and enumerates monitors, so each runs
    // off the WebView UI thread this hook is called on — same
    // reason as the two xenon-home writers above. The query is
    // parsed inside the thread so the hook returns immediately.
    //
    // Unknown paths do NOTHING. That is deliberate and unlike the
    // xenon-home catch-all above, where an unknown path collapses
    // the kiosk: a fallback that acts is what makes an unknown
    // path dangerous.
    if scheme == "xenon-display" {
        let handle = nav_handle.clone();
        let path = url.path().to_string();
        let query = url.query().map(|q| q.to_string());
        std::thread::spawn(move || {
            apply_display_signal(&handle, &path, query.as_deref());
        });
        return false;
    }
    // Touch interactions on the dashboard end here (never a real
    // page): put the mouse back on the monitor it was on before
    // Windows teleported it to the touched point.
    if scheme == "xenon-cursor" {
        #[cfg(windows)]
        cursor_guard::restore();
        return false;
    }
    // The interface scale (never a real page), sent only to shells
    // that declare `nativePageZoom`. Clamped to the Settings
    // slider's range so a malformed value cannot blow the page up.
    // Applied off this thread, like the display signal: this hook
    // runs on the event loop the zoom call dispatches to.
    #[cfg(target_os = "macos")]
    if scheme == "xenon-zoom" {
        let z = url
            .query_pairs()
            .find(|(k, _)| k == "z")
            .and_then(|(_, v)| v.parse::<f64>().ok())
            .filter(|z| z.is_finite())
            .map(|z| z.clamp(0.6, 2.5));
        // `nudge=1`: a widget frame loaded at this scale and came
        // out unscaled. Setting the same zoom again is a no-op in
        // WebKit, so step a hair off it first: that re-zooms every
        // frame, the new one included.
        let nudge = url.query_pairs().any(|(k, v)| k == "nudge" && v == "1");
        if let (Some(z), Some(win)) = (z, nav_handle.get_webview_window("main")) {
            std::thread::spawn(move || {
                if nudge {
                    let off = if z >= 2.5 { -0.001 } else { 0.001 };
                    let _ = win.set_zoom(z + off);
                }
                let _ = win.set_zoom(z);
            });
        }
        return false;
    }
    if scheme == "xenon-fullscreen" {
        // Route the F11 shortcut through the same canonical toggle the
        // tray uses: it honours the Edge-kiosk guard (a no-op while the
        // panel is owned), re-places the window on its monitor, and
        // persists the choice — none of which a raw set_fullscreen does.
        if url.path() == "toggle" {
            if let Some(win) = nav_handle.get_webview_window("main") {
                if let Ok(is_fullscreen) = win.is_fullscreen() {
                    monitor::set_fullscreen_pref(nav_handle, !is_fullscreen);
                }
            }
        }
        return false;
    }
    // Game-focus guard signals (never a real page): the dashboard
    // reports game mode and text-field focus so touches don't
    // steal the game's focus — except while the user types.
    if scheme == "xenon-focus" {
        #[cfg(windows)]
        match url.path() {
            "guard-on" => focus_guard::set_game_mode(true),
            "guard-off" => focus_guard::set_game_mode(false),
            "type-start" => {
                if let Some(win) = nav_handle.get_webview_window("main") {
                    focus_guard::type_start(&win);
                }
            }
            "type-end" => focus_guard::type_end(),
            _ => {}
        }
        return false;
    }
    // Always allow the app's own pages: the bundled splash asset
    // and the loopback dashboard it hands over to. On Windows the
    // bundled assets are served over `http://tauri.localhost`, not
    // the `tauri://` custom scheme (macOS/Linux) — treating that
    // host as external would bounce the splash itself to the OS
    // browser and leave the kiosk black.
    if matches!(scheme, "tauri" | "data" | "blob" | "about") {
        return true;
    }
    // Loopback only on the port this shell's backend listens on:
    // any other local service is not our page, and is treated
    // like any other site below.
    if nav_policy::is_own_page(url, port) {
        return true;
    }
    // The YouTube player in a tile navigates inside its own iframe.
    if embed_nav::is_youtube_embed(url) {
        return true;
    }
    // External http/https, mailto and tel go to the default
    // browser (or mail/phone app) and the in-webview navigation is
    // cancelled. Every other scheme is dropped: handing it to the
    // OS opener launches whatever handler is registered for it
    // (search-ms:, ms-*:, vscode://, smb://, file:), and a widget
    // frame can name any of them. Same list as the layer windows.
    if nav_policy::opens_externally(url) {
        use tauri_plugin_opener::OpenerExt;
        let _ = nav_handle.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

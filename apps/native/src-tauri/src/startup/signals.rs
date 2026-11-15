// The two signals with the most verbs: `xenon-app:` (restart, search, layers, glow, see-through) and `xenon-home:` (the home gesture).

use crate::*;

/// A `xenon-app:` signal, by its path.
#[cfg(desktop)]
pub(super) fn app(nav_handle: &tauri::AppHandle, url: &tauri::Url) {
    match url.path() {
        // stop_owned_backend() first: this hook runs ON the
        // event-loop thread, and restart() skips RunEvent::Exit
        // when called from there — so nothing else would stop
        // the backend child before the process is exec'd away.
        "restart" => {
            crash_log::session_end("restart from the dashboard");
            stop_owned_backend();
            nav_handle.restart()
        }
        // The dashboard (this webview) relays the server's
        // global-hotkey broadcast: open the native Spotlight
        // window on the PRIMARY monitor. Close/expand/
        // collapse are handled by that window's own hook.
        // MUST run on its own thread: window creation
        // sends a message to the event loop and BLOCKS for
        // the reply, and this hook (like run_on_main_thread
        // — both were proven deadlocks live) runs inside
        // that very loop, so the reply can never arrive.
        // From a plain thread the loop is free to serve it.
        "spotlight-open" => {
            let h = nav_handle.clone();
            std::thread::spawn(move || spotlight_window::open(&h));
        }
        // The language the splash speaks at the next launch.
        "splash-language" => {
            let code = url.query_pairs().find(|(k, _)| k == "l")
                .and_then(|(_, v)| prefs::clean_language(&v));
            if let Some(code) = code {
                prefs::update(nav_handle, |p| p.language = Some(code));
            }
        }
        // The Twitch tile's "Sign in to Twitch": twitch.tv's own
        // sign-in page in this profile, so the player embed
        // in the dashboard reads the session (twitch_login.rs).
        // A plain thread for the same reason as above.
        // The dashboard's widget placements changed (or it just
        // loaded): open, move and close the layer windows to
        // match (layers/mod.rs). A plain thread, like above.
        "layers-sync" => {
            let h = nav_handle.clone();
            let u = url.clone();
            std::thread::spawn(move || layers::sync(&h, &u));
        }
        // Xenon AI's voice state changed: light or dim the
        // edges of the other screens (layers/glow.rs).
        "ai-glow" => {
            let h = nav_handle.clone();
            let u = url.clone();
            std::thread::spawn(move || layers::glow(&h, &u));
        }
        // Settings → Background, "See-through background":
        // remember it, and relaunch when the window has to be
        // rebuilt (see_through.rs). A plain thread: it writes
        // display.json, and a restart from there runs the
        // normal Exit path.
        "see-through-on" | "see-through-off" => {
            let want = url.path() == "see-through-on";
            let h = nav_handle.clone();
            std::thread::spawn(move || see_through::set_from_dashboard(&h, want));
        }
        #[cfg(windows)]
        "twitch-login" => {
            let h = nav_handle.clone();
            std::thread::spawn(move || twitch_login::open(&h));
        }
        _ => {}
    }
}

/// A `xenon-home:` signal, by its path.
pub(super) fn home(nav_handle: &tauri::AppHandle, url: &tauri::Url) {
    match url.path() {
        "rdp-on" | "rdp-off" => {
            let on = url.path() == "rdp-on";
            // The watchdog reads this atomic each tick; update it
            // immediately so the next tick applies the choice.
            monitor::HIDE_ON_RDP
                .store(on, std::sync::atomic::Ordering::SeqCst);
            // Persist off the WebView UI thread (this hook runs on
            // it, and file IO here can stall the page mid-load).
            // prefs::update locks the whole load→save so it can't
            // race the swipe-home writer below (or a tray toggle).
            let handle = nav_handle.clone();
            std::thread::spawn(move || {
                prefs::update(&handle, |p| p.hide_on_rdp = on);
            });
        }
        "gesture-on" | "gesture-off" => {
            let on = url.path() == "gesture-on";
            // reg.exe + file IO — off the WebView UI thread:
            // this hook runs on it, and blocking it here can
            // stall the page mid-load.
            let handle = nav_handle.clone();
            std::thread::spawn(move || {
                prefs::update(&handle, |p| p.swipe_home = on);
                #[cfg(windows)]
                if on {
                    edge_swipe::disable();
                } else {
                    edge_swipe::restore();
                }
            });
        }
        "return" => {
            if let Some(win) = nav_handle.get_webview_window("main") {
                monitor::exit_home(&win);
            }
        }
        _ => {
            if let Some(win) = nav_handle.get_webview_window("main") {
                monitor::enter_home(&win);
            }
        }
    }
}

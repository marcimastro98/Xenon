use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
mod cursor_guard;
#[cfg(windows)]
mod edge_swipe;
#[cfg(windows)]
mod focus_guard;
mod monitor;
mod prefs;
mod tray;

/// Injected into every page the kiosk webview loads (the splash and, after it
/// hands over, the loopback dashboard). In a Tauri webview a `target="_blank"`
/// link — and `window.open()` — spawns a new *webview* window instead of the OS
/// browser, and both bypass the Rust `on_navigation` hook below. This funnels
/// those external opens into a top-level navigation so the hook can catch the
/// URL and redirect it to the default browser, keeping the kiosk on the
/// dashboard. Internal/loopback and relative links are left untouched.
const EXTERNAL_LINK_SHIM: &str = r#"
(function () {
  // Let the shared dashboard know it is running inside the native shell (used to
  // offer app updates here, and to hide the "install the native app" promo that
  // the browser/iCUE surfaces show).
  try { window.__XENON_NATIVE__ = true; } catch (e) {}
  // What this shell build understands, so the dashboard never sends a signal an
  // older shell would misread (an unknown xenon-home path used to mean "go home",
  // which collapsed the kiosk to the desktop strip on load).
  try { window.__XENON_NATIVE_CAPS__ = { homeGestureToggle: true }; } catch (e) {}
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
})();
"#;

/// Guards the one-shot update check so it fires once per launch, when the
/// loopback dashboard first loads (not on the splash).
#[cfg(desktop)]
static UPDATE_CHECK_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Build the tiny JS that asks the dashboard to show its localized "update
/// available — tap to install" toast. Retries briefly in case the dashboard's
/// scripts have not finished loading yet. The version is JSON-encoded so it is
/// always a safe string literal.
#[cfg(desktop)]
fn update_prompt_js(version: &str) -> String {
    let v = serde_json::to_string(version).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(v){{var n=0;function go(){{if(window.XenonNative&&window.XenonNative.showUpdatePrompt){{try{{window.XenonNative.showUpdatePrompt(v);}}catch(e){{}}}}else if(n++<50){{setTimeout(go,200);}}}}go();}})({v});"
    )
}

/// Check GitHub for a newer signed release; if one exists, surface the in-dashboard
/// prompt. Never installs on its own — the user taps to update (see the
/// `xenon-update:` navigation below).
#[cfg(desktop)]
fn spawn_update_check(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Ok(Some(update)) = updater.check().await {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.eval(update_prompt_js(&update.version));
            }
        }
    });
}

/// Download and install the pending update, then relaunch. Triggered by the user
/// tapping the update toast (which navigates to `xenon-update:install`).
#[cfg(desktop)]
fn spawn_update_install(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Ok(Some(update)) = updater.check().await {
            if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                app.restart();
            }
        }
    });
}

/// Entry point shared by the desktop `main.rs` (and a future mobile target).
///
/// The window itself — borderless, full-screen kiosk pointed at the bundled
/// splash — is built in `setup()` (so it can carry the navigation hook and link
/// shim above). The splash waits for the local backend service and then
/// navigates the same webview to
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
        }))
        // Open external links (Support, Community Discord, Report a bug, …) in
        // the user's default browser instead of trapping them in the kiosk.
        .plugin(tauri_plugin_opener::init());

    // Autostart at login + self-update (desktop only).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        // When the loopback dashboard first loads (not the splash), check once
        // for a newer signed release and, if any, surface the update toast.
        .on_page_load(|_webview, _payload| {
            #[cfg(desktop)]
            {
                use std::sync::atomic::Ordering;
                let is_dashboard = matches!(
                    _payload.url().host_str(),
                    Some("127.0.0.1") | Some("localhost")
                );
                if is_dashboard && !UPDATE_CHECK_STARTED.swap(true, Ordering::SeqCst) {
                    spawn_update_check(_webview.app_handle().clone());
                }
            }
        })
        .setup(|app| {
            // Build the kiosk window in Rust (rather than declaratively in
            // tauri.conf.json) so it can carry an initialization script and a
            // navigation hook: external links open in the OS browser while the
            // webview itself never leaves the splash/dashboard. Props mirror the
            // former config window (borderless, full-screen, 2560×720 Edge size).
            let nav_handle = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Xenon")
                .inner_size(2560.0, 720.0)
                .min_inner_size(640.0, 240.0)
                .resizable(true)
                .decorations(false)
                .fullscreen(true)
                .always_on_top(false)
                .visible(true)
                .focused(true)
                .center()
                .transparent(false)
                // The kiosk lives on the Edge and is controlled from the system
                // tray (show/hide/restart/exit), so keep it out of the main
                // taskbar and Alt-Tab — it runs quietly in the background.
                .skip_taskbar(true)
                .initialization_script(EXTERNAL_LINK_SHIM)
                .on_navigation(move |url| {
                    let scheme = url.scheme();
                    // The update toast taps navigate here: install the pending
                    // update and relaunch. Never a real navigation.
                    #[cfg(desktop)]
                    if scheme == "xenon-update" {
                        spawn_update_install(nav_handle.clone());
                        return false;
                    }
                    // The home-bar gesture taps navigate here (never a real page):
                    //   xenon-home:go          → collapse to the desktop strip
                    //   xenon-home:return      → restore the kiosk on the Edge
                    //   xenon-home:gesture-on  → the Settings toggle: block Windows'
                    //   xenon-home:gesture-off   edge swipe (or give it back) now,
                    //                            and remember the choice for launch.
                    if scheme == "xenon-home" {
                        match url.path() {
                            "gesture-on" | "gesture-off" => {
                                let on = url.path() == "gesture-on";
                                // reg.exe + file IO — off the WebView UI thread:
                                // this hook runs on it, and blocking it here can
                                // stall the page mid-load.
                                let handle = nav_handle.clone();
                                std::thread::spawn(move || {
                                    let mut saved = prefs::load(&handle);
                                    if saved.swipe_home != on {
                                        saved.swipe_home = on;
                                        prefs::save(&handle, &saved);
                                    }
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
                    let loopback = matches!(
                        url.host_str(),
                        Some("127.0.0.1") | Some("localhost") | Some("::1") | Some("tauri.localhost")
                    );
                    if matches!(scheme, "http" | "https") && loopback {
                        return true;
                    }
                    // Anything else (external http/https, mailto, tel, …) is handed
                    // to the default browser and the in-webview navigation cancelled.
                    use tauri_plugin_opener::OpenerExt;
                    let _ = nav_handle.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .build()?;

            // Place the kiosk window on the Xeneon Edge (if connected) and keep a
            // watchdog running so it returns there after display reorders, replug
            // or resume from standby.
            monitor::place_now(&window);
            monitor::start_watchdog(app.handle().clone());

            // Remember where the desktop mouse is so it can be put back after a
            // touch on the kiosk yanks it onto the Edge (tray-toggleable).
            #[cfg(windows)]
            cursor_guard::start(&window);

            // While a game runs, stop kiosk touches from stealing its focus; if
            // an activation slips through anyway, hand the focus straight back.
            #[cfg(windows)]
            {
                focus_guard::start(&window);
                window.on_window_event(|event| {
                    if let tauri::WindowEvent::Focused(true) = event {
                        focus_guard::on_focused();
                    }
                });
            }

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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Xenon native app")
        .run(|_app, _event| {});
}

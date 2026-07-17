use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
mod cursor_guard;
#[cfg(windows)]
mod edge_swipe;
#[cfg(windows)]
mod focus_guard;
#[cfg(windows)]
mod gpu;
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
  // which collapsed the kiosk to the desktop strip on load). Runtime-only caps
  // (shellVersion, updateEvents, lowPowerGpu) are merged in by the second init
  // script built in setup() — keep this literal so old-shell semantics stay
  // greppable.
  try { window.__XENON_NATIVE_CAPS__ = { homeGestureToggle: true, rdpToggle: true }; } catch (e) {}
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
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F11') {
      e.preventDefault();
      window.location.href = 'xenon-fullscreen:toggle';
    }
  });
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

/// Build the tiny JS that reports a shell-update event into the dashboard
/// (XenonNative.onShellUpdateEvent — progress overlay or error toast). Retries
/// briefly in case the dashboard's scripts have not finished loading. The event
/// is serde-encoded, so it is always a safe JS literal.
#[cfg(desktop)]
fn update_report_js(event: &serde_json::Value) -> String {
    format!(
        "(function(e){{var n=0;function go(){{if(window.XenonNative&&window.XenonNative.onShellUpdateEvent){{try{{window.XenonNative.onShellUpdateEvent(e);}}catch(err){{}}}}else if(n++<50){{setTimeout(go,200);}}}}go();}})({event});"
    )
}

/// Eval a shell-update event into the dashboard, best effort (no window → drop).
#[cfg(desktop)]
fn report_update_event(app: &tauri::AppHandle, event: serde_json::Value) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(update_report_js(&event));
    }
}

/// First ~200 chars of an updater error, safe to embed via serde. Full errors
/// can carry URLs/paths the toast has no room for.
#[cfg(desktop)]
fn short_err(e: &dyn std::fmt::Display) -> String {
    e.to_string().chars().take(200).collect()
}

/// Download and install the pending update, then relaunch. Triggered by the user
/// tapping the update toast (which navigates to `xenon-update:install`).
///
/// EVERY exit path reports an event into the dashboard — a failed check,
/// download or install used to die in silence here, which read as "Updating
/// Xenon… and nothing happens" (the bug real users hit). Progress is throttled
/// to ~5% steps so the eval channel never floods the webview.
#[cfg(desktop)]
fn spawn_update_install(app: tauri::AppHandle) {
    use serde_json::json;
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        report_update_event(&app, json!({ "phase": "checking" }));
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                report_update_event(
                    &app,
                    json!({ "phase": "error", "code": "check_failed", "message": short_err(&e) }),
                );
                return;
            }
        };
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => {
                report_update_event(&app, json!({ "phase": "uptodate" }));
                return;
            }
            Err(e) => {
                report_update_event(
                    &app,
                    json!({ "phase": "error", "code": "check_failed", "message": short_err(&e) }),
                );
                return;
            }
        };
        let progress_app = app.clone();
        let done_app = app.clone();
        let mut received: u64 = 0;
        let mut last_pct: u64 = u64::MAX; // sentinel → the first chunk always reports
        let mut last_bytes_report: u64 = 0;
        let result = update
            .download_and_install(
                move |chunk, total| {
                    received += chunk as u64;
                    let Some(t) = total.filter(|t| *t > 0) else {
                        // No usable content length (chunked CDN response): still
                        // emit byte-count heartbeats — the dashboard's watchdog
                        // treats silence as a wedged updater. First chunk, then
                        // every ~2 MB.
                        if last_bytes_report == 0 || received - last_bytes_report >= 2_000_000 {
                            last_bytes_report = received;
                            report_update_event(
                                &progress_app,
                                json!({ "phase": "downloading", "received": received }),
                            );
                        }
                        return;
                    };
                    let pct = received * 100 / t;
                    if last_pct != u64::MAX && pct < last_pct.saturating_add(5) && pct < 100 {
                        return;
                    }
                    last_pct = pct;
                    report_update_event(
                        &progress_app,
                        json!({ "phase": "downloading", "received": received, "total": t }),
                    );
                },
                move || {
                    report_update_event(&done_app, json!({ "phase": "installing" }));
                },
            )
            .await;
        match result {
            Ok(()) => {
                report_update_event(&app, json!({ "phase": "restarting" }));
                app.restart();
            }
            Err(e) => {
                report_update_event(
                    &app,
                    json!({ "phase": "error", "code": "install_failed", "message": short_err(&e) }),
                );
            }
        }
    });
}

/// Legacy rescue: un-strand existing installs whose DASHBOARD predates the
/// orchestrated update flow. Their old update.js never updates the Node backend
/// on native (it only ever triggered the shell updater), so after this shell
/// self-updates, the backend would stay old forever. This self-contained script
/// no-ops on new dashboards (they expose XenonUpdate.nativeOrchestrate and own
/// the flow); on old ones, when the backend version is older than this shell,
/// it offers a persistent toast that drives the backend's own signed
/// prepare/apply endpoints and reloads when the new version serves. English
/// only by design — it exists precisely because the old dashboard's i18n has no
/// keys for it, and it turns into dead code once the user base is current.
#[cfg(desktop)]
fn legacy_rescue_js(shell_version: &str) -> String {
    let v = serde_json::to_string(shell_version).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function (shellVer) {{
  try {{
    if (window.XenonUpdate && typeof window.XenonUpdate.nativeOrchestrate === 'function') return;
    if (window.__xenonLegacyRescue) return;
    window.__xenonLegacyRescue = true;
  }} catch (e) {{ return; }}
  function newer(a, b) {{
    a = String(a || '').replace(/^v/i, '').split('.');
    b = String(b || '').replace(/^v/i, '').split('.');
    for (var i = 0; i < 3; i++) {{
      var x = parseInt(a[i], 10) || 0, y = parseInt(b[i], 10) || 0;
      if (x !== y) return x > y;
    }}
    return false;
  }}
  function toast(opts) {{
    try {{
      if (window.XenonToast && typeof window.XenonToast.show === 'function') window.XenonToast.show(opts);
    }} catch (e) {{}}
  }}
  fetch('/version').then(function (r) {{ return r.json(); }}).then(function (j) {{
    if (!j || !j.version || !newer(shellVer, j.version)) return;
    fetch('/update/self-status').then(function (r) {{ return r.json(); }}).then(function (st) {{
      if (!st || !st.supported) return;
      toast({{
        type: 'info', duration: 0,
        title: 'Dashboard update available',
        message: 'Tap to install the latest dashboard (v' + String(shellVer).replace(/^v/i, '') + ').',
        onClick: function () {{
          toast({{ type: 'info', title: 'Updating the dashboard…', message: 'The page reloads by itself when it is done.' }});
          fetch('/update/prepare', {{ method: 'POST' }}).then(function (r) {{ return r.json(); }}).then(function (res) {{
            if (!res || !res.ok) {{
              toast({{ type: 'error', title: 'Update failed', message: 'Could not prepare the update' + (res && res.error ? ' (' + res.error + ')' : '') + '.' }});
              return;
            }}
            fetch('/update/apply', {{ method: 'POST' }}).catch(function () {{}});
            var tries = 0;
            var poll = setInterval(function () {{
              if (++tries > 144) {{
                clearInterval(poll);
                // The applier rolled back or stalled (this old backend writes no
                // result file to consult) — say so instead of dying silently.
                toast({{ type: 'error', title: 'Update failed', message: 'The dashboard update did not complete and the previous version is still running. Restart the app to try again.' }});
                return;
              }}
              fetch('/version', {{ cache: 'no-store' }}).then(function (r) {{ return r.json(); }}).then(function (v) {{
                if (v && v.version && !newer(shellVer, v.version)) {{ clearInterval(poll); location.reload(); }}
              }}).catch(function () {{}});
            }}, 2500);
          }}).catch(function () {{
            toast({{ type: 'error', title: 'Update failed', message: 'Could not reach the dashboard backend.' }});
          }});
        }}
      }});
    }}).catch(function () {{}});
  }}).catch(function () {{}});
}})({v});"#
    )
}

/// Guards the one-shot legacy-rescue injection so it fires once per launch.
#[cfg(desktop)]
static LEGACY_RESCUE_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Self-heal for a missing backend: the kiosk is only a shell for the local
/// dashboard, so if nothing answers on 127.0.0.1:3030 shortly after launch the
/// splash would spin forever (reported in the wild as "stuck on waiting for the
/// Xenon service"). Nudge the widget's per-logon scheduled task ("Xenon Edge
/// Widget", registered by the widget installer) once, best-effort — it covers a
/// backend that crashed or whose logon start never fired. The probe MUST come
/// first: the task's start-hidden.vbs kills whatever listens on 3030 before
/// starting node, so nudging while a healthy server runs would restart it.
/// If the task does not exist (widget never installed) this is a no-op and the
/// splash's own hint tells the user what to install.
#[cfg(windows)]
fn spawn_backend_nudge(port: u16) {
    std::thread::spawn(move || {
        use std::net::{SocketAddr, TcpStream};
        use std::time::Duration;
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        // ~8–16s of grace so a normally-starting backend is never interfered with.
        for _ in 0..4 {
            if TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok() {
                return; // backend is up — nothing to heal
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        if port == 3030 {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("schtasks")
                .args(["/Run", "/TN", "Xenon Edge Widget"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
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
                // Old dashboards can't update their own backend — offer it from
                // here (no-op on new dashboards; see legacy_rescue_js). Delayed
                // so the dashboard's scripts (XenonToast, t()) have settled.
                if is_dashboard && !LEGACY_RESCUE_STARTED.swap(true, Ordering::SeqCst) {
                    let app = _webview.app_handle().clone();
                    let ver = app.package_info().version.to_string();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(8));
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.eval(legacy_rescue_js(&ver));
                        }
                    });
                }
            }
        })
        .setup(|app| {
            let port = std::env::var("XENON_PORT")
                .ok()
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(3030);
            // Build the kiosk window in Rust (rather than declaratively in
            // tauri.conf.json) so it can carry an initialization script and a
            // navigation hook: external links open in the OS browser while the
            // webview itself never leaves the splash/dashboard. Props mirror the
            // former config window (borderless, full-screen, 2560×720 Edge size).
            let nav_handle = app.handle().clone();
            // Computed once, up front, so both the WebView2 launch flag below
            // (`additional_browser_args`) and the JS-facing cap just below it
            // read the SAME decision instead of enumerating displays twice.
            #[cfg(windows)]
            let gpu_flag = gpu::webview_gpu_flag();
            #[cfg(not(windows))]
            let gpu_flag: Option<&'static str> = None;
            // Runtime-only capabilities merged over the shim's literal caps: the
            // dashboard's update orchestrator needs the shell's own version (to
            // know whether the exe is outdated too) and whether this shell
            // reports update progress/errors (updateEvents). `lowPowerGpu` tells
            // the dashboard it is rendering on the weaker of two GPUs on purpose
            // (see gpu.rs) — backgroundfx.css uses it to pause the purely
            // decorative aurora/grid layers, which on this machine's iGPU can
            // combine with a busy animated theme background to drop the kiosk's
            // real presented frame rate into single digits (measured via
            // PresentMon — see the "native-app-hybrid-gpu-idle-burn" note).
            // serde-encoding keeps the injection a safe JS literal.
            let caps_js = format!(
                "try{{window.__XENON_NATIVE_CAPS__=Object.assign(window.__XENON_NATIVE_CAPS__||{{}},{});}}catch(e){{}}",
                serde_json::json!({
                    "shellVersion": app.package_info().version.to_string(),
                    "updateEvents": true,
                    "lowPowerGpu": matches!(gpu_flag, Some("--force_low_power_gpu")),
                })
            );
            let port_js = format!("try{{window.__XENON_PORT__={};}}catch(e){{}}", port);
            let init_script = format!("{EXTERNAL_LINK_SHIM}\n{caps_js}\n{port_js}");
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
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
                .initialization_script(&init_script)
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
                    //   xenon-home:rdp-on      → the Settings toggle: hide the kiosk
                    //   xenon-home:rdp-off       while a Windows Remote Desktop
                    //                            session is active (or stop), and
                    //                            remember the choice for launch.
                    if scheme == "xenon-home" {
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
                    if scheme == "xenon-fullscreen" {
                        // Route the F11 shortcut through the same canonical toggle the
                        // tray uses: it honours the Edge-kiosk guard (a no-op while the
                        // panel is owned), re-places the window on its monitor, and
                        // persists the choice — none of which a raw set_fullscreen does.
                        if url.path() == "toggle" {
                            if let Some(win) = nav_handle.get_webview_window("main") {
                                if let Ok(is_fullscreen) = win.is_fullscreen() {
                                    monitor::set_fullscreen_pref(&nav_handle, !is_fullscreen);
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
                });

            // WebView2 browser arguments. `additional_browser_args` REPLACES wry's
            // default (`--disable-features=…`), so it's re-included below.
            //
            // 1) Keep the unfocused kiosk renderer fully alive. The Edge window never
            //    holds focus (WS_EX_NOACTIVATE) and lives on a secondary display, so
            //    Chromium would background/throttle its renderer after a while —
            //    freezing its JS timers and the SSE stream, so the dashboard silently
            //    stops updating and the Deck stops responding even though the socket
            //    stays open (reported as "the app stopped talking to the server").
            //    These three switches stop that suspension.
            // 2) Match the WebView2 render GPU to the display presenting the kiosk
            //    (the Edge, typically an iGPU over USB-C). Rendering on a different
            //    GPU than the one scanning out the window makes Chromium copy every
            //    composited frame across adapters on the CPU — ~1.5 idle cores on a
            //    hybrid-GPU machine. See gpu::webview_gpu_flag (no-op off hybrids);
            //    `gpu_flag` was already computed above, alongside the JS-facing
            //    `lowPowerGpu` cap.
            #[cfg(windows)]
            let builder = {
                let mut args = String::from(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows",
                );
                if let Some(flag) = gpu_flag {
                    args.push(' ');
                    args.push_str(flag);
                }
                builder.additional_browser_args(&args)
            };
            let window = builder.build()?;

            // Place the kiosk window on the Xeneon Edge (if connected) and keep a
            // watchdog running so it returns there after display reorders, replug
            // or resume from standby.
            monitor::place_now(&window);
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

            // If the local backend never comes up, kick its logon task once.
            #[cfg(windows)]
            spawn_backend_nudge(port);

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

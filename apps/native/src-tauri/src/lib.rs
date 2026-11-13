use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod crash_log;
mod embed_nav;
mod engine_install;
#[cfg(windows)]
mod cursor_guard;
#[cfg(windows)]
mod edge_swipe;
#[cfg(windows)]
mod focus_guard;
#[cfg(windows)]
mod gpu;
mod layers;
mod webview_setup;
mod display_signal;
mod backend_task;
#[cfg(windows)]
mod backend_nudge_windows;
#[cfg(windows)]
mod backend_bootstrap;
mod shell_update;
mod autostart;
mod backend_probe;
#[cfg(target_os = "macos")]
mod backend_child_macos;
#[cfg(target_os = "macos")]
mod backend_nudge_macos;
mod backend_nudge_linux;
mod host_graphics_linux;
#[cfg(windows)]
pub use layers::{pad_reader, PAD_READER_ARG};

#[cfg(windows)]
use backend_bootstrap::{bootstrap_script, run_backend_bootstrap};
#[cfg(windows)]
use backend_nudge_windows::spawn_backend_nudge;
#[cfg(windows)]
use backend_task::{BACKEND_TASK, backend_task_state, decode_console_bytes, repair_startup_task, start_backend_task, TaskState};
use display_signal::apply_display_signal;
pub(crate) use display_signal::display_state_js;
use webview_setup::EXTERNAL_LINK_SHIM;
#[cfg(windows)]
pub(crate) use webview_setup::browser_args;

pub(crate) use autostart::sync_autostart;
use shell_update::shell_self_update;
#[cfg(desktop)]
use shell_update::{legacy_rescue_js, LEGACY_RESCUE_STARTED, spawn_update_check, spawn_update_install, UPDATE_CHECK_STARTED};
// Only the Windows files ask these by name: the other systems go through backend_answers.
#[cfg(windows)]
use backend_probe::{backend_answers_once, backend_answers_within, LOGON_PROBE_TRIES, PROBE_TRIES};

#[cfg(target_os = "macos")]
pub use backend_child_macos::stop_owned_backend;
#[cfg(target_os = "macos")]
use backend_child_macos::backend_entry;
#[cfg(target_os = "macos")]
pub(crate) use backend_child_macos::start_backend_child;
#[cfg(target_os = "macos")]
use backend_nudge_macos::{current_uid, spawn_backend_nudge};

#[cfg(target_os = "linux")]
use backend_nudge_linux::{find_in_path, host_env_command, spawn_backend_nudge};
#[cfg(target_os = "linux")]
use host_graphics_linux::prefer_host_graphics_libs;

/// First argument that turns this binary into the engine install self-test.
pub const ENGINE_SELFTEST_ARG: &str = "--install-engine-selftest";

/// Runs the self-test (`engine_install::selftest`) and returns the exit code.
pub fn engine_selftest(args: &[String]) -> i32 {
    engine_install::selftest(args)
}

/// First argument of the "Installed apps" entry: remove Xenon (Windows).
pub const UNINSTALL_ARG: &str = "--uninstall";

/// Removes the engine this app installed, then the app (`engine_install::uninstall`).
#[cfg(windows)]
pub fn uninstall() -> i32 {
    engine_install::uninstall()
}
#[cfg(windows)]
mod login_task;
mod memory_level;
mod monitor;
mod monitor_names;
mod nav_policy;
#[cfg(desktop)]
mod page_load;
mod prefs;
mod see_through;
mod show_desktop;
mod spotlight_window;
mod tray;
#[cfg(windows)]
mod twitch_login;
#[cfg(target_os = "linux")]
mod webview_guard;

/// A Windows system tool by its absolute path in System32. A bare name is
/// looked up in the app's own folder first, which is per-user and writable,
/// so a planted schtasks.exe or reg.exe there would run instead.
#[allow(dead_code)]
pub(crate) fn system32_exe(name: &str) -> std::path::PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| String::from("C:\\Windows"));
    std::path::Path::new(&root).join("System32").join(name)
}

/// No-op twin so every caller can say "stop what we own" without a `cfg`. Only
/// macOS ever owns the backend process.
#[cfg(not(target_os = "macos"))]
pub fn stop_owned_backend() {}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn spawn_backend_nudge(_app: &tauri::AppHandle, _port: u16) {}

#[cfg(not(target_os = "linux"))]
fn prefer_host_graphics_libs() {}

/// On a Wayland compositor that offers explicit sync (Hyprland, and so Omarchy,
/// among others) WebKitGTK's DMABUF renderer can make the compositor drop the
/// window with protocol error 71, "Missing acquire timeline". Turning the
/// renderer off avoids it, at the price of copying each frame, so it is done
/// only where that error can happen: a session GTK will draw through Wayland.
/// Under X11 (including a forced GDK_BACKEND=x11 on a Wayland desktop) nothing
/// changes. A value the user already set always wins, so "=0" brings it back.
#[cfg(target_os = "linux")]
fn disable_dmabuf_on_wayland() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty());
    let forced_x11 = std::env::var("GDK_BACKEND").is_ok_and(|b| b.trim_start().starts_with("x11"));
    if wayland && !forced_x11 && std::env::var_os(VAR).is_none() {
        std::env::set_var(VAR, "1");
    }
}

/// Make Xlib safe to use from more than one thread, before GTK opens the display.
///
/// Moving our own screen reads onto the main thread (monitor.rs, `on_main`) was
/// not enough: the AppImageHub test of v4.11.11 (PR #7417) still aborted with
/// "[xcb] Unknown sequence number ... XInitThreads has not been called" four
/// seconds after the tray icon appeared, so some other thread, ours or inside a
/// library (the tray indicator, GDK), still reaches the same X connection.
/// XInitThreads is Xlib's own answer and must be the first Xlib call in the
/// process; after it, concurrent use is locked instead of fatal. libX11 is
/// already loaded by GTK on every Linux desktop, Wayland ones included, so this
/// adds no dependency, and under Wayland the call is harmless.
#[cfg(target_os = "linux")]
fn init_xlib_threads() {
    #[link(name = "X11")]
    extern "C" {
        fn XInitThreads() -> std::os::raw::c_int;
    }
    // SAFETY: takes no arguments, and runs before any thread or display exists.
    unsafe {
        XInitThreads();
    }
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
    // First of all, so that everything below it is covered: the crash diary. A
    // stripped, console-less kiosk that dies has no other way to say why, and
    // "it closed on its own after a while" is unfixable without one.
    crash_log::install();
    crash_log::session_start();

    // Before GTK starts and before any thread exists (set_var is not thread-safe).
    #[cfg(target_os = "linux")]
    disable_dmabuf_on_wayland();

    // Before anything can touch a display: an AppImage whose bundled libraries
    // shadow the host's driver stack renders NOTHING, and never says so.
    prefer_host_graphics_libs();

    #[cfg(target_os = "linux")]
    init_xlib_threads();

    let mut builder = tauri::Builder::default()
        // Only one kiosk instance may own the Edge. A second launch shows the
        // existing window, on its screen, instead of opening a duplicate. A second
        // LOGIN launch is not the user asking for anything (macOS has two login
        // entries that both start the app), so it changes nothing: showing the
        // window there would undo phone mode at every login.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--autostart") {
                return;
            }
            monitor::reveal(app);
        }))
        // Open external links (Support, Community Discord, Report a bug, …) in
        // the user's default browser instead of trapping them in the kiosk.
        .plugin(tauri_plugin_opener::init());

    // Autostart at login + self-update (desktop only).
    #[cfg(desktop)]
    {
        builder = builder
            // The argument is what lets the app tell a login launch from the
            // user double-clicking Xenon. In phone mode the first must stay
            // invisible and the second must not.
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--autostart"]),
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
                // A cancelled `xenon-app:` signal also ends in a page-load event
                // (src/page_load.rs): none of the work below is for it.
                let started = matches!(_payload.event(), tauri::webview::PageLoadEvent::Started);
                let is_dashboard = matches!(
                    _payload.url().host_str(),
                    Some("127.0.0.1") | Some("localhost")
                ) && page_load::real(_webview.label(), started);
                // "Widgets only" (server/js/usage-mode.js): the server sends the
                // main window to the driver page instead of the dashboard. The
                // URL alone says which one loaded, so the window hides before the
                // driver paints and comes back when the dashboard loads. Only the
                // main webview's loads count: this hook also fires for every
                // widget-layer window, whose page is `/` too. Nor does the splash:
                // it is not the dashboard leaving the driver.
                if is_dashboard
                    && _webview.label() == "main"
                    && nav_policy::is_backend_page(_payload.url(), monitor::backend_port())
                {
                    if let Some(win) = _webview.app_handle().get_webview_window("main") {
                        let url = _payload.url();
                        let full = url.query_pairs().any(|(k, v)| k == "full" && v == "1");
                        let on_driver = url.path() == monitor::DRIVER_PATH;
                        if monitor::set_driver(&win, on_driver, full) {
                            let app = _webview.app_handle().clone();
                            std::thread::spawn(move || layers::driver_left(&app));
                        }
                        // Not on `Started`: that one still has the address before
                        // the server's redirect to the driver.
                        if !started && monitor::opened_to_nothing(on_driver) {
                            let app = _webview.app_handle().clone();
                            std::thread::spawn(move || monitor::show_now(&app));
                        }
                        // A window that starts hidden (phone mode, a login
                        // start) never passed through `hide_window`.
                        if !win.is_visible().unwrap_or(true) {
                            memory_level::set_low(&win, true);
                        }
                    }
                }
                if is_dashboard && !UPDATE_CHECK_STARTED.swap(true, Ordering::SeqCst) {
                    spawn_update_check(_webview.app_handle().clone());
                }
                // First accurate display state: the init-script snapshot is built
                // before the window exists, so it carries no `active` screen.
                if is_dashboard {
                    monitor::push_display_state(_webview.app_handle());
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
            // former config window (borderless, full-screen), except the size,
            // which now comes from the screen that will host it.
            let nav_handle = app.handle().clone();
            // The saved screen choice, read once here: it decides the initial
            // window visibility, seeds the watchdog's in-memory mirror, and
            // carries the GPU-pin preference read just below — all of which
            // happen before the backend is necessarily up.
            let display_prefs = prefs::load(app.handle());
            monitor::set_placement_cache(&display_prefs);
            // Decide the WebView2 render GPU ONCE, before any webview exists, and
            // record it: `additional_browser_args` is an environment option fixed
            // for the whole process, so every later builder must read back the
            // SAME value (`gpu::applied`) rather than re-deciding. Recomputing per
            // window was a live bug — see the note at the top of gpu.rs. The
            // JS-facing `lowPowerGpu` cap below reads this decision too, instead of
            // enumerating displays a second time. It is aimed at the screen the
            // window is about to open on, by the same rule that places it.
            #[cfg(windows)]
            let gpu_flag = gpu::arm(
                display_prefs.gpu_pin,
                monitor::initial_screen_name(app.handle(), &display_prefs).as_deref(),
            );
            #[cfg(not(windows))]
            let gpu_flag: Option<&'static str> = None;
            // See-through window (see_through.rs): after the pin, because whether a
            // transparent webview is visible depends on which adapter draws it.
            let see_through = see_through::decide(
                &display_prefs,
                monitor::initial_screen_name(app.handle(), &display_prefs).as_deref(),
            );
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
            // `--autostart` is appended to the login entry (see the plugin init
            // above), so its presence tells a login launch from a deliberate one.
            // A user who double-clicks Xenon must always SEE it, even in phone
            // mode: an app that opens and shows nothing reads as broken.
            let autostarted = std::env::args().any(|a| a == "--autostart");
            // "Widgets only" last time: a login start shows no splash either.
            monitor::seed_driver(&display_prefs);
            if !autostarted {
                monitor::started_by_hand();
            }
            let start_hidden =
                (!display_prefs.shows_on_this_pc() || display_prefs.widgets_only) && autostarted;
            // A deliberate launch in phone mode must SHOW the window: nothing is
            // written, so the next login is hidden again as chosen. Without this
            // the window is built visible and then hidden a moment later by
            // `place_now`, which is the same "opens and shows nothing" it is
            // meant to avoid.
            if !display_prefs.shows_on_this_pc() && !autostarted {
                monitor::allow_show_this_session();
            }
            // `displayPicker` is the hard gate for the dashboard: `xenon-display:`
            // is a NEW scheme, and on an older shell an unknown scheme falls
            // through to the OS opener, which on Windows raises a "how do you
            // want to open this?" dialog on the kiosk. The page must check this
            // before ever assigning such a URL — exactly as it already does for
            // homeGestureToggle and rdpToggle.
            //
            // `displays` is a snapshot: the window does not exist yet at this
            // point, so `display.active` is deliberately absent here and arrives
            // with the first push (on page load, on placement, on replug).
            //
            // Linux draws layers only on X11 with a compositor (layers/linux.rs);
            // `layersWhy` tells the dashboard what is missing, so it can say so.
            #[cfg(target_os = "linux")]
            let layers_why = layers::linux::probe();
            #[cfg(not(target_os = "linux"))]
            let layers_why: Option<&str> = None;
            let caps = serde_json::json!({
                "shellVersion": app.package_info().version.to_string(),
                "updateEvents": true,
                "shellSelfUpdate": shell_self_update(),
                "lowPowerGpu": matches!(gpu_flag, Some("--force_low_power_gpu")),
                "displayPicker": true,
                // "Sign in to Twitch" in the Twitch tile (xenon-app:twitch-login).
                // Windows only: WebKit blocks the third-party cookie the
                // player embed would need, so elsewhere it could not work.
                "twitchLogin": cfg!(windows),
                // The interface scale as WKWebView page zoom (xenon-zoom:set).
                // macOS only: there the dashboard's CSS `zoom` reaches into
                // the sandboxed widget frames without shrinking their
                // viewport, so SDK widgets came out enlarged, blurry and
                // cropped (Discord, Oct 2026). WebView2 keeps the CSS path:
                // it resets native zoom on every cancelled signal navigation.
                "nativePageZoom": cfg!(target_os = "macos"),
                // The monitor list, injected BEFORE the page loads. It used
                // to arrive only with the first `push_display_state`, after
                // the dashboard had loaded — so the first-run screen picker
                // opened with no screens on it and, if that push never
                // landed, stayed that way: a question about which screen to
                // use, asked without offering one. The snapshot has no
                // `display.active` (no window exists yet); that half still
                // comes with the push.
                "displays": monitor::display_list_json(app.handle()),
                "phoneMode": !display_prefs.shows_on_this_pc(),
                // Widget layers on the desktop and in the overlay
                // (xenon-app:layers-sync): Windows, macOS and Linux on X11.
                // Anchoring to an app is Windows only (`draws` per backend).
                "layers": layers_why.is_none(),
                "layersWhy": layers_why,
                // Xenon AI's edge glow on other screens (xenon-app:ai-glow):
                // native windows wherever layer windows can be drawn, so
                // on Linux not on GNOME Wayland or X11 without a compositor.
                "aiGlow": layers_why.is_none(),
                // The Ambient scene as animated wallpaper and screensaver
                // (layers/scene.rs), in the same layers-sync, where layer
                // windows can be drawn at all.
                "scene": layers_why.is_none() && layers::draws_scene(),
                // "Draw on screen" as a layer window (draw.html, the
                // `draw:` surface) where the capture engine has no sheet.
                "draw": layers_why.is_none() && layers::draws_sheet(),
                // The Xenon menu over the main screen (menu.html, the
                // `menu:` surface) and its global shortcut.
                "menu": layers_why.is_none() && layers::draws_menu(),
                // A widget that follows one app's window (`anchor:` surfaces).
                "anchor": layers_why.is_none() && layers::draws_anchor(),
                // It says which virtual desktop is shown (layers/desks.rs).
                "desks": layers_why.is_none() && layers::desks::supported(),
                // Holding View + Menu on a controller opens the Xenon menu
                // (layers/pad.rs).
                "pad": layers_why.is_none() && layers::draws_menu() && layers::pad::supported(),
                // Widget windows can be kept out of screenshots and recordings
                // (`set_content_protected`: WDA_EXCLUDEFROMCAPTURE on Windows,
                // sharingType none on macOS, where Xenon's capture engine also
                // leaves those windows out by name, since ScreenCaptureKit on
                // macOS 15 may not), so "show them in captures" is a real choice.
                // Linux has no such flag.
                "outOfCaptures": layers_why.is_none() && cfg!(any(windows, target_os = "macos")),
                // Linux stacks the wallpaper under the windows, not behind
                // the icons a desktop may draw (layers/linux.rs).
                "wallpaperBehindIcons": !cfg!(target_os = "linux"),
                // The see-through window (see_through.rs, xenon-app:see-through-*).
                // `seeThroughOn`: this window was built transparent, so the
                // dashboard paints no backdrop of its own. `seeThroughWanted`:
                // the user's switch. `seeThroughReady`: it could be built
                // transparent here; when not, `seeThroughWhy` says why
                // ("gpu" on Windows, "compositor" on Linux).
                "seeThrough": cfg!(any(windows, target_os = "macos", target_os = "linux")),
                "seeThroughOn": see_through.on,
                "seeThroughWhy": see_through.why,
                "seeThroughWanted": display_prefs.see_through,
                "seeThroughReady": see_through.ready,
                "splashLang": display_prefs.language.clone().unwrap_or_default(),
            });
            layers::set_menu_caps(&caps);
            let caps_js = format!(
                "try{{window.__XENON_NATIVE_CAPS__=Object.assign(window.__XENON_NATIVE_CAPS__||{{}},{caps});}}catch(e){{}}"
            );
            let port_js = format!("try{{window.__XENON_PORT__={};}}catch(e){{}}", port);
            // Whether the splash may offer "Complete setup" at all: release
            // Windows builds that actually carry the bootstrap, and nothing
            // else (see bootstrap_script). Without this the button would show
            // up in `tauri dev` and on any future non-Windows target.
            let engine_bundled = engine_install::packaged(app.handle()).is_some();
            #[cfg(windows)]
            let setup_available = engine_bundled || bootstrap_script(app.handle()).is_some();
            #[cfg(not(windows))]
            let setup_available = engine_bundled;
            let setup_js = format!(
                "try{{window.__XENON_SETUP_AVAILABLE__={};window.__XENON_ENGINE_BUNDLED__={};}}catch(e){{}}",
                setup_available, engine_bundled
            );
            // The nonce every signal URL from this window must carry, and the
            // script that hands it to the top-level page of our own origins only
            // (nav_policy.rs explains why widget frames must never see it).
            let signal_nonce = nav_policy::new_nonce();
            let nonce_js = nav_policy::nonce_script(&signal_nonce, port);
            let init_script = format!("{EXTERNAL_LINK_SHIM}\n{caps_js}\n{port_js}\n{setup_js}\n{nonce_js}");
            // Size and full-screen state both come from the screen that will host
            // it, by the same rule `place_now` is about to apply (see
            // monitor::initial_window). The literal 2560×720 that used to be here
            // made every machine without an Edge open a window shaped like a panel
            // it does not have, which on macOS — where the window cannot be built
            // full-screen — is the first thing an installer shows you.
            let (init_w, init_h, init_fullscreen) =
                monitor::initial_window(app.handle(), &display_prefs);
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Xenon")
                // The window's own backing, under the web content. Left unset it
                // is the platform default - WHITE - and every moment the page is
                // not painting its own background shows through as a white
                // dashboard. On Windows that is the launch flash the Spotlight
                // window already guards against; on macOS it outlives the launch:
                // after the display sleeps, WebKit brings the page back without
                // repainting the root background, so the white backing shows in
                // every gap and the tiles - which are translucent - composite
                // over it as pale grey. Reported on Discord from a Mac mini
                // (Sep 2026) on a dashboard explicitly set to Dark, which is why
                // it was not the theme: the palette was never wrong, the surface
                // behind it was. Near-black, matching --bg in styles/global.css.
                //
                // On macOS this needs `macOSPrivateApi` in tauri.conf.json, and
                // that is the ONLY reason it is on. WKWebView paints an opaque
                // WHITE background of its own, and the switch that turns it off
                // (`drawsBackground`) is a private key — so wry only compiles
                // that call in under the private-api feature. Without it the
                // colour set here lands on the NSWindow, which the white webview
                // then covers completely: the window would be dark and the app
                // still white. Xenon is not distributed through the App Store,
                // where private APIs are refused; it ships as a signed .dmg.
                .background_color(tauri::window::Color(6, 8, 10, 255))
                .inner_size(init_w, init_h)
                .min_inner_size(640.0, 240.0)
                .resizable(true)
                .decorations(false)
                .always_on_top(false)
                // Built invisible rather than hidden right after: a post-build
                // `hide()` is a visible flash on macOS, which is the one platform
                // where phone mode still launches the app.
                .visible(!start_hidden)
                .focused(!start_hidden)
                .center();
            // On macOS `transparent` exists only behind the `macos-private-api`
            // feature, which `macOSPrivateApi` in tauri.conf.json switches on —
            // first for `background_color` above, and now for this too. The
            // window is opaque unless the user asked for it see-through and this
            // machine can draw it (see_through.rs).
            let builder = builder.transparent(see_through.on);
            // The one exception to the dark backing above: a window the user asked
            // to be see-through (see_through.rs) has none at all, the layer
            // windows' recipe. The splash and the dashboard paint their own ground
            // until the dashboard hands it over to the desktop.
            let builder = if see_through.on {
                builder.background_color(tauri::window::Color(0, 0, 0, 0))
            } else {
                builder
            };
            // Borderless + native fullscreen is a combination macOS does not
            // have. `toggleFullScreen:` needs NSWindowStyleMaskTitled, and on a
            // window built with `decorations(false)` the transition dereferences
            // null and kills the process — measured, not inferred: SIGSEGV in
            // -[_NSEnterFullScreenTransitionController _performEnterFullScreen]
            // on every launch, so the app never opened once on that platform.
            // The kiosk covers its display by geometry there instead (see
            // monitor::enter_borderless_fullscreen), which is also the better
            // behaviour: native fullscreen would move the window into a Space of
            // its own, away from the display it is supposed to own.
            //
            // NOTE this is invisible to `npm run check:platform-apis`: the
            // method exists on every platform and only its RUNTIME meaning
            // differs. That check answers "does this API exist here", never
            // "does this combination work here".
            //
            // Full-screen at BUILD time only where that is the state the window is
            // about to be placed in anyway — the Edge kiosk, or a screen the user
            // chose and asked to fill. Everywhere else `place_now` turns it back
            // into an ordinary window a moment later, so building it full-screen
            // meant a launch that covers your whole desktop for a frame and then
            // does not: the "why did Xenon take over my screen?" half of opening it
            // for the first time.
            #[cfg(not(target_os = "macos"))]
            let builder = builder.fullscreen(init_fullscreen);
            let builder = builder
                // The kiosk lives on the Edge and is controlled from the system
                // tray (show/hide/restart/exit), so keep it out of the main
                // taskbar and Alt-Tab — it runs quietly in the background.
                .skip_taskbar(true)
                .initialization_script(&init_script)
                .on_navigation(move |raw| {
                    // Every `xenon-*` scheme is a signal, and a signal is obeyed
                    // only with this launch's nonce (nav_policy.rs): on macOS and
                    // Linux this hook also sees navigations inside the sandboxed
                    // widget frames, which must not be able to restart the app,
                    // move it between screens or run the updater. A signal without
                    // it is dropped here, never passed on to the OS opener below.
                    let checked;
                    let url: &tauri::Url = if nav_policy::is_signal(raw) {
                        match nav_policy::verified_signal(raw, &signal_nonce) {
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
                                    prefs::update(&nav_handle, |p| p.language = Some(code));
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
                        if url.path() == "run" && engine_install::packaged(&nav_handle).is_some() {
                            engine_install::spawn(&nav_handle, port);
                            return false;
                        }
                        #[cfg(windows)]
                        match url.path() {
                            // Also the "Repair Xenon" button: the same script
                            // starts an installed engine first and reinstalls
                            // it only when it still does not start.
                            "run" => run_backend_bootstrap(&nav_handle),
                            // The other half of the same panel: the engine IS
                            // installed here, its startup task is simply
                            // switched off (see spawn_backend_nudge).
                            "enable-task" => repair_startup_task(&nav_handle),
                            // Installed and switched on, just not running.
                            "start" => start_backend_task(&nav_handle, port),
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
            //    hybrid-GPU machine. See gpu::arm (no-op off hybrids, and off when
            //    the user turned the pin off in the tray);
            //    `gpu_flag` was already computed above, alongside the JS-facing
            //    `lowPowerGpu` cap.
            #[cfg(windows)]
            let builder = builder.additional_browser_args(&browser_args(gpu_flag));
            let window = builder.build()?;

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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Xenon native app")
        .run(|_app, _event| {
            if matches!(_event, tauri::RunEvent::Exit) {
                // Close the session in the crash diary. A launch with no exit
                // line and no panic after it is the signature of a process that
                // was killed from the outside — antivirus, Task Manager, or the
                // PC going down hard — and that distinction is the whole point
                // of keeping the file.
                crash_log::session_end("clean shutdown");
                // Whatever we started, we stop. On macOS the backend is this
                // app's own child (see spawn_backend_nudge), so quitting must
                // take it with us rather than leave a headless server holding
                // port 3030.
                #[cfg(target_os = "macos")]
                stop_owned_backend();
            }
        });
}

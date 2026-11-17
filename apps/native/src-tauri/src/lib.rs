use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod dmabuf;
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
mod startup;
mod tray;
mod tray_words;
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
    dmabuf::disable_dmabuf_on_hyprland();

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
        .on_page_load(startup::page::on_page_load)
        .setup(startup::setup)
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

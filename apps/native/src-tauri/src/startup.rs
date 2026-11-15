// What the app does once at launch: it reads the saved choices, builds the main window and starts what depends on it.

use crate::*;

mod main_window;
mod navigation;
pub(crate) mod page;
mod script;
mod signals;
mod started;

/// The `setup` step of `run`, in the order it always had: the saved choices, the
/// GPU pin, the start script, the window, and then everything that needs the window.
pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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
    let (init_script, signal_nonce) = script::build(app, &display_prefs, gpu_flag, &see_through, port);
    let builder = main_window::builder(app, &display_prefs, &see_through, start_hidden, init_script)
        .on_navigation(move |raw| navigation::allowed(&nav_handle, &signal_nonce, port, raw));

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
    started::after_window(app, window, autostarted, port);

    Ok(())
}

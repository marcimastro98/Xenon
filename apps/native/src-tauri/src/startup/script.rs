// The script every page of the main window starts with: what this app can do here, the port, and the nonce of its signals.

use crate::*;

/// Builds the start script and the nonce its signals must carry. It also hands
/// the same capabilities to the Xenon menu window.
pub(super) fn build(
    app: &tauri::App,
    display_prefs: &prefs::DisplayPrefs,
    gpu_flag: Option<&'static str>,
    see_through: &see_through::Launch,
    port: u16,
) -> (String, String) {
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
        // The own Bit on the taskbar (layers/bit_desk.rs).
        "bitDesk": layers_why.is_none() && layers::bit_desk::supported(),
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
    (init_script, signal_nonce)
}

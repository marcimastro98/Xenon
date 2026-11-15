// The main window as it is built at launch: its size, its backing, and whether it starts shown.

use crate::*;

/// The builder of the main window, up to its start script. `setup` adds the
/// navigation hook and the browser arguments, then builds it.
pub(super) fn builder<'a>(
    app: &'a tauri::App,
    display_prefs: &prefs::DisplayPrefs,
    see_through: &see_through::Launch,
    start_hidden: bool,
    init_script: String,
) -> WebviewWindowBuilder<'a, tauri::Wry, tauri::App> {
    // Size and full-screen state both come from the screen that will host
    // it, by the same rule `place_now` is about to apply (see
    // monitor::initial_window). The literal 2560×720 that used to be here
    // made every machine without an Edge open a window shaped like a panel
    // it does not have, which on macOS — where the window cannot be built
    // full-screen — is the first thing an installer shows you.
    let (init_w, init_h, init_fullscreen) =
        monitor::initial_window(app.handle(), display_prefs);
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
    builder
        // The kiosk lives on the Edge and is controlled from the system
        // tray (show/hide/restart/exit), so keep it out of the main
        // taskbar and Alt-Tab — it runs quietly in the background.
        .skip_taskbar(true)
        .initialization_script(&init_script)
}

// One layer window: opened, kept on its own page, and its tile rectangles reported.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use super::{Live, MENU_ASIDE, MENU_CAPS, menu_window, NEXT_LABEL, shield, spec};
#[cfg(target_os = "linux")]
use super::{linux as backend, native_handle};
#[cfg(target_os = "macos")]
use super::{macos as backend, native_handle};
#[cfg(windows)]
use super::{native_handle, win32 as backend};
use super::page::{ALERTS_CAPS, LAYER_SHIM, layer_url, port};
#[cfg(windows)]
use super::page::ALERTS_ROLL;
use super::signals::{glow_from_alerts, menu_back, open_asked_dashboard, query, saver_done};
use super::spec::{Kind, Surface};

/// Where the layer webviews keep their profile when the main one is pinned to
/// another GPU. A transparent webview pinned to one adapter and shown on a
/// screen driven by the other renders BLANK (spotlight_window.rs), and every
/// webview on one profile must share its browser arguments, so a pinned
/// process gives its layers a profile of their own, without the pin. That costs
/// one more browser process, on pinned hybrid machines only.
#[cfg(windows)]
fn unpinned_profile(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::gpu::applied()?;
    Some(app.path().app_local_data_dir().ok()?.join("layers-webview"))
}

pub(super) fn open(app: &AppHandle, s: &Surface) -> Option<Live> {
    let prefix = if spec::is_scene(&s.key) { "scene" } else { "layer" };
    let label = format!("{prefix}-{}", NEXT_LABEL.fetch_add(1, Ordering::Relaxed));
    let handle = app.clone();
    let own = label.clone();
    let alerts = spec::is_alerts(&s.key);
    let kind = s.kind;
    let nonce = crate::nav_policy::new_nonce();
    let nonce_js = crate::nav_policy::nonce_script(&nonce, port());
    let menu_at = (kind == Kind::Menu).then(|| {
        MENU_ASIDE.store(false, Ordering::Relaxed);
        menu_window::forget_lowered();
        menu_window::opening(app)
    });
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(layer_url(&s.key)?))
        .focused(false)
        // Built visible and out of sight: win32::apply puts it in place. A
        // window built hidden and shown natively would keep its webview hidden.
        .visible(true)
        .initialization_script(LAYER_SHIM)
        // Its own signal nonce, like the main window (nav_policy.rs): on
        // macOS and Linux this hook also sees navigations from the sandboxed
        // widget frames these pages host, and a widget must not be able to
        // send `xenon-app:layer-rects` (a full-screen input region) or any
        // other signal of this window.
        .initialization_script(&nonce_js)
        .on_navigation(move |url| navigate(&handle, &own, alerts, kind, &nonce, url));
    let builder = match menu_at {
        Some(at) => menu_window::dress(builder, at),
        None => builder
            .title("Xenon widgets")
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .background_color(tauri::window::Color(0, 0, 0, 0))
            .skip_taskbar(true)
            .resizable(false)
            .inner_size(1.0, 1.0)
            .position(-32000.0, -32000.0),
    };
    let builder = if alerts { builder.initialization_script(ALERTS_CAPS) } else { builder };
    #[cfg(windows)]
    let builder = if alerts { builder.initialization_script(ALERTS_ROLL) } else { builder };
    let builder = match MENU_CAPS.get().filter(|_| kind == Kind::Menu) {
        Some(caps) => builder.initialization_script(caps),
        None => builder,
    };
    // Same arguments as the main webview when they share a profile (see
    // `crate::browser_args`); without the GPU pin when they do not.
    #[cfg(windows)]
    let builder = builder.additional_browser_args(&crate::browser_args(None));
    #[cfg(windows)]
    let builder = match unpinned_profile(app) {
        Some(dir) => builder.data_directory(dir),
        None => builder,
    };
    match builder.build() {
        Ok(win) => {
            let handle = native_handle(&win)?;
            // Bit's cards are Xenon's own, never what the user captures (and
            // `sync` keeps it so; it also decides for the menu, right after).
            if alerts {
                let _ = win.set_content_protected(true);
            }
            if kind == Kind::Menu {
                menu_window::watch_close(&win);
            }
            Some(Live {
                label,
                handle,
                surface: s.clone(),
                shield: shield::Shield::default(),
                #[cfg(windows)]
                opened_at: menu_at.map(|at| at.rect).unwrap_or_default(),
            })
        }
        Err(e) => {
            crate::crash_log::note("layer-window", &format!("failed to open: {e}"));
            None
        }
    }
}

/// A layer page never leaves the loopback dashboard: its own signals are
/// handled here, external links go to the OS browser, every other scheme
/// (native-bridge signals meant for the main window) is dropped.
fn navigate(app: &AppHandle, label: &str, alerts: bool, kind: Kind, nonce: &str, url: &tauri::Url) -> bool {
    // A signal counts only with this window's nonce, which is then removed so
    // the handlers below read the query exactly as before.
    let verified;
    let url: &tauri::Url = if crate::nav_policy::is_signal(url) {
        match crate::nav_policy::verified_signal(url, nonce) {
            Some(u) => { verified = u; &verified }
            None => return false,
        }
    } else {
        url
    };
    match url.scheme() {
        // Xenon's own pages, on its own port only.
        "http" | "https" if crate::nav_policy::is_own_page(url, port()) => true,
        "http" | "https" => {
            use tauri_plugin_opener::OpenerExt;
            if kind == Kind::Menu {
                if let Some(win) = app.get_webview_window(label) {
                    menu_window::lower(&win);
                }
            }
            let _ = app.opener().open_url(url.as_str(), None::<&str>);
            false
        }
        "xenon-app" if url.path() == "layer-rects" => {
            let editing = url.query_pairs().any(|(k, v)| k == "edit" && v == "1");
            report_rects(app, label, url, Some(editing));
            false
        }
        // The wallpaper's page on battery (server/js/screen-scene.js).
        "xenon-app" if kind == Kind::Wallpaper && url.path() == "scene-pause" => {
            let on = url.query_pairs().any(|(k, v)| k == "on" && v == "1");
            if let Some(h) = app.get_webview_window(label).as_ref().and_then(native_handle) {
                backend::set_paused(h, on);
            }
            false
        }
        // Any input on a screensaver ends them all.
        "xenon-app" if kind == Kind::Saver && url.path() == "saver-done" => {
            let h = app.clone();
            std::thread::spawn(move || saver_done(&h));
            false
        }
        // The alerts window's cards: it never speaks for the edit mode.
        "xenon-app" if url.path() == "alert-rects" => {
            report_rects(app, label, url, None);
            false
        }
        // Bit answering there in "widgets only" (server/js/screen-bit.js):
        // the window lights the edges the way the dashboard does.
        "xenon-app" if alerts && url.path() == "ai-glow" => {
            let h = app.clone();
            let u = url.clone();
            std::thread::spawn(move || glow_from_alerts(&h, &u));
            false
        }
        // A tile's Set up button on a widget on the screen: Settings, on
        // the dashboard (spec::tile_settings). Nothing else from these windows.
        "xenon-app" if matches!(kind, Kind::Desktop | Kind::Overlay | Kind::Anchor) && !alerts => {
            let query = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
            if let Some((page, cat)) = spec::tile_settings(url.path(), query("open").as_deref(), query("cat").as_deref()) {
                crate::monitor::open_dashboard(app, page, cat);
            }
            false
        }
        // Restart Xenon in Settings, in the menu's window: only the main window
        // knows how (it stops the backend first), so it is handed on as its own.
        "xenon-app" if kind == Kind::Menu && url.path() == "restart" => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.eval("location.href=(window.__xenonSignal||String)('xenon-app:restart')");
            }
            false
        }
        // A one-shot function of the menu: out of the picture it takes, then back
        // with what happened. The server says when (screen-menu.js `aside`).
        "xenon-app" if kind == Kind::Menu && matches!(url.path(), "menu-aside" | "menu-back") => {
            let back = url.path() == "menu-back";
            MENU_ASIDE.store(!back, Ordering::Relaxed);
            if let Some(win) = app.get_webview_window(label) {
                if back {
                    let _ = win.show();
                    let _ = win.set_focus();
                    let (h, own) = (app.clone(), label.to_string());
                    std::thread::spawn(move || menu_back(&h, &own));
                } else {
                    let _ = win.hide();
                }
            }
            false
        }
        // Its update card and What's New, or the Xenon menu's gallery, Settings
        // and dashboard rows: the dashboard, on that screen. Only those windows,
        // only those screens (spec::dashboard_page).
        "xenon-app" if alerts || kind == Kind::Menu => {
            open_asked_dashboard(app, url, kind == Kind::Menu);
            false
        }
        _ => false,
    }
}

/// Runs on the main thread (navigation hooks do), like win32::set_region.
fn report_rects(app: &AppHandle, label: &str, url: &tauri::Url, editing: Option<bool>) {
    let Some(win) = app.get_webview_window(label) else { return };
    let Some(handle) = native_handle(&win) else { return };
    let rects = |name| spec::parse_rects(&query(url, name).unwrap_or_default());
    #[cfg(windows)]
    {
        let closing = rects("roll");
        if !closing.is_empty() {
            backend::roll_away(handle, closing);
        }
    }
    backend::set_region(handle, rects("d"), rects("t"), editing);
}

//! Widget layers: dashboard tiles drawn on the desktop, over everything
//! (overlay) or following one app's window (anchor), for people with a single
//! screen. Each surface is one transparent window loading the dashboard in
//! `?layer=<key>` mode (server/js/layer-host.js), which draws only the tiles
//! placed on it: one window per layer per monitor, one per anchored widget
//! (the spike measured ~15 MB per extra window, so sharing one matters).
//!
//! Driven by the main dashboard, which navigates `xenon-app:layers-sync?d=<json>`
//! whenever the placements change (js/layers-shell.js). This module opens,
//! moves and closes the windows to match. Each layer page reports where its
//! tiles are (`xenon-app:layer-rects?d=`) and the window region is cut to them.
//!
//! The same sync carries the Ambient scene's windows (scene.rs): the animated
//! wallpaper and the screensaver, which load `/scene` instead of a layer page.
//!
//! Threads: `sync` runs on a plain thread, because window creation blocks on
//! the event loop (see lib.rs `spotlight-open`); every Win32 or AppKit call on
//! a layer window runs on the main thread, which owns the windows and the hooks.
//!
//! macOS (macos.rs) and Linux (linux.rs, on X11 or with layer-shell) draw the
//! desktop and overlay layers, the alerts window and the Ambient scene.
//! Anchored widgets follow their app on Windows, macOS (anchor_macos.rs) and
//! X11 (anchor_x11.rs); a layer-shell session has no way to find another
//! app's window, and the shell says so (lib.rs native caps). Xenon AI's edge glow is drawn on all three, by plain native
//! windows rather than webviews (glow.rs and one glow_* file per OS).
#![cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]

mod anchor;
#[cfg(target_os = "macos")]
mod anchor_macos;
#[cfg(target_os = "linux")]
mod anchor_x11;
pub mod desks;
#[cfg(target_os = "macos")]
mod desks_macos;
#[cfg(windows)]
mod desks_win32;
#[cfg(target_os = "linux")]
mod desks_x11;
pub mod pad;
#[cfg(target_os = "linux")]
mod pad_linux;
#[cfg(target_os = "macos")]
mod pad_macos;
#[cfg(windows)]
mod pad_win32;
#[cfg(windows)]
mod pad_winmm;
#[cfg(windows)]
mod ffi;
mod glow;
#[cfg(target_os = "linux")]
mod glow_linux;
#[cfg(target_os = "macos")]
mod glow_macos;
#[cfg(windows)]
mod glow_win32;
#[cfg(target_os = "linux")]
mod layer_shell;
#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod scene;
mod spec;
#[cfg(windows)]
mod win32;

/// How the windows behave on this OS: the same `Plan`, `apply` and `set_region`.
#[cfg(target_os = "linux")]
use linux as backend;
#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(windows)]
use win32 as backend;

/// How the edge glow is drawn on this OS: the same `Screen::of`, `Plan` and `apply`.
#[cfg(target_os = "linux")]
use glow_linux as glow_backend;
#[cfg(target_os = "macos")]
use glow_macos as glow_backend;
#[cfg(windows)]
use glow_win32 as glow_backend;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use spec::{Kind, Surface};

struct Live {
    label: String,
    /// The native window: its HWND, its NSWindow on macOS, its GtkWindow on Linux.
    handle: isize,
    surface: Surface,
}

/// Whether this OS draws the Ambient scene as wallpaper and screensaver: the
/// native caps (lib.rs `scene`) offer only what the backend accepts.
pub fn draws_scene() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(not(windows))]
    return backend::draws(Kind::Wallpaper) && backend::draws(Kind::Saver);
}

/// Whether the shell draws the "Draw on screen" sheet (draw.html): macOS and
/// Linux. Windows draws it with the capture engine instead.
pub fn draws_sheet() -> bool {
    #[cfg(windows)]
    return false;
    #[cfg(not(windows))]
    return backend::draws(Kind::Draw);
}

/// Whether a widget can follow another app's window (`anchor:` surfaces):
/// Windows, macOS and X11. Wayland gives no app the other windows' places.
pub fn draws_anchor() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(not(windows))]
    return backend::draws(Kind::Anchor);
}

/// Whether the shell draws the Xenon menu over the screen (menu.html): every
/// OS where layer windows can be drawn.
pub fn draws_menu() -> bool {
    #[cfg(windows)]
    return true;
    #[cfg(not(windows))]
    return backend::draws(Kind::Menu);
}

/// The open layer windows. Touched only by `sync`, which holds the lock for the
/// whole pass, so two syncs never race on the same window.
static LIVE: Mutex<Vec<Live>> = Mutex::new(Vec::new());
static NEXT_LABEL: AtomicU32 = AtomicU32::new(1);
/// For the backends' main-thread code, which runs with no handle (`memory_for`,
/// the macOS cursor watch).
static APP: OnceLock<AppHandle> = OnceLock::new();
/// A screensaver was ended by the user: none opens again until a sync comes
/// without one, i.e. the server saw the input and the idle time started over.
static SAVER_DONE: AtomicBool = AtomicBool::new(false);

/// Links and `window.open` to external sites become top-level navigations, so
/// the hook below hands them to the OS browser instead of opening a webview
/// window. `__XENON_LAYER_SHELL__` tells layer-host.js to report its tiles.
const LAYER_SHIM: &str = r#"(function () {
  try { window.__XENON_LAYER_SHELL__ = true; } catch (e) {}
  function external(u) {
    try {
      var url = new URL(u, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return url.hostname !== '127.0.0.1' && url.hostname !== 'localhost';
    } catch (e) { return false; }
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && external(a.href)) { e.preventDefault(); window.location.href = a.href; }
  }, true);
  var open = window.open;
  window.open = function (u) {
    if (external(u)) { window.location.href = u; return null; }
    return open.apply(window, arguments);
  };
})();"#;

/// The alerts window only: it may light the edges for Bit (glow_from_alerts),
/// so js/ai-edge-glow.js may send there. No other native capability: the
/// window takes no other signal.
const ALERTS_CAPS: &str = "try { window.__XENON_NATIVE_CAPS__ = Object.assign(window.__XENON_NATIVE_CAPS__ || {}, { aiGlow: true }); } catch (e) {}";

fn port() -> u16 {
    std::env::var("XENON_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3030)
}

/// A widget layer loads the dashboard in `?layer=<key>` mode; the alerts window
/// loads its own page, which is not a layer page: it shows the pop-ups the
/// layer pages keep quiet (utils.js isLayerPage).
fn layer_url(key: &str) -> Option<tauri::Url> {
    let base = format!("http://127.0.0.1:{}/", port());
    if spec::is_alerts(key) {
        return tauri::Url::parse(&(base + "screen-alerts")).ok();
    }
    if spec::is_draw(key) {
        return tauri::Url::parse(&(base + "draw")).ok();
    }
    if spec::is_menu(key) {
        return tauri::Url::parse(&(base + "menu")).ok();
    }
    if spec::is_scene(key) {
        let mut url = tauri::Url::parse(&(base + "scene")).ok()?;
        url.query_pairs_mut().append_pair("key", key);
        return Some(url);
    }
    let mut url = tauri::Url::parse(&base).ok()?;
    url.query_pairs_mut().append_pair("layer", key);
    Some(url)
}

/// Which screensavers of a sync may open now. None after the user ended one,
/// until the sync drops them; none while an app keeps the screen on or a
/// window is in full screen (they are asked for again on the next sync).
fn allow_savers(surfaces: &mut Vec<Surface>, live: &[Live]) {
    let asked = surfaces.iter().any(|s| s.kind == Kind::Saver);
    if !asked {
        SAVER_DONE.store(false, Ordering::Relaxed);
        return;
    }
    let open = live.iter().any(|l| l.surface.kind == Kind::Saver);
    let blocked = SAVER_DONE.load(Ordering::Relaxed)
        || (!open && saver_held());
    if blocked {
        surfaces.retain(|s| s.kind != Kind::Saver);
    }
}

/// An app keeps the screen on (a video) or a window is in full screen.
#[cfg(windows)]
fn saver_held() -> bool {
    scene::display_required() || scene::front_fullscreen()
}

#[cfg(not(windows))]
fn saver_held() -> bool {
    backend::saver_held()
}

/// The query value `d` of a signal URL, decoded.
fn payload(url: &tauri::Url) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == "d").map(|(_, v)| v.into_owned())
}

/// `xenon-app:layers-sync` from the main dashboard. Call on a plain thread.
pub fn sync(app: &AppHandle, url: &tauri::Url) {
    let Some(mut spec) = payload(url).as_deref().and_then(spec::parse) else { return };
    let _ = APP.set(app.clone());
    desks::want(app, spec.desks);
    pad::want(app, spec.pad);
    let Ok(mut live) = LIVE.lock() else { return };
    #[cfg(not(windows))]
    spec.surfaces.retain(|s| backend::draws(s.kind));
    // Windows draws on the screen with the capture engine's own sheet.
    #[cfg(windows)]
    spec.surfaces.retain(|s| s.kind != Kind::Draw);
    allow_savers(&mut spec.surfaces, &live);
    // A Wayland session without layer-shell (GNOME) gets no layer windows:
    // they would sit wherever the compositor puts a normal window. The
    // dashboard already sends none there.
    #[cfg(target_os = "linux")]
    if !linux::usable() {
        spec.surfaces.clear();
    }
    // A surface whose kind changed gets a fresh window: the behaviours differ.
    // A window that is gone (a wallpaper goes with Explorer) is opened again.
    live.retain(|l| {
        let alive = app.get_webview_window(&l.label).is_some();
        let keep = alive && spec.surfaces.iter().any(|s| s.key == l.surface.key && s.kind == l.surface.kind);
        if !keep {
            close(app, &l.label);
        }
        keep
    });
    for s in &spec.surfaces {
        match live.iter_mut().find(|l| l.surface.key == s.key) {
            Some(l) => l.surface = s.clone(),
            None => live.extend(open(app, s)),
        }
    }
    let mut plans = Vec::with_capacity(live.len());
    for l in live.iter() {
        if let Some(win) = app.get_webview_window(&l.label) {
            // The alerts window and the menu stay out of captures whatever
            // the setting: Bit looking at the screen must see the game, not
            // its own card, and a screenshot from the menu must not show it.
            // A drawing is meant to be seen, in a recording too.
            let key = &l.surface.key;
            let own = spec::is_alerts(key) || spec::is_menu(key);
            let _ = win.set_content_protected((spec.exclude && !spec::is_draw(key)) || own);
        }
        plans.push(plan(app, l));
    }
    let _ = app.run_on_main_thread(move || backend::apply(plans));
    // Moved onto the screen only after `apply` is queued: a new window must
    // not sit full size, taking clicks and focus, before it is set up.
    #[cfg(not(windows))]
    for l in live.iter() {
        if let Some(win) = app.get_webview_window(&l.label) {
            place(app, &win, &l.surface);
        }
    }
}

/// The main window left the "widgets only" driver for the dashboard. Only the
/// driver asks for the alerts window, and a dashboard with nothing placed sends
/// no sync at all (layers-shell.js), so the window would stay. Plain thread:
/// `sync` can hold LIVE while it waits on the main thread.
pub fn driver_left(app: &AppHandle) {
    let Ok(mut live) = LIVE.lock() else { return };
    let before = live.len();
    live.retain(|l| {
        let alerts = spec::is_alerts(&l.surface.key);
        if alerts {
            close(app, &l.label);
        }
        !alerts
    });
    if live.len() == before {
        return;
    }
    let plans: Vec<backend::Plan> = live.iter().map(|l| plan(app, l)).collect();
    let _ = app.run_on_main_thread(move || backend::apply(plans));
}

/// `xenon-app:saver-done` from a screensaver page: the user is back. Close
/// every screensaver now rather than wait for the server's next status.
/// Plain thread, like `sync`.
fn saver_done(app: &AppHandle) {
    SAVER_DONE.store(true, Ordering::Relaxed);
    let Ok(mut live) = LIVE.lock() else { return };
    live.retain(|l| {
        let saver = l.surface.kind == Kind::Saver;
        if saver {
            close(app, &l.label);
        }
        !saver
    });
    let plans: Vec<backend::Plan> = live.iter().map(|l| plan(app, l)).collect();
    let _ = app.run_on_main_thread(move || backend::apply(plans));
}

/// `xenon-app:ai-glow` from the main dashboard: light the edges of the chosen
/// screens while Xenon AI listens, thinks or speaks (glow.rs). Call on a plain
/// thread: the monitor lookup goes through the event loop.
pub fn glow(app: &AppHandle, url: &tauri::Url) {
    let Some(spec) = payload(url).as_deref().and_then(glow::parse) else { return };
    // A monitor that is gone resolves to the main one; the same screen twice
    // is drawn once (glow_backend::apply).
    let monitors = spec.monitors.iter().filter_map(|id| crate::monitor::layer_monitor(app, id)).collect();
    paint_glow(app, spec.state, spec.rgb, spec.still, monitors);
}

/// The same from the on-screen alerts window, where Bit answers in "widgets
/// only" (server/js/screen-bit.js). It names the screens setting, not the
/// screens: only the main webview gets the display list. Plain thread.
fn glow_from_alerts(app: &AppHandle, url: &tauri::Url) {
    let Some(spec) = payload(url).as_deref().and_then(glow::parse_screens) else { return };
    let mut monitors = Vec::new();
    if spec.state != glow::State::Off {
        let all = crate::monitor::monitors_with_primary(app);
        let primary: Vec<bool> = all.iter().map(|(_, p)| *p).collect();
        let picked = glow::pick(spec.screens, &primary);
        monitors = all.into_iter().enumerate().filter(|(i, _)| picked.contains(i)).map(|(_, (m, _))| m).collect();
    }
    paint_glow(app, spec.state, spec.rgb, spec.still, monitors);
}

fn paint_glow(app: &AppHandle, state: glow::State, rgb: [u8; 3], still: bool, monitors: Vec<tauri::Monitor>) {
    let screens = monitors.iter().map(glow_backend::Screen::of).collect();
    let plan = glow_backend::Plan { state, rgb, still, screens };
    let _ = app.run_on_main_thread(move || glow_backend::apply(plan));
}

/// Desktop and overlay layers cover their monitor's work area (the screen minus
/// the taskbar), the scenes the whole screen; a monitor that is gone falls back
/// to the main one.
#[cfg(windows)]
fn plan(app: &AppHandle, l: &Live) -> win32::Plan {
    let whole = matches!(l.surface.kind, Kind::Wallpaper | Kind::Saver | Kind::Menu);
    let area = match l.surface.kind {
        Kind::Anchor => ffi::Rect::default(),
        _ => crate::monitor::layer_monitor(app, &l.surface.monitor)
            .map(|m| {
                let (p, s) = if whole {
                    (*m.position(), *m.size())
                } else {
                    let w = m.work_area();
                    (w.position, w.size)
                };
                ffi::Rect { l: p.x, t: p.y, r: p.x + s.width as i32, b: p.y + s.height as i32 }
            })
            .unwrap_or_default(),
    };
    win32::Plan { hwnd: l.handle, kind: l.surface.kind, area, anchor: l.surface.anchor.clone() }
}

/// Off Windows the window is put on its screen by `place`, in `sync`; an
/// anchored one by the backend, next to its app.
#[cfg(target_os = "macos")]
fn plan(_app: &AppHandle, l: &Live) -> backend::Plan {
    backend::Plan { handle: l.handle, kind: l.surface.kind, anchor: l.surface.anchor.clone() }
}

/// Linux sizes a wallpaper itself, before mapping it (`linux::show_wallpaper`),
/// and a layer-shell surface takes its monitor from the same rectangle.
#[cfg(target_os = "linux")]
fn plan(app: &AppHandle, l: &Live) -> backend::Plan {
    let area = logical_rect(app, &l.surface)
        .map(|(x, y, w, h)| [x.round() as i32, y.round() as i32, w.round() as i32, h.round() as i32]);
    backend::Plan { handle: l.handle, kind: l.surface.kind, area, anchor: l.surface.anchor.clone() }
}

/// The window on its monitor's work area (the screen minus the menu bar and
/// the Dock, or the panels), the scenes on the whole screen. Plain thread:
/// Tauri hands the move to the main thread. Positions go in logical units: the
/// physical ones are scaled by each monitor's own factor.
#[cfg(not(windows))]
fn place(app: &AppHandle, win: &tauri::WebviewWindow, s: &Surface) {
    // A layer surface is sized and placed by the compositor (layer_shell.rs).
    #[cfg(target_os = "linux")]
    if linux::layer_shell() {
        return;
    }
    // An anchored widget sits next to its app, not on a monitor.
    if s.kind == Kind::Anchor {
        return;
    }
    let Some((x, y, width, height)) = logical_rect(app, s) else {
        return;
    };
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    let _ = win.set_size(tauri::LogicalSize::new(width, height));
    // Full screen on the monitor it was just moved to: over the panels too.
    #[cfg(target_os = "linux")]
    if matches!(s.kind, Kind::Saver | Kind::Draw | Kind::Menu) {
        let _ = win.set_fullscreen(true);
    }
}

/// Where a surface goes, in logical units: its monitor's work area, the whole
/// monitor for the scenes and the drawing sheet.
#[cfg(not(windows))]
fn logical_rect(app: &AppHandle, s: &Surface) -> Option<(f64, f64, f64, f64)> {
    if s.kind == Kind::Anchor {
        return None;
    }
    let m = crate::monitor::layer_monitor(app, &s.monitor)?;
    let scale = m.scale_factor();
    let (pos, size) = if matches!(s.kind, Kind::Wallpaper | Kind::Saver | Kind::Draw | Kind::Menu) {
        (*m.position(), *m.size())
    } else {
        let area = m.work_area();
        (area.position, area.size)
    };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    Some((pos.x, pos.y, size.width, size.height))
}

/// A layer window was just hidden (desktop layer covered by a full-screen app,
/// anchored app minimized) or shown again: let its webview give memory back
/// meanwhile (crate::memory_level). Found by handle, not through LIVE: this
/// runs on the main thread, and `sync` can hold LIVE while it waits on that
/// thread to build a window. A hidden wallpaper also stops its page: nothing
/// animates behind a full-screen window (`scene-` windows).
#[cfg(windows)]
fn memory_for(hwnd: isize, low: bool) {
    let Some(app) = APP.get() else { return };
    let found = app.webview_windows().into_values().find(|w| {
        (w.label().starts_with("layer-") || w.label().starts_with("scene-"))
            && w.hwnd().ok().map(|h| h.0 as isize) == Some(hwnd)
    });
    let Some(win) = found else { return };
    crate::memory_level::set_low(&win, low);
    if win.label().starts_with("scene-") {
        crate::memory_level::set_visible(&win, !low);
    }
}

#[cfg(windows)]
fn native_handle(win: &tauri::WebviewWindow) -> Option<isize> {
    Some(win.hwnd().ok()?.0 as isize)
}

#[cfg(target_os = "macos")]
fn native_handle(win: &tauri::WebviewWindow) -> Option<isize> {
    Some(win.ns_window().ok()? as isize)
}

#[cfg(target_os = "linux")]
fn native_handle(win: &tauri::WebviewWindow) -> Option<isize> {
    Some(linux::handle_of(&win.gtk_window().ok()?))
}

fn close(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.destroy();
    }
}

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

fn open(app: &AppHandle, s: &Surface) -> Option<Live> {
    let prefix = if spec::is_scene(&s.key) { "scene" } else { "layer" };
    let label = format!("{prefix}-{}", NEXT_LABEL.fetch_add(1, Ordering::Relaxed));
    let handle = app.clone();
    let own = label.clone();
    let alerts = spec::is_alerts(&s.key);
    let menu = spec::is_menu(&s.key);
    let kind = s.kind;
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(layer_url(&s.key)?))
        .title("Xenon widgets")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        // Built visible and out of sight: win32::apply puts it in place. A
        // window built hidden and shown natively would keep its webview hidden.
        .visible(true)
        .inner_size(1.0, 1.0)
        .position(-32000.0, -32000.0)
        .initialization_script(LAYER_SHIM)
        .on_navigation(move |url| navigate(&handle, &own, alerts, kind, url));
    let builder = if alerts { builder.initialization_script(ALERTS_CAPS) } else { builder };
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
            // Bit's cards and the menu are Xenon's own, never what the user
            // captures (and `sync` keeps it so).
            if alerts || menu {
                let _ = win.set_content_protected(true);
            }
            Some(Live { label, handle, surface: s.clone() })
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
fn navigate(app: &AppHandle, label: &str, alerts: bool, kind: Kind, url: &tauri::Url) -> bool {
    let loopback = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    match url.scheme() {
        "http" | "https" if loopback => true,
        "http" | "https" => {
            use tauri_plugin_opener::OpenerExt;
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
        // Its update card, or the Xenon menu's gallery, Settings and
        // dashboard rows: the dashboard, on that screen. Only those windows,
        // only those screens (spec::dashboard_page).
        "xenon-app" if alerts || kind == Kind::Menu => {
            let query = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
            let (open, cat) = (query("open"), query("cat"));
            if let Some((page, cat)) = spec::dashboard_page(url.path(), open.as_deref(), cat.as_deref(), kind == Kind::Menu) {
                crate::monitor::open_dashboard(app, page, cat);
            }
            false
        }
        _ => false,
    }
}

/// Runs on the main thread (navigation hooks do), like win32::set_region.
fn report_rects(app: &AppHandle, label: &str, url: &tauri::Url, editing: Option<bool>) {
    let Some(win) = app.get_webview_window(label) else { return };
    let Some(handle) = native_handle(&win) else { return };
    let rects = spec::parse_rects(&payload(url).unwrap_or_default());
    backend::set_region(handle, rects, editing);
}

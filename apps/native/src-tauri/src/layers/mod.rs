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
#[cfg(windows)]
mod clicks_win32;
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
mod pad_sony;
#[cfg(windows)]
pub use pad_sony::READER_ARG as PAD_READER_ARG;
#[cfg(windows)]
pub use pad_winmm::serve as pad_reader;
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
mod menu_window;
#[cfg(any(windows, test))]
mod roll;
#[cfg(windows)]
mod scene;
mod shield;
mod spec;
#[cfg(windows)]
mod win32;
mod supports;
mod page;
mod signals;
mod window;



use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

use spec::{Kind, Surface};

pub use signals::{driver_left, force_focus, keep_focus_here, open_asked_dashboard, sync};
pub use supports::{draws_anchor, draws_menu, draws_scene, draws_sheet};
/// How the windows behave on this OS: the same `Plan`, `apply` and `set_region`.
#[cfg(target_os = "linux")]
use linux as backend;
#[cfg(target_os = "macos")]
use macos as backend;
// The glow has a file of its own with the same name as this function: both are reached as `layers::glow`.
pub use signals::glow;

struct Live {
    label: String,
    /// The native window: its HWND, its NSWindow on macOS, its GtkWindow on Linux.
    handle: isize,
    surface: Surface,
    /// Whether it stays out of captures, as told and as wanted (shield.rs).
    shield: shield::Shield,
    /// Where the menu's window opened (`menu_window`); nothing for the others.
    #[cfg(windows)]
    opened_at: menu_window::Rect,
}

/// The open layer windows. Touched only by `sync`, which holds the lock for the
/// whole pass, so two syncs never race on the same window.
static LIVE: Mutex<Vec<Live>> = Mutex::new(Vec::new());
static NEXT_LABEL: AtomicU32 = AtomicU32::new(1);
/// For the backends' main-thread code, which runs with no handle (`memory_for`,
/// the macOS cursor watch).
static APP: OnceLock<AppHandle> = OnceLock::new();
/// The menu's window opens Settings in place: spec::menu_caps_script.
static MENU_CAPS: OnceLock<String> = OnceLock::new();

/// Called once, with the main window's capabilities, before any layer exists.
pub fn set_menu_caps(caps: &serde_json::Value) {
    let _ = MENU_CAPS.set(spec::menu_caps_script(caps));
}
/// A screensaver was ended by the user: none opens again until a sync comes
/// without one, i.e. the server saw the input and the idle time started over.
static SAVER_DONE: AtomicBool = AtomicBool::new(false);
/// The menu stepped aside for a one-shot function: a sync must not bring it back.
static MENU_ASIDE: AtomicBool = AtomicBool::new(false);

fn menu_aside() -> bool {
    MENU_ASIDE.load(Ordering::Relaxed)
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

/// Desktop and overlay layers cover their monitor's work area (the screen minus
/// the taskbar), the scenes the whole screen; a monitor that is gone falls back
/// to the main one.
#[cfg(windows)]
fn plan(app: &AppHandle, l: &Live) -> win32::Plan {
    let whole = matches!(l.surface.kind, Kind::Wallpaper | Kind::Saver);
    let area = match l.surface.kind {
        Kind::Anchor => ffi::Rect::default(),
        Kind::Menu => {
            let [x, y, w, h] = l.opened_at;
            ffi::Rect { l: x, t: y, r: x + w, b: y + h }
        }
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
    let Some((x, y, width, height)) = logical_rect(app, s) else {
        return;
    };
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    let _ = win.set_size(tauri::LogicalSize::new(width, height));
    // Full screen on the monitor it was just moved to: over the panels too.
    #[cfg(target_os = "linux")]
    if matches!(s.kind, Kind::Saver | Kind::Draw) {
        let _ = win.set_fullscreen(true);
    }
}

/// Where a surface goes, in logical units: its monitor's work area, the whole
/// monitor for the scenes and the drawing sheet. Nowhere for an anchored widget,
/// which sits next to its app, and for the menu, which the user moves.
#[cfg(not(windows))]
fn logical_rect(app: &AppHandle, s: &Surface) -> Option<(f64, f64, f64, f64)> {
    if matches!(s.kind, Kind::Anchor | Kind::Menu) {
        return None;
    }
    let m = crate::monitor::layer_monitor(app, &s.monitor)?;
    let scale = m.scale_factor();
    let (pos, size) = if matches!(s.kind, Kind::Wallpaper | Kind::Saver | Kind::Draw) {
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

/// After the event loop has really taken the window down.
#[cfg(windows)]
fn repaint_desktop_soon() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(400));
        scene::repaint_desktop();
    });
}

fn close(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.destroy();
    }
}

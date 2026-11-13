// Finds the Xeneon Edge among the screens and tells whether the window still sits on its screen.

use tauri::{Manager, Monitor, PhysicalSize, WebviewWindow};
use super::display_info::virtual_display_names;
use super::screens::{current_of, monitors_of, on_main};

/// Native resolution of the CORSAIR Xeneon Edge 14.5" panel.
pub(super) const EDGE_WIDTH: u32 = 2560;
pub(super) const EDGE_HEIGHT: u32 = 720;

/// True when a reported size IS the Edge panel, in EITHER orientation.
///
/// The OS reports the rotated mode, so a panel the user has mounted vertically
/// answers 720×2560 and an ordered comparison stops recognising it. That was not
/// a cosmetic loss: `is_edge_panel` has no name fallback, so a vertical Edge fell
/// out of the kiosk path entirely and opened as a decorated window at 88% of the
/// screen, with the "(Xeneon Edge)" chip gone from the picker that would have let
/// the user say otherwise. Reported by a user who wanted a vertical mount.
///
/// A monitor genuinely 720 wide and 2560 tall that is NOT an Edge gets the kiosk
/// treatment under `Auto`, which is the same bet the landscape signature already
/// makes on 2560×720, and the screen picker is there to override it.
pub(super) fn is_edge_size(size: PhysicalSize<u32>) -> bool {
    (size.width == EDGE_WIDTH && size.height == EDGE_HEIGHT)
        || (size.width == EDGE_HEIGHT && size.height == EDGE_WIDTH)
}

/// True when a monitor's physical size matches the Edge panel. Some hubs also let
/// us confirm via the device name, but the exact panel size is the reliable
/// signal across DisplayPort/USB-C connections.
fn is_edge(monitor: &Monitor) -> bool {
    if is_edge_size(*monitor.size()) {
        return true;
    }
    // Secondary hint: a name containing "Xeneon" / "Edge" (best-effort only).
    matches!(monitor.name(), Some(name)
        if { let n = name.to_lowercase(); n.contains("xeneon") || n.contains("edge") })
}

/// Locate the Edge among the currently connected monitors, if present.
///
/// A virtual display can advertise 2560×720 too (Xenon's own second-screen driver
/// offers that mode), so `is_edge` alone can land the kiosk on a screen the user
/// cannot see. We therefore prefer a match that is NOT a known virtual display,
/// and fall back to the plain first match — if the virtual-display lookup is
/// wrong or unavailable, the worst case is the old behaviour rather than no Edge
/// at all.
pub(super) fn find_edge(window: &WebviewWindow) -> Option<Monitor> {
    find_edge_in(monitors_of(window)?)
}

/// The same search over a list read from anywhere — the window, or the app handle
/// before a window exists (see `opens_as_kiosk`).
pub(super) fn find_edge_in(monitors: Vec<Monitor>) -> Option<Monitor> {
    let candidates: Vec<Monitor> = monitors.into_iter().filter(is_edge).collect();
    if candidates.len() < 2 {
        return candidates.into_iter().next();
    }
    let virtual_names = virtual_display_names();
    let is_virtual = |m: &Monitor| {
        matches!(m.name(), Some(name) if virtual_names.iter().any(|v| v == name))
    };
    let real = candidates.iter().position(|m| !is_virtual(m));
    let pick = real.unwrap_or(0);
    candidates.into_iter().nth(pick)
}

/// Whether the window currently sits on the given monitor (compared by origin).
pub(super) fn window_is_on(window: &WebviewWindow, monitor: &Monitor) -> bool {
    match current_of(window) {
        Some(current) => current.position() == monitor.position(),
        None => false,
    }
}

/// Whether the window has been minimized, by anything: Xenon itself never does it.
pub(super) fn minimized(window: &WebviewWindow) -> bool {
    let w = window.clone();
    on_main(window.app_handle(), move || w.is_minimized().unwrap_or(false)).unwrap_or(false)
}

/// Whether the kiosk has left its screen: moved off it, or minimized.
///
/// A minimized window still answers for the screen it came from, so the origin
/// alone reads it as in place, and the kiosk has no taskbar button to bring it back
/// with. Windows 11 minimizes windows when a monitor goes away, its default, and a
/// KVM switch takes one away. Reported on Discord: the Edge showed the desktop
/// after every switch until "Automatic" was picked in the tray.
pub(super) fn kiosk_off_screen(on_it: bool, minimized: bool) -> bool {
    !on_it || minimized
}

/// Bring a minimized window back without taking the foreground from whatever is
/// in use, a game included. `unminimize` would: it is `SW_RESTORE`, which activates.
#[cfg(windows)]
pub(super) fn restore_quietly(window: &WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    }
    const SW_SHOWNOACTIVATE: i32 = 4;
    if !minimized(window) {
        return;
    }
    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        ShowWindow(hwnd.0 as isize, SW_SHOWNOACTIVATE);
    }
}

#[cfg(not(windows))]
pub(super) fn restore_quietly(window: &WebviewWindow) {
    if minimized(window) {
        let _ = window.unminimize();
    }
}

/// True when this monitor IS the Edge panel, judged on size alone (either
/// orientation — see `is_edge_size`).
///
/// Deliberately not `is_edge`: that one also matches any display whose OS name
/// merely contains "edge" or "xeneon", which is a fine hint for the auto-pin and
/// a trap here. Under "an explicit choice wins", a false positive would drop the
/// user's chosen monitor into a borderless, undecorated, taskbar-hidden window
/// with no title bar and no way out.
pub(super) fn is_edge_panel(monitor: &Monitor) -> bool {
    is_edge_size(*monitor.size())
}

/// True when a Xeneon Edge is connected right now.
pub fn edge_present(window: &WebviewWindow) -> bool {
    find_edge(window).is_some()
}

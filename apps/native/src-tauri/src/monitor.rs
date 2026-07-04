//! Xeneon Edge monitor targeting + kiosk watchdog.
//!
//! The Edge reports its native panel resolution of 2560×720. We find the monitor
//! with that physical size and pin the borderless kiosk window to it, then keep a
//! lightweight watchdog running so the window returns to the Edge after Windows
//! reorders displays, the panel is unplugged/replugged, or the PC resumes from
//! standby. If the Edge is not present, we degrade gracefully (leave the window on
//! the primary display, full-screen) and re-place it the moment the Edge appears.

use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, WebviewWindow};

/// Native resolution of the CORSAIR Xeneon Edge 14.5" panel.
const EDGE_WIDTH: u32 = 2560;
const EDGE_HEIGHT: u32 = 720;

/// How often the watchdog re-checks the window is on the Edge.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);

/// True when a monitor's physical size matches the Edge panel. Some hubs also let
/// us confirm via the device name, but the exact 2560×720 size is the reliable
/// signal across DisplayPort/USB-C connections.
fn is_edge(monitor: &Monitor) -> bool {
    let size = monitor.size();
    if size.width == EDGE_WIDTH && size.height == EDGE_HEIGHT {
        return true;
    }
    // Secondary hint: a name containing "Xeneon" / "Edge" (best-effort only).
    matches!(monitor.name(), Some(name)
        if { let n = name.to_lowercase(); n.contains("xeneon") || n.contains("edge") })
}

/// Locate the Edge among the currently connected monitors, if present.
fn find_edge(window: &WebviewWindow) -> Option<Monitor> {
    window
        .available_monitors()
        .ok()?
        .into_iter()
        .find(is_edge)
}

/// Whether the window currently sits on the given monitor (compared by origin).
fn window_is_on(window: &WebviewWindow, monitor: &Monitor) -> bool {
    match window.current_monitor() {
        Ok(Some(current)) => current.position() == monitor.position(),
        _ => false,
    }
}

/// Move the kiosk window onto the Edge and make it borderless full-screen there.
///
/// Fullscreen follows the monitor the window sits on, so we must drop fullscreen,
/// move onto the Edge origin, then re-enter fullscreen — otherwise `set_position`
/// is ignored while the window is still fullscreen on another display.
fn place_on_edge(window: &WebviewWindow, edge: &Monitor) {
    let origin: PhysicalPosition<i32> = *edge.position();
    let _ = window.set_fullscreen(false);
    let _ = window.set_position(origin);
    let _ = window.set_fullscreen(true);
    let _ = window.set_focus();
}

/// Place the window on the Edge now if it is connected; otherwise leave it
/// full-screen on the primary display. Called once at startup.
pub fn place_now(window: &WebviewWindow) {
    match find_edge(window) {
        Some(edge) => place_on_edge(window, &edge),
        None => {
            // Edge not connected yet — stay full-screen on whatever we opened on.
            let _ = window.set_fullscreen(true);
        }
    }
}

/// Start the background watchdog. Re-pins the window to the Edge whenever it is
/// present but the window has drifted off it (display reorder, replug, resume).
///
/// Captures the `AppHandle` (Send + Sync) and looks the window up each tick, so
/// the loop stops cleanly once the window is gone.
pub fn start_watchdog(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(WATCHDOG_INTERVAL);

        let window = match app.get_webview_window("main") {
            Some(w) => w,
            None => break, // window destroyed → stop the watchdog
        };

        if let Some(edge) = find_edge(&window) {
            if !window_is_on(&window, &edge) {
                place_on_edge(&window, &edge);
            }
        }
    });
}

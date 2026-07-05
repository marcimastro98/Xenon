//! Xeneon Edge monitor targeting + kiosk watchdog.
//!
//! The Edge reports its native panel resolution of 2560×720. We find the monitor
//! with that physical size and pin the borderless kiosk window to it, then keep a
//! lightweight watchdog running so the window returns to the Edge after Windows
//! reorders displays, the panel is unplugged/replugged, or the PC resumes from
//! standby. If the Edge is not present, we degrade gracefully to an ordinary
//! resizable desktop window (usable on any laptop or monitor) and upgrade it to
//! the full kiosk the moment the Edge appears.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow,
};

use crate::prefs;

/// Native resolution of the CORSAIR Xeneon Edge 14.5" panel.
const EDGE_WIDTH: u32 = 2560;
const EDGE_HEIGHT: u32 = 720;

/// Height (physical px) of the "home indicator" strip the kiosk shrinks to when
/// the user swipes up to the desktop. Full width, pinned to the *top* edge so the
/// Windows taskbar (bottom of the screen) stays fully reachable behind it.
const HOME_BAR_HEIGHT: u32 = 36;

/// True while the kiosk is collapsed to the home-bar strip (user swiped up to the
/// Windows desktop). The watchdog checks this and leaves the window alone so it
/// does not immediately re-pin it back to full-screen. Set by `enter_home`,
/// cleared by `exit_home`.
pub static HOME_MODE: AtomicBool = AtomicBool::new(false);

/// Widest the windowed dashboard opens; the actual size is capped to fit the
/// monitor so it never spills off a small screen. The window keeps the Edge's
/// 3.556:1 aspect so the wide dashboard layout is never distorted.
const MAX_WINDOW_WIDTH: f64 = 1600.0;
const WINDOW_ASPECT: f64 = EDGE_WIDTH as f64 / EDGE_HEIGHT as f64;

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
    // Enforce the kiosk chrome: borderless and hidden from the taskbar/Alt-Tab, so
    // that upgrading a windowed session (no Edge → Edge plugged in) becomes a full
    // kiosk, not just a full-screen window with a title bar.
    let _ = window.set_decorations(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_position(origin);
    let _ = window.set_fullscreen(true);
    let _ = window.set_focus();
}

/// A window size that fits inside the given monitor (never wider or taller than
/// the screen), keeping the Edge's wide aspect so the dashboard is not distorted.
fn windowed_size_for(monitor: &Monitor) -> LogicalSize<f64> {
    let scale = monitor.scale_factor();
    let mon_w = monitor.size().width as f64 / scale;
    let mon_h = monitor.size().height as f64 / scale;
    let mut w = (mon_w * 0.92).min(MAX_WINDOW_WIDTH);
    let mut h = w / WINDOW_ASPECT;
    let max_h = mon_h * 0.9;
    if h > max_h {
        h = max_h;
        w = h * WINDOW_ASPECT;
    }
    // Never ask for less than the window's own minimum (640×240).
    LogicalSize::new(w.max(640.0), h.max(240.0))
}

/// Ordinary, controllable desktop window on the given monitor: a title bar, a
/// taskbar entry, sized to fit that screen and centred on it. Used off the Edge —
/// the kiosk chrome would trap the user in a borderless fullscreen with no way out.
fn place_windowed_on(window: &WebviewWindow, monitor: &Monitor) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_size(windowed_size_for(monitor));
    // Sit on the target monitor, then centre within it.
    let _ = window.set_position(*monitor.position());
    let _ = window.center();
    let _ = window.set_focus();
}

/// Full-screen on the given monitor, but still reachable on an ordinary PC: it
/// stays in the taskbar / Alt-Tab and a title bar returns if the user leaves
/// full-screen from the tray. (This is the non-Edge "fullscreen" choice — distinct
/// from the borderless, taskbar-hidden Edge kiosk in `place_on_edge`.)
fn place_fullscreen_on(window: &WebviewWindow, monitor: &Monitor) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_position(*monitor.position());
    let _ = window.set_fullscreen(true);
    let _ = window.set_focus();
}

/// The primary monitor, or the first available one if the primary is unknown.
fn primary_or_first(window: &WebviewWindow) -> Option<Monitor> {
    window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.available_monitors().ok().and_then(|m| m.into_iter().next()))
}

/// Find a connected monitor by its OS name (best-effort; `None` if it is gone).
fn monitor_by_name(window: &WebviewWindow, name: &str) -> Option<Monitor> {
    window
        .available_monitors()
        .ok()?
        .into_iter()
        .find(|m| m.name().map(|n| n.to_string()).as_deref() == Some(name))
}

/// The monitor a saved preference points at, falling back to the primary display.
fn preferred_monitor(window: &WebviewWindow, prefs: &prefs::DisplayPrefs) -> Option<Monitor> {
    prefs
        .monitor
        .as_deref()
        .and_then(|n| monitor_by_name(window, n))
        .or_else(|| primary_or_first(window))
}

/// True when a Xeneon Edge is connected right now.
pub fn edge_present(window: &WebviewWindow) -> bool {
    find_edge(window).is_some()
}

/// No Edge connected: open per the user's saved display preference (windowed by
/// default, or full-screen on their chosen monitor), fitted to whatever screen
/// this PC has. The watchdog still upgrades to the Edge kiosk if one appears.
pub fn apply_prefs(window: &WebviewWindow) {
    let prefs = prefs::load(window.app_handle());
    match preferred_monitor(window, &prefs) {
        Some(monitor) if prefs.fullscreen => place_fullscreen_on(window, &monitor),
        Some(monitor) => place_windowed_on(window, &monitor),
        None => {
            // No monitor info at all — fall back to a plain windowed state.
            let _ = window.set_fullscreen(false);
            let _ = window.set_decorations(true);
            let _ = window.set_skip_taskbar(false);
        }
    }
}

/// Place the window on the Edge now if it is connected; otherwise present it per
/// the saved display preference. Called once at startup.
pub fn place_now(window: &WebviewWindow) {
    match find_edge(window) {
        Some(edge) => place_on_edge(window, &edge),
        None => apply_prefs(window),
    }
}

/// Swipe-up-to-desktop: collapse the kiosk to a slim, always-on-top strip along
/// the top edge of the Edge (or, off the Edge, the monitor it currently sits on),
/// revealing the Windows desktop behind it. The strip sits at the *top* on purpose:
/// pinned to the bottom it would sit over the Windows taskbar and block it, and the
/// whole point of dropping to the desktop is to reach the taskbar. The dashboard
/// itself draws the grab handle in that strip (see `native-bridge.js`); here we only
/// reshape the OS window. The watchdog is paused via `HOME_MODE` so it will not yank
/// the window back to full-screen while the user is on the desktop.
pub fn enter_home(window: &WebviewWindow) {
    HOME_MODE.store(true, Ordering::SeqCst);
    let target = find_edge(window)
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| primary_or_first(window));
    // The kiosk carries a 640×240 minimum; drop it so the strip can be this thin.
    let _ = window.set_min_size(None::<LogicalSize<f64>>);
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(false);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_always_on_top(true);
    if let Some(monitor) = target {
        let origin: PhysicalPosition<i32> = *monitor.position();
        let size = monitor.size();
        let strip_h = HOME_BAR_HEIGHT.min(size.height);
        let _ = window.set_size(PhysicalSize::new(size.width, strip_h));
        // Top edge of the monitor, so the taskbar at the bottom stays uncovered.
        let _ = window.set_position(PhysicalPosition::new(origin.x, origin.y));
    }
    let _ = window.set_focus();
}

/// Return from the desktop: restore the kiosk to its normal placement (Edge kiosk
/// if the Edge is connected, otherwise the saved windowed/full-screen preference),
/// re-arm the minimum size, drop always-on-top, and let the watchdog run again.
pub fn exit_home(window: &WebviewWindow) {
    HOME_MODE.store(false, Ordering::SeqCst);
    let _ = window.set_always_on_top(false);
    let _ = window.set_min_size(Some(LogicalSize::new(640.0, 240.0)));
    place_now(window);
    let _ = window.set_focus();
}

/// Human-readable labels for each connected monitor, in enumeration order — used
/// to build the tray's "show on which display" picker.
pub fn monitor_labels(window: &WebviewWindow) -> Vec<String> {
    window
        .available_monitors()
        .ok()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let s = m.size();
            format!("Display {} — {}×{}", i + 1, s.width, s.height)
        })
        .collect()
}

/// Tray action: switch the (non-Edge) window between full-screen and windowed and
/// remember the choice. A no-op while the Edge kiosk owns the panel.
pub fn set_fullscreen_pref(app: &AppHandle, on: bool) {
    let Some(window) = app.get_webview_window("main") else { return };
    if edge_present(&window) {
        return;
    }
    let mut prefs = prefs::load(app);
    prefs.fullscreen = on;
    prefs::save(app, &prefs);
    if let Some(monitor) = preferred_monitor(&window, &prefs) {
        if on {
            place_fullscreen_on(&window, &monitor);
        } else {
            place_windowed_on(&window, &monitor);
        }
    }
}

/// Tray action: move the (non-Edge) window onto the monitor at `index` (matching
/// `monitor_labels`), preserving the current full-screen/windowed choice, and
/// remember it. A no-op while the Edge kiosk owns the panel.
pub fn move_to_monitor(app: &AppHandle, index: usize) {
    let Some(window) = app.get_webview_window("main") else { return };
    if edge_present(&window) {
        return;
    }
    let Some(monitor) = window
        .available_monitors()
        .ok()
        .and_then(|list| list.into_iter().nth(index))
    else {
        return;
    };
    let mut prefs = prefs::load(app);
    prefs.monitor = monitor.name().map(|n| n.to_string());
    prefs::save(app, &prefs);
    if prefs.fullscreen {
        place_fullscreen_on(&window, &monitor);
    } else {
        place_windowed_on(&window, &monitor);
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

        // The user deliberately dropped to the home-bar strip — don't fight it.
        if HOME_MODE.load(Ordering::SeqCst) {
            continue;
        }

        if let Some(edge) = find_edge(&window) {
            if !window_is_on(&window, &edge) {
                place_on_edge(&window, &edge);
            }
        }
    });
}

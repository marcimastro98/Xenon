// Where the window opens at launch, before any watchdog runs.

use tauri::{AppHandle, Monitor, WebviewWindow};
use crate::prefs;
use crate::prefs::Placement;
use super::edge::{EDGE_HEIGHT, EDGE_WIDTH, find_edge_in, is_edge_panel};
use super::ids::find_by_id;
use super::pick::pick_in;
use super::place::{monitor_rect, point, windowed_size_for};
#[cfg(target_os = "macos")]
use super::place::wait_until_on;
use super::screens::{app_monitors, app_primary, monitors_of, primary_of};

/// How the window should be BUILT — its size, and whether it starts full-screen —
/// decided before it exists and before `place_now` can measure anything.
/// Returns `(width, height, fullscreen)`, the size in logical pixels.
///
/// The builder used to hardcode 2560×720 and `fullscreen(true)`: the Edge panel's
/// exact resolution, and the Edge's own final state, on every machine. On macOS,
/// where the window cannot be built full-screen at all (see the note in `lib.rs`),
/// that first frame was an Edge-shaped window on a machine with no Edge; elsewhere
/// it was a full-screen window that `place_now` shrank a moment later — a launch
/// that covers the whole desktop for a frame and then does not.
///
/// This mirrors `resolve`, deliberately and in the same order, because the only
/// useful question here is "what will `place_now` do a moment from now". An
/// approximation of that question is not cheaper, it is just wrong in both
/// directions: judging the Edge by SIZE ALONE misses one recognised by name only
/// (the hub case `is_edge` exists for) and, worse, matches Xenon's own virtual
/// second-screen display, which advertises 2560×720 — so a user who had chosen a
/// real monitor got the full-screen flash this is meant to remove.
pub fn initial_window(app: &AppHandle, prefs: &prefs::DisplayPrefs) -> (f64, f64, bool) {
    let (target, fullscreen) = initial_target(app, prefs);
    match target {
        Some(m) => {
            if fullscreen {
                let scale = m.scale_factor();
                let size = m.size();
                (
                    size.width as f64 / scale,
                    size.height as f64 / scale,
                    true,
                )
            } else {
                let size = windowed_size_for(&m);
                (size.width, size.height, false)
            }
        }
        // No monitor answered — the Edge's own size is as good a guess as any,
        // and `place_now` corrects it as soon as a screen can be read.
        None => (EDGE_WIDTH as f64, EDGE_HEIGHT as f64, false),
    }
}

/// The OS name of the screen the window is about to open on, for `gpu::arm`:
/// the render GPU has to be the one driving THAT screen, and it is chosen before
/// any window exists.
pub fn initial_screen_name(app: &AppHandle, prefs: &prefs::DisplayPrefs) -> Option<String> {
    initial_target(app, prefs).0.and_then(|m| m.name().cloned())
}

/// `(target screen, kiosk-or-fullscreen)` before the window exists, mirroring
/// `resolve` (see `initial_window` for why it must).
fn initial_target(app: &AppHandle, prefs: &prefs::DisplayPrefs) -> (Option<Monitor>, bool) {
    let monitors = app_monitors(app);
    let primary = app_primary(app);
    // (target screen, kiosk-or-fullscreen), mirroring `resolve`.
    let (target, fullscreen) = match prefs.placement {
        // Nothing on this PC. A deliberate launch still shows an ORDINARY window
        // (see `apply_target`), so size it like one and never full-screen.
        Placement::Phone => (primary, false),
        Placement::Screen => {
            // The same rule as `chosen_monitor`, so the first frame and the
            // first placement agree on the screen.
            let chosen = pick_in(
                &monitors,
                prefs.monitor.as_deref(),
                prefs.monitor_fingerprint.as_deref(),
            )
            .index()
            .map(|i| monitors[i].clone());
            match chosen {
                // The Edge chosen by name is the kiosk; any other screen honours
                // the saved full-screen preference.
                Some(m) => {
                    let fs = is_edge_panel(&m) || prefs.fullscreen;
                    (Some(m), fs)
                }
                // Chosen screen unplugged: the window will be hidden. Size it as a
                // plain window so that revealing it from the tray is not a surprise.
                None => (primary, false),
            }
        }
        Placement::Auto => match find_edge_in(monitors.clone()) {
            Some(edge) => (Some(edge), true),
            None => {
                let preferred = prefs
                    .monitor
                    .as_deref()
                    .and_then(|id| find_by_id(&monitors, id))
                    .map(|i| monitors[i].clone())
                    .or(primary);
                let fs = prefs.fullscreen;
                (preferred, fs)
            }
        },
    };
    (target.or_else(|| monitors.into_iter().next()), fullscreen)
}

/// Ordinary, controllable desktop window on the given monitor: a title bar, a
/// taskbar entry, sized to fit that screen and centred on it. Used off the Edge —
/// the kiosk chrome would trap the user in a borderless fullscreen with no way out.
pub(super) fn place_windowed_on(window: &WebviewWindow, monitor: &Monitor, focus: bool) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let _ = window.set_size(windowed_size_for(monitor));
    // Sit on the target monitor, then centre within it.
    let rect = monitor_rect(monitor);
    let _ = window.set_position(point(rect.x, rect.y));
    let _ = window.center();
    if focus {
        let _ = window.set_focus();
    }
}

/// Full-screen on the given monitor, but still reachable on an ordinary PC: it
/// stays in the taskbar / Alt-Tab and a title bar returns if the user leaves
/// full-screen from the tray. (This is the non-Edge "fullscreen" choice — distinct
/// from the borderless, taskbar-hidden Edge kiosk in `place_on_edge`.)
pub(super) fn place_fullscreen_on(window: &WebviewWindow, monitor: &Monitor, focus: bool) {
    let _ = window.set_fullscreen(false);
    let _ = window.set_decorations(true);
    let _ = window.set_skip_taskbar(false);
    let rect = monitor_rect(monitor);
    let _ = window.set_position(point(rect.x, rect.y));
    // macOS takes a window full screen on the display it is on NOW, so the same
    // wait as `place_on_edge`: the move first, then full screen.
    #[cfg(target_os = "macos")]
    if !wait_until_on(window, monitor) {
        crate::crash_log::note("display", "the window had not reached its screen after 600 ms; going full screen anyway");
    }
    let _ = window.set_fullscreen(true);
    if focus {
        let _ = window.set_focus();
    }
}

/// The primary monitor, or the first available one if the primary is unknown.
pub(super) fn primary_or_first(window: &WebviewWindow) -> Option<Monitor> {
    primary_of(window).or_else(|| monitors_of(window).and_then(|m| m.into_iter().next()))
}

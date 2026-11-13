// Describes the screens to the dashboard and the tray: the list, the current state, and what only Windows can tell.

use tauri::{AppHandle, Monitor, WebviewWindow};
use crate::prefs::Placement;
use super::edge::is_edge_panel;
use super::ids::{display_ids, id_of};
use super::pick::chosen_monitor;
use super::screens::{app_monitors, app_primary, current_of, monitors_of, placement_cache, primary_of};

// This module is shared by every target, but two of the things it consults —
// the virtual-display list and the game-mode guard — are implemented with Win32
// APIs and so live in `#[cfg(windows)]` modules. Referring to them directly
// made the whole crate fail to resolve on macOS/Linux. These shims keep the
// logic below platform-agnostic, and the non-Windows values are the behaviour
// this file had before either feature existed.

/// Names of virtual/phantom displays to avoid when several monitors match the
/// Edge signature. Only Windows can present one (the second-screen driver, see
/// gpu.rs), so elsewhere the list is empty and `find_edge` keeps its plain
/// first-match behaviour.
#[cfg(windows)]
pub(super) fn virtual_display_names() -> Vec<String> {
    crate::gpu::virtual_display_names()
}
#[cfg(not(windows))]
pub(super) fn virtual_display_names() -> Vec<String> {
    Vec::new()
}

/// Whether a game currently holds the foreground. Tracked by focus_guard, which
/// is Windows-only; elsewhere the watchdog re-pins unconditionally, exactly as
/// it did before the guard was added.
#[cfg(windows)]
pub(super) fn game_mode() -> bool {
    crate::focus_guard::game_mode()
}
#[cfg(not(windows))]
pub(super) fn game_mode() -> bool {
    false
}

/// Whether the GPU this process pinned WebView2 to at launch is still the one
/// driving the screen the kiosk is on. Only Windows pins anything (see gpu.rs), so
/// elsewhere the answer is always "no disagreement".
#[cfg(windows)]
fn gpu_mismatch(window: &WebviewWindow) -> bool {
    let presenting = current_of(window).and_then(|m| m.name().cloned());
    crate::gpu::mismatch(presenting.as_deref())
}
#[cfg(not(windows))]
fn gpu_mismatch(_window: &WebviewWindow) -> bool {
    false
}

/// One entry per connected monitor, shared by the tray picker and the dashboard's
/// Settings → Screen list so the two can never disagree about what is attached.
pub struct DisplayInfo {
    /// Never empty — see `display_id`. An unnamed output is identified by shape.
    pub id: String,
    pub label: String,
    /// The model, as a person knows the screen. Empty when the system reports none.
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Where it sits on the desktop, so the menu can draw the screens as they stand.
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub primary: bool,
    pub edge: bool,
}

impl DisplayInfo {
    /// The label for a plain text menu, where "which one is the Edge" has to be
    /// spelled out because there is nowhere to put a chip.
    pub fn tray_label(&self) -> String {
        if self.edge {
            format!("{} (Xeneon Edge)", self.label)
        } else if self.primary {
            format!("{} (primary)", self.label)
        } else {
            self.label.clone()
        }
    }
}

/// Every connected monitor, in enumeration order.
///
/// The index in `Display N` is only a human hint: on Windows the OS name is
/// `\\.\DISPLAYn`, assigned by ORDER, so both the number and the name shift when
/// screens are replugged. With two identical panels the resolution alone tells
/// you nothing either, which is why `primary` and `edge` are reported as flags —
/// the dashboard renders them as chips, and the tray, which has no chips, spells
/// them into the label itself (see `tray_label`).
pub fn displays(window: &WebviewWindow) -> Vec<DisplayInfo> {
    let primary = primary_of(window);
    let monitors = monitors_of(window).unwrap_or_default();
    describe(monitors, primary)
}

/// The same list, read from the app handle instead of a window.
///
/// The screens can be enumerated before the window exists, and that is the point:
/// the caps the shell injects into the page carry the monitor list from the very
/// first render (see `lib.rs`), so the first-run picker draws its screens straight
/// away instead of waiting on `push_display_state` — a push that arrives after the
/// dashboard loads, and that a page which never gets one leaves stuck on "Reading
/// the screens on this PC…".
pub fn displays_for_app(app: &AppHandle) -> Vec<DisplayInfo> {
    let primary = app_primary(app);
    let monitors = app_monitors(app);
    describe(monitors, primary)
}

fn describe(monitors: Vec<Monitor>, primary: Option<Monitor>) -> Vec<DisplayInfo> {
    let ids = display_ids(&monitors);
    // Which entry is the primary is decided by its ORIGIN, not by its id: two
    // same-model monitors on macOS report the same name, and matching on that
    // flagged both of them primary.
    let primary_origin = primary.as_ref().map(|m| *m.position());
    let models = crate::monitor_names::model_names(&monitors);
    monitors
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let s = m.size();
            let id = ids[i].clone();
            let edge = is_edge_panel(&m);
            let primary = primary_origin == Some(*m.position());
            DisplayInfo {
                id,
                label: format!("Display {} — {}×{}", i + 1, s.width, s.height),
                name: crate::monitor_names::display_name(&models[i], edge),
                width: s.width,
                height: s.height,
                x: m.position().x,
                y: m.position().y,
                scale: m.scale_factor(),
                primary,
                edge,
            }
        })
        .collect()
}

/// The monitor list as the dashboard consumes it, without the placement half of
/// `display_state` (which needs a window to report the ACTIVE screen honestly).
pub fn display_list_json(app: &AppHandle) -> serde_json::Value {
    serde_json::Value::Array(displays_for_app(app).iter().map(display_json).collect())
}

fn display_json(d: &DisplayInfo) -> serde_json::Value {
    serde_json::json!({
        "id": d.id, "label": d.label, "name": d.name, "width": d.width, "height": d.height,
        "x": d.x, "y": d.y, "scale": d.scale, "primary": d.primary, "edge": d.edge,
    })
}

/// The whole display state, as the dashboard consumes it. `active` is the screen
/// the window is really on — the page shows the truth, not the intent.
pub fn display_state(window: &WebviewWindow) -> serde_json::Value {
    let cache = placement_cache();
    let list: Vec<serde_json::Value> = displays(window).iter().map(display_json).collect();
    // Reported with `display_id`, the same key the list uses, so the dashboard's
    // `d.id === state.active` comparison keeps working on outputs the OS did not
    // name (where it used to compare against `null` and never match).
    let active = current_of(window)
        .and_then(|m| id_of(window, &m));
    let missing = cache.mode == Placement::Screen && chosen_monitor(window, &cache).is_none();
    serde_json::json!({
        "displays": list,
        "display": {
            "mode": match cache.mode {
                Placement::Auto => "auto",
                Placement::Screen => "screen",
                Placement::Phone => "phone",
            },
            "monitor": cache.monitor,
            "fullscreen": cache.fullscreen,
            "active": active,
            "missing": missing,
            // A display change after launch can leave the webview rendering on one
            // GPU while the kiosk is presented by another, which costs real CPU for
            // as long as the app stays up and can only be fixed by restarting it
            // (see gpu.rs). Reported here because Settings → Screen is both where
            // this becomes true and where the user is standing when it does.
            "gpuMismatch": gpu_mismatch(window),
        }
    })
}

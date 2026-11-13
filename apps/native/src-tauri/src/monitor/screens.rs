// Asks the system for its screens, always on the main thread, and keeps the last answer for the threads that may not ask.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, Monitor, WebviewWindow};
use crate::prefs;
use crate::prefs::Placement;
use super::{PLACEMENT, SHOW_OVERRIDE};
use super::ids::display_ids;

#[derive(Clone)]
pub(super) struct PlacementCache {
    pub(super) mode: Placement,
    pub(super) monitor: Option<String>,
    pub(super) fingerprint: Option<String>,
    pub(super) fullscreen: bool,
}

pub(super) fn placement_cache() -> PlacementCache {
    PLACEMENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

// ── Screen reads, always made on the main thread ────────────────────────────
//
// Every monitor read in this crate goes through these five, never through
// `available_monitors()` / `primary_monitor()` / `current_monitor()` directly.
// Tauri hands the QUERY to the event loop but builds the `Monitor` it returns on
// the CALLING thread, and on Linux that build asks GDK for the work area: an X11
// request on the connection the main thread is reading events from. The app-level
// variants do not even hop. From the watchdog (every 3 s) that is two threads on
// one Xlib connection, and Xlib aborts the process with "[xcb] Unknown request in
// queue while dequeuing" — which is how the AppImage died at launch in the
// AppImageHub test (PR #7417). On macOS the same build reads NSScreen, which
// AppKit also expects on the main thread. `run_on_main_thread` runs inline when
// already there, so these are safe from any thread, and from a background thread
// they block exactly as the window getters they replace already did.

pub(super) fn on_main<R, F>(app: &AppHandle, f: F) -> Option<R>
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    // An event loop that has already exited drops the task unrun: `recv` then
    // fails instead of waiting forever.
    rx.recv().ok()
}

pub(super) fn monitors_of(window: &WebviewWindow) -> Option<Vec<Monitor>> {
    let w = window.clone();
    on_main(window.app_handle(), move || w.available_monitors().ok()).flatten()
}

pub(super) fn primary_of(window: &WebviewWindow) -> Option<Monitor> {
    let w = window.clone();
    on_main(window.app_handle(), move || w.primary_monitor().ok().flatten()).flatten()
}

pub(super) fn current_of(window: &WebviewWindow) -> Option<Monitor> {
    let w = window.clone();
    on_main(window.app_handle(), move || w.current_monitor().ok().flatten()).flatten()
}

pub(crate) fn app_monitors(app: &AppHandle) -> Vec<Monitor> {
    let a = app.clone();
    on_main(app, move || a.available_monitors().unwrap_or_default()).unwrap_or_default()
}

pub(crate) fn app_primary(app: &AppHandle) -> Option<Monitor> {
    let a = app.clone();
    on_main(app, move || a.primary_monitor().ok().flatten()).flatten()
}

/// The screen a widget layer draws on, by the id the dashboard got from
/// `display_list_json`. '' or a screen that is no longer attached means the
/// primary one: a placement never disappears because its monitor did.
pub(crate) fn layer_monitor(app: &AppHandle, id: &str) -> Option<Monitor> {
    let monitors = app_monitors(app);
    if !id.is_empty() {
        if let Some(i) = display_ids(&monitors).iter().position(|x| x == id) {
            return monitors.into_iter().nth(i);
        }
    }
    app_primary(app).or_else(|| monitors.into_iter().next())
}

/// Every attached monitor, and whether it is the primary one: for Bit's edge
/// glow from the on-screen alerts window (layers::glow_from_alerts).
pub(crate) fn monitors_with_primary(app: &AppHandle) -> Vec<(Monitor, bool)> {
    let primary = app_primary(app).map(|p| *p.position());
    app_monitors(app)
        .into_iter()
        .map(|m| {
            let is_primary = Some(*m.position()) == primary;
            (m, is_primary)
        })
        .collect()
}

/// Mark this session as a deliberate, user-initiated launch, so phone mode does
/// not hide a window the user just asked for by double-clicking the app. Set at
/// startup when the process was NOT started by the login entry. Session-only:
/// nothing is written, and the next login is hidden again as chosen.
pub fn allow_show_this_session() {
    SHOW_OVERRIDE.store(true, Ordering::SeqCst);
}

/// Refresh the in-memory mirror. Every writer of the placement triple calls this
/// in the same breath as `prefs::update`, or the watchdog keeps acting on the
/// previous choice until the next launch.
pub fn set_placement_cache(prefs: &prefs::DisplayPrefs) {
    let mut guard = PLACEMENT.lock().unwrap_or_else(|e| e.into_inner());
    guard.mode = prefs.placement;
    guard.monitor = prefs.monitor.clone();
    guard.fingerprint = prefs.monitor_fingerprint.clone();
    guard.fullscreen = prefs.fullscreen;
}

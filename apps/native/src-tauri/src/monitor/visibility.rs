// Shows and hides the window: when it may show, and hiding during a remote desktop session.

use std::sync::atomic::Ordering;
use tauri::WebviewWindow;
use crate::memory_level;
use crate::prefs::Placement;
use super::{DRIVER, HIDE_ON_RDP, NO_SCREEN, RDP_HIDDEN, SHOW_OVERRIDE, VISIT};
use super::screens::placement_cache;

/// Whether the window is allowed to be visible right now.
///
/// Three independent reasons can hide it, and before this predicate existed the
/// RDP branch called `window.show()` unconditionally — so ending a remote session
/// would reveal a window that phone mode, or a missing screen, still wanted
/// hidden. Every `show()` outside the deliberate tray override goes through here.
fn may_show() -> bool {
    if SHOW_OVERRIDE.load(Ordering::SeqCst) || VISIT.load(Ordering::SeqCst) {
        return true;
    }
    !RDP_HIDDEN.load(Ordering::SeqCst)
        && !NO_SCREEN.load(Ordering::SeqCst)
        && placement_cache().mode != Placement::Phone
        && !DRIVER.load(Ordering::SeqCst)
}

/// Show the window only if nothing else wants it hidden.
fn show_if_allowed(window: &WebviewWindow) {
    if may_show() {
        show_window(window);
    }
}

/// Shows the window, leaving the keyboard where it is unless `focus` asks for it.
/// Windows and macOS do that by themselves; on X11 the window manager hands a
/// window the focus as it maps, unless the window says not to.
pub(super) fn show_for(window: &WebviewWindow, focus: bool) {
    #[cfg(target_os = "linux")]
    focus_on_map(window, focus);
    #[cfg(not(target_os = "linux"))]
    let _ = focus;
    show_if_allowed(window);
    #[cfg(target_os = "linux")]
    focus_on_map(window, true);
}

// Queued on the main thread, in order with the show between the two calls.
#[cfg(target_os = "linux")]
fn focus_on_map(window: &WebviewWindow, on: bool) {
    use gtk::prelude::GtkWindowExt;
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        // Redundant here, as in `gdk_fullscreen_on`, for check-platform-apis.
        #[cfg(target_os = "linux")]
        if let Ok(gtk_win) = target.gtk_window() {
            gtk_win.set_focus_on_map(on);
        }
    });
}

/// Every hide and show of the main window goes through these two, so a hidden
/// dashboard (phone mode, widgets only, Remote Desktop, the tray) hands its
/// memory back and a shown one asks for it first (see `memory_level.rs`).
pub fn hide_window(window: &WebviewWindow) {
    let _ = window.hide();
    memory_level::set_low(window, true);
}

pub(super) fn show_window(window: &WebviewWindow) {
    memory_level::set_low(window, false);
    let _ = window.show();
}

/// Whether this process is running inside a Windows Remote Desktop / Terminal
/// Services session. `SM_REMOTESESSION` is true ONLY for a genuine `mstsc`/RDP
/// login — a Sunshine/Moonlight stream of the physical console session reports
/// false, so our own remote-control feature never trips the RDP hide.
#[cfg(windows)]
pub(super) fn is_remote_session() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetSystemMetrics(index: i32) -> i32;
    }
    const SM_REMOTESESSION: i32 = 0x1000;
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

#[cfg(not(windows))]
pub(super) fn is_remote_session() -> bool {
    false
}

/// Apply the Remote-Desktop hide immediately (not on the next watchdog tick), so a
/// launch that begins inside an RDP session doesn't flash the kiosk over the remote
/// desktop for a full watchdog interval before the loop's first check hides it.
/// No-op unless the pref is on AND we're currently in a remote session; the watchdog
/// then owns the show-again-at-console transition as usual.
pub fn apply_rdp_hide_now(window: &WebviewWindow) {
    if HIDE_ON_RDP.load(Ordering::SeqCst) && is_remote_session() && !RDP_HIDDEN.swap(true, Ordering::SeqCst) {
        hide_window(window);
    }
}

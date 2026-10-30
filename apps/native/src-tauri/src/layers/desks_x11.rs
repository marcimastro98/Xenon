//! The workspace shown on X11: the root window's `_NET_CURRENT_DESKTOP`, read
//! on a GTK timer that runs only while some page is tied to a desktop and
//! stops with its generation (desks.rs). Read with the anchors' X connection
//! (anchor_x11.rs). Not offered with layer-shell: Wayland gives no common way
//! to know the workspace.
#![cfg(target_os = "linux")]

use std::time::Duration;

use gtk::glib::ControlFlow;
use tauri::AppHandle;

use super::desks;

const EVERY: Duration = Duration::from_millis(500);

/// Main thread.
pub fn start(app: AppHandle, gen: u32) {
    gtk::glib::timeout_add_local(EVERY, move || {
        if !desks::live(gen) {
            return ControlFlow::Break;
        }
        if let Some(d) = super::anchor_x11::current_desk() {
            desks::seen(&app, gen, d);
        }
        ControlFlow::Continue
    });
}

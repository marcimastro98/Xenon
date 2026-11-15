// Linux: the screen kept awake while the screensaver of the dashboard shows.

use std::time::Duration;
use gtk::gdk::prelude::MonitorExt;
use gtk::glib::object::{Cast, ObjectType};
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::{GtkApplicationExt, GtkWindowExt, WidgetExt};
use super::cover::fullscreen_monitor;

/// Whether a screensaver must wait: an app keeps the screen on (a video asks
/// the session to stay awake) or a window in front is in full screen. Called
/// on a plain thread, so asked of the main thread; no answer in 2 s = go on.
pub fn saver_held() -> bool {
    let Some(app) = super::APP.get() else { return false };
    let (tx, rx) = std::sync::mpsc::channel();
    let asked = app.run_on_main_thread(move || {
        let _ = tx.send(idle_inhibited() || fullscreen_monitor().is_some());
    });
    asked.is_ok() && rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false)
}

/// Some app holds the session's idle inhibitor (what a video player takes).
/// The session manager answers; a desktop without one says no.
fn idle_inhibited() -> bool {
    gtk::Window::list_toplevels()
        .into_iter()
        .filter_map(|w| w.downcast::<gtk::Window>().ok()?.application())
        .next()
        .is_some_and(|a| a.is_inhibited(gtk::ApplicationInhibitFlags::IDLE))
}

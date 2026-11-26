// Linux: the scene put to rest while a window covers the screen or the laptop runs on battery.

use std::sync::atomic::Ordering;
use gtk::gdk::prelude::MonitorExt;
use gtk::glib::object::{Cast, ObjectType};
use gtk::glib::translate::{from_glib_full, ToGlibPtr};
use gtk::prelude::{GtkApplicationExt, GtkWindowExt, WidgetExt};
use super::{find, STATE, WATCHING};
use super::super::spec::Kind;
use super::wallpaper::show_wallpaper;

/// Every 2 s while there is a wallpaper: hide the ones on the monitor of a
/// full-screen window in front (nothing animates behind it), and all of them
/// on battery (WebKitGTK has no battery API for the page to ask); show them
/// again after. Stops with the last wallpaper.
pub(super) fn watch_cover() -> gtk::glib::ControlFlow {
    let full = fullscreen_monitor();
    let battery = on_battery();
    let go_on = STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return true };
        st.entries.retain(|e| find(e.handle).is_some());
        let mut any = false;
        for e in st.entries.iter_mut().filter(|e| e.kind == Kind::Wallpaper) {
            any = true;
            let Some(w) = find(e.handle) else { continue };
            let on = w.window().and_then(|g| g.display().monitor_at_window(&g));
            let covered = battery || (full.is_some() && on == full);
            if covered != e.covered {
                e.covered = covered;
                show_wallpaper(&w, e);
            }
        }
        any
    });
    if go_on {
        return gtk::glib::ControlFlow::Continue;
    }
    WATCHING.store(false, Ordering::Relaxed);
    gtk::glib::ControlFlow::Break
}

/// The kernel's power supplies: a battery that is discharging. A PC without
/// one, or one plugged in, says no.
fn on_battery() -> bool {
    let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") else { return false };
    dir.flatten().any(|d| {
        let read = |name: &str| std::fs::read_to_string(d.path().join(name)).unwrap_or_default();
        discharging(&read("type"), &read("status"))
    })
}

pub(super) fn discharging(kind: &str, status: &str) -> bool {
    kind.trim() == "Battery" && status.trim() == "Discharging"
}

/// The monitor of the active window when that window, not one of Xenon's,
/// fills it (X11; Wayland never says). Main thread; also Bit on the desktop
/// (bit_desk/linux.rs) hides under it.
pub(in crate::layers) fn fullscreen_monitor() -> Option<gtk::gdk::Monitor> {
    let screen = gtk::gdk::Screen::default()?;
    // gdk-rs leaves this call out (deprecated in GTK, still the X11 answer).
    // Transfer full: the reference is ours, released with `active`.
    let active: gtk::gdk::Window =
        unsafe { from_glib_full::<_, Option<_>>(gtk::gdk::ffi::gdk_screen_get_active_window(screen.to_glib_none().0)) }?;
    let ours = gtk::Window::list_toplevels().iter().any(|t| t.window().as_ref() == Some(&active));
    if ours {
        return None;
    }
    // Another app's window can close between the two calls: X then answers
    // BadDrawable, which GDK turns into an exit unless it is trapped.
    gtk::gdk::error_trap_push();
    let found = active.display().monitor_at_window(&active).map(|m| (active.frame_extents(), m));
    if gtk::gdk::error_trap_pop() != 0 {
        return None;
    }
    let (r, monitor) = found?;
    let m = monitor.geometry();
    let fills = (r.x(), r.y(), r.width(), r.height()) == (m.x(), m.y(), m.width(), m.height());
    fills.then_some(monitor)
}

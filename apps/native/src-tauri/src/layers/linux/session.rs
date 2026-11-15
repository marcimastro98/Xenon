// Linux: whether this session can draw layer windows at all, and through what.

use std::sync::atomic::Ordering;
use gtk::gdk::prelude::MonitorExt;
use gtk::glib::object::{Cast, ObjectType};
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::{GtkApplicationExt, GtkWindowExt, WidgetExt};
use super::{SHELL, USABLE};
use super::super::layer_shell;

/// Why layers cannot work in this session, if they cannot: GTK must run on
/// X11 (a native X session, or XWayland with `GDK_BACKEND=x11`) and a
/// compositor must draw the transparency. Main thread: it asks GDK. The answer
/// is kept for `usable`, which `sync` reads from a plain thread.
pub fn probe() -> Option<&'static str> {
    use gtk::glib::prelude::ObjectExt;
    let why = match gtk::gdk::Display::default() {
        None => Some("no_display"),
        Some(d) if d.type_().name() != "GdkX11Display" => {
            let shell = layer_shell::supported();
            SHELL.store(shell, Ordering::Relaxed);
            (!shell).then_some("wayland")
        }
        Some(d) if !d.default_screen().is_composited() => Some("no_compositor"),
        Some(_) => None,
    };
    USABLE.store(why.is_none(), Ordering::Relaxed);
    why
}

/// What the last `probe` said.
pub fn usable() -> bool {
    USABLE.load(Ordering::Relaxed)
}

/// The windows are layer surfaces: the compositor sizes and places them.
pub fn layer_shell() -> bool {
    SHELL.load(Ordering::Relaxed)
}

/// The GtkWindow pointer as an isize: what `find` matches against.
pub fn handle_of(win: &gtk::ApplicationWindow) -> isize {
    win.as_ptr() as isize
}

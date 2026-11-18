// Linux: the scene behind the desktop and the widgets over it, shown, taken away and cut to their shapes.

use std::sync::atomic::Ordering;
use gtk::cairo::{RectangleInt, Region};
use gtk::gdk::WindowTypeHint;
use gtk::gdk::prelude::MonitorExt;
use gtk::glib::object::{Cast, ObjectType};
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::{GtkApplicationExt, GtkWindowExt, WidgetExt};
use super::{EDITING, Entry};
use super::session::layer_shell;
use super::super::spec::Kind;

pub(super) fn widgets(w: &gtk::Window, kind: Kind) {
    let above = kind == Kind::Overlay || EDITING.load(Ordering::Relaxed);
    // Below first: a window manager drops one state when the other is set.
    w.set_keep_below(!above);
    w.set_keep_above(above);
    w.stick();
    w.set_skip_taskbar_hint(true);
    w.set_skip_pager_hint(true);
    w.set_accept_focus(false);
}

/// Neither above nor below the others: the window it is transient for sets
/// its place (anchor_x11.rs), and it follows that window across workspaces.
pub(super) fn anchored(w: &gtk::Window) {
    w.set_keep_above(false);
    w.set_keep_below(false);
    w.stick();
    w.set_skip_taskbar_hint(true);
    w.set_skip_pager_hint(true);
    w.set_accept_focus(false);
}

/// Window managers read a window's type when it is mapped: a new wallpaper is
/// hidden, typed and shown again, once. Desktop-type keeps it out of "show
/// desktop", the task switcher and the panels; below keeps it under the rest.
pub(super) fn wallpaper(w: &gtk::Window, e: &Entry) {
    if w.type_hint() != WindowTypeHint::Desktop {
        w.hide();
        w.set_type_hint(WindowTypeHint::Desktop);
    }
    w.set_keep_above(false);
    w.set_keep_below(true);
    w.stick();
    w.set_skip_taskbar_hint(true);
    w.set_skip_pager_hint(true);
    w.set_accept_focus(false);
    show_wallpaper(w, e);
}

/// Shown unless paused or covered, sized while still unmapped: a window
/// manager may refuse to move or resize a desktop-type window once it is up,
/// and GTK keeps a non-resizable window at the size it last asked for.
pub(super) fn show_wallpaper(w: &gtk::Window, e: &Entry) {
    if e.paused || e.covered {
        w.hide();
        return;
    }
    if layer_shell() {
        w.show();
        return;
    }
    if let Some([x, y, width, height]) = e.area {
        if w.is_visible() && w.position() != (x, y) {
            w.hide();
        }
        w.set_size_request(width, height);
        w.resize(width, height);
        w.move_(x, y);
    }
    w.show();
    if let Some(g) = w.window() {
        g.lower();
    }
}

/// Over everything and taking every input: any key or move ends a screensaver
/// (screen-scene.js), the drawing sheet draws with them (screen-draw-page.js).
/// Full screen comes from `place`, once it is on its monitor.
pub(super) fn take_all(w: &gtk::Window) {
    w.input_shape_combine_region(None);
    w.set_keep_below(false);
    w.set_keep_above(true);
    w.stick();
    w.set_skip_taskbar_hint(true);
    w.set_skip_pager_hint(true);
    w.set_accept_focus(true);
    if !w.is_active() {
        w.present();
    }
}

/// The input shape from the page's rectangles, in the window's own logical
/// pixels (GTK scales by a whole factor). No rectangles = no input at all.
pub(super) fn cut(w: &gtk::Window, rects: &[[i32; 4]]) {
    let scale = w.scale_factor().max(1);
    let region = Region::create();
    for r in rects {
        let (x, y) = (r[0].div_euclid(scale), r[1].div_euclid(scale));
        // Rounded out, so a tile's last device pixel still takes the click.
        let right = (r[0] + r[2] + scale - 1).div_euclid(scale);
        let bottom = (r[1] + r[3] + scale - 1).div_euclid(scale);
        let _ = region.union_rectangle(&RectangleInt::new(x, y, right - x, bottom - y));
    }
    w.input_shape_combine_region(Some(&region));
    // On Wayland GTK hands the new input region to the compositor with the next
    // frame, and a still page draws none: the cut would wait for whatever repaints
    // next and clicks would keep following the old one. A redraw makes that frame.
    w.queue_draw();
}

//! Bit's window on Linux (linux.rs draws in it): a transparent window that
//! never takes the focus, the mouse on it (state.rs says what a press, a drag
//! and a drop mean) and its input shape, cut to Bit's cells so the clicks next
//! to it reach what is under it.

use std::cell::RefCell;
use std::rc::Rc;

use gtk::cairo::{Context, ImageSurface, Operator, RectangleInt, Region};
use gtk::gdk::prelude::MonitorExt;
use gtk::gdk::{EventMask, WindowTypeHint};
use gtk::glib::Propagation;
use gtk::prelude::{GtkWindowExt, WidgetExt, WidgetExtManual};

use super::super::{layer_shell, linux};
use super::linux::{centre, render, with, Lin};
use super::state::Desk;
use super::{tell, wheel_call, Area, Frame};

fn draw(cr: &Context, image: Option<&ImageSurface>) {
    cr.set_operator(Operator::Source);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.0);
    let _ = cr.paint();
    let Some(image) = image else { return };
    cr.set_operator(Operator::Over);
    if cr.set_source_surface(image, 0.0, 0.0).is_ok() {
        let _ = cr.paint();
    }
}

/// A transparent window that never takes the focus, drawing `image`. None
/// without an RGBA visual: Bit would stand in an opaque black box.
pub(super) fn create(image: Rc<RefCell<Option<ImageSurface>>>) -> Option<gtk::Window> {
    let visual = gtk::gdk::Screen::default()?.rgba_visual()?;
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_visual(Some(&visual));
    window.set_app_paintable(true);
    window.set_decorated(false);
    window.set_resizable(false);
    window.set_skip_taskbar_hint(true);
    window.set_skip_pager_hint(true);
    window.set_accept_focus(false);
    window.set_focus_on_map(false);
    window.set_title("Bit");
    if linux::layer_shell() {
        layer_shell::place_bit(&window);
    } else {
        window.set_type_hint(WindowTypeHint::Notification);
        window.set_keep_above(true);
        window.stick();
    }
    window.connect_draw(move |_, cr| {
        draw(cr, image.borrow().as_ref());
        Propagation::Stop
    });
    mouse(&window);
    Some(window)
}

/// The left button on Bit: a press, a drag (X11 only, see linux.rs) and the release.
fn mouse(window: &gtk::Window) {
    window.add_events(EventMask::BUTTON_PRESS_MASK | EventMask::BUTTON_RELEASE_MASK | EventMask::POINTER_MOTION_MASK | EventMask::SCROLL_MASK);
    // The wheel over Bit: one size up or down (GDK's Up is away from the person).
    window.connect_scroll_event(|_, e| {
        let up = match e.direction() {
            gtk::gdk::ScrollDirection::Up => 1.0,
            gtk::gdk::ScrollDirection::Down => -1.0,
            _ => 0.0,
        };
        if let Some(call) = wheel_call(up) {
            tell(call);
        }
        Propagation::Stop
    });
    window.connect_button_press_event(|_, e| {
        if e.button() == 1 {
            with(|l| {
                let c = global(&l.desk, e.position(), e.root());
                l.desk.press(c);
            });
        }
        Propagation::Stop
    });
    window.connect_motion_notify_event(|_, e| {
        // Wayland: the surface stays put until the drop.
        if !linux::layer_shell() {
            with(|l| {
                let c = global(&l.desk, e.position(), e.root());
                if l.desk.drag_to(c) {
                    render(l);
                }
            });
        }
        Propagation::Stop
    });
    window.connect_button_release_event(|_, e| {
        if e.button() == 1 {
            release(Some((e.position(), e.root())));
        }
        Propagation::Stop
    });
    // The pointer taken away mid-press: a drag drops where it is, a tap is nothing.
    window.connect_grab_broken_event(|_, _| {
        release(None);
        Propagation::Proceed
    });
}

/// The cursor in physical pixels, as Tauri reports the screens: the root
/// coordinates on X11; on Wayland, where they are not global, the window's own
/// corner plus the point inside it (the window does not move while pressed).
fn global(d: &Desk, local: (f64, f64), root: (f64, f64)) -> (i32, i32) {
    let s = d.scale;
    if linux::layer_shell() {
        let (x, y) = d.at();
        (x + (local.0 * s).round() as i32, y + (local.1 * s).round() as i32)
    } else {
        ((root.0 * s).round() as i32, (root.1 * s).round() as i32)
    }
}

/// The monitor at a point in physical pixels: its whole area and its desktop.
fn areas_at(p: (i32, i32), scale: f64) -> Option<(Area, Area)> {
    let display = gtk::gdk::Display::default()?;
    let s = scale.max(0.5);
    let m = display.monitor_at_point((f64::from(p.0) / s).round() as i32, (f64::from(p.1) / s).round() as i32)?;
    let k = f64::from(m.scale_factor());
    let area = |r: gtk::gdk::Rectangle| Area {
        l: (f64::from(r.x()) * k).round() as i32,
        t: (f64::from(r.y()) * k).round() as i32,
        r: (f64::from(r.x() + r.width()) * k).round() as i32,
        b: (f64::from(r.y() + r.height()) * k).round() as i32,
    };
    Some((area(m.geometry()), area(m.workarea())))
}

/// The press ended (`at`: where the button came up, None: the pointer was taken away).
fn release(at: Option<((f64, f64), (f64, f64))>) {
    let mut said = None;
    with(|l| {
        if let Some((local, root)) = at.filter(|_| linux::layer_shell()) {
            let c = global(&l.desk, local, root);
            l.desk.drag_to(c);
        }
        said = l.desk.release(at.is_some(), |d| areas_at(centre(d), d.scale));
        render(l);
    });
    if let Some(call) = said {
        tell(call);
    }
}

/// Which cells are drawn on `frame`, mirrored like the picture.
fn solid(frame: &Frame, w: usize, h: usize, mirror: bool) -> Vec<bool> {
    (0..w * h)
        .map(|i| {
            let (cy, cx) = (i / w, i % w);
            let col = if mirror { w - 1 - cx } else { cx };
            frame.cells.get(cy * w + col).is_some_and(|&k| k != 0)
        })
        .collect()
}

/// The input shape cut to the cells on show, one rectangle per run of a row; only when they changed.
pub(super) fn cut(l: &mut Lin) {
    let (Some(window), Some(frame)) = (&l.window, l.desk.current()) else { return };
    let (w, h) = (l.desk.spec.w, l.desk.spec.h);
    let cells = solid(frame, w, h, l.desk.left);
    if cells == l.shape {
        return;
    }
    let c = f64::from(l.desk.cell) / l.desk.scale.max(0.5);
    let region = Region::create();
    for cy in 0..h {
        let mut x = 0;
        while x < w {
            if !cells[cy * w + x] {
                x += 1;
                continue;
            }
            let start = x;
            while x < w && cells[cy * w + x] {
                x += 1;
            }
            let r = RectangleInt::new((start as f64 * c) as i32, (cy as f64 * c) as i32, ((x - start) as f64 * c).ceil() as i32, c.ceil() as i32);
            let _ = region.union_rectangle(&r);
        }
    }
    window.input_shape_combine_region(Some(&region));
    l.shape = cells;
}

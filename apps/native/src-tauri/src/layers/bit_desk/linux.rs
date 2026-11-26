//! Bit on the desktop on Linux (Beta; built here, not yet run on a real Linux
//! PC), where layer windows can be drawn (linux.rs `usable`: X11 with a
//! compositor, or Wayland with layer-shell), with the contract of win32.rs:
//! one transparent window that never takes the focus, kept out of the taskbar
//! and the pager, whose input shape is cut to Bit's cells, so the clicks next
//! to it reach what is under it.
//!
//! - X11: a notification window kept above the others and on every workspace,
//!   moved by the window manager; hidden while another app's full-screen
//!   window covers its monitor (linux/cover.rs), checked at most once a second.
//! - Wayland: a layer surface in the top band (under a full-screen app),
//!   placed by its margins from the monitor's corner (layer_shell.rs). The
//!   compositor never says where a window is, so the desktop there has no
//!   work area: Bit stands on the screen's bottom edge, and a panel may cover
//!   it. A surface cannot follow the cursor exactly while it moves, so a drag
//!   lands where it is let go, without following the pointer on the way.
//!
//! window_linux.rs makes the window and handles the mouse and the input
//! shape; this file draws the frame, places the window and keeps the clock:
//! one glib timeout at a time, for the next tick only (state.rs `wait_ms`).
//! Main thread only; the state is a thread-local borrowed with
//! `try_borrow_mut`, like glow_linux.rs.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use gtk::cairo::{Format, ImageSurface};
use gtk::gdk::prelude::MonitorExt;
use gtk::glib::{self, ControlFlow, SourceId};
use gtk::prelude::{GtkWindowExt, WidgetExt, WidgetExtManual};

use super::super::{layer_shell, linux};
use super::state::{now, Desk};
use super::window_linux::{create, cut};
use super::{tell, Plan};

/// How often, at most, a full-screen window is looked for.
const COVER_EVERY_MS: u64 = 1000;

#[derive(Default)]
pub(super) struct Lin {
    pub(super) window: Option<gtk::Window>,
    /// Shared with the window's draw handler, which never touches `LIN`.
    image: Rc<RefCell<Option<ImageSurface>>>,
    /// The live timeout. Only `tick` ends one by returning Break, and it
    /// forgets the id first, so a stored id is always live.
    timer: Option<SourceId>,
    /// The cells the input shape was last cut to.
    pub(super) shape: Vec<bool>,
    /// The monitor the layer surface is on (Wayland).
    monitor: Option<gtk::gdk::Monitor>,
    covered_at: u64,
    pub(super) desk: Desk,
}

thread_local! {
    static LIN: RefCell<Lin> = RefCell::new(Lin::default());
}

pub(super) fn with(f: impl FnOnce(&mut Lin)) {
    LIN.with(|cell| {
        if let Ok(mut l) = cell.try_borrow_mut() {
            f(&mut l);
        }
    });
}

/// The middle of Bit's window, in physical pixels.
pub(super) fn centre(d: &Desk) -> (i32, i32) {
    let ((x, y), (w, h)) = (d.at(), d.size());
    (x + w / 2, y + h / 2)
}
/// The frame on show as a cairo image (ARGB32 is premultiplied B, G, R, A in
/// memory on the little-endian machines Xenon ships for, what `paint` writes).
fn surface(d: &Desk) -> Option<ImageSurface> {
    let (w, h) = d.size();
    let stride = Format::ARgb32.stride_for_width(u32::try_from(w).ok()?).ok()?;
    if w <= 0 || h <= 0 || stride != w * 4 {
        return None;
    }
    let image = ImageSurface::create_for_data(d.pixels()?, Format::ARgb32, w, h, stride).ok()?;
    image.set_device_scale(d.scale, d.scale);
    Some(image)
}

/// The frame on show, the window's size and place, and its input shape.
pub(super) fn render(l: &mut Lin) -> bool {
    let Some(window) = l.window.clone() else { return false };
    let Some(image) = surface(&l.desk) else { return false };
    *l.image.borrow_mut() = Some(image);
    let d = &l.desk;
    let s = d.scale.max(0.5);
    let ((x, y), (w, h)) = (d.at(), d.size());
    let logical = |v: i32| (f64::from(v) / s).round() as i32;
    window.set_size_request(logical(w), logical(h));
    if linux::layer_shell() {
        let (cx, cy) = centre(d);
        let here = gtk::gdk::Display::default().and_then(|disp| disp.monitor_at_point(logical(cx), logical(cy)));
        let moved = here.is_some() && here != l.monitor;
        let (mon_l, mon_t) = here.as_ref().or(l.monitor.as_ref()).map_or((0, 0), |m| (m.geometry().x(), m.geometry().y()));
        layer_shell::move_bit(&window, here.as_ref().filter(|_| moved), logical(x) - mon_l, logical(y) - mon_t);
        if moved {
            l.monitor = here;
        }
    } else {
        window.resize(logical(w), logical(h));
        window.move_(logical(x), logical(y));
    }
    window.queue_draw();
    cut(l);
    true
}

/// Hidden while another app's full-screen window covers Bit's monitor (X11). True when it just came back.
fn recheck(l: &mut Lin, t: u64) -> bool {
    if linux::layer_shell() || t.saturating_sub(l.covered_at) < COVER_EVERY_MS {
        return false;
    }
    l.covered_at = t;
    let Some(window) = l.window.clone() else { return false };
    let full = linux::fullscreen_monitor();
    let s = l.desk.scale.max(0.5);
    let (cx, cy) = centre(&l.desk);
    let on = gtk::gdk::Display::default().and_then(|d| d.monitor_at_point((f64::from(cx) / s) as i32, (f64::from(cy) / s) as i32));
    let cover = full.is_some() && full == on;
    let back = l.desk.hidden && !cover;
    if cover != l.desk.hidden {
        l.desk.hidden = cover;
        if cover { window.hide() } else { window.show() }
    }
    back
}

fn close(l: &mut Lin) {
    if let Some(id) = l.timer.take() {
        id.remove();
    }
    if let Some(window) = l.window.take() {
        window.hide();
        // SAFETY: the window is this module's own; nothing else holds it.
        unsafe { window.destroy() };
    }
    *l = Lin::default();
}

/// The next tick, and only that one.
fn arm(l: &mut Lin, t: u64) {
    if let Some(id) = l.timer.take() {
        id.remove();
    }
    l.timer = Some(glib::timeout_add_local(Duration::from_millis(l.desk.wait_ms(t)), tick));
}

pub fn apply(plan: Plan) {
    with(|l| {
        if !plan.spec.on || !linux::usable() {
            return close(l);
        }
        let fresh = l.window.is_none();
        if fresh {
            l.window = create(l.image.clone());
            if l.window.is_none() {
                return;
            }
        }
        let t = now();
        l.desk.take(plan, t);
        if !render(l) {
            return close(l);
        }
        if fresh {
            if let Some(window) = &l.window {
                window.show();
            }
        }
        l.covered_at = 0;
        recheck(l, t);
        arm(l, t);
    });
}

fn tick() -> ControlFlow {
    let mut arrived = false;
    with(|l| {
        // This timeout ends by returning Break: forget its id, never remove it twice.
        l.timer = None;
        let t = now();
        if l.window.is_none() || l.desk.stale(t) {
            return close(l);
        }
        let back = recheck(l, t);
        let (dirty, came) = l.desk.tick(t);
        arrived = came;
        if !l.desk.hidden && (back || dirty) {
            render(l);
        }
        arm(l, t);
    });
    if arrived {
        tell("arrived()".into());
    }
    ControlFlow::Break
}

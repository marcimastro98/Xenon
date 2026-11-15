//! Anchored widgets on X11 (Beta: run under Xvfb with a window manager, not yet
//! on a real Linux desktop).
//!
//! The window manager lists every app window bottom to top
//! (`_NET_CLIENT_LIST_STACKING`) with its class (`WM_CLASS`, what the server's
//! app list shows), its state and its workspace. While some widget is anchored
//! a GTK timer reads that list every 100 ms and moves a widget only when its
//! place changed: next to the front window of its app (anchor.rs `spot`). The
//! widget is made transient for that window, so the window manager keeps it
//! right above it: a window the person brings over the app covers the widget
//! too, and nothing restacks it by hand. Minimized (`_NET_WM_STATE_HIDDEN`),
//! closed or on another workspace = the widget hides. Polled because X tells
//! only the window manager when another client's window moves.
//!
//! libX11 is opened at run time (GDK already has it loaded on X11), like
//! layer_shell.rs: nothing new is linked. Every call goes through GDK's own
//! display inside a GDK error trap, so a window that closes between two reads
//! makes that read fail, never the app. Main thread only, like linux.rs.
#![cfg(target_os = "linux")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{c_int, c_ulong, c_void};
use std::time::Duration;

use gtk::glib::object::ObjectType;
use gtk::glib::ControlFlow;
use gtk::prelude::{GtkWindowExt, WidgetExt};

use super::anchor::{self, Seen};
use super::linux;
use super::spec::Anchor;

mod xlib;
mod x;

use x::X;

type Display = c_void;
/// X ids are C unsigned longs: 64 bits on the 64-bit systems Xenon ships for.
type Xid = u64;
type Atom = c_ulong;

/// How often the list is read while some widget is anchored.
const EVERY: Duration = Duration::from_millis(100);
/// Smaller windows are an app's helpers (a tooltip, a drag image), not the
/// window a widget follows; the widget itself is never smaller.
const MIN_SIDE: f64 = 40.0;
/// `_NET_WM_DESKTOP` of a window shown on every workspace.
const ALL_DESKTOPS: c_ulong = 0xFFFF_FFFF;
const ANY_PROPERTY_TYPE: Atom = 0;
const SUCCESS: c_int = 0;
const RTLD_NOW: c_int = 2;

/// The class, the second of WM_CLASS's two NUL-ended strings ("instance",
/// "Class"); a window that sets only one gives that one.
fn class_of(bytes: &[u8]) -> String {
    let mut parts = bytes.split(|b| *b == 0).filter(|p| !p.is_empty());
    let first = parts.next();
    let pick = parts.next().or(first).unwrap_or_default();
    String::from_utf8_lossy(pick).trim().to_string()
}

fn shown(state: &[c_ulong], hidden: Atom, desktop: Option<c_ulong>, current: Option<c_ulong>) -> bool {
    let here = match (desktop, current) {
        (Some(d), Some(c)) => d == c || d == ALL_DESKTOPS,
        _ => true,
    };
    here && !state.contains(&hidden)
}

/// `[left, top, right, bottom]` from the client area `[x, y, width, height]`,
/// the window manager's frame and a client-side shadow (both left, right, top,
/// bottom, missing = none).
fn visible_frame(client: [c_int; 4], net: &[c_ulong], csd: &[c_ulong]) -> [f64; 4] {
    let side = |v: &[c_ulong], i: usize| v.get(i).map_or(0.0, |n| *n as f64);
    let [x, y, w, h] = client.map(f64::from);
    let grow = |i| side(net, i) - side(csd, i);
    [x - grow(0), y - grow(2), x + w + grow(1), y + h + grow(3)]
}

/// One anchored widget, where it was last put and over which window.
struct Job {
    handle: isize,
    anchor: Anchor,
    target: Option<Xid>,
    at: Option<[i32; 4]>,
}

#[derive(Default)]
struct Follow {
    jobs: Vec<Job>,
    /// Each window's app, read once: a window does not change app.
    apps: HashMap<Xid, String>,
    running: bool,
}

thread_local! {
    static FOLLOW: RefCell<Follow> = RefCell::new(Follow::default());
}

/// The anchored widgets after a sync (main thread). The timer starts with the
/// first one and stops on its own after the last.
pub fn set(jobs: Vec<(isize, Anchor)>) {
    let start = FOLLOW.with(|cell| {
        let Ok(mut f) = cell.try_borrow_mut() else { return false };
        let mut old = std::mem::take(&mut f.jobs);
        f.jobs = jobs
            .into_iter()
            .map(|(handle, anchor)| match old.iter().position(|j| j.handle == handle && j.anchor == anchor) {
                Some(i) => old.swap_remove(i),
                None => Job { handle, anchor, target: None, at: None },
            })
            .collect();
        let start = !f.jobs.is_empty() && !f.running;
        f.running |= start;
        start
    });
    if start {
        gtk::glib::timeout_add_local(EVERY, tick);
    }
}

fn tick() -> ControlFlow {
    let go_on = FOLLOW.with(|cell| {
        let Ok(mut f) = cell.try_borrow_mut() else { return true };
        f.jobs.retain(|j| linux::find(j.handle).is_some());
        let Some(x) = (!f.jobs.is_empty()).then(X::open).flatten() else {
            f.running = false;
            f.apps.clear();
            return false;
        };
        gtk::gdk::error_trap_push();
        let Follow { jobs, apps, .. } = &mut *f;
        let list = windows(&x, apps, jobs);
        for j in jobs.iter_mut() {
            follow(&x, j, &list);
        }
        let _ = gtk::gdk::error_trap_pop();
        true
    });
    if go_on {
        ControlFlow::Continue
    } else {
        ControlFlow::Break
    }
}

/// The workspace shown, for desks_x11.rs (main thread, X11 only).
pub(super) fn current_desk() -> Option<super::desks::Desk> {
    let x = X::open()?;
    gtk::gdk::error_trap_push();
    let current = x.numbers(x.root, x.atoms.current_desktop).first().copied();
    let count = x.numbers(x.root, x.atoms.desktops).first().copied();
    let _ = gtk::gdk::error_trap_pop();
    super::desks::from_x11(current, count)
}

/// The on-screen windows of the anchored apps, front to back.
fn windows(x: &X, apps: &mut HashMap<Xid, String>, jobs: &[Job]) -> Vec<Seen> {
    let stacking = x.numbers(x.root, x.atoms.stacking);
    apps.retain(|id, _| stacking.contains(id));
    let current = x.numbers(x.root, x.atoms.current_desktop).first().copied();
    stacking
        .iter()
        .rev()
        .filter_map(|&id| {
            let app = apps.entry(id).or_insert_with(|| x.app(id)).clone();
            if !jobs.iter().any(|j| anchor::app_matches(&j.anchor.app, &app)) || !x.on_screen(id, current) {
                return None;
            }
            let frame = x.frame(id)?;
            let big = frame[2] - frame[0] >= MIN_SIDE && frame[3] - frame[1] >= MIN_SIDE;
            big.then_some(Seen { id, app, frame })
        })
        .collect()
}

/// Put one widget next to its window, or hide it. Sizes are GTK's logical
/// pixels: X counts device pixels, GTK scales by a whole factor.
fn follow(x: &X, j: &mut Job, list: &[Seen]) {
    let Some(w) = linux::find(j.handle) else { return };
    let Some(gdk) = w.window() else { return };
    // SAFETY: the live GdkWindow of a realized X11 toplevel, main thread.
    let own = unsafe { (x.api.xid)(gdk.as_ptr()) };
    let scale = f64::from(w.scale_factor().max(1));
    let logical: Vec<Seen> =
        list.iter().map(|s| Seen { frame: s.frame.map(|v| v / scale), ..s.clone() }).collect();
    let Some(spot) = anchor::spot(&logical, &j.anchor, own, 1.0) else {
        if w.is_visible() {
            w.hide();
        }
        j.at = None;
        return;
    };
    if j.target != Some(spot.target) {
        // SAFETY: both ids are live windows on this display; an id that just
        // closed fails inside the caller's error trap.
        unsafe { (x.api.transient_for)(x.dpy, own, spot.target) };
        j.target = Some(spot.target);
        // A window manager reads the new owner at the next restack only
        // (openbox left the widget under its window): ask for one now. The
        // window is the app's front one, so the person just brought it up.
        gdk.raise();
    }
    let rect = spot.rect.map(|v| v.round() as i32);
    if j.at != Some(rect) {
        let [left, top, width, height] = rect;
        w.set_size_request(width, height);
        w.resize(width, height);
        w.move_(left, top);
        j.at = Some(rect);
    }
    if !w.is_visible() {
        // The window manager minimizes a transient with its window, and GDK
        // maps a window it last saw minimized as minimized again: some window
        // managers (openbox) then minimize its window too. Shown restored.
        w.deiconify();
        w.show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_class_is_the_second_string_of_wm_class() {
        assert_eq!(class_of(b"krita\0Krita\0"), "Krita");
        assert_eq!(class_of(b"navigator\0firefox\0"), "firefox");
        assert_eq!(class_of(b"xterm\0"), "xterm");
        assert_eq!(class_of(b""), "");
        assert_eq!(class_of(b"\0\0"), "");
    }

    #[test]
    fn a_minimized_window_or_one_on_another_workspace_is_not_followed() {
        let hidden = 77;
        assert!(shown(&[12, 13], hidden, Some(1), Some(1)));
        assert!(!shown(&[12, hidden], hidden, Some(1), Some(1)));
        assert!(!shown(&[], hidden, Some(2), Some(1)));
        assert!(shown(&[], hidden, Some(ALL_DESKTOPS), Some(1)));
        assert!(shown(&[], hidden, None, Some(1)));
        assert!(shown(&[], hidden, Some(3), None));
    }

    #[test]
    fn the_frame_adds_the_title_bar_and_drops_the_shadow() {
        // Server-side title bar 24 px, borders 2 px.
        assert_eq!(visible_frame([100, 50, 800, 600], &[2, 2, 24, 2], &[]), [98.0, 26.0, 902.0, 652.0]);
        // A GTK app drawing its own shadow, 10 px on every side.
        assert_eq!(visible_frame([100, 50, 800, 600], &[], &[10, 10, 10, 10]), [110.0, 60.0, 890.0, 640.0]);
        assert_eq!(visible_frame([0, 0, 640, 480], &[], &[]), [0.0, 0.0, 640.0, 480.0]);
    }
}

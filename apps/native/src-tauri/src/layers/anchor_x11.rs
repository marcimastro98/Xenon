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
use std::ffi::{c_char, c_int, c_long, c_uchar, c_uint, c_ulong, c_void, CStr};
use std::sync::OnceLock;
use std::time::Duration;

use gtk::glib::object::ObjectType;
use gtk::glib::ControlFlow;
use gtk::prelude::{GtkWindowExt, WidgetExt};

use super::anchor::{self, Seen};
use super::linux;
use super::spec::Anchor;

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

extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// The Xlib and GDK-X11 functions used here, all decades old.
struct Api {
    xdisplay: unsafe extern "C" fn(*mut gtk::gdk::ffi::GdkDisplay) -> *mut Display,
    xid: unsafe extern "C" fn(*mut gtk::gdk::ffi::GdkWindow) -> Xid,
    root: unsafe extern "C" fn(*mut Display) -> Xid,
    intern: unsafe extern "C" fn(*mut Display, *const c_char, c_int) -> Atom,
    #[allow(clippy::type_complexity)]
    property: unsafe extern "C" fn(
        *mut Display,
        Xid,
        Atom,
        c_long,
        c_long,
        c_int,
        Atom,
        *mut Atom,
        *mut c_int,
        *mut c_ulong,
        *mut c_ulong,
        *mut *mut c_uchar,
    ) -> c_int,
    free: unsafe extern "C" fn(*mut c_void) -> c_int,
    #[allow(clippy::type_complexity)]
    geometry: unsafe extern "C" fn(
        *mut Display,
        Xid,
        *mut Xid,
        *mut c_int,
        *mut c_int,
        *mut c_uint,
        *mut c_uint,
        *mut c_uint,
        *mut c_uint,
    ) -> c_int,
    translate: unsafe extern "C" fn(*mut Display, Xid, Xid, c_int, c_int, *mut c_int, *mut c_int, *mut Xid) -> c_int,
    transient_for: unsafe extern "C" fn(*mut Display, Xid, Xid) -> c_int,
}

static API: OnceLock<Option<Api>> = OnceLock::new();

fn api() -> Option<&'static Api> {
    API.get_or_init(load).as_ref()
}

// The signatures are the struct's fields: spelling each one again in the
// transmute would only repeat them.
#[allow(clippy::missing_transmute_annotations)]
fn load() -> Option<Api> {
    // SAFETY: library names and NUL-terminated symbol names; every symbol is
    // checked for null before it becomes a function pointer of the signature
    // Xlib.h, Xutil.h and gdkx.h declare.
    unsafe {
        let x11 = dlopen(c"libX11.so.6".as_ptr(), RTLD_NOW);
        let gdk = dlopen(c"libgdk-3.so.0".as_ptr(), RTLD_NOW);
        if x11.is_null() || gdk.is_null() {
            return None;
        }
        macro_rules! sym {
            ($lib:expr, $name:literal) => {{
                let p = dlsym($lib, $name.as_ptr());
                if p.is_null() {
                    return None;
                }
                std::mem::transmute::<*mut c_void, _>(p)
            }};
        }
        Some(Api {
            xdisplay: sym!(gdk, c"gdk_x11_display_get_xdisplay"),
            xid: sym!(gdk, c"gdk_x11_window_get_xid"),
            root: sym!(x11, c"XDefaultRootWindow"),
            intern: sym!(x11, c"XInternAtom"),
            property: sym!(x11, c"XGetWindowProperty"),
            free: sym!(x11, c"XFree"),
            geometry: sym!(x11, c"XGetGeometry"),
            translate: sym!(x11, c"XTranslateCoordinates"),
            transient_for: sym!(x11, c"XSetTransientForHint"),
        })
    }
}

/// The atoms read here, interned once: the X server outlives the app.
struct Atoms {
    stacking: Atom,
    state: Atom,
    hidden: Atom,
    desktop: Atom,
    current_desktop: Atom,
    desktops: Atom,
    frame: Atom,
    gtk_frame: Atom,
    pid: Atom,
    class: Atom,
}

static ATOMS: OnceLock<Atoms> = OnceLock::new();

/// GDK's X connection, and the calls to make on it.
struct X {
    api: &'static Api,
    dpy: *mut Display,
    root: Xid,
    atoms: &'static Atoms,
}

impl X {
    fn open() -> Option<X> {
        let api = api()?;
        let display = gtk::gdk::Display::default()?;
        // SAFETY: GDK's live display on the main thread; `linux::usable` and
        // `!layer_shell` (the only way an anchor reaches here) mean it is X11.
        let dpy = unsafe { (api.xdisplay)(display.as_ptr()) };
        if dpy.is_null() {
            return None;
        }
        // SAFETY: a live Display; the atom names are NUL-terminated.
        let root = unsafe { (api.root)(dpy) };
        let atom = |name: &CStr| unsafe { (api.intern)(dpy, name.as_ptr(), 0) };
        let atoms = ATOMS.get_or_init(|| Atoms {
            stacking: atom(c"_NET_CLIENT_LIST_STACKING"),
            state: atom(c"_NET_WM_STATE"),
            hidden: atom(c"_NET_WM_STATE_HIDDEN"),
            desktop: atom(c"_NET_WM_DESKTOP"),
            current_desktop: atom(c"_NET_CURRENT_DESKTOP"),
            desktops: atom(c"_NET_NUMBER_OF_DESKTOPS"),
            frame: atom(c"_NET_FRAME_EXTENTS"),
            gtk_frame: atom(c"_GTK_FRAME_EXTENTS"),
            pid: atom(c"_NET_WM_PID"),
            class: atom(c"WM_CLASS"),
        });
        Some(X { api, dpy, root, atoms })
    }

    /// A property's raw items and their format (8, 16 or 32), up to 4096 of
    /// them. Format 32 items come as C longs, as Xlib hands them over.
    fn read(&self, w: Xid, name: Atom) -> Option<(c_int, Vec<u8>, usize)> {
        let (mut kind, mut format, mut n, mut after) = (0, 0, 0, 0);
        let mut data: *mut c_uchar = std::ptr::null_mut();
        // SAFETY: a live Display; every out-pointer is a local; the data Xlib
        // returns is copied out and then freed with XFree.
        unsafe {
            let ok = (self.api.property)(
                self.dpy, w, name, 0, 4096, 0, ANY_PROPERTY_TYPE,
                &mut kind, &mut format, &mut n, &mut after, &mut data,
            );
            if ok != SUCCESS || data.is_null() {
                return None;
            }
            let item = match format {
                8 => 1,
                16 => std::mem::size_of::<std::ffi::c_short>(),
                _ => std::mem::size_of::<c_long>(),
            };
            let bytes = std::slice::from_raw_parts(data, n as usize * item).to_vec();
            (self.api.free)(data.cast());
            Some((format, bytes, n as usize))
        }
    }

    /// A format-32 property as numbers (window ids, atoms, cardinals).
    fn numbers(&self, w: Xid, name: Atom) -> Vec<c_ulong> {
        match self.read(w, name) {
            Some((32, bytes, _)) => bytes
                .chunks_exact(std::mem::size_of::<c_ulong>())
                .map(|c| c_ulong::from_ne_bytes(c.try_into().unwrap_or_default()))
                .collect(),
            _ => Vec::new(),
        }
    }

    /// The app a window belongs to, named as the server's app list names it
    /// (linux-collectors.js): the WM_CLASS class, else the program's file name.
    fn app(&self, w: Xid) -> String {
        let class = match self.read(w, self.atoms.class) {
            Some((8, bytes, _)) => class_of(&bytes),
            _ => String::new(),
        };
        if !class.is_empty() {
            return class;
        }
        let Some(&pid) = self.numbers(w, self.atoms.pid).first() else { return String::new() };
        std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default()
    }

    /// Not minimized, and on the workspace in view (or on all of them).
    fn on_screen(&self, w: Xid, current: Option<c_ulong>) -> bool {
        let state = self.numbers(w, self.atoms.state);
        let desktop = self.numbers(w, self.atoms.desktop).first().copied();
        shown(&state, self.atoms.hidden, desktop, current)
    }

    /// The window as the person sees it, in X pixels: its client area plus the
    /// window manager's frame, minus the shadow a client-side decorated app
    /// draws inside it.
    fn frame(&self, w: Xid) -> Option<[f64; 4]> {
        let (mut root, mut x, mut y, mut width, mut height, mut border, mut depth) = (0, 0, 0, 0, 0, 0, 0);
        let (mut left, mut top, mut child) = (0, 0, 0);
        // SAFETY: a live Display; every out-pointer is a local. A window that
        // just closed makes the call fail inside the caller's error trap.
        let ok = unsafe {
            (self.api.geometry)(self.dpy, w, &mut root, &mut x, &mut y, &mut width, &mut height, &mut border, &mut depth)
                != 0
                && (self.api.translate)(self.dpy, w, self.root, 0, 0, &mut left, &mut top, &mut child) != 0
        };
        if !ok {
            return None;
        }
        let net = self.numbers(w, self.atoms.frame);
        let csd = self.numbers(w, self.atoms.gtk_frame);
        Some(visible_frame([left, top, width as c_int, height as c_int], &net, &csd))
    }
}

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

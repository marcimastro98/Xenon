// Linux: one connection to the X server and what it is asked: a window's properties, frame and desktop.

use std::ffi::{c_int, c_long, c_uchar, c_ulong, CStr};
use std::sync::OnceLock;
use gtk::glib::object::ObjectType;
use super::{ANY_PROPERTY_TYPE, Atom, class_of, Display, shown, SUCCESS, visible_frame, Xid};
use super::xlib::{api, Api};

/// The atoms read here, interned once: the X server outlives the app.
pub(super) struct Atoms {
    pub(super) stacking: Atom,
    state: Atom,
    hidden: Atom,
    desktop: Atom,
    pub(super) current_desktop: Atom,
    pub(super) desktops: Atom,
    pub(super) frame: Atom,
    gtk_frame: Atom,
    pid: Atom,
    class: Atom,
}

static ATOMS: OnceLock<Atoms> = OnceLock::new();

/// GDK's X connection, and the calls to make on it.
pub(super) struct X {
    pub(super) api: &'static Api,
    pub(super) dpy: *mut Display,
    pub(super) root: Xid,
    pub(super) atoms: &'static Atoms,
}

impl X {
    pub(super) fn open() -> Option<X> {
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
    pub(super) fn numbers(&self, w: Xid, name: Atom) -> Vec<c_ulong> {
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
    pub(super) fn app(&self, w: Xid) -> String {
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
    pub(super) fn on_screen(&self, w: Xid, current: Option<c_ulong>) -> bool {
        let state = self.numbers(w, self.atoms.state);
        let desktop = self.numbers(w, self.atoms.desktop).first().copied();
        shown(&state, self.atoms.hidden, desktop, current)
    }

    /// The window as the person sees it, in X pixels: its client area plus the
    /// window manager's frame, minus the shadow a client-side decorated app
    /// draws inside it.
    pub(super) fn frame(&self, w: Xid) -> Option<[f64; 4]> {
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

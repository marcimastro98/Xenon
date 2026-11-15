// Linux: the few Xlib calls an anchored widget needs, loaded from the library the session already has.

use std::ffi::{c_char, c_int, c_long, c_uchar, c_uint, c_ulong, c_void};
use std::sync::OnceLock;
use super::{Atom, Display, RTLD_NOW, Xid};

extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// The Xlib and GDK-X11 functions used here, all decades old.
pub(super) struct Api {
    pub(super) xdisplay: unsafe extern "C" fn(*mut gtk::gdk::ffi::GdkDisplay) -> *mut Display,
    pub(super) xid: unsafe extern "C" fn(*mut gtk::gdk::ffi::GdkWindow) -> Xid,
    pub(super) root: unsafe extern "C" fn(*mut Display) -> Xid,
    pub(super) intern: unsafe extern "C" fn(*mut Display, *const c_char, c_int) -> Atom,
    #[allow(clippy::type_complexity)]
    pub(super) property: unsafe extern "C" fn(
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
    pub(super) free: unsafe extern "C" fn(*mut c_void) -> c_int,
    #[allow(clippy::type_complexity)]
    pub(super) geometry: unsafe extern "C" fn(
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
    pub(super) translate: unsafe extern "C" fn(*mut Display, Xid, Xid, c_int, c_int, *mut c_int, *mut c_int, *mut Xid) -> c_int,
    pub(super) transient_for: unsafe extern "C" fn(*mut Display, Xid, Xid) -> c_int,
}

static API: OnceLock<Option<Api>> = OnceLock::new();

pub(super) fn api() -> Option<&'static Api> {
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

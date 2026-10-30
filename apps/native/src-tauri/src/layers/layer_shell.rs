//! Layer windows on Wayland, through the wlr layer-shell protocol (KDE Plasma,
//! Sway, Hyprland and the other wlroots desktops; GNOME has no such protocol).
//! A layer surface is placed by the compositor: on one monitor, stretched to
//! the edges it is anchored to, in a band (background, bottom, top, overlay)
//! that normal windows never cross.
//!
//! The library (`libgtk-layer-shell.so.0`) is opened at run time, when the
//! session is Wayland, and only if the system has it: nothing is linked at
//! build time, so the app still starts where it is missing, and the layers are
//! then reported unavailable like on GNOME. The gtk-layer-shell crate is not
//! used: it is unmaintained.
//!
//! A window becomes a layer surface only before GTK realizes it, so a window
//! that is already up is hidden and unrealized first, once (`place`).
//! Main thread only, like the rest of the GTK calls.
#![cfg(target_os = "linux")]

use std::ffi::{c_char, c_int, c_void};
use std::sync::OnceLock;

use gtk::glib::object::ObjectType;
use gtk::prelude::{GtkWindowExt, WidgetExt};

use super::spec::Kind;

type Win = *mut gtk::ffi::GtkWindow;

extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
const RTLD_NOW: c_int = 2;

// The library's enums (gtk-layer-shell.h).
const LAYER_BACKGROUND: c_int = 0;
const LAYER_BOTTOM: c_int = 1;
const LAYER_TOP: c_int = 2;
const LAYER_OVERLAY: c_int = 3;
const EDGES: [c_int; 4] = [0, 1, 2, 3]; // left, right, top, bottom
const KEYBOARD_NONE: c_int = 0;
const KEYBOARD_EXCLUSIVE: c_int = 1;

/// The functions Xenon calls, all present since gtk-layer-shell 0.6 (2021).
struct Api {
    is_supported: unsafe extern "C" fn() -> c_int,
    init_for_window: unsafe extern "C" fn(Win),
    is_layer_window: unsafe extern "C" fn(Win) -> c_int,
    set_namespace: unsafe extern "C" fn(Win, *const c_char),
    set_layer: unsafe extern "C" fn(Win, c_int),
    set_anchor: unsafe extern "C" fn(Win, c_int, c_int),
    set_exclusive_zone: unsafe extern "C" fn(Win, c_int),
    set_monitor: unsafe extern "C" fn(Win, *mut gtk::gdk::ffi::GdkMonitor),
    set_keyboard_mode: unsafe extern "C" fn(Win, c_int),
}

static API: OnceLock<Option<Api>> = OnceLock::new();

fn api() -> Option<&'static Api> {
    API.get_or_init(load).as_ref()
}

fn load() -> Option<Api> {
    // SAFETY: a library name and NUL-terminated symbol names; every symbol is
    // checked for null before it becomes a function pointer of the signature
    // gtk-layer-shell.h declares.
    unsafe {
        let lib = dlopen(c"libgtk-layer-shell.so.0".as_ptr(), RTLD_NOW);
        if lib.is_null() {
            return None;
        }
        macro_rules! sym {
            ($name:literal) => {{
                let p = dlsym(lib, $name.as_ptr());
                if p.is_null() {
                    return None;
                }
                std::mem::transmute::<*mut c_void, _>(p)
            }};
        }
        Some(Api {
            is_supported: sym!(c"gtk_layer_is_supported"),
            init_for_window: sym!(c"gtk_layer_init_for_window"),
            is_layer_window: sym!(c"gtk_layer_is_layer_window"),
            set_namespace: sym!(c"gtk_layer_set_namespace"),
            set_layer: sym!(c"gtk_layer_set_layer"),
            set_anchor: sym!(c"gtk_layer_set_anchor"),
            set_exclusive_zone: sym!(c"gtk_layer_set_exclusive_zone"),
            set_monitor: sym!(c"gtk_layer_set_monitor"),
            set_keyboard_mode: sym!(c"gtk_layer_set_keyboard_mode"),
        })
    }
}

/// The library is on the system and the compositor speaks layer-shell. Main
/// thread, after GTK has its display.
pub fn supported() -> bool {
    // SAFETY: a no-argument query of the library just loaded.
    api().is_some_and(|a| unsafe { (a.is_supported)() } != 0)
}

/// Which band a surface lives in. The desktop layer comes up to the top band
/// while its widgets are edited; the overlay and the screensaver sit over
/// full-screen windows too.
fn band(kind: Kind, editing: bool) -> c_int {
    match kind {
        Kind::Wallpaper => LAYER_BACKGROUND,
        Kind::Desktop if editing => LAYER_TOP,
        Kind::Desktop => LAYER_BOTTOM,
        _ => LAYER_OVERLAY,
    }
}

/// The scenes and the drawing sheet cover the whole monitor, panels included
/// (-1); the widget layers keep clear of the panels (0), like the work area on
/// the other systems.
fn exclusive_zone(kind: Kind) -> c_int {
    if matches!(kind, Kind::Wallpaper | Kind::Saver | Kind::Draw | Kind::Menu) {
        -1
    } else {
        0
    }
}

/// Make `w` a layer surface of `kind` on `monitor`, stretched to its edges.
/// Only the screensaver and the drawing sheet take the keyboard. Leaves the window hidden when it
/// had to be rebuilt: the caller shows it.
pub fn place(w: &gtk::Window, kind: Kind, editing: bool, monitor: Option<&gtk::gdk::Monitor>) {
    let Some(a) = api() else { return };
    let p: Win = w.as_ptr();
    // SAFETY: `p` is a live GtkWindow (found among GTK's toplevels by the
    // caller) on the main thread; the calls follow gtk-layer-shell.h, with
    // `init_for_window` only on an unrealized window.
    unsafe {
        if (a.is_layer_window)(p) == 0 {
            w.hide();
            if w.is_realized() {
                w.unrealize();
            }
            (a.init_for_window)(p);
            (a.set_namespace)(p, c"xenon".as_ptr());
            for edge in EDGES {
                (a.set_anchor)(p, edge, 1);
            }
        }
        (a.set_layer)(p, band(kind, editing));
        (a.set_exclusive_zone)(p, exclusive_zone(kind));
        let keyboard = if takes_keys(kind) { KEYBOARD_EXCLUSIVE } else { KEYBOARD_NONE };
        (a.set_keyboard_mode)(p, keyboard);
        if let Some(m) = monitor {
            (a.set_monitor)(p, m.as_ptr());
        }
    }
    w.set_accept_focus(takes_keys(kind));
}

/// Make a new, not yet shown `w` the edge glow's surface (glow_linux.rs) on
/// `monitor`: the overlay band, every edge, over the panels, never the keyboard.
pub fn place_glow(w: &gtk::Window, monitor: Option<&gtk::gdk::Monitor>) {
    let Some(a) = api() else { return };
    let p: Win = w.as_ptr();
    // SAFETY: `p` is a live GtkWindow the caller just made and has not
    // realized, on the main thread; the calls follow gtk-layer-shell.h.
    unsafe {
        (a.init_for_window)(p);
        (a.set_namespace)(p, c"xenon-glow".as_ptr());
        for edge in EDGES {
            (a.set_anchor)(p, edge, 1);
        }
        (a.set_layer)(p, LAYER_OVERLAY);
        (a.set_exclusive_zone)(p, -1);
        (a.set_keyboard_mode)(p, KEYBOARD_NONE);
        if let Some(m) = monitor {
            (a.set_monitor)(p, m.as_ptr());
        }
    }
}

fn takes_keys(kind: Kind) -> bool {
    matches!(kind, Kind::Saver | Kind::Draw | Kind::Menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_surface_has_its_band() {
        assert_eq!(band(Kind::Wallpaper, false), LAYER_BACKGROUND);
        assert_eq!(band(Kind::Desktop, false), LAYER_BOTTOM);
        assert_eq!(band(Kind::Desktop, true), LAYER_TOP);
        assert_eq!(band(Kind::Overlay, false), LAYER_OVERLAY);
        assert_eq!(band(Kind::Saver, false), LAYER_OVERLAY);
        assert_eq!(band(Kind::Draw, false), LAYER_OVERLAY);
    }

    #[test]
    fn only_the_scenes_cover_the_panels() {
        assert_eq!(exclusive_zone(Kind::Wallpaper), -1);
        assert_eq!(exclusive_zone(Kind::Saver), -1);
        assert_eq!(exclusive_zone(Kind::Draw), -1);
        assert_eq!(exclusive_zone(Kind::Desktop), 0);
        assert_eq!(exclusive_zone(Kind::Overlay), 0);
    }

    #[test]
    fn only_the_screensaver_and_the_drawing_sheet_take_the_keyboard() {
        assert!(takes_keys(Kind::Saver) && takes_keys(Kind::Draw) && takes_keys(Kind::Menu));
        assert_eq!(exclusive_zone(Kind::Menu), -1);
        assert!(!takes_keys(Kind::Overlay) && !takes_keys(Kind::Desktop) && !takes_keys(Kind::Wallpaper));
    }
}

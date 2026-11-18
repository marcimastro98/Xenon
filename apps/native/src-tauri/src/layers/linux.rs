//! How each layer window behaves on Linux (phase 5), on X11 and on the Wayland
//! desktops that speak layer-shell (layer_shell.rs, where the bands below are
//! the compositor's own: background, bottom, top, overlay):
//!
//! - desktop: kept below the other windows (`_NET_WM_STATE_BELOW`), on every
//!   workspace. In edit mode it comes above them so the widgets can be dragged.
//! - overlay, and the alerts window: kept above (`_NET_WM_STATE_ABOVE`), on
//!   every workspace. A full-screen game may still cover it: the window
//!   manager decides that stacking, not us.
//! - wallpaper (the Ambient scene): a desktop-type window under every other one,
//!   on every workspace, that no click reaches. Hidden while a full-screen
//!   window covers its monitor or the page asks (battery). Desktops that draw
//!   their own icons (KDE, Xfce) may stack it over them: the window manager
//!   decides, and the settings say so.
//! - screensaver: full screen, above everything, takes the keyboard.
//! - the drawing sheet (draw.html): like the screensaver, full screen, above
//!   everything, takes the keyboard (its keys pick colours and close it).
//! - anchored widgets (X11 only, anchor_x11.rs): next to one app's window,
//!   transient for it so the window manager keeps them right above it. A
//!   layer-shell session never says where another app's window is, so there
//!   `draws` is false and nothing offers them.
//!
//! Clicks next to a tile reach the window underneath: the input shape of the
//! window is cut to the rectangles its page reported (XShape), so nothing
//! polls the cursor. Only the screensaver and the drawing sheet take the
//! keyboard.
//!
//! GNOME on Wayland has no way for an app to stack itself under or over the
//! others, so `available` is false there and the dashboard says so.
//! Transparency needs a compositor: without one the window would be an opaque
//! black screen, so that counts as unavailable too.
//!
//! Main-thread only, like win32.rs: the state is a thread-local, and a window is
//! only touched after it is found among GTK's live toplevels, so a handle whose
//! window was just destroyed is dropped, never dereferenced.
#![cfg(target_os = "linux")]

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use gtk::glib::object::{Cast, ObjectType};
use gtk::glib::translate::ToGlibPtr;
use gtk::gdk::prelude::MonitorExt;
use gtk::prelude::{GtkApplicationExt, GtkWindowExt, WidgetExt};

use super::anchor_x11;
use super::layer_shell;
use super::spec::{Anchor, Kind};

mod session;
mod wallpaper;
mod cover;
mod saver;

use cover::watch_cover;
#[cfg(test)]
use cover::discharging;
pub use saver::saver_held;
pub use session::{handle_of, layer_shell, probe, usable};
use wallpaper::{anchored, cut, show_wallpaper, take_all, wallpaper, widgets};
use super::APP;

pub struct Plan {
    pub handle: isize,
    pub kind: Kind,
    /// Where the surface goes, logical pixels (x, y, width, height): a wallpaper
    /// is sized from it on X11, a layer surface takes its monitor from it.
    pub area: Option<[i32; 4]>,
    /// The app an `anchor:` window follows.
    pub anchor: Option<Anchor>,
}

struct Entry {
    handle: isize,
    kind: Kind,
    /// The page's tiles, device pixels of its own window (layer-host.js).
    rects: Vec<[i32; 4]>,
    /// A wallpaper the page paused (`set_paused`), or one `watch_cover`
    /// rests (a full-screen window covers it, the PC runs on battery):
    /// hidden while either holds.
    paused: bool,
    covered: bool,
    area: Option<[i32; 4]>,
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    /// Rectangles a page reported before its window joined `entries`.
    pending: Vec<(isize, Vec<[i32; 4]>)>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

static EDITING: AtomicBool = AtomicBool::new(false);
/// `probe` found an X11 session with a compositor, or layer-shell.
static USABLE: AtomicBool = AtomicBool::new(false);
/// `probe` found a Wayland session with layer-shell: the windows are layer
/// surfaces, placed by the compositor.
static SHELL: AtomicBool = AtomicBool::new(false);
/// `watch_cover` runs: only while there is a wallpaper.
static WATCHING: AtomicBool = AtomicBool::new(false);
const COVER_EVERY: Duration = Duration::from_secs(2);

/// What this backend can draw.
pub fn draws(kind: Kind) -> bool {
    match kind {
        Kind::Anchor => !layer_shell(),
        _ => matches!(kind, Kind::Desktop | Kind::Overlay | Kind::Wallpaper | Kind::Saver | Kind::Draw | Kind::Menu),
    }
}

pub(super) fn find(handle: isize) -> Option<gtk::Window> {
    gtk::Window::list_toplevels()
        .into_iter()
        .find(|w| w.as_ptr() as isize == handle)
        .and_then(|w| w.downcast::<gtk::Window>().ok())
}

fn configure(w: &gtk::Window, e: &Entry) {
    // A window with a title bar on every desktop: a layer surface has none.
    if e.kind == Kind::Menu {
        w.input_shape_combine_region(None);
        // An ordinary window unless a game is on.
        w.set_keep_above(super::menu_window::stays_on_top());
        w.set_accept_focus(true);
        return;
    }
    if layer_shell() {
        let monitor = e.area.and_then(|[x, y, width, height]| w.display().monitor_at_point(x + width / 2, y + height / 2));
        layer_shell::place(w, e.kind, EDITING.load(Ordering::Relaxed), monitor.as_ref());
        match e.kind {
            Kind::Wallpaper => show_wallpaper(w, e),
            // Every input is the screensaver's (any key or move ends it), or
            // the drawing sheet's.
            Kind::Saver | Kind::Draw => {
                w.input_shape_combine_region(None);
                w.show();
            }
            _ => w.show(),
        }
        return;
    }
    match e.kind {
        Kind::Wallpaper => wallpaper(w, e),
        Kind::Saver | Kind::Draw => take_all(w),
        Kind::Anchor => anchored(w),
        _ => widgets(w, e.kind),
    }
}

/// Apply a sync: forget windows that are gone, set up new ones.
/// No saver or menu here takes the focus away from an app (see macos.rs, win32.rs).
pub fn forget_return_focus() {}

pub fn apply(plans: Vec<Plan>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else {
            return;
        };
        let mut old = std::mem::take(&mut st.entries);
        let mut anchored = Vec::new();
        for p in plans {
            let Some(w) = find(p.handle) else {
                continue;
            };
            // Takes the keyboard when it opens, never again: the user may be
            // in the app under it by the next sync.
            let menu_opened = p.kind == Kind::Menu && !old.iter().any(|e| e.handle == p.handle);
            let mut e = match old.iter().position(|e| e.handle == p.handle) {
                Some(i) => old.swap_remove(i),
                None => {
                    let i = st.pending.iter().position(|(h, _)| *h == p.handle);
                    let rects = i.map(|i| st.pending.swap_remove(i).1).unwrap_or_default();
                    // Cut before the first report too: a screen-sized window
                    // that swallowed clicks would break the desktop.
                    cut(&w, &rects);
                    Entry { handle: p.handle, kind: p.kind, rects, paused: false, covered: false, area: None }
                }
            };
            e.kind = p.kind;
            e.area = p.area;
            if let (Kind::Anchor, Some(a)) = (p.kind, p.anchor) {
                anchored.push((p.handle, a));
            }
            configure(&w, &e);
            if menu_opened {
                w.present();
            }
            st.entries.push(e);
        }
        st.pending.retain(|(h, _)| find(*h).is_some());
        if st.entries.iter().any(|e| e.kind == Kind::Wallpaper) && !WATCHING.swap(true, Ordering::Relaxed) {
            gtk::glib::timeout_add_local(COVER_EVERY, watch_cover);
        }
        anchor_x11::set(anchored);
    });
}

/// The page's tile rectangles, and whether the widgets are being edited
/// (`None` from the alerts window, which has no say in it). Main thread: the
/// navigation hooks run there. The input shape is all they cut here, the drawing
/// stays whole, so words that clicks go through need nothing.
pub fn set_region(handle: isize, rects: Vec<[i32; 4]>, _through: Vec<[i32; 4]>, editing: Option<bool>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else {
            return;
        };
        st.entries.retain(|e| find(e.handle).is_some());
        match st.entries.iter_mut().find(|e| e.handle == handle) {
            Some(e) => {
                if let Some(w) = find(handle) {
                    cut(&w, &rects);
                }
                e.rects = rects;
            }
            None => {
                st.pending.retain(|(h, _)| *h != handle);
                st.pending.push((handle, rects));
            }
        }
        let Some(editing) = editing else { return };
        if EDITING.swap(editing, Ordering::Relaxed) != editing {
            for e in st.entries.iter().filter(|e| e.kind == Kind::Desktop) {
                if let Some(w) = find(e.handle) {
                    configure(&w, e);
                }
            }
        }
    });
}

/// A widget picked in edit mode takes the keyboard for its arrows, and lets it
/// go after (keys.rs). Main thread. A sync while it is held (`configure`) puts
/// the window back to taking none: the next pick asks again.
pub fn set_keys(handle: isize, on: bool) {
    let Some(w) = find(handle) else { return };
    if layer_shell() {
        layer_shell::keyboard(&w, on);
    }
    w.set_accept_focus(on);
    if on {
        w.present();
    }
}

/// `xenon-app:scene-pause` from a wallpaper page: on battery it is hidden
/// until the charger is back. Main thread: the navigation hooks run there.
pub fn set_paused(handle: isize, paused: bool) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        let wallpaper = st.entries.iter_mut().find(|e| e.handle == handle && e.kind == Kind::Wallpaper);
        let Some(e) = wallpaper else { return };
        e.paused = paused;
        if let Some(w) = find(handle) {
            show_wallpaper(&w, e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::discharging;

    #[test]
    fn only_a_discharging_battery_rests_the_wallpaper() {
        assert!(discharging("Battery\n", "Discharging\n"));
        assert!(!discharging("Battery\n", "Charging\n"));
        assert!(!discharging("Battery\n", "Full\n"));
        assert!(!discharging("Battery\n", "Not charging\n"));
        assert!(!discharging("Mains\n", "Discharging\n"));
        assert!(!discharging("", ""));
    }
}

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

use gtk::cairo::{RectangleInt, Region};
use gtk::gdk::WindowTypeHint;
use gtk::glib::object::{Cast, ObjectType};
use gtk::glib::translate::{from_glib_full, ToGlibPtr};
use gtk::gdk::prelude::MonitorExt;
use gtk::prelude::{GtkApplicationExt, GtkWindowExt, WidgetExt};

use super::anchor_x11;
use super::layer_shell;
use super::spec::{Anchor, Kind};

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

pub(super) fn find(handle: isize) -> Option<gtk::Window> {
    gtk::Window::list_toplevels()
        .into_iter()
        .find(|w| w.as_ptr() as isize == handle)
        .and_then(|w| w.downcast::<gtk::Window>().ok())
}

fn configure(w: &gtk::Window, e: &Entry) {
    if layer_shell() {
        let monitor = e.area.and_then(|[x, y, width, height]| w.display().monitor_at_point(x + width / 2, y + height / 2));
        layer_shell::place(w, e.kind, EDITING.load(Ordering::Relaxed), monitor.as_ref());
        match e.kind {
            Kind::Wallpaper => show_wallpaper(w, e),
            // Every input is the screensaver's (any key or move ends it), or
            // the drawing sheet's, or the menu's.
            Kind::Saver | Kind::Draw | Kind::Menu => {
                w.input_shape_combine_region(None);
                w.show();
            }
            _ => w.show(),
        }
        return;
    }
    match e.kind {
        Kind::Wallpaper => wallpaper(w, e),
        Kind::Saver | Kind::Draw | Kind::Menu => take_all(w),
        Kind::Anchor => anchored(w),
        _ => widgets(w, e.kind),
    }
}

fn widgets(w: &gtk::Window, kind: Kind) {
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
fn anchored(w: &gtk::Window) {
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
fn wallpaper(w: &gtk::Window, e: &Entry) {
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
fn show_wallpaper(w: &gtk::Window, e: &Entry) {
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
fn take_all(w: &gtk::Window) {
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
fn cut(w: &gtk::Window, rects: &[[i32; 4]]) {
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
}

/// Apply a sync: forget windows that are gone, set up new ones.
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
            st.entries.push(e);
        }
        st.pending.retain(|(h, _)| find(*h).is_some());
        if st.entries.iter().any(|e| e.kind == Kind::Wallpaper) && !WATCHING.swap(true, Ordering::Relaxed) {
            gtk::glib::timeout_add_local(COVER_EVERY, watch_cover);
        }
        anchor_x11::set(anchored);
    });
}

/// Every 2 s while there is a wallpaper: hide the ones on the monitor of a
/// full-screen window in front (nothing animates behind it), and all of them
/// on battery (WebKitGTK has no battery API for the page to ask); show them
/// again after. Stops with the last wallpaper.
fn watch_cover() -> gtk::glib::ControlFlow {
    let full = fullscreen_monitor();
    let battery = on_battery();
    let go_on = STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return true };
        st.entries.retain(|e| find(e.handle).is_some());
        let mut any = false;
        for e in st.entries.iter_mut().filter(|e| e.kind == Kind::Wallpaper) {
            any = true;
            let Some(w) = find(e.handle) else { continue };
            let on = w.window().and_then(|g| g.display().monitor_at_window(&g));
            let covered = battery || (full.is_some() && on == full);
            if covered != e.covered {
                e.covered = covered;
                show_wallpaper(&w, e);
            }
        }
        any
    });
    if go_on {
        return gtk::glib::ControlFlow::Continue;
    }
    WATCHING.store(false, Ordering::Relaxed);
    gtk::glib::ControlFlow::Break
}

/// The kernel's power supplies: a battery that is discharging. A PC without
/// one, or one plugged in, says no.
fn on_battery() -> bool {
    let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") else { return false };
    dir.flatten().any(|d| {
        let read = |name: &str| std::fs::read_to_string(d.path().join(name)).unwrap_or_default();
        discharging(&read("type"), &read("status"))
    })
}

fn discharging(kind: &str, status: &str) -> bool {
    kind.trim() == "Battery" && status.trim() == "Discharging"
}

/// The monitor of the active window when that window, not one of Xenon's,
/// fills it. Main thread.
fn fullscreen_monitor() -> Option<gtk::gdk::Monitor> {
    let screen = gtk::gdk::Screen::default()?;
    // gdk-rs leaves this call out (deprecated in GTK, still the X11 answer).
    // Transfer full: the reference is ours, released with `active`.
    let active: gtk::gdk::Window =
        unsafe { from_glib_full::<_, Option<_>>(gtk::gdk::ffi::gdk_screen_get_active_window(screen.to_glib_none().0)) }?;
    let ours = gtk::Window::list_toplevels().iter().any(|t| t.window().as_ref() == Some(&active));
    if ours {
        return None;
    }
    // Another app's window can close between the two calls: X then answers
    // BadDrawable, which GDK turns into an exit unless it is trapped.
    gtk::gdk::error_trap_push();
    let found = active.display().monitor_at_window(&active).map(|m| (active.frame_extents(), m));
    if gtk::gdk::error_trap_pop() != 0 {
        return None;
    }
    let (r, monitor) = found?;
    let m = monitor.geometry();
    let fills = (r.x(), r.y(), r.width(), r.height()) == (m.x(), m.y(), m.width(), m.height());
    fills.then_some(monitor)
}

/// The page's tile rectangles, and whether the widgets are being edited
/// (`None` from the alerts window, which has no say in it). Main thread: the
/// navigation hooks run there.
pub fn set_region(handle: isize, rects: Vec<[i32; 4]>, editing: Option<bool>) {
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

/// Whether a screensaver must wait: an app keeps the screen on (a video asks
/// the session to stay awake) or a window in front is in full screen. Called
/// on a plain thread, so asked of the main thread; no answer in 2 s = go on.
pub fn saver_held() -> bool {
    let Some(app) = super::APP.get() else { return false };
    let (tx, rx) = std::sync::mpsc::channel();
    let asked = app.run_on_main_thread(move || {
        let _ = tx.send(idle_inhibited() || fullscreen_monitor().is_some());
    });
    asked.is_ok() && rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false)
}

/// Some app holds the session's idle inhibitor (what a video player takes).
/// The session manager answers; a desktop without one says no.
fn idle_inhibited() -> bool {
    gtk::Window::list_toplevels()
        .into_iter()
        .filter_map(|w| w.downcast::<gtk::Window>().ok()?.application())
        .next()
        .is_some_and(|a| a.is_inhibited(gtk::ApplicationInhibitFlags::IDLE))
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

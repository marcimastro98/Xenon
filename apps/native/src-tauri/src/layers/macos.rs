//! How each layer window behaves on macOS (phase 4; built here, not yet run on
//! a real Mac):
//!
//! - desktop: one level under the normal windows (so above the desktop icons),
//!   on every Space and left alone by Mission Control and window cycling. In
//!   edit mode it comes up to the floating level so the widgets can be dragged.
//! - overlay, and the alerts window: the status-bar level, on every Space and
//!   next to full-screen apps (`FullScreenAuxiliary`).
//! - wallpaper (the Ambient scene behind the desktop icons): just above the
//!   desktop picture, on every Space, never taking the mouse; on battery its
//!   page pauses it (`set_paused`), which hides it.
//! - screensaver: the screen-saver level, on every Space and over full-screen
//!   apps; it takes the mouse and the keyboard (the app is activated, and the
//!   app that was in front gets it back when the last one closes).
//! - both cover their whole monitor, menu bar included: the shared `place`
//!   puts every layer window on the work area, so a moved or resized scene
//!   window is snapped back to its screen's frame.
//! - anchored widgets: at the normal window level, right above the front
//!   window of their app and moved with it (anchor_macos.rs), on every Space
//!   and next to a full-screen app; ordered out when the app has no window on
//!   the screen. The whole window is the widget, so it always takes the mouse.
//!
//! macOS has no window regions: a window either takes the mouse or lets it
//! through. A watcher thread reads the cursor (`NSEvent::mouseLocation`, safe
//! off the main thread) and only when it moved asks the main thread to let each
//! window take the mouse while the cursor is over one of the rectangles its
//! page reported (`spec::hit`). It runs only while some window has a tile.
//!
//! An occluded window is throttled by WebKit itself, so a desktop layer under
//! a full-screen app costs nothing without the Windows "covered" logic.
//!
//! A click on a widget does make Xenon the active app: AppKit activates the
//! app of a clicked window, and only an NSPanel may refuse. The game in front
//! gets the keyboard back with a click.
//!
//! Main-thread only, like win32.rs: the state is a thread-local, and a window is
//! only touched after it is found among the app's live windows, so a handle
//! whose window was just destroyed is dropped, never dereferenced.
#![cfg(target_os = "macos")]

use std::cell::{OnceCell, RefCell};
use std::ffi::CStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSEvent, NSFloatingWindowLevel, NSNormalWindowLevel, NSScreenSaverWindowLevel,
    NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior,
};
use objc2_foundation::{NSArray, NSRect};
use tauri::AppHandle;

use super::anchor_macos;
use super::spec::{self, Anchor, Kind};

/// How often the watcher reads the cursor. A main-thread hop happens only when
/// it moved, so a still mouse costs one tiny read per tick.
const WATCH_EVERY: Duration = Duration::from_millis(50);

pub struct Plan {
    pub handle: isize,
    pub kind: Kind,
    pub anchor: Option<Anchor>,
}

struct Entry {
    handle: isize,
    kind: Kind,
    /// The page's tiles, device pixels of its own window (layer-host.js).
    rects: Vec<[i32; 4]>,
    takes_mouse: bool,
    /// A wallpaper its page paused (on battery): hidden until it resumes.
    paused: bool,
}

impl Entry {
    /// The Ambient scene or the drawing sheet: the whole monitor, its mouse
    /// fixed by its kind.
    fn scene(&self) -> bool {
        matches!(self.kind, Kind::Wallpaper | Kind::Saver | Kind::Draw | Kind::Menu)
    }
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    /// Rectangles a page reported before its window joined `entries`.
    pending: Vec<(isize, Vec<[i32; 4]>)>,
    /// The app in front when a screensaver took the keyboard.
    before_saver: Option<Retained<AnyObject>>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
    static OBSERVER: OnceCell<Retained<Observer>> = const { OnceCell::new() };
}

static EDITING: AtomicBool = AtomicBool::new(false);
/// Some window has tiles: the watcher keeps going.
static WANTED: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);
/// A hit test is queued on the main thread: a busy main thread gets one, not a pile.
static QUEUED: AtomicBool = AtomicBool::new(false);

/// What this backend can draw.
pub fn draws(kind: Kind) -> bool {
    matches!(kind, Kind::Desktop | Kind::Overlay | Kind::Anchor | Kind::Wallpaper | Kind::Saver | Kind::Draw | Kind::Menu)
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut AnyObject;
    fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
    fn CGDisplayBounds(display: u32) -> NSRect;
}
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMCopyAssertionsStatus(status: *mut *mut AnyObject) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: *mut AnyObject);
}
/// kCGDesktopWindowLevelKey: the desktop picture. The icons sit 20 above it.
const DESKTOP_LEVEL_KEY: i32 = 2;
/// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
const ON_SCREEN_WINDOWS: u32 = 1 | 16;

define_class!(
    // Snaps a scene window back to its whole screen when `place` (or anything
    // else) moves or resizes it. AppKit posts these on the main thread.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "XenonSceneFrameObserver"]
    struct Observer;

    impl Observer {
        #[unsafe(method(windowChanged:))]
        fn window_changed(&self, note: &AnyObject) {
            let window: Option<Retained<AnyObject>> = unsafe { msg_send![note, object] };
            let Some(window) = window else { return };
            let handle = Retained::as_ptr(&window) as isize;
            STATE.with(|cell| {
                let Ok(st) = cell.try_borrow() else { return };
                if !st.entries.iter().any(|e| e.handle == handle && e.scene()) {
                    return;
                }
                if let Some(w) = windows().and_then(|all| find(&all, handle)) {
                    fill_screen(&w);
                }
            });
        }
    }
);

/// An NSString from a C string, by message.
pub(super) fn ns_string(text: &CStr) -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"NSString")?;
    unsafe { msg_send![class, stringWithUTF8String: text.as_ptr()] }
}

/// Listens for scene windows being moved or resized, once.
fn observe(mtm: MainThreadMarker) {
    OBSERVER.with(|cell| {
        if cell.get().is_some() {
            return;
        }
        let Some(center_class) = AnyClass::get(c"NSNotificationCenter") else { return };
        let observer: Retained<Observer> = unsafe { msg_send![Observer::alloc(mtm), init] };
        let center: Retained<AnyObject> = unsafe { msg_send![center_class, defaultCenter] };
        for name in [c"NSWindowDidMoveNotification", c"NSWindowDidResizeNotification"] {
            let Some(name) = ns_string(name) else { continue };
            let any: Option<&AnyObject> = None;
            let _: () = unsafe {
                msg_send![&*center, addObserver: &*observer, selector: sel!(windowChanged:), name: &*name, object: any]
            };
        }
        let _ = cell.set(observer);
    });
}

/// The window over its whole screen, menu bar included.
fn fill_screen(w: &NSWindow) {
    let screen: Option<Retained<AnyObject>> = unsafe { msg_send![w, screen] };
    let Some(screen) = screen else { return };
    let full: NSRect = unsafe { msg_send![&*screen, frame] };
    if w.frame() != full {
        w.setFrame_display(full, true);
    }
}

pub(super) fn windows() -> Option<Retained<NSArray<NSWindow>>> {
    let mtm = MainThreadMarker::new()?;
    Some(NSApplication::sharedApplication(mtm).windows())
}

pub(super) fn find(all: &NSArray<NSWindow>, handle: isize) -> Option<Retained<NSWindow>> {
    all.iter().find(|w| Retained::as_ptr(w) as isize == handle)
}

fn configure(w: &NSWindow, e: &Entry) {
    let level = match e.kind {
        Kind::Desktop if EDITING.load(Ordering::Relaxed) => NSFloatingWindowLevel,
        Kind::Desktop => NSNormalWindowLevel - 1,
        // Among the apps' own windows: one the person brings over its app
        // covers the widget too.
        Kind::Anchor => NSNormalWindowLevel,
        Kind::Wallpaper => (unsafe { CGWindowLevelForKey(DESKTOP_LEVEL_KEY) }) as isize + 1,
        Kind::Saver | Kind::Draw | Kind::Menu => NSScreenSaverWindowLevel,
        _ => NSStatusWindowLevel,
    };
    w.setLevel(level);
    let mut behaviour = NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle;
    if matches!(e.kind, Kind::Overlay | Kind::Anchor | Kind::Saver | Kind::Draw | Kind::Menu) {
        behaviour |= NSWindowCollectionBehavior::FullScreenAuxiliary;
    }
    w.setCollectionBehavior(behaviour);
    // "Hide Xenon" (Cmd+H) hides the dashboard, not the widgets on the screen.
    w.setCanHide(false);
    match e.kind {
        Kind::Wallpaper => w.setIgnoresMouseEvents(true),
        // Any input ends a screensaver, so it takes it all; the drawing
        // sheet draws with it.
        Kind::Saver | Kind::Draw | Kind::Menu | Kind::Anchor => w.setIgnoresMouseEvents(false),
        _ => w.setIgnoresMouseEvents(!e.takes_mouse),
    }
    if e.scene() {
        w.setHasShadow(false);
        fill_screen(w);
    }
    if e.kind == Kind::Wallpaper && e.paused {
        w.orderOut(None);
    }
}

/// The front app when it is not Xenon, by message: NSWorkspace may be used
/// off the main thread.
fn front_app() -> Option<(Retained<AnyObject>, i32)> {
    let workspace: Retained<AnyObject> =
        unsafe { msg_send![AnyClass::get(c"NSWorkspace")?, sharedWorkspace] };
    let app: Option<Retained<AnyObject>> = unsafe { msg_send![&*workspace, frontmostApplication] };
    let app = app?;
    let pid: i32 = unsafe { msg_send![&*app, processIdentifier] };
    (pid != std::process::id() as i32).then_some((app, pid))
}

/// A screensaver takes the keyboard; the app it took it from gets it back
/// once the last screensaver is gone.
fn saver_focus(st: &mut State, all: &NSArray<NSWindow>, mtm: MainThreadMarker) {
    let saver = st.entries.iter().find(|e| matches!(e.kind, Kind::Saver | Kind::Draw | Kind::Menu)).map(|e| e.handle);
    match saver.and_then(|h| find(all, h)) {
        Some(w) if !w.isKeyWindow() => {
            if st.before_saver.is_none() {
                st.before_saver = front_app().map(|(app, _)| app);
            }
            // Deprecated in macOS 14, and the call that works on every version.
            #[allow(deprecated)]
            NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
            w.makeKeyAndOrderFront(None);
        }
        Some(_) => {}
        None => {
            if let Some(app) = st.before_saver.take() {
                let _: bool = unsafe { msg_send![&*app, activateWithOptions: 0usize] };
            }
        }
    }
}

/// Apply a sync: forget windows that are gone, set up new ones, re-place all.
pub fn apply(plans: Vec<Plan>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else {
            return;
        };
        let Some(all) = windows() else { return };
        let mut old = std::mem::take(&mut st.entries);
        let mut anchored = Vec::new();
        for p in plans {
            let mut e = match old.iter().position(|e| e.handle == p.handle) {
                Some(i) => old.swap_remove(i),
                None => {
                    let i = st.pending.iter().position(|(h, _)| *h == p.handle);
                    let rects = i.map(|i| st.pending.swap_remove(i).1).unwrap_or_default();
                    // Nothing takes the mouse until the cursor is on a tile: a
                    // screen-sized window that swallowed clicks would break the desktop.
                    Entry {
                        handle: p.handle,
                        kind: p.kind,
                        rects,
                        takes_mouse: false,
                        paused: false,
                    }
                }
            };
            e.kind = p.kind;
            let Some(w) = find(&all, e.handle) else {
                continue;
            };
            configure(&w, &e);
            if let (Kind::Anchor, Some(anchor)) = (e.kind, p.anchor) {
                anchored.push(anchor_macos::Job { handle: e.handle, number: w.windowNumber() as u64, anchor });
            }
            st.entries.push(e);
        }
        anchor_macos::set(anchored);
        st.pending.retain(|(h, _)| find(&all, *h).is_some());
        hit_test(&mut st, &all);
        if let Some(mtm) = MainThreadMarker::new() {
            if st.entries.iter().any(Entry::scene) {
                observe(mtm);
            }
            saver_focus(&mut st, &all, mtm);
        }
    });
    watch();
}

/// The page's tile rectangles, and whether the widgets are being edited
/// (`None` from the alerts window, which has no say in it). Main thread: the
/// navigation hooks run there.
pub fn set_region(handle: isize, rects: Vec<[i32; 4]>, editing: Option<bool>) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else {
            return;
        };
        let Some(all) = windows() else { return };
        match st.entries.iter_mut().find(|e| e.handle == handle) {
            Some(e) => e.rects = rects,
            None => {
                st.pending.retain(|(h, _)| *h != handle);
                st.pending.push((handle, rects));
            }
        }
        if let Some(editing) = editing {
            if EDITING.swap(editing, Ordering::Relaxed) != editing {
                for e in st.entries.iter().filter(|e| e.kind == Kind::Desktop) {
                    if let Some(w) = find(&all, e.handle) {
                        configure(&w, e);
                    }
                }
            }
        }
        hit_test(&mut st, &all);
    });
    watch();
}

/// Each window takes the mouse only while the cursor is on one of its tiles.
/// Windows that are gone leave the state here.
fn hit_test(st: &mut State, all: &NSArray<NSWindow>) {
    st.entries.retain(|e| find(all, e.handle).is_some());
    // A drag that leaves the tile (a slider, a scrollbar) keeps its window
    // until the button is up.
    let held = NSEvent::pressedMouseButtons() != 0;
    for e in st.entries.iter_mut().filter(|e| !e.scene() && e.kind != Kind::Anchor) {
        let Some(w) = find(all, e.handle) else {
            continue;
        };
        let on = cursor_on(&w, &e.rects);
        if on != e.takes_mouse && !(held && e.takes_mouse) {
            e.takes_mouse = on;
            w.setIgnoresMouseEvents(!on);
        }
    }
    WANTED.store(
        st.entries.iter().any(|e| !e.rects.is_empty() && e.kind != Kind::Anchor),
        Ordering::Relaxed,
    );
}

/// The cursor in the window's own device pixels, top-left origin like the
/// page's rectangles (AppKit counts points from the bottom-left).
fn cursor_on(w: &NSWindow, rects: &[[i32; 4]]) -> bool {
    if rects.is_empty() {
        return false;
    }
    let Some(view) = w.contentView() else {
        return false;
    };
    let p = w.mouseLocationOutsideOfEventStream();
    let height = view.frame().size.height;
    let scale = w.backingScaleFactor();
    spec::hit(rects, p.x * scale, (height - p.y) * scale)
}

fn tick() {
    QUEUED.store(false, Ordering::Relaxed);
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else {
            return;
        };
        let Some(all) = windows() else { return };
        hit_test(&mut st, &all);
    });
}

/// Start the watcher if some window has tiles and none is running. It stops on
/// its own when no window has any, re-checking once so a tile reported while
/// it was stopping is never left without one.
fn watch() {
    if !WANTED.load(Ordering::Relaxed) || WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(app) = super::APP.get().cloned() else {
        WATCHING.store(false, Ordering::SeqCst);
        return;
    };
    std::thread::spawn(move || run_watcher(&app));
}

fn run_watcher(app: &AppHandle) {
    let mut last: Option<(f64, f64)> = None;
    loop {
        std::thread::sleep(WATCH_EVERY);
        if !WANTED.load(Ordering::Relaxed) {
            WATCHING.store(false, Ordering::SeqCst);
            if !WANTED.load(Ordering::Relaxed) || WATCHING.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        let p = NSEvent::mouseLocation();
        let now = Some((p.x, p.y));
        if now == last {
            continue;
        }
        last = now;
        if !QUEUED.swap(true, Ordering::Relaxed) && app.run_on_main_thread(tick).is_err() {
            WATCHING.store(false, Ordering::SeqCst);
            return;
        }
    }
}

/// Whether a screensaver must wait: an app keeps the display awake (a video,
/// a presentation) or the app in front has a window over a whole screen.
/// Called on a plain thread: only IOKit, CoreGraphics and NSWorkspace, which
/// allow it.
pub fn saver_held() -> bool {
    autoreleasepool(|_| display_kept_on() || front_fullscreen())
}

/// Some app holds a display-sleep assertion (what `pmset -g assertions` lists).
fn display_kept_on() -> bool {
    let mut status: *mut AnyObject = std::ptr::null_mut();
    if unsafe { IOPMCopyAssertionsStatus(&mut status) } != 0 || status.is_null() {
        return false;
    }
    // A CFDictionary is an NSDictionary: read by message, then released.
    let dict = unsafe { &*status };
    let held = [c"PreventUserIdleDisplaySleep", c"NoDisplaySleepAssertion"]
        .into_iter()
        .filter_map(ns_string)
        .any(|key| number(dict, &key).is_some_and(|n| n > 0.0));
    unsafe { CFRelease(status) };
    held
}

/// A number in a dictionary, by message.
fn number(dict: &AnyObject, key: &AnyObject) -> Option<f64> {
    let v: Option<Retained<AnyObject>> = unsafe { msg_send![dict, objectForKey: key] };
    Some(unsafe { msg_send![&*v?, doubleValue] })
}

pub(super) fn number_at(dict: &AnyObject, key: &CStr) -> Option<f64> {
    number(dict, &*ns_string(key)?)
}

/// The sizes of the active displays, in points.
fn display_sizes() -> Vec<(f64, f64)> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } != 0 {
        return Vec::new();
    }
    ids[..(count as usize).min(ids.len())]
        .iter()
        .map(|&d| {
            let b = unsafe { CGDisplayBounds(d) };
            (b.size.width, b.size.height)
        })
        .collect()
}

/// The front app has a normal window exactly the size of a display. Owners,
/// layers and bounds need no Screen Recording grant; no window name is read.
fn front_fullscreen() -> bool {
    let Some((_, pid)) = front_app() else { return false };
    let screens = display_sizes();
    let list = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_WINDOWS, 0) };
    if list.is_null() {
        return false;
    }
    let windows = unsafe { &*list };
    let n: usize = unsafe { msg_send![windows, count] };
    let full = (0..n).any(|i| {
        let d: Retained<AnyObject> = unsafe { msg_send![windows, objectAtIndex: i] };
        if number_at(&d, c"kCGWindowOwnerPID") != Some(pid as f64)
            || number_at(&d, c"kCGWindowLayer") != Some(0.0)
        {
            return false;
        }
        let Some(key) = ns_string(c"kCGWindowBounds") else { return false };
        let bounds: Option<Retained<AnyObject>> = unsafe { msg_send![&*d, objectForKey: &*key] };
        let Some(bounds) = bounds else { return false };
        let size = (number_at(&bounds, c"Width"), number_at(&bounds, c"Height"));
        screens.iter().any(|&(w, h)| size == (Some(w), Some(h)))
    });
    unsafe { CFRelease(list) };
    full
}

/// `xenon-app:scene-pause` from a wallpaper page: on battery it is hidden
/// until the charger is back.
pub fn set_paused(handle: isize, paused: bool) {
    STATE.with(|cell| {
        let Ok(mut st) = cell.try_borrow_mut() else { return };
        let wallpaper = st.entries.iter_mut().find(|e| e.handle == handle && e.kind == Kind::Wallpaper);
        let Some(e) = wallpaper else { return };
        e.paused = paused;
        let Some(w) = windows().and_then(|all| find(&all, handle)) else { return };
        if paused {
            w.orderOut(None);
        } else {
            w.orderFrontRegardless();
        }
    });
}

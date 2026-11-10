//! Anchored widgets on macOS (Beta: built here, not yet run on a real Mac).
//!
//! The window server lists every on-screen window front to back with its
//! owner app, number and bounds, and asks no grant for that: no Accessibility,
//! no Screen Recording (no window name is read). While some widget is anchored
//! a follower thread reads the list every 100 ms and asks the main thread to
//! move a widget only when its place changed: next to the front window of its
//! app (anchor.rs `spot`), ordered right above it, so a window the person
//! brings over the app covers the widget too. No window of the app on the
//! screen (closed, minimized, hidden, on another Space) = the widget is
//! ordered out. Polled because macOS tells only Accessibility clients when
//! another app's window moves, and that grant is not worth asking for this.
#![cfg(target_os = "macos")]

use std::ffi::CStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::msg_send;
use objc2_app_kit::NSWindowOrderingMode;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::AppHandle;

use super::anchor::{self, Seen, Spot};
use super::macos::{find, ns_string, number_at, windows};
use super::spec::Anchor;

/// How often the list is read while some widget is anchored.
const EVERY: Duration = Duration::from_millis(100);
/// Smaller windows are an app's helpers (a tooltip, a drag image), not the
/// window a widget follows; the widget itself is never smaller.
const MIN_SIDE: f64 = 40.0;
/// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
const ON_SCREEN_WINDOWS: u32 = 1 | 16;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut AnyObject;
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> NSRect;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: *mut AnyObject);
}

/// One anchored widget: its NSWindow (`handle`), its window-server number and
/// the app it follows.
#[derive(Clone)]
pub struct Job {
    pub handle: isize,
    pub number: u64,
    pub anchor: Anchor,
}

static JOBS: Mutex<Vec<Job>> = Mutex::new(Vec::new());
static RUNNING: AtomicBool = AtomicBool::new(false);

/// The anchored widgets after a sync (main thread). The follower starts with
/// the first one and stops on its own after the last.
pub fn set(jobs: Vec<Job>) {
    let any = !jobs.is_empty();
    if let Ok(mut held) = JOBS.lock() {
        *held = jobs;
    }
    if !any || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(app) = super::APP.get().cloned() else {
        RUNNING.store(false, Ordering::SeqCst);
        return;
    };
    std::thread::spawn(move || follow(&app));
}

fn jobs() -> Vec<Job> {
    JOBS.lock().map(|j| j.clone()).unwrap_or_default()
}

fn follow(app: &AppHandle) {
    let mut last: Vec<(isize, Option<Spot>)> = Vec::new();
    loop {
        std::thread::sleep(EVERY);
        let mut jobs = jobs();
        if jobs.is_empty() {
            // Stop, then look once more: a widget anchored while stopping
            // must not be left without a follower.
            RUNNING.store(false, Ordering::SeqCst);
            jobs = self::jobs();
            if jobs.is_empty() || RUNNING.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        let list = autoreleasepool(|_| on_screen());
        let now: Vec<(isize, Option<Spot>)> =
            jobs.iter().map(|j| (j.handle, anchor::spot(&list, &j.anchor, j.number, 1.0))).collect();
        let moves: Vec<(isize, Option<Spot>)> = now.iter().filter(|n| !last.contains(n)).cloned().collect();
        last = now;
        if !moves.is_empty() && app.run_on_main_thread(move || apply(moves)).is_err() {
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
    }
}

/// The normal windows on the screen, front to back, in global points with a
/// top-left origin (the window server's own space).
fn on_screen() -> Vec<Seen> {
    let list = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_WINDOWS, 0) };
    if list.is_null() {
        return Vec::new();
    }
    let windows = unsafe { &*list };
    let n: usize = unsafe { msg_send![windows, count] };
    let seen = (0..n)
        .filter_map(|i| {
            let d: Retained<AnyObject> = unsafe { msg_send![windows, objectAtIndex: i] };
            seen_of(&d)
        })
        .collect();
    unsafe { CFRelease(list) };
    seen
}

fn seen_of(d: &AnyObject) -> Option<Seen> {
    if number_at(d, c"kCGWindowLayer") != Some(0.0) || number_at(d, c"kCGWindowAlpha").is_some_and(|a| a <= 0.0) {
        return None;
    }
    let id = number_at(d, c"kCGWindowNumber")? as u64;
    let key = ns_string(c"kCGWindowBounds")?;
    let bounds: Option<Retained<AnyObject>> = unsafe { msg_send![d, objectForKey: &*key] };
    let bounds = bounds?;
    let (x, y) = (number_at(&bounds, c"X")?, number_at(&bounds, c"Y")?);
    let (w, h) = (number_at(&bounds, c"Width")?, number_at(&bounds, c"Height")?);
    if w < MIN_SIDE || h < MIN_SIDE {
        return None;
    }
    Some(Seen { id, app: text_at(d, c"kCGWindowOwnerName").unwrap_or_default(), frame: [x, y, x + w, y + h] })
}

/// A string in a dictionary, by message.
fn text_at(dict: &AnyObject, key: &CStr) -> Option<String> {
    let key = ns_string(key)?;
    let v: Option<Retained<AnyObject>> = unsafe { msg_send![dict, objectForKey: &*key] };
    let utf8: *const std::ffi::c_char = unsafe { msg_send![&*v?, UTF8String] };
    if utf8.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(utf8) }.to_string_lossy().into_owned())
}

/// Move, order or hide the widgets whose place changed. Main thread; a widget
/// whose window is gone is skipped.
fn apply(moves: Vec<(isize, Option<Spot>)>) {
    let Some(all) = windows() else { return };
    // AppKit counts from the bottom-left of the main display, the window
    // server from its top-left.
    let main_height = unsafe { CGDisplayBounds(CGMainDisplayID()) }.size.height;
    for (handle, spot) in moves {
        let Some(w) = find(&all, handle) else { continue };
        let Some(s) = spot else {
            w.orderOut(None);
            continue;
        };
        let [x, top, width, height] = s.rect;
        let frame = NSRect::new(NSPoint::new(x, main_height - top - height), NSSize::new(width, height));
        if w.frame() != frame {
            w.setFrame_display(frame, true);
        }
        if !s.above {
            w.orderWindow_relativeTo(NSWindowOrderingMode::Above, s.target as isize);
        }
    }
}

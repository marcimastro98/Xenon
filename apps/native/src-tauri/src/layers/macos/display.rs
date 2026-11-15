// macOS: what the displays say: kept on by the screensaver, their sizes, an app in full screen, the layers paused.

use std::ffi::CStr;
use objc2::msg_send;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use super::{CFRelease, CGDisplayBounds, CGGetActiveDisplayList, CGWindowListCopyWindowInfo, find, IOPMCopyAssertionsStatus, ns_string, ON_SCREEN_WINDOWS, STATE, windows};
use super::focus::front_app;
use super::super::spec::Kind;

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

pub(in super::super) fn number_at(dict: &AnyObject, key: &CStr) -> Option<f64> {
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

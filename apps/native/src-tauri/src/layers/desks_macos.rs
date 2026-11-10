//! The Space shown on macOS (Beta: built here, not yet run on a real Mac).
//!
//! AppKit says when the active Space changes but not which one it is, so the
//! window server is asked: its connection's active Space and every display's
//! Spaces in Mission Control order. These calls are not in Apple's public
//! headers; they are looked up at runtime, and a macOS without them is simply
//! not offered the option (`supported`). No grant is needed. Read every 500 ms
//! on a thread, only while some page is tied to a desktop (desks.rs).
#![cfg(target_os = "macos")]

use std::ffi::{c_int, c_void, CStr};
use std::sync::OnceLock;
use std::time::Duration;

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::msg_send;
use tauri::AppHandle;

use super::desks::{self, Desk, Spaces};
use super::macos::{ns_string, number_at};

const EVERY: Duration = Duration::from_millis(500);
/// dlfcn.h RTLD_DEFAULT on macOS: every image already loaded.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const std::ffi::c_char) -> *mut c_void;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: *mut AnyObject);
}

struct Cgs {
    connection: unsafe extern "C" fn() -> c_int,
    active: unsafe extern "C" fn(c_int) -> u64,
    spaces: unsafe extern "C" fn(c_int) -> *mut AnyObject,
}

static CGS: OnceLock<Option<Cgs>> = OnceLock::new();

fn cgs() -> Option<&'static Cgs> {
    CGS.get_or_init(|| {
        let find = |name: &CStr| {
            // SAFETY: a NUL-terminated name; a null answer is handled.
            let p = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) };
            (!p.is_null()).then_some(p)
        };
        let (c, a, s) = (find(c"CGSMainConnectionID")?, find(c"CGSGetActiveSpace")?, find(c"CGSCopyManagedDisplaySpaces")?);
        // SAFETY: the window server's own entry points with these signatures
        // since macOS 10.7 (used the same way by every Spaces utility).
        Some(unsafe {
            Cgs {
                connection: std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> c_int>(c),
                active: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(c_int) -> u64>(a),
                spaces: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(c_int) -> *mut AnyObject>(s),
            }
        })
    })
    .as_ref()
}

pub fn supported() -> bool {
    cgs().is_some()
}

pub fn start(app: AppHandle, gen: u32) {
    std::thread::spawn(move || {
        while desks::live(gen) {
            if let Some(d) = autoreleasepool(|_| read()) {
                desks::seen(&app, gen, d);
            }
            std::thread::sleep(EVERY);
        }
    });
}

fn read() -> Option<Desk> {
    let cgs = cgs()?;
    // SAFETY: plain window-server queries; the copied list is released below.
    let (active, list) = unsafe {
        let cid = (cgs.connection)();
        ((cgs.active)(cid), (cgs.spaces)(cid))
    };
    if list.is_null() {
        return None;
    }
    // SAFETY: a CFArray of CFDictionary, toll-free bridged to NSArray.
    let displays: Vec<Spaces> = items(unsafe { &*list }).iter().map(|d| spaces_of(d)).collect();
    unsafe { CFRelease(list) };
    desks::from_spaces(active, &displays)
}

fn items(array: &AnyObject) -> Vec<Retained<AnyObject>> {
    let n: usize = unsafe { msg_send![array, count] };
    (0..n).map(|i| unsafe { msg_send![array, objectAtIndex: i] }).collect()
}

/// One display's Spaces: (ManagedSpaceID, type).
fn spaces_of(display: &AnyObject) -> Spaces {
    let Some(key) = ns_string(c"Spaces") else { return Vec::new() };
    let list: Option<Retained<AnyObject>> = unsafe { msg_send![display, objectForKey: &*key] };
    let Some(list) = list else { return Vec::new() };
    items(&list)
        .iter()
        .filter_map(|s| Some((id_at(s, c"ManagedSpaceID")?, number_at(s, c"type").unwrap_or(0.0) as i64)))
        .collect()
}

fn id_at(dict: &AnyObject, key: &CStr) -> Option<u64> {
    let key = ns_string(key)?;
    let v: Option<Retained<AnyObject>> = unsafe { msg_send![dict, objectForKey: &*key] };
    Some(unsafe { msg_send![&*v?, unsignedLongLongValue] })
}

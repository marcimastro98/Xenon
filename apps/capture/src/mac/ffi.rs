//! The small glue the ScreenCaptureKit path needs around objc2: opening a
//! framework at run time, the OS version, waiting on a completion handler and
//! handing Apple objects between threads.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_core_media::CMTime;
use objc2_foundation::{NSError, NSProcessInfo};

use crate::video::TICKS_PER_SECOND;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
const RTLD_NOW: c_int = 2;

/// A framework opened once, by path; None when this macOS has none (or it
/// would not load). Loaded at run time so the engine starts on a macOS too
/// old to have it.
pub fn framework(path: &'static CStr, slot: &'static OnceLock<usize>) -> Option<*mut c_void> {
    let handle = *slot.get_or_init(|| unsafe { dlopen(path.as_ptr(), RTLD_NOW) } as usize);
    (handle != 0).then_some(handle as *mut c_void)
}

/// An Objective-C constant (`NSString *const`) exported by an opened framework.
pub fn constant(handle: *mut c_void, name: &CStr) -> Option<&'static AnyObject> {
    let at = unsafe { dlsym(handle, name.as_ptr()) } as *const *const AnyObject;
    if at.is_null() {
        return None;
    }
    unsafe { (*at).as_ref() }
}

/// This Mac's macOS is at least `major.minor`.
pub fn os_at_least(major: isize, minor: isize) -> bool {
    let v = NSProcessInfo::processInfo().operatingSystemVersion();
    (v.majorVersion, v.minorVersion) >= (major, minor)
}

/// An Apple object moved to another thread. Only for objects Apple documents
/// as safe to use from any thread, or that one thread at a time owns.
pub struct Sent<T>(pub T);
unsafe impl<T> Send for Sent<T> {}

/// What a completion handler hands back: an object, or the error.
pub type Answer = Result<Option<Retained<AnyObject>>, Retained<NSError>>;

/// Waits for a completion handler that `call` starts with a sender; None when
/// it never came back in time.
pub fn wait_for(
    deadline: Duration,
    call: impl FnOnce(mpsc::Sender<Sent<Answer>>),
) -> Option<Answer> {
    let (tx, rx) = mpsc::channel();
    call(tx);
    rx.recv_timeout(deadline).ok().map(|s| s.0)
}

/// A retained answer from the raw pointers a completion handler gets.
///
/// # Safety
/// Both pointers must be null or valid objects for the duration of the call.
pub unsafe fn answer(object: *mut AnyObject, error: *mut NSError) -> Answer {
    match unsafe { Retained::retain(error) } {
        Some(e) => Err(e),
        None => Ok(unsafe { Retained::retain(object) }),
    }
}

/// A CMTime in 100-ns units (what the frame clock counts in).
pub fn time_of_ticks(ticks: i64) -> CMTime {
    unsafe { CMTime::new(ticks, TICKS_PER_SECOND as i32) }
}

/// A CMTime as 100-ns units; None when it is not a number (invalid, infinite).
pub fn ticks_of_time(t: CMTime) -> Option<i64> {
    const VALID: u32 = 1;
    const NOT_NUMERIC: u32 = 0b11100; // positive/negative infinity, indefinite
    if t.flags.0 & VALID == 0 || t.flags.0 & NOT_NUMERIC != 0 || t.timescale <= 0 {
        return None;
    }
    Some((t.value as i128 * TICKS_PER_SECOND as i128 / t.timescale as i128) as i64)
}

/// The error code of an NSError, and its domain and description for the
/// `detail` field (never a path or a window's name: Apple's text only).
pub fn error_detail(e: &NSError) -> (isize, String) {
    let detail = format!("{} {}", e.domain(), e.code());
    (e.code(), detail)
}

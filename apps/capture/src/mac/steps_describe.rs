//! What a step says about a click on macOS: the app it went to, from the
//! window under it (the owner's name, never a window title), and, only when
//! Accessibility is allowed for Xenon, the name and role of the control
//! (AXTitle or AXDescription, AXRole). Without that grant both are "".

use std::ffi::{c_int, c_void, CStr};
use std::ptr::{null_mut, NonNull};
use std::sync::OnceLock;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_core_foundation::{CFRetained, CFString, CFType};
use objc2_core_graphics::{kCGWindowOwnerPID, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_foundation::{NSArray, NSString};

use super::ffi;
use super::frame::ns;
use super::steps_plan;

const APPKIT: &CStr = c"/System/Library/Frameworks/AppKit.framework/AppKit";
static APPKIT_HANDLE: OnceLock<usize> = OnceLock::new();
/// The longest app name kept.
const APP_MAX: usize = 64;
/// How long one Accessibility question may take: a frozen app must not hold
/// the next step up.
const AX_TIMEOUT: f32 = 0.5;
/// kAXErrorSuccess
const AX_OK: i32 = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateSystemWide() -> *mut c_void;
    fn AXUIElementSetMessagingTimeout(element: *mut c_void, seconds: f32) -> i32;
    fn AXUIElementCopyElementAtPosition(app: *mut c_void, x: f32, y: f32, out: *mut *mut c_void) -> i32;
    fn AXUIElementCopyAttributeValue(element: *mut c_void, attribute: &CFString, out: *mut *mut c_void) -> i32;
}

extern "C" {
    /// libproc (in libSystem): a process's executable name.
    fn proc_name(pid: c_int, buffer: *mut c_void, size: u32) -> c_int;
}

/// The app a click went to.
#[derive(Default)]
pub struct App {
    pub pid: i32,
    /// The executable's name (`xenon-native` for Xenon itself).
    pub exe: String,
    /// What the step shows: the app's own name, else its executable's.
    pub name: String,
}

#[derive(Default)]
pub struct Described {
    pub name: String,
    pub role: &'static str,
}

/// A CoreFoundation object handed over with its reference (a Copy/Create call).
fn owned(p: *mut c_void) -> Option<CFRetained<CFType>> {
    NonNull::new(p.cast::<CFType>()).map(|p| unsafe { CFRetained::from_raw(p) })
}

fn raw(object: &CFRetained<CFType>) -> *mut c_void {
    CFRetained::as_ptr(object).as_ptr().cast()
}

/// The process that owns CoreGraphics window `window`; 0 when unknown. Only
/// the owner's id is read from the window list.
fn owner(window: u32) -> i32 {
    if window == 0 {
        return 0;
    }
    let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionIncludingWindow, window) else {
        return 0;
    };
    // CFArray and NSArray are the same object (toll-free bridged).
    let list: &NSArray<AnyObject> = unsafe { &*CFRetained::as_ptr(&list).as_ptr().cast() };
    let Some(info) = list.firstObject() else {
        return 0;
    };
    let pid: Option<Retained<AnyObject>> =
        unsafe { msg_send![&*info, objectForKey: ns(kCGWindowOwnerPID)] };
    pid.map_or(0, |n| unsafe { msg_send![&*n, intValue] })
}

fn exe_name(pid: i32) -> String {
    let mut buffer = [0u8; 256];
    let n = unsafe { proc_name(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if n <= 0 {
        return String::new();
    }
    CStr::from_bytes_until_nul(&buffer)
        .map(|s| s.to_string_lossy().chars().take(APP_MAX).collect())
        .unwrap_or_default()
}

/// The app's name as the Dock shows it (NSRunningApplication, AppKit opened
/// at run time: the engine has no window of its own).
fn display_name(pid: i32) -> Option<String> {
    ffi::framework(APPKIT, &APPKIT_HANDLE)?;
    let class = AnyClass::get(c"NSRunningApplication")?;
    let app: Option<Retained<AnyObject>> =
        unsafe { msg_send![class, runningApplicationWithProcessIdentifier: pid] };
    let name: Option<Retained<NSString>> = unsafe { msg_send![&*app?, localizedName] };
    let name: String = crate::steps::clean_name(&name?.to_string()).chars().take(APP_MAX).collect();
    (!name.is_empty()).then_some(name)
}

/// The app that owns `window`.
pub fn app(window: u32) -> App {
    let pid = owner(window);
    if pid <= 0 {
        return App::default();
    }
    let exe = exe_name(pid);
    let name = display_name(pid).unwrap_or_else(|| exe.clone());
    App { pid, exe, name }
}

/// The control at (`x`, `y`) points, when Accessibility is allowed.
pub fn control(x: f64, y: f64) -> Described {
    if unsafe { AXIsProcessTrusted() } == 0 {
        return Described::default();
    }
    let Some(system) = owned(unsafe { AXUIElementCreateSystemWide() }) else {
        return Described::default();
    };
    unsafe { AXUIElementSetMessagingTimeout(raw(&system), AX_TIMEOUT) };
    let mut found = null_mut();
    let asked = unsafe { AXUIElementCopyElementAtPosition(raw(&system), x as f32, y as f32, &mut found) };
    let Some(element) = owned(found).filter(|_| asked == AX_OK) else {
        return Described::default();
    };
    let text = |attribute: &'static str| -> Option<String> {
        let key = CFString::from_static_str(attribute);
        let mut value = null_mut();
        let read = unsafe { AXUIElementCopyAttributeValue(raw(&element), &key, &mut value) };
        let value = owned(value)?;
        (read == AX_OK).then(|| value.downcast_ref::<CFString>().map(|s| s.to_string()))?
    };
    let role = text("AXRole").unwrap_or_default();
    Described {
        name: steps_plan::name(&role, text("AXTitle").as_deref(), text("AXDescription").as_deref()),
        role: steps_plan::role(&role),
    }
}

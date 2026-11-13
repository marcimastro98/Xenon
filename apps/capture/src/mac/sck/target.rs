// macOS screen capture: finding the screen or window to capture, and the settings of its stream.

use block2::RcBlock;
use objc2::{msg_send, sel};
use objc2_core_foundation::CGRect;
use objc2_core_media::CMTime;
use objc2_foundation::{NSArray, NSError};
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use crate::proto::Fail;
use super::{CONTENT_WAIT, ERROR_USER_DECLINED, PIXEL_420V, QUEUE_DEPTH};
use super::super::ffi::{self, Sent};

/// What to record.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Target {
    /// A CoreGraphics display id.
    Display(u32),
    /// A CoreGraphics window number.
    Window(u32),
}

pub struct Spec {
    pub target: Target,
    pub width: u32,
    pub height: u32,
    /// The shortest time between two pictures.
    pub interval: CMTime,
    pub cursor: bool,
    pub sound: bool,
}

/// The system's list of displays and windows, asked fresh each time.
pub(in super::super) fn content() -> Result<Retained<AnyObject>, Fail> {
    let class = AnyClass::get(c"SCShareableContent").ok_or(Fail::code("unsupported"))?;
    let answer = ffi::wait_for(CONTENT_WAIT, |tx| {
        let done = RcBlock::new(move |content: *mut AnyObject, error: *mut NSError| {
            let _ = tx.send(Sent(unsafe { ffi::answer(content, error) }));
        });
        let _: () = unsafe { msg_send![class, getShareableContentWithCompletionHandler: &*done] };
    });
    match answer {
        Some(Ok(Some(content))) => Ok(content),
        Some(Err(e)) => Err(start_failure(&e)),
        _ => Err(Fail::new("capture_failed", "no shareable content")),
    }
}

/// Why a stream did not start: a refused permission says so.
pub(super) fn start_failure(e: &NSError) -> Fail {
    let (code, detail) = ffi::error_detail(e);
    if code == ERROR_USER_DECLINED {
        return Fail::new("no_permission", detail);
    }
    Fail::new("capture_failed", detail)
}

/// A display (by display id) or a window (by window number) in the content.
fn find(content: &AnyObject, window: bool, id: u32) -> Option<Retained<AnyObject>> {
    let all: Retained<NSArray<AnyObject>> = if window {
        unsafe { msg_send![content, windows] }
    } else {
        unsafe { msg_send![content, displays] }
    };
    all.iter().find(|item| {
        let found: u32 = if window {
            unsafe { msg_send![&**item, windowID] }
        } else {
            unsafe { msg_send![&**item, displayID] }
        };
        found == id
    })
}

/// The content's windows whose numbers are in `ids` (sorted).
fn windows_named(content: &AnyObject, ids: &[u32]) -> Retained<NSArray<AnyObject>> {
    if ids.is_empty() {
        return NSArray::new();
    }
    let all: Retained<NSArray<AnyObject>> = unsafe { msg_send![content, windows] };
    let named: Vec<Retained<AnyObject>> = all
        .iter()
        .filter(|w| {
            let id: u32 = unsafe { msg_send![&**w, windowID] };
            ids.binary_search(&id).is_ok()
        })
        .collect();
    NSArray::from_retained_slice(&named)
}

/// A window's frame in points, top-left origin (CoreGraphics), when it is on screen.
pub fn window_frame(window: u32) -> Option<CGRect> {
    let content = content().ok()?;
    let w = find(&content, true, window)?;
    Some(unsafe { msg_send![&*w, frame] })
}

/// What a stream or a picture takes. A whole display leaves out the windows
/// `hide` names (no_share.rs) that the content lists.
pub(in super::super) fn filter(content: &AnyObject, target: Target, hide: &[u32]) -> Result<Retained<AnyObject>, Fail> {
    let class = AnyClass::get(c"SCContentFilter").ok_or(Fail::code("unsupported"))?;
    let new: Allocated<AnyObject> = unsafe { msg_send![class, alloc] };
    match target {
        Target::Display(id) => {
            let display = find(content, false, id)
                .ok_or(Fail::code("no_monitor"))?;
            let left_out = windows_named(content, hide);
            Ok(unsafe { msg_send![new, initWithDisplay: &*display, excludingWindows: &*left_out] })
        }
        Target::Window(id) => {
            let window = find(content, true, id)
                .ok_or(Fail::code("no_window"))?;
            Ok(unsafe { msg_send![new, initWithDesktopIndependentWindow: &*window] })
        }
    }
}

pub(super) fn configuration(spec: &Spec) -> Result<Retained<AnyObject>, Fail> {
    let class = AnyClass::get(c"SCStreamConfiguration").ok_or(Fail::code("unsupported"))?;
    let c: Retained<AnyObject> = unsafe { msg_send![class, new] };
    let has = |s: objc2::runtime::Sel| -> bool { unsafe { msg_send![&*c, respondsToSelector: s] } };
    unsafe {
        let _: () = msg_send![&*c, setWidth: spec.width as usize];
        let _: () = msg_send![&*c, setHeight: spec.height as usize];
        let _: () = msg_send![&*c, setMinimumFrameInterval: spec.interval];
        let _: () = msg_send![&*c, setPixelFormat: PIXEL_420V];
        let _: () = msg_send![&*c, setShowsCursor: spec.cursor];
        let _: () = msg_send![&*c, setQueueDepth: QUEUE_DEPTH];
        if has(sel!(setScalesToFit:)) {
            // A window that changes size stays whole in the frame.
            let _: () = msg_send![&*c, setScalesToFit: true];
        }
        if spec.sound {
            let _: () = msg_send![&*c, setCapturesAudio: true];
            let _: () = msg_send![&*c, setSampleRate: crate::audio::RATE as isize];
            let _: () = msg_send![&*c, setChannelCount: crate::audio::CHANNELS as isize];
            // Xenon's own sounds (a notification chime) stay out of the clip.
            let _: () = msg_send![&*c, setExcludesCurrentProcessAudio: true];
        }
    }
    Ok(c)
}

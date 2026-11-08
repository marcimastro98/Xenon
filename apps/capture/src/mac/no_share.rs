//! The windows on any screen whose owner asked not to be captured, read from
//! the system's window list, which still tells each window's sharing state
//! (no_share_plan.rs says why the engine needs them), and a running capture
//! of a display kept leaving out the current ones.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, sel};
use objc2_core_foundation::{CFRetained, CFString};
use objc2_core_graphics::{kCGWindowNumber, kCGWindowSharingState, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_foundation::{NSArray, NSError};

use super::ffi::{self, Sent};
use super::frame::ns;
use super::no_share_plan;
use super::sck::{self, Target};

/// Their window numbers, sorted. Windows off screen too: a widget that shows a
/// moment later is already named.
pub fn windows() -> Vec<u32> {
    let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionAll, 0) else {
        return Vec::new();
    };
    // CFArray and NSArray are the same object (toll-free bridged).
    let list: &NSArray<AnyObject> = unsafe { &*CFRetained::as_ptr(&list).as_ptr().cast() };
    no_share_plan::pick(
        list.iter()
            .map(|info| (number(&info, unsafe { kCGWindowNumber }), number(&info, unsafe { kCGWindowSharingState }))),
    )
}

fn number(info: &AnyObject, key: &CFString) -> Option<i64> {
    let n: Option<Retained<AnyObject>> = unsafe { msg_send![info, objectForKey: ns(key)] };
    n.map(|n| unsafe { msg_send![&*n, longLongValue] })
}

/// How often a running capture of a whole display looks again: a widget
/// added, or the setting flipped in the middle of Instant Replay.
const EVERY: Duration = Duration::from_secs(2);
const UPDATE_WAIT: Duration = Duration::from_secs(5);

/// Keeps a running stream's left-out windows current, on its own thread.
/// Dropping it ends that thread at its next look.
pub struct Keeper {
    _stop: mpsc::Sender<()>,
}

impl Keeper {
    /// None where the system cannot change a running stream's filter (a
    /// macOS without `updateContentFilter`): the list stays as it started.
    pub fn start(stream: &Retained<AnyObject>, display: u32, first: Vec<u32>) -> Option<Keeper> {
        let can: bool =
            unsafe { msg_send![&**stream, respondsToSelector: sel!(updateContentFilter:completionHandler:)] };
        if !can {
            return None;
        }
        let (tx, rx) = mpsc::channel();
        let stream = Sent(stream.clone());
        std::thread::Builder::new()
            .name("xenon-capture-keep-out".into())
            .spawn(move || keep(stream, display, first, rx))
            .ok()?;
        Some(Keeper { _stop: tx })
    }
}

fn keep(stream: Sent<Retained<AnyObject>>, display: u32, mut last: Vec<u32>, stop: mpsc::Receiver<()>) {
    while let Err(mpsc::RecvTimeoutError::Timeout) = stop.recv_timeout(EVERY) {
        let now = windows();
        if now == last {
            continue;
        }
        let Ok(content) = sck::content() else { continue };
        let Ok(filter) = sck::filter(&content, Target::Display(display), &now) else { continue };
        if update(&stream.0, &filter) {
            last = now;
        }
    }
}

fn update(stream: &AnyObject, filter: &AnyObject) -> bool {
    let done = ffi::wait_for(UPDATE_WAIT, |tx| {
        let block = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(Sent(unsafe { ffi::answer(std::ptr::null_mut(), error) }));
        });
        let _: () = unsafe { msg_send![stream, updateContentFilter: filter, completionHandler: &*block] };
    });
    matches!(done, Some(Ok(_)))
}

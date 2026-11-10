//! A picture of a whole display through ScreenCaptureKit (macOS 14), so the
//! windows that ask not to be captured stay out of it as they stay out of a
//! recording (no_share.rs). screencapture takes the rest: a window, an area
//! picked by hand, an older macOS, or this one failing.

use std::path::Path;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_core_foundation::{CFRetained, CGRect};
use objc2_core_graphics::CGImage;
use objc2_foundation::NSError;

use super::ffi::{self, Sent};
use super::image;
use super::no_share;
use super::sck::{self, Target};
use crate::proto::Fail;

/// The first picture can wait behind the Screen Recording prompt.
const SHOT_WAIT: Duration = Duration::from_secs(20);

pub fn available() -> bool {
    sck::available() && ffi::os_at_least(14, 0) && AnyClass::get(c"SCScreenshotManager").is_some()
}

/// Writes a PNG of display `display` (a CoreGraphics id), at its pixel size, to `path`.
pub fn display(display: u32, cursor: bool, path: &Path) -> Result<(), Fail> {
    let content = sck::content()?;
    let filter = sck::filter(&content, Target::Display(display), &no_share::windows())?;
    let rect: CGRect = unsafe { msg_send![&*filter, contentRect] };
    let scale: f32 = unsafe { msg_send![&*filter, pointPixelScale] };
    let (width, height) = pixels(rect, scale).ok_or(Fail::code("no_monitor"))?;
    let class = AnyClass::get(c"SCStreamConfiguration").ok_or(Fail::code("unsupported"))?;
    let config: Retained<AnyObject> = unsafe { msg_send![class, new] };
    unsafe {
        let _: () = msg_send![&*config, setWidth: width as usize];
        let _: () = msg_send![&*config, setHeight: height as usize];
        let _: () = msg_send![&*config, setShowsCursor: cursor];
    }
    let picture = picture(&filter, &config)?;
    if image::write_png(&picture, path) {
        Ok(())
    } else {
        Err(Fail::code("write_failed"))
    }
}

fn pixels(rect: CGRect, scale: f32) -> Option<(u32, u32)> {
    let side = |points: f64| {
        let px = (points * f64::from(scale)).round();
        (px >= 1.0 && px <= f64::from(u16::MAX)).then_some(px as u32)
    };
    Some((side(rect.size.width)?, side(rect.size.height)?))
}

type Picture = Result<CFRetained<CGImage>, isize>;

fn picture(filter: &AnyObject, config: &AnyObject) -> Result<CFRetained<CGImage>, Fail> {
    let class = AnyClass::get(c"SCScreenshotManager").ok_or(Fail::code("unsupported"))?;
    let (tx, rx) = mpsc::channel::<Sent<Picture>>();
    let done = RcBlock::new(move |picture: *mut CGImage, error: *mut NSError| {
        // Retained here: the system lets go of it when the handler returns.
        let got = match (NonNull::new(picture), unsafe { error.as_ref() }) {
            (Some(p), None) => Ok(unsafe { CFRetained::retain(p) }),
            (_, Some(e)) => Err(e.code()),
            (None, None) => Err(0),
        };
        let _ = tx.send(Sent(got));
    });
    let _: () =
        unsafe { msg_send![class, captureImageWithFilter: filter, configuration: config, completionHandler: &*done] };
    match rx.recv_timeout(SHOT_WAIT).map(|s| s.0) {
        Ok(Ok(picture)) => Ok(picture),
        Ok(Err(sck::ERROR_USER_DECLINED)) => Err(Fail::code("no_permission")),
        Ok(Err(code)) => Err(Fail::new("capture_failed", format!("SCScreenshotManager {code}"))),
        Err(_) => Err(Fail::new("capture_failed", "screenshot timed out")),
    }
}

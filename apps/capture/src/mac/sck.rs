//! ScreenCaptureKit (macOS 12.3 and later): a display or one window as a
//! stream of pictures, and the Mac's sound (macOS 13 and later). The
//! framework is opened at run time, never linked, and reached by message, so
//! the engine still starts where it does not exist and the caller falls back
//! to screencapture (record.rs). The Screen Recording grant is the system's
//! own prompt.

use std::ffi::CStr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, NSObject};
use objc2::{define_class, msg_send, sel, ClassType, DefinedClass};
use objc2_core_foundation::{CFRetained, CGRect};
use objc2_core_media::{CMSampleBuffer, CMTime};
use objc2_core_video::CVPixelBuffer;
use objc2_foundation::{NSArray, NSError};

use super::ffi::{self, Sent};
use crate::proto::Fail;

const PATH: &CStr = c"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit";
static HANDLE: OnceLock<usize> = OnceLock::new();

/// Waits on the system: the first ask for the shareable content can sit
/// behind the Screen Recording prompt.
const CONTENT_WAIT: Duration = Duration::from_secs(20);
const START_WAIT: Duration = Duration::from_secs(10);
const STOP_WAIT: Duration = Duration::from_secs(5);

/// SCStreamOutputType, SCFrameStatus, SCStreamErrorCode.
const OUTPUT_SCREEN: isize = 0;
const OUTPUT_AUDIO: isize = 1;
const FRAME_COMPLETE: isize = 0;
pub const ERROR_USER_DECLINED: isize = -3801;
pub const ERROR_USER_STOPPED: isize = -3817;
/// kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange: what the H.264 encoder takes as is.
const PIXEL_420V: u32 = u32::from_be_bytes(*b"420v");
/// A few pictures in flight, so the latest one can be held while new ones arrive.
const QUEUE_DEPTH: isize = 6;

/// ScreenCaptureKit is there to use.
pub fn available() -> bool {
    ffi::os_at_least(12, 3)
        && ffi::framework(PATH, &HANDLE).is_some()
        && AnyClass::get(c"SCStream").is_some()
}

/// The Mac's own sound can be recorded (macOS 13).
pub fn sound_available() -> bool {
    available() && ffi::os_at_least(13, 0)
}

/// What a stream hands in, on its own queue.
pub trait Sink: Send + Sync {
    /// A new picture (only complete ones: an unchanged screen sends none).
    fn picture(&self, picture: CFRetained<CVPixelBuffer>);
    /// A buffer of the Mac's sound.
    fn sound(&self, buffer: &CMSampleBuffer);
    /// The stream ended by itself with this SCStreamErrorCode.
    fn ended(&self, code: isize);
}
pub type SinkRef = Arc<dyn Sink>;

define_class!(
    // SCStreamOutput and SCStreamDelegate, added at run time (`output_class`)
    // because the protocols only exist once the framework is open.
    #[unsafe(super(NSObject))]
    #[name = "XenonCaptureStreamOutput"]
    #[ivars = SinkRef]
    struct Output;

    impl Output {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(&self, _stream: &AnyObject, buffer: &CMSampleBuffer, kind: isize) {
            match kind {
                OUTPUT_SCREEN => {
                    if let Some(picture) = complete_picture(buffer) {
                        self.ivars().picture(picture);
                    }
                }
                OUTPUT_AUDIO => self.ivars().sound(buffer),
                _ => {}
            }
        }

        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop(&self, _stream: &AnyObject, error: &NSError) {
            self.ivars().ended(error.code());
        }
    }
);

fn output_class() -> &'static AnyClass {
    let class = Output::class();
    for name in [c"SCStreamOutput", c"SCStreamDelegate"] {
        if let Some(p) = AnyProtocol::get(name) {
            // Adding a protocol a class already has does nothing.
            unsafe { objc2::ffi::class_addProtocol(class as *const _ as *mut _, p) };
        }
    }
    class
}

/// The picture in a screen buffer, when the frame is complete (not idle,
/// blank or suspended).
fn complete_picture(buffer: &CMSampleBuffer) -> Option<CFRetained<CVPixelBuffer>> {
    let key = ffi::constant(ffi::framework(PATH, &HANDLE)?, c"SCStreamFrameInfoStatus")?;
    let list = unsafe { buffer.sample_attachments_array(false) }?;
    let list = CFRetained::as_ptr(&list).as_ptr() as *const NSArray<AnyObject>;
    let list = unsafe { &*list };
    let first: Option<Retained<AnyObject>> = unsafe { msg_send![list, firstObject] };
    let status: Option<Retained<AnyObject>> =
        unsafe { msg_send![&*first?, objectForKey: key] };
    let status: isize = unsafe { msg_send![&*status?, integerValue] };
    if status != FRAME_COMPLETE {
        return None;
    }
    unsafe { buffer.image_buffer() }
}

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
fn content() -> Result<Retained<AnyObject>, Fail> {
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
fn start_failure(e: &NSError) -> Fail {
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

/// A window's frame in points, top-left origin (CoreGraphics), when it is on screen.
pub fn window_frame(window: u32) -> Option<CGRect> {
    let content = content().ok()?;
    let w = find(&content, true, window)?;
    Some(unsafe { msg_send![&*w, frame] })
}

fn filter(content: &AnyObject, target: Target) -> Result<Retained<AnyObject>, Fail> {
    let class = AnyClass::get(c"SCContentFilter").ok_or(Fail::code("unsupported"))?;
    let new: Allocated<AnyObject> = unsafe { msg_send![class, alloc] };
    match target {
        Target::Display(id) => {
            let display = find(content, false, id)
                .ok_or(Fail::code("no_monitor"))?;
            let none = NSArray::<AnyObject>::new();
            Ok(unsafe { msg_send![new, initWithDisplay: &*display, excludingWindows: &*none] })
        }
        Target::Window(id) => {
            let window = find(content, true, id)
                .ok_or(Fail::code("no_window"))?;
            Ok(unsafe { msg_send![new, initWithDesktopIndependentWindow: &*window] })
        }
    }
}

fn configuration(spec: &Spec) -> Result<Retained<AnyObject>, Fail> {
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

/// A running stream. Stopped on drop if `stop` was not called.
pub struct Stream {
    stream: Retained<AnyObject>,
    _output: Retained<Output>,
    _queue: DispatchRetained<DispatchQueue>,
    running: bool,
}

impl Stream {
    pub fn start(spec: &Spec, sink: SinkRef) -> Result<Stream, Fail> {
        let content = content()?;
        let filter = filter(&content, spec.target)?;
        let config = configuration(spec)?;
        let class = AnyClass::get(c"SCStream").ok_or(Fail::code("unsupported"))?;
        let output: Allocated<Output> = unsafe { msg_send![output_class(), alloc] };
        let output: Retained<Output> = unsafe { msg_send![super(output.set_ivars(sink)), init] };
        let queue = DispatchQueue::new("app.xenon.capture.stream", None);
        let new: Allocated<AnyObject> = unsafe { msg_send![class, alloc] };
        let stream: Retained<AnyObject> = unsafe {
            msg_send![new, initWithFilter: &*filter, configuration: &*config, delegate: &*output]
        };
        let add = |kind: isize| -> Result<(), Fail> {
            let added: Result<(), Retained<NSError>> = unsafe {
                msg_send![&*stream, addStreamOutput: &*output, type: kind, sampleHandlerQueue: &*queue, error: _]
            };
            added.map_err(|e| Fail::new("capture_failed", ffi::error_detail(&e).1))
        };
        add(OUTPUT_SCREEN)?;
        if spec.sound {
            add(OUTPUT_AUDIO)?;
        }
        let started = call_with_error(&stream, START_WAIT, true);
        match started {
            Some(None) => {}
            Some(Some(e)) => return Err(start_failure(&e)),
            None => return Err(Fail::new("capture_failed", "start timed out")),
        }
        Ok(Stream {
            stream,
            _output: output,
            _queue: queue,
            running: true,
        })
    }

    pub fn stop(&mut self) {
        if std::mem::take(&mut self.running) {
            let _ = call_with_error(&self.stream, STOP_WAIT, false);
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop();
    }
}

/// startCapture/stopCapture with a completion handler; Some(None) when it
/// went through, Some(error) when it failed, None when it never answered.
fn call_with_error(
    stream: &AnyObject,
    deadline: Duration,
    start: bool,
) -> Option<Option<Retained<NSError>>> {
    let answer = ffi::wait_for(deadline, |tx| {
        let done = RcBlock::new(move |error: *mut NSError| {
            let _ = tx.send(Sent(unsafe { ffi::answer(std::ptr::null_mut(), error) }));
        });
        if start {
            let _: () = unsafe { msg_send![stream, startCaptureWithCompletionHandler: &*done] };
        } else {
            let _: () = unsafe { msg_send![stream, stopCaptureWithCompletionHandler: &*done] };
        }
    })?;
    Some(answer.err())
}


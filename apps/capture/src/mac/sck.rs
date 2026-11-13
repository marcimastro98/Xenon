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
use objc2::{ClassType, define_class, DefinedClass, msg_send};
use objc2_core_foundation::CFRetained;
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::CVPixelBuffer;
use objc2_foundation::{NSArray, NSError};

use super::ffi::{self, Sent};
use super::no_share;
use crate::proto::Fail;

mod target;

pub use target::{Spec, Target, window_frame};
use target::{configuration, start_failure};
pub(super) use target::{content, filter};

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

/// A running stream. Stopped on drop if `stop` was not called.
pub struct Stream {
    stream: Retained<AnyObject>,
    _output: Retained<Output>,
    _queue: DispatchRetained<DispatchQueue>,
    running: bool,
    /// Keeps the windows that ask not to be captured out (a whole display only).
    keeper: Option<no_share::Keeper>,
}

impl Stream {
    pub fn start(spec: &Spec, sink: SinkRef) -> Result<Stream, Fail> {
        let content = content()?;
        let hide = match spec.target {
            Target::Display(_) => no_share::windows(),
            Target::Window(_) => Vec::new(),
        };
        let filter = filter(&content, spec.target, &hide)?;
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
        let keeper = match spec.target {
            Target::Display(id) => no_share::Keeper::start(&stream, id, hide),
            Target::Window(_) => None,
        };
        Ok(Stream {
            stream,
            _output: output,
            _queue: queue,
            running: true,
            keeper,
        })
    }

    pub fn stop(&mut self) {
        self.keeper = None;
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

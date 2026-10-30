//! The microphone through an AVFoundation capture session: the default input
//! device, its buffers handed to a closure on the session's own queue. Used
//! on every macOS the ScreenCaptureKit path runs on (its own microphone
//! output needs macOS 15). The Microphone grant is the system's own prompt.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{define_class, msg_send, ClassType, DefinedClass};
use objc2_av_foundation::AVMediaTypeAudio;
use objc2_core_media::CMSampleBuffer;
use objc2_foundation::{NSError, NSString};

/// AVAuthorizationStatus
const NOT_DETERMINED: isize = 0;
const AUTHORIZED: isize = 3;
/// How long the first-time prompt may wait on the user.
const ASK_WAIT: Duration = Duration::from_secs(60);

pub type MicSink = Box<dyn Fn(&CMSampleBuffer) + Send + Sync>;

define_class!(
    // AVCaptureAudioDataOutputSampleBufferDelegate, checked by selector.
    #[unsafe(super(NSObject))]
    #[name = "XenonCaptureMicOutput"]
    #[ivars = MicSink]
    struct Output;

    impl Output {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn did_output(&self, _output: &AnyObject, buffer: &CMSampleBuffer, _connection: &AnyObject) {
            (self.ivars())(buffer);
        }
    }
);

pub struct Mic {
    session: Retained<AnyObject>,
    _output: Retained<Output>,
    _queue: DispatchRetained<DispatchQueue>,
}

/// The grant for `kind` (the Microphone here, the Camera in camera.rs),
/// asking once when it was never asked.
pub(super) fn allowed(device: &AnyClass, kind: &NSString) -> bool {
    let status: isize = unsafe { msg_send![device, authorizationStatusForMediaType: kind] };
    if status != NOT_DETERMINED {
        return status == AUTHORIZED;
    }
    let (tx, rx) = mpsc::channel();
    let done = RcBlock::new(move |granted: objc2::runtime::Bool| {
        let _ = tx.send(granted.as_bool());
    });
    let _: () = unsafe { msg_send![device, requestAccessForMediaType: kind, completionHandler: &*done] };
    rx.recv_timeout(ASK_WAIT).unwrap_or(false)
}

impl Mic {
    /// The default microphone running; None when there is none, the grant is
    /// refused or it would not open (the recording goes on without it).
    pub fn start(sink: MicSink) -> Option<Mic> {
        let audio: &NSString = unsafe { AVMediaTypeAudio }?;
        let device_class = AnyClass::get(c"AVCaptureDevice")?;
        if !allowed(device_class, audio) {
            return None;
        }
        let device: Option<Retained<AnyObject>> =
            unsafe { msg_send![device_class, defaultDeviceWithMediaType: audio] };
        let device = device?;
        let input_class = AnyClass::get(c"AVCaptureDeviceInput")?;
        let input: Result<Retained<AnyObject>, Retained<NSError>> =
            unsafe { msg_send![input_class, deviceInputWithDevice: &*device, error: _] };
        let input = input.ok()?;
        let session: Retained<AnyObject> =
            unsafe { msg_send![AnyClass::get(c"AVCaptureSession")?, new] };
        let output: Retained<AnyObject> =
            unsafe { msg_send![AnyClass::get(c"AVCaptureAudioDataOutput")?, new] };
        let delegate: Allocated<Output> = unsafe { msg_send![Output::class(), alloc] };
        let delegate: Retained<Output> = unsafe { msg_send![super(delegate.set_ivars(sink)), init] };
        let queue = DispatchQueue::new("app.xenon.capture.mic", None);
        unsafe {
            let _: () = msg_send![&*output, setSampleBufferDelegate: &*delegate, queue: &*queue];
            let can_in: bool = msg_send![&*session, canAddInput: &*input];
            let can_out: bool = msg_send![&*session, canAddOutput: &*output];
            if !can_in || !can_out {
                return None;
            }
            let _: () = msg_send![&*session, addInput: &*input];
            let _: () = msg_send![&*session, addOutput: &*output];
            let _: () = msg_send![&*session, startRunning];
            let running: bool = msg_send![&*session, isRunning];
            if !running {
                return None;
            }
        }
        Some(Mic {
            session,
            _output: delegate,
            _queue: queue,
        })
    }
}

impl Drop for Mic {
    fn drop(&mut self) {
        let _: () = unsafe { msg_send![&*self.session, stopRunning] };
    }
}

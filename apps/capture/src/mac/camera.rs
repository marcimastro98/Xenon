//! The webcam in a recording, as on Windows (win/record/camera.rs): an
//! AVFoundation capture session of the default camera, on a queue of its own,
//! keeps only its latest picture as BGRA rows for the bubble (webcam.rs). It
//! is opened only when the user asked for it on this recording and stopped
//! (its light off) when the recording ends. The Camera grant is the system's
//! own prompt, asked once.

use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{define_class, msg_send, ClassType, DefinedClass};
use objc2_av_foundation::{AVCaptureSessionPreset1280x720, AVMediaTypeVideo};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::kCVPixelBufferPixelFormatTypeKey;
use objc2_foundation::{NSError, NSString};

use super::frame::{self, Locked};
use super::mic;
use super::writer::{dict, num};

/// How long the camera may take to hand its first picture once it runs
/// before the recording goes on without it.
const OPEN_TIMEOUT: Duration = Duration::from_secs(4);
/// kCVPixelFormatType_32BGRA: what the bubble samples.
const BGRA: u32 = u32::from_be_bytes(*b"BGRA");

pub struct Picture {
    pub width: u32,
    pub height: u32,
    /// Tight rows, `width * 4` bytes each.
    pub bgra: Vec<u8>,
    /// Goes up with every new picture, so the bubble is drawn once per picture.
    pub seq: u64,
}

/// What the session's queue hands in.
pub struct Keep {
    latest: Arc<Mutex<Option<Picture>>>,
    /// Told once, on the first picture.
    first: Mutex<Option<mpsc::Sender<()>>>,
}

define_class!(
    // AVCaptureVideoDataOutputSampleBufferDelegate, checked by selector.
    #[unsafe(super(NSObject))]
    #[name = "XenonCaptureCameraOutput"]
    #[ivars = Keep]
    struct Output;

    impl Output {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn did_output(&self, _output: &AnyObject, buffer: &CMSampleBuffer, _connection: &AnyObject) {
            let Some((width, height, bgra)) = copy(buffer) else { return };
            let keep = self.ivars();
            if let Ok(mut slot) = keep.latest.lock() {
                let seq = slot.as_ref().map_or(1, |p| p.seq + 1);
                *slot = Some(Picture { width, height, bgra, seq });
            }
            if let Some(tx) = keep.first.lock().ok().and_then(|mut f| f.take()) {
                let _ = tx.send(());
            }
        }
    }
);

/// A camera buffer's picture as tight BGRA rows.
fn copy(buffer: &CMSampleBuffer) -> Option<(u32, u32, Vec<u8>)> {
    let image = unsafe { buffer.image_buffer() }?;
    let (width, height) = frame::size(&image);
    let locked = Locked::read(&image)?;
    let plane = locked.plane(0)?;
    let row = width as usize * 4;
    if plane.stride < row {
        return None;
    }
    let mut bgra = Vec::with_capacity(row * height as usize);
    for r in 0..height as usize {
        let at = r * plane.stride;
        bgra.extend_from_slice(plane.data.get(at..at + row)?);
    }
    Some((width, height, bgra))
}

pub struct Camera {
    latest: Arc<Mutex<Option<Picture>>>,
    session: Retained<AnyObject>,
    _output: Retained<Output>,
    _queue: DispatchRetained<DispatchQueue>,
}

impl Camera {
    /// The default camera, once it handed its first picture; None when there
    /// is none, the grant is refused, another app holds it, or it did not
    /// answer in time (the recording goes on without it).
    pub fn open() -> Option<Camera> {
        let video: &NSString = unsafe { AVMediaTypeVideo }?;
        let device_class = AnyClass::get(c"AVCaptureDevice")?;
        if !mic::allowed(device_class, video) {
            return None;
        }
        let device: Option<Retained<AnyObject>> =
            unsafe { msg_send![device_class, defaultDeviceWithMediaType: video] };
        let input: Result<Retained<AnyObject>, Retained<NSError>> = unsafe {
            msg_send![AnyClass::get(c"AVCaptureDeviceInput")?, deviceInputWithDevice: &*device?, error: _]
        };
        let input = input.ok()?;
        let session: Retained<AnyObject> = unsafe { msg_send![AnyClass::get(c"AVCaptureSession")?, new] };
        let output: Retained<AnyObject> =
            unsafe { msg_send![AnyClass::get(c"AVCaptureVideoDataOutput")?, new] };
        let latest = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::channel();
        let keep = Keep { latest: latest.clone(), first: Mutex::new(Some(tx)) };
        let delegate: Allocated<Output> = unsafe { msg_send![Output::class(), alloc] };
        let delegate: Retained<Output> = unsafe { msg_send![super(delegate.set_ivars(keep)), init] };
        let queue = DispatchQueue::new("app.xenon.capture.camera", None);
        let settings = dict(&[(frame::ns(unsafe { kCVPixelBufferPixelFormatTypeKey }), num(BGRA as i64))]);
        unsafe {
            let _: () = msg_send![&*output, setVideoSettings: &*settings];
            // Only the latest picture is kept: a late one is dropped, never queued.
            let _: () = msg_send![&*output, setAlwaysDiscardsLateVideoFrames: true];
            let _: () = msg_send![&*output, setSampleBufferDelegate: &*delegate, queue: &*queue];
            let can_in: bool = msg_send![&*session, canAddInput: &*input];
            let can_out: bool = msg_send![&*session, canAddOutput: &*output];
            if !can_in || !can_out {
                return None;
            }
            let _: () = msg_send![&*session, addInput: &*input];
            let _: () = msg_send![&*session, addOutput: &*output];
            // The bubble is a few hundred pixels: a larger picture only costs copying.
            let preset = AVCaptureSessionPreset1280x720;
            let can_preset: bool = msg_send![&*session, canSetSessionPreset: preset];
            if can_preset {
                let _: () = msg_send![&*session, setSessionPreset: preset];
            }
        }
        let camera = Camera { latest, session, _output: delegate, _queue: queue };
        let _: () = unsafe { msg_send![&*camera.session, startRunning] };
        // Dropped on a timeout: the session stops, the light goes off.
        rx.recv_timeout(OPEN_TIMEOUT).ok().map(|()| camera)
    }

    /// Runs `f` on the latest picture, if the camera has one.
    pub fn with_latest<R>(&self, f: impl FnOnce(&Picture) -> R) -> Option<R> {
        let guard = self.latest.lock().ok()?;
        guard.as_ref().map(f)
    }
}

impl Drop for Camera {
    fn drop(&mut self) {
        let _: () = unsafe { msg_send![&*self.session, stopRunning] };
    }
}

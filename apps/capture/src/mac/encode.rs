//! The MP4 an export writes through AVAssetWriter: H.264 from frames filled
//! here (pixel buffers from the writer's own pool), and the source's first
//! sound track copied as stored. Not in real time: the inputs say when they
//! take more, and the file ends with its index first.

use std::path::Path;
use std::ptr::{null_mut, NonNull};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus,
    AVFileTypeMPEG4, AVMediaTypeAudio, AVMediaTypeVideo,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMFormatDescription, CMSampleBuffer};
use objc2_core_video::{
    kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, CVPixelBuffer, CVPixelBufferPool,
};
use objc2_foundation::{NSDictionary, NSString, NSURL};

use super::ffi;
use super::frame;
use super::writer::{any, dict, failure, num, video_settings, Shape};
use crate::proto::Fail;

/// The longest the encoder may take to finish the file.
const FINISH_WAIT: Duration = Duration::from_secs(60);
/// kCVReturnSuccess
const CV_OK: i32 = 0;

pub struct Encoder {
    writer: Retained<AVAssetWriter>,
    video: Retained<AVAssetWriterInput>,
    adaptor: Retained<AVAssetWriterInputPixelBufferAdaptor>,
    sound: Option<Retained<AVAssetWriterInput>>,
}

fn no_encoder() -> Fail {
    Fail::code("no_encoder")
}

impl Encoder {
    /// A new file at `path` (which must not exist): video of `shape`, and a
    /// sound track taking samples of `sound` as they are.
    pub fn new(
        path: &Path,
        shape: &Shape,
        sound: Option<&CMFormatDescription>,
    ) -> Result<Encoder, Fail> {
        let url = NSURL::from_file_path(path).ok_or(Fail::code("bad_request"))?;
        let mp4 = unsafe { AVFileTypeMPEG4 }.ok_or_else(no_encoder)?;
        let writer =
            unsafe { AVAssetWriter::initWithURL_fileType_error(AVAssetWriter::alloc(), &url, mp4) }
                .map_err(|e| failure(Some(e)))?;
        unsafe { writer.setShouldOptimizeForNetworkUse(true) };
        let kind = unsafe { AVMediaTypeVideo }.ok_or_else(no_encoder)?;
        let settings = video_settings(shape)?;
        let video = unsafe {
            AVAssetWriterInput::initWithMediaType_outputSettings(
                AVAssetWriterInput::alloc(),
                kind,
                Some(&settings),
            )
        };
        let pixels = dict(&[
            (
                frame::ns(unsafe { kCVPixelBufferPixelFormatTypeKey }),
                num(super::reader::NV12 as i64),
            ),
            (
                frame::ns(unsafe { kCVPixelBufferWidthKey }),
                num(shape.width as i64),
            ),
            (
                frame::ns(unsafe { kCVPixelBufferHeightKey }),
                num(shape.height as i64),
            ),
            (
                frame::ns(unsafe { kCVPixelBufferIOSurfacePropertiesKey }),
                any(NSDictionary::<NSString, AnyObject>::new()),
            ),
        ]);
        let adaptor = unsafe {
            AVAssetWriterInputPixelBufferAdaptor::initWithAssetWriterInput_sourcePixelBufferAttributes(
                AVAssetWriterInputPixelBufferAdaptor::alloc(),
                &video,
                Some(&pixels),
            )
        };
        if !unsafe { writer.canAddInput(&video) } {
            return Err(no_encoder());
        }
        unsafe { writer.addInput(&video) };
        let sound = match sound {
            Some(format) => {
                let kind = unsafe { AVMediaTypeAudio }.ok_or_else(no_encoder)?;
                let input = unsafe {
                    AVAssetWriterInput::initWithMediaType_outputSettings_sourceFormatHint(
                        AVAssetWriterInput::alloc(),
                        kind,
                        None,
                        Some(format),
                    )
                };
                // A sound the file cannot take as stored: the copy is silent.
                unsafe { writer.canAddInput(&input) }.then(|| {
                    unsafe { writer.addInput(&input) };
                    input
                })
            }
            None => None,
        };
        if !unsafe { writer.startWriting() } {
            return Err(failure(unsafe { writer.error() }));
        }
        Ok(Encoder {
            writer,
            video,
            adaptor,
            sound,
        })
    }

    /// Whether the file copies a sound track.
    pub fn has_sound(&self) -> bool {
        self.sound.is_some()
    }

    /// The copy starts at `ticks` of the source's time.
    pub fn begin(&self, ticks: i64) {
        unsafe {
            self.writer
                .startSessionAtSourceTime(ffi::time_of_ticks(ticks))
        };
    }

    pub fn check(&self) -> Result<(), Fail> {
        if unsafe { self.writer.status() } == AVAssetWriterStatus::Failed {
            return Err(failure(unsafe { self.writer.error() }));
        }
        Ok(())
    }

    pub fn video_ready(&self) -> bool {
        unsafe { self.video.isReadyForMoreMediaData() }
    }

    pub fn sound_ready(&self) -> bool {
        self.sound
            .as_ref()
            .is_some_and(|s| unsafe { s.isReadyForMoreMediaData() })
    }

    /// A frame for `fill` to draw into, from the writer's pool.
    pub fn blank(&self) -> Result<CFRetained<CVPixelBuffer>, Fail> {
        let pool: Retained<CVPixelBufferPool> =
            unsafe { self.adaptor.pixelBufferPool() }.ok_or_else(no_encoder)?;
        let mut out: *mut CVPixelBuffer = null_mut();
        let status =
            unsafe { CVPixelBufferPool::create_pixel_buffer(None, &pool, NonNull::from(&mut out)) };
        let out = NonNull::new(out).map(|p| unsafe { CFRetained::from_raw(p) });
        match out {
            Some(b) if status == CV_OK => Ok(b),
            _ => Err(Fail::code("encoder_failed")),
        }
    }

    /// One frame shown at `ticks` (the input must be ready).
    pub fn picture(&self, picture: &CVPixelBuffer, ticks: i64) -> Result<(), Fail> {
        let ok = unsafe {
            self.adaptor
                .appendPixelBuffer_withPresentationTime(picture, ffi::time_of_ticks(ticks))
        };
        if !ok {
            return Err(failure(unsafe { self.writer.error() }));
        }
        Ok(())
    }

    /// A piece of the sound track as the source stored it (the input must be ready).
    pub fn sound(&self, sample: &CMSampleBuffer) -> Result<(), Fail> {
        let Some(input) = &self.sound else {
            return Ok(());
        };
        if !unsafe { input.appendSampleBuffer(sample) } {
            return Err(failure(unsafe { self.writer.error() }));
        }
        Ok(())
    }

    pub fn end_video(&self) {
        unsafe { self.video.markAsFinished() };
    }

    pub fn end_sound(&self) {
        if let Some(s) = &self.sound {
            unsafe { s.markAsFinished() };
        }
    }

    /// Writes the rest of the file and waits for it.
    pub fn finish(self) -> Result<(), Fail> {
        self.check()?;
        let (tx, rx) = mpsc::channel::<()>();
        let done = RcBlock::new(move || {
            let _ = tx.send(());
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&done) };
        if rx.recv_timeout(FINISH_WAIT).is_err() {
            return Err(Fail::new("encoder_failed", "finish timed out"));
        }
        match unsafe { self.writer.status() } {
            AVAssetWriterStatus::Completed => Ok(()),
            _ => Err(failure(unsafe { self.writer.error() })),
        }
    }

    /// Stops without a file: what was written is deleted by AVFoundation.
    pub fn cancel(self) {
        unsafe { self.writer.cancelWriting() };
    }
}

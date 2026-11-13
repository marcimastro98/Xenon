//! An MP4 written by AVFoundation: H.264 video from the frame clock and AAC
//! sound tracks from the mixer (audio.rs), the same file a Windows recording
//! makes. Written in fragments, so a crash still leaves a file that plays up
//! to the last one, and finished with its index first.

use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut, NonNull};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_av_foundation::{AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeVideo};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMAudioSampleBufferCreateReadyWithPacketDescriptions, CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMTime};
use objc2_core_video::CVPixelBuffer;
use objc2_foundation::NSURL;

use super::ffi;
use crate::audio::{CHANNELS, RATE};
use crate::pcm;

mod settings;

pub(super) use settings::{any, dict, failure, num, sound_inputs, video_settings};

/// AVErrorDiskFull.
const ERROR_DISK_FULL: isize = -11807;
/// kAudioFormatMPEG4AAC, kAudioFormatLinearPCM and its signed-packed flags.
const FORMAT_AAC: u32 = u32::from_be_bytes(*b"aac ");
const SIGNED_PACKED: u32 = (1 << 2) | (1 << 3);
const AAC_BITRATE: i64 = 160_000;
/// A fragment every two seconds: what a crash can lose at most.
const FRAGMENT_TICKS: i64 = 2 * crate::video::TICKS_PER_SECOND;
/// The longest the encoder may take to finish the file.
const FINISH_WAIT: Duration = Duration::from_secs(30);
/// kCMBlockBufferAssureMemoryNowFlag
const MEMORY_NOW: u32 = 1;

pub struct Writer {
    writer: Retained<AVAssetWriter>,
    video: Retained<AVAssetWriterInput>,
    adaptor: Retained<AVAssetWriterInputPixelBufferAdaptor>,
    sound: Vec<Retained<AVAssetWriterInput>>,
    format: Option<CFRetained<CMFormatDescription>>,
}

pub struct Shape {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    /// AAC tracks, in the order the mixer gives them (audio::tracks).
    pub tracks: usize,
}

impl Writer {
    /// A new file at `path` (which must not exist), ready for its first frame at 0.
    pub fn new(path: &Path, shape: &Shape) -> Result<Writer, crate::proto::Fail> {
        let url = NSURL::from_file_path(path).ok_or(crate::proto::Fail::code("bad_request"))?;
        let mp4 = unsafe { AVFileTypeMPEG4 }.ok_or(crate::proto::Fail::code("no_encoder"))?;
        let writer = unsafe { AVAssetWriter::initWithURL_fileType_error(AVAssetWriter::alloc(), &url, mp4) }
            .map_err(|e| failure(Some(e)))?;
        unsafe {
            writer.setShouldOptimizeForNetworkUse(true);
            writer.setMovieFragmentInterval(ffi::time_of_ticks(FRAGMENT_TICKS));
        }
        let video_type = unsafe { AVMediaTypeVideo }.ok_or(crate::proto::Fail::code("no_encoder"))?;
        let settings = video_settings(shape)?;
        let video = unsafe {
            AVAssetWriterInput::initWithMediaType_outputSettings(AVAssetWriterInput::alloc(), video_type, Some(&settings))
        };
        unsafe { video.setExpectsMediaDataInRealTime(true) };
        let adaptor = unsafe {
            AVAssetWriterInputPixelBufferAdaptor::initWithAssetWriterInput_sourcePixelBufferAttributes(
                AVAssetWriterInputPixelBufferAdaptor::alloc(),
                &video,
                None,
            )
        };
        if !unsafe { writer.canAddInput(&video) } {
            return Err(crate::proto::Fail::code("no_encoder"));
        }
        unsafe { writer.addInput(&video) };
        let (sound, format) = sound_inputs(&writer, shape.tracks, true)?;
        if !unsafe { writer.startWriting() } {
            return Err(failure(unsafe { writer.error() }));
        }
        unsafe { writer.startSessionAtSourceTime(ffi::time_of_ticks(0)) };
        Ok(Writer { writer, video, adaptor, sound, format })
    }

    /// One frame shown at `ticks`; Ok(false) when the encoder was busy and
    /// the frame was dropped.
    pub fn picture(&self, picture: &CVPixelBuffer, ticks: i64) -> Result<bool, crate::proto::Fail> {
        self.check()?;
        if !unsafe { self.video.isReadyForMoreMediaData() } {
            return Ok(false);
        }
        let ok = unsafe { self.adaptor.appendPixelBuffer_withPresentationTime(picture, ffi::time_of_ticks(ticks)) };
        if !ok {
            return Err(failure(unsafe { self.writer.error() }));
        }
        Ok(true)
    }

    /// A finished piece of sound track `track`, starting at timeline frame `at`.
    pub fn sound(&self, track: usize, at: u64, samples: &[i16]) -> Result<(), crate::proto::Fail> {
        self.check()?;
        let (Some(input), Some(format)) = (self.sound.get(track), self.format.as_ref()) else {
            return Ok(());
        };
        let frames = samples.len() / CHANNELS;
        if frames == 0 || !unsafe { input.isReadyForMoreMediaData() } {
            return Ok(());
        }
        let Some(buffer) = sample_buffer(format, at, &samples[..frames * CHANNELS]) else {
            return Err(crate::proto::Fail::code("encoder_failed"));
        };
        if !unsafe { input.appendSampleBuffer(&buffer) } {
            return Err(failure(unsafe { self.writer.error() }));
        }
        Ok(())
    }

    fn check(&self) -> Result<(), crate::proto::Fail> {
        if unsafe { self.writer.status() } == AVAssetWriterStatus::Failed {
            return Err(failure(unsafe { self.writer.error() }));
        }
        Ok(())
    }

    /// Stops without a file: what was written is deleted by AVFoundation.
    pub fn cancel(self) {
        unsafe { self.writer.cancelWriting() };
    }

    /// Ends the file at `end_ticks` and waits for it to be written.
    pub fn finish(self, end_ticks: i64) -> Result<(), crate::proto::Fail> {
        self.check()?;
        unsafe {
            self.writer.endSessionAtSourceTime(ffi::time_of_ticks(end_ticks));
            self.video.markAsFinished();
            for s in &self.sound {
                s.markAsFinished();
            }
        }
        let (tx, rx) = mpsc::channel::<()>();
        let done = RcBlock::new(move || {
            let _ = tx.send(());
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&done) };
        if rx.recv_timeout(FINISH_WAIT).is_err() {
            return Err(crate::proto::Fail::new("encoder_failed", "finish timed out"));
        }
        match unsafe { self.writer.status() } {
            AVAssetWriterStatus::Completed => Ok(()),
            _ => Err(failure(unsafe { self.writer.error() })),
        }
    }
}

/// 16-bit stereo samples as a ready sound buffer stamped at timeline frame `at`.
pub(super) fn sample_buffer(format: &CMFormatDescription, at: u64, samples: &[i16]) -> Option<CFRetained<CMSampleBuffer>> {
    let bytes = pcm::le_bytes(samples);
    let mut block: *mut CMBlockBuffer = null_mut();
    let status = unsafe {
        CMBlockBuffer::create_with_memory_block(
            None,
            null_mut(),
            bytes.len(),
            None,
            null(),
            0,
            bytes.len(),
            MEMORY_NOW,
            NonNull::from(&mut block),
        )
    };
    let block = NonNull::new(block).map(|b| unsafe { CFRetained::from_raw(b) })?;
    if status != 0 {
        return None;
    }
    let src = NonNull::new(bytes.as_ptr() as *mut c_void)?;
    if unsafe { CMBlockBuffer::replace_data_bytes(src, &block, 0, bytes.len()) } != 0 {
        return None;
    }
    let mut out: *mut CMSampleBuffer = null_mut();
    let time = unsafe { CMTime::new(at as i64, RATE as i32) };
    let status = unsafe {
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            None,
            &block,
            format,
            (samples.len() / CHANNELS) as isize,
            time,
            null(),
            NonNull::from(&mut out),
        )
    };
    let out = NonNull::new(out).map(|b| unsafe { CFRetained::from_raw(b) })?;
    (status == 0).then_some(out)
}

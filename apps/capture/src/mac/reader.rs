//! A saved video read frame by frame through AVAssetReader: the first video
//! track decoded to the pixel format asked for, and the first sound track
//! (Xenon's mix comes first) as stored, for a copy to take as is.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_av_foundation::{
    AVAsset, AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetTrack,
    AVMediaType, AVMediaTypeAudio, AVMediaTypeVideo, AVURLAsset,
};
use objc2_core_media::{CMFormatDescription, CMSampleBuffer};
use objc2_core_video::kCVPixelBufferPixelFormatTypeKey;
use objc2_foundation::{NSArray, NSURL};

use super::ffi;
use super::writer::{dict, num};
use crate::video::TICKS_PER_SECOND;

/// kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange (what H.264 takes) and
/// kCVPixelFormatType_32BGRA (what a GIF frame is made from).
pub const NV12: u32 = u32::from_be_bytes(*b"420v");
pub const BGRA: u32 = u32::from_be_bytes(*b"BGRA");
/// The sound's bitrate when the file does not say (what Xenon records).
const AUDIO_BPS: u32 = 192_000;

/// The first sound track, read as stored.
pub struct Sound {
    output: Retained<AVAssetReaderTrackOutput>,
    /// Its CMFormatDescription: what the copy's track is told it gets.
    format: Retained<AnyObject>,
    pub bps: u32,
}

impl Sound {
    pub fn format(&self) -> &CMFormatDescription {
        // formatDescriptions holds CMFormatDescriptionRefs.
        unsafe { &*Retained::as_ptr(&self.format).cast::<CMFormatDescription>() }
    }
}

pub struct Source {
    reader: Retained<AVAssetReader>,
    video: Retained<AVAssetReaderTrackOutput>,
    pub sound: Option<Sound>,
    /// The picture's frames per second and length (its size is the
    /// decoded frames': frame::size).
    pub fps: u32,
    pub seconds: f64,
}

/// What one read gave.
pub enum Read {
    Sample(Retained<CMSampleBuffer>),
    End,
    Failed,
}

/// The asset's tracks of a kind. The synchronous form: a local file read on a
/// worker thread, on every macOS the engine runs on (the loading form needs 12).
#[allow(deprecated)]
pub(super) fn tracks(asset: &AVAsset, kind: &AVMediaType) -> Retained<NSArray<AVAssetTrack>> {
    unsafe { asset.tracksWithMediaType(kind) }
}

fn first_sound(asset: &AVAsset, reader: &AVAssetReader) -> Option<Sound> {
    let track = tracks(asset, unsafe { AVMediaTypeAudio }?).firstObject()?;
    let format = unsafe { track.formatDescriptions() }.firstObject()?;
    let output = unsafe {
        AVAssetReaderTrackOutput::initWithTrack_outputSettings(
            AVAssetReaderTrackOutput::alloc(),
            &track,
            None,
        )
    };
    unsafe { output.setAlwaysCopiesSampleData(false) };
    if !unsafe { reader.canAddOutput(&output) } {
        return None;
    }
    unsafe { reader.addOutput(&output) };
    let rate = unsafe { track.estimatedDataRate() };
    let bps = if rate.is_finite() && rate > 0.0 {
        rate as u32
    } else {
        AUDIO_BPS
    };
    Some(Sound {
        output,
        format,
        bps,
    })
}

/// `src` opened for reading its pictures as `pixels` (NV12 or BGRA), with
/// its first sound track when `with_sound`; None when it has no video or
/// AVFoundation cannot read it.
pub fn open(src: &str, pixels: u32, with_sound: bool) -> Option<Source> {
    let url = NSURL::from_file_path(src)?;
    let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
    let track = tracks(&asset, unsafe { AVMediaTypeVideo }?).firstObject()?;
    let reader =
        unsafe { AVAssetReader::initWithAsset_error(AVAssetReader::alloc(), &asset) }.ok()?;
    let settings = dict(&[(
        super::frame::ns(unsafe { kCVPixelBufferPixelFormatTypeKey }),
        num(pixels as i64),
    )]);
    let video = unsafe {
        AVAssetReaderTrackOutput::initWithTrack_outputSettings(
            AVAssetReaderTrackOutput::alloc(),
            &track,
            Some(&settings),
        )
    };
    unsafe { video.setAlwaysCopiesSampleData(false) };
    if !unsafe { reader.canAddOutput(&video) } {
        return None;
    }
    unsafe { reader.addOutput(&video) };
    let sound = if with_sound {
        first_sound(&asset, &reader)
    } else {
        None
    };
    let rate = unsafe { track.nominalFrameRate() };
    let fps = if rate.is_finite() && rate >= 1.0 {
        (rate.round() as u32).min(240)
    } else {
        30
    };
    let seconds = ffi::ticks_of_time(unsafe { asset.duration() })
        .map_or(0.0, |t| t as f64 / TICKS_PER_SECOND as f64);
    if !unsafe { reader.startReading() } {
        return None;
    }
    Some(Source {
        reader,
        video,
        sound,
        fps,
        seconds,
    })
}

impl Source {
    fn read(&self, output: &AVAssetReaderTrackOutput) -> Read {
        match unsafe { output.copyNextSampleBuffer() } {
            Some(s) => Read::Sample(s),
            None if unsafe { self.reader.status() } == AVAssetReaderStatus::Failed => Read::Failed,
            None => Read::End,
        }
    }

    pub fn next_video(&self) -> Read {
        self.read(&self.video)
    }

    /// The next piece of the sound track; End when there is none.
    pub fn next_sound(&self) -> Read {
        match &self.sound {
            Some(s) => self.read(&s.output),
            None => Read::End,
        }
    }
}

impl Drop for Source {
    fn drop(&mut self) {
        if unsafe { self.reader.status() } == AVAssetReaderStatus::Reading {
            unsafe { self.reader.cancelReading() };
        }
    }
}

/// A sample's presentation time in 100-ns units.
pub fn time_of(sample: &CMSampleBuffer) -> Option<i64> {
    ffi::ticks_of_time(unsafe { sample.presentation_time_stamp() })
}

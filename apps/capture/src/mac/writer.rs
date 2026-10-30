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
use objc2::runtime::AnyObject;
use objc2::{msg_send, AllocAnyThread, Message};
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus,
    AVFileTypeMPEG4, AVMediaTypeAudio, AVMediaTypeVideo, AVVideoAllowFrameReorderingKey,
    AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeH264,
    AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey,
    AVVideoMaxKeyFrameIntervalKey, AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelKey,
    AVVideoWidthKey,
};
use objc2_core_audio_types::AudioStreamBasicDescription;
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionCreate, CMAudioSampleBufferCreateReadyWithPacketDescriptions,
    CMBlockBuffer, CMFormatDescription, CMSampleBuffer, CMTime,
};
use objc2_core_video::CVPixelBuffer;
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString, NSURL};

use super::ffi;
use crate::audio::{CHANNELS, RATE};
use crate::pcm;

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

fn key(k: Option<&'static NSString>) -> Result<&'static NSString, crate::proto::Fail> {
    k.ok_or(crate::proto::Fail::code("no_encoder"))
}

/// Any object as a dictionary value.
pub(super) fn any<T: Message>(object: Retained<T>) -> Retained<AnyObject> {
    unsafe { Retained::cast_unchecked(object) }
}

pub(super) fn num(n: i64) -> Retained<AnyObject> {
    any(NSNumber::new_i64(n))
}

/// A string constant's text as a new string (a key compares by its text).
fn text(k: &NSString) -> Retained<AnyObject> {
    any(NSString::from_str(&k.to_string()))
}

pub(super) fn dict(pairs: &[(&NSString, Retained<AnyObject>)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: Vec<&NSString> = pairs.iter().map(|p| p.0).collect();
    let values: Vec<Retained<AnyObject>> = pairs.iter().map(|p| p.1.clone()).collect();
    NSDictionary::from_retained_objects(&keys, &values)
}

pub(super) fn video_settings(s: &Shape) -> Result<Retained<NSDictionary<NSString, AnyObject>>, crate::proto::Fail> {
    let fps = s.fps.max(1) as i64;
    let compression = dict(&[
        (key(unsafe { AVVideoAverageBitRateKey })?, num(s.bitrate as i64)),
        (key(unsafe { AVVideoExpectedSourceFrameRateKey })?, num(fps)),
        (key(unsafe { AVVideoMaxKeyFrameIntervalKey })?, num(fps * 2)),
        (
            key(unsafe { AVVideoProfileLevelKey })?,
            text(key(unsafe { AVVideoProfileLevelH264HighAutoLevel })?),
        ),
        (key(unsafe { AVVideoAllowFrameReorderingKey })?, any(NSNumber::new_bool(false))),
    ]);
    Ok(dict(&[
        (key(unsafe { AVVideoCodecKey })?, text(key(unsafe { AVVideoCodecTypeH264 })?)),
        (key(unsafe { AVVideoWidthKey })?, num(s.width as i64)),
        (key(unsafe { AVVideoHeightKey })?, num(s.height as i64)),
        (key(unsafe { AVVideoCompressionPropertiesKey })?, any(compression)),
    ]))
}

/// An AVFAudio settings key: its constant from the loaded frameworks (it moved
/// between frameworks over the years), else the name it has always had.
fn audio_key(name: &'static std::ffi::CStr) -> Retained<NSString> {
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
    match ffi::constant(RTLD_DEFAULT, name) {
        Some(k) => NSString::from_str(&unsafe { &*(k as *const AnyObject).cast::<NSString>() }.to_string()),
        None => NSString::from_str(name.to_str().unwrap_or_default()),
    }
}

fn sound_settings() -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys = [
        audio_key(c"AVFormatIDKey"),
        audio_key(c"AVSampleRateKey"),
        audio_key(c"AVNumberOfChannelsKey"),
        audio_key(c"AVEncoderBitRateKey"),
    ];
    dict(&[
        (&keys[0], num(FORMAT_AAC as i64)),
        (&keys[1], num(RATE as i64)),
        (&keys[2], num(CHANNELS as i64)),
        (&keys[3], num(AAC_BITRATE)),
    ])
}

/// The format of the 16-bit stereo the mixer gives.
fn pcm_format() -> Option<CFRetained<CMFormatDescription>> {
    let bytes = (CHANNELS * 2) as u32;
    let mut basic = AudioStreamBasicDescription {
        mSampleRate: RATE as f64,
        mFormatID: pcm::LINEAR_PCM,
        mFormatFlags: SIGNED_PACKED,
        mBytesPerPacket: bytes,
        mFramesPerPacket: 1,
        mBytesPerFrame: bytes,
        mChannelsPerFrame: CHANNELS as u32,
        mBitsPerChannel: 16,
        mReserved: 0,
    };
    let mut out: *const CMFormatDescription = null();
    let status = unsafe {
        CMAudioFormatDescriptionCreate(
            None,
            NonNull::from(&mut basic),
            0,
            null(),
            0,
            null(),
            None,
            NonNull::from(&mut out),
        )
    };
    if status != 0 {
        return None;
    }
    NonNull::new(out as *mut CMFormatDescription).map(|p| unsafe { CFRetained::from_raw(p) })
}

/// Why the writer stopped: a full disk says so.
pub(super) fn failure(e: Option<Retained<NSError>>) -> crate::proto::Fail {
    match e {
        Some(e) if e.code() == ERROR_DISK_FULL => crate::proto::Fail::new("disk_full", ffi::error_detail(&e).1),
        Some(e) => crate::proto::Fail::new("encoder_failed", ffi::error_detail(&e).1),
        None => crate::proto::Fail::code("encoder_failed"),
    }
}

/// The AAC inputs, and the format of the sound buffers they take.
pub(super) type SoundInputs = (Vec<Retained<AVAssetWriterInput>>, Option<CFRetained<CMFormatDescription>>);

/// AAC tracks taking the mixer's 16-bit stereo, added to `writer` (none when
/// `tracks` is 0), and the format their sound buffers are made with.
pub(super) fn sound_inputs(
    writer: &AVAssetWriter,
    tracks: usize,
    live: bool,
) -> Result<SoundInputs, crate::proto::Fail> {
    let mut sound = Vec::new();
    let format = if tracks > 0 { pcm_format() } else { None };
    if format.is_some() {
        let audio_type = unsafe { AVMediaTypeAudio }.ok_or(crate::proto::Fail::code("no_encoder"))?;
        let settings = sound_settings();
        for i in 0..tracks {
            let input = unsafe {
                AVAssetWriterInput::initWithMediaType_outputSettings(AVAssetWriterInput::alloc(), audio_type, Some(&settings))
            };
            unsafe { input.setExpectsMediaDataInRealTime(live) };
            if i > 0 {
                // The mix plays; the tracks after it are for editing.
                let _: () = unsafe { msg_send![&*input, setMarksOutputTrackAsEnabled: false] };
            }
            if !unsafe { writer.canAddInput(&input) } {
                break;
            }
            unsafe { writer.addInput(&input) };
            sound.push(input);
        }
    }
    Ok((sound, format))
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

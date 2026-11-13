// macOS file writer: the picture and sound settings handed to the system's writer.

use std::ffi::c_void;
use std::ptr::{NonNull, null};
use objc2::{AllocAnyThread, Message, msg_send};
use objc2_av_foundation::{AVAssetWriter, AVAssetWriterInput, AVMediaTypeAudio, AVVideoAllowFrameReorderingKey, AVVideoAverageBitRateKey, AVVideoCodecKey, AVVideoCodecTypeH264, AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey, AVVideoHeightKey, AVVideoMaxKeyFrameIntervalKey, AVVideoProfileLevelH264HighAutoLevel, AVVideoProfileLevelKey, AVVideoWidthKey};
use objc2_core_audio_types::AudioStreamBasicDescription;
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMAudioFormatDescriptionCreate, CMFormatDescription};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use crate::pcm;
use crate::audio::{CHANNELS, RATE};
use super::{AAC_BITRATE, ERROR_DISK_FULL, FORMAT_AAC, Shape, SIGNED_PACKED};
use super::super::ffi;

fn key(k: Option<&'static NSString>) -> Result<&'static NSString, crate::proto::Fail> {
    k.ok_or(crate::proto::Fail::code("no_encoder"))
}

/// Any object as a dictionary value.
pub(in super::super) fn any<T: Message>(object: Retained<T>) -> Retained<AnyObject> {
    unsafe { Retained::cast_unchecked(object) }
}

pub(in super::super) fn num(n: i64) -> Retained<AnyObject> {
    any(NSNumber::new_i64(n))
}

/// A string constant's text as a new string (a key compares by its text).
fn text(k: &NSString) -> Retained<AnyObject> {
    any(NSString::from_str(&k.to_string()))
}

pub(in super::super) fn dict(pairs: &[(&NSString, Retained<AnyObject>)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: Vec<&NSString> = pairs.iter().map(|p| p.0).collect();
    let values: Vec<Retained<AnyObject>> = pairs.iter().map(|p| p.1.clone()).collect();
    NSDictionary::from_retained_objects(&keys, &values)
}

pub(in super::super) fn video_settings(s: &Shape) -> Result<Retained<NSDictionary<NSString, AnyObject>>, crate::proto::Fail> {
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
pub(in super::super) fn failure(e: Option<Retained<NSError>>) -> crate::proto::Fail {
    match e {
        Some(e) if e.code() == ERROR_DISK_FULL => crate::proto::Fail::new("disk_full", ffi::error_detail(&e).1),
        Some(e) => crate::proto::Fail::new("encoder_failed", ffi::error_detail(&e).1),
        None => crate::proto::Fail::code("encoder_failed"),
    }
}

/// The AAC inputs, and the format of the sound buffers they take.
pub(in super::super) type SoundInputs = (Vec<Retained<AVAssetWriterInput>>, Option<CFRetained<CMFormatDescription>>);

/// AAC tracks taking the mixer's 16-bit stereo, added to `writer` (none when
/// `tracks` is 0), and the format their sound buffers are made with.
pub(in super::super) fn sound_inputs(
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

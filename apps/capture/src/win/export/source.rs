// Windows export: opening the saved video and reading its size, length and sound.

use windows::core::{Error, HSTRING, Result};
use windows::Win32::Media::MediaFoundation::{IMFMediaType, IMFSourceReader, MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_SUBTYPE, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_YUV_MATRIX, MF_PD_DURATION, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, MF_SOURCE_READER_MEDIASOURCE, MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Audio, MFMediaType_Video, MFNominalRange_0_255, MFVideoArea, MFVideoFormat_NV12, MFVideoTransferMatrix_BT601};
use windows::Win32::System::Variant::VT_UI8;
use crate::reframe::{Crop, Yuv};
use super::{AUDIO_BPS, MAX_STREAMS};
use super::super::edit::TICKS;
use super::super::record::encoder::attributes;

/// A saved video opened for decoding to NV12 (what the decoder gives and
/// the encoder takes: no colour conversion either way).
pub(super) struct Source {
    pub(super) reader: IMFSourceReader,
    /// The reader's index of the (first) video stream.
    pub(super) video: u32,
    /// The decoded frame, and the part of it that is picture (no padding rows).
    pub(super) frame: (u32, u32),
    pub(super) visible: Crop,
    pub(super) fps: u32,
    pub(super) seconds: f64,
    pub(super) yuv: Yuv,
    /// The first sound track: reader stream, stored type, bits per second.
    pub(super) audio: Option<(u32, IMFMediaType, u32)>,
}

pub(super) fn open(src: &str, with_audio: bool) -> Result<Source> {
    unsafe {
        let attrs = attributes(1)?;
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(src), &attrs)?;
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        let video = first_stream(&reader, &MFMediaType_Video).ok_or_else(Error::empty)?;
        reader.SetStreamSelection(video, true)?;
        let native = reader.GetNativeMediaType(video, 0)?;
        let rate = native.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or(30 << 32 | 1);
        let fps = ((rate >> 32) as f64 / (rate as u32).max(1) as f64).round();
        let want = MFCreateMediaType()?;
        want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        reader.SetCurrentMediaType(video, None, &want)?;
        let current = reader.GetCurrentMediaType(video)?;
        let size = current.GetUINT64(&MF_MT_FRAME_SIZE)?;
        let frame = ((size >> 32) as u32, size as u32);
        let visible = aperture(&current)
            .or_else(|| aperture(&native))
            .filter(|c| c.x + c.w <= frame.0 && c.y + c.h <= frame.1)
            .unwrap_or(Crop::whole(frame.0, frame.1));
        let audio = if with_audio {
            first_audio(&reader)
        } else {
            None
        };
        Ok(Source {
            seconds: duration(&reader),
            reader,
            video,
            frame,
            visible,
            fps: fps.clamp(1.0, 240.0) as u32,
            yuv: Yuv {
                bt601: native.GetUINT32(&MF_MT_YUV_MATRIX).ok()
                    == Some(MFVideoTransferMatrix_BT601.0 as u32),
                full: native.GetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE).ok()
                    == Some(MFNominalRange_0_255.0 as u32),
            },
            audio,
        })
    }
}

/// The picture inside a decoded frame (H.264 codes 1080 rows as 1088).
fn aperture(t: &IMFMediaType) -> Option<Crop> {
    let mut area: MFVideoArea = unsafe { std::mem::zeroed() };
    let buf = unsafe {
        std::slice::from_raw_parts_mut(
            (&mut area as *mut MFVideoArea).cast::<u8>(),
            std::mem::size_of::<MFVideoArea>(),
        )
    };
    unsafe { t.GetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, buf, None).ok()? };
    let (w, h) = (area.Area.cx.max(0) as u32, area.Area.cy.max(0) as u32);
    (w >= 2 && h >= 2).then_some(Crop {
        x: area.OffsetX.value.max(0) as u32,
        y: area.OffsetY.value.max(0) as u32,
        w,
        h,
    })
}

fn duration(reader: &IMFSourceReader) -> f64 {
    unsafe {
        let Ok(pv) =
            reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
        else {
            return 0.0;
        };
        let v = &pv.Anonymous.Anonymous;
        if v.vt == VT_UI8 {
            v.Anonymous.uhVal as f64 / TICKS
        } else {
            0.0
        }
    }
}

/// The reader's index of the first stream of `major` (audio or video).
fn first_stream(reader: &IMFSourceReader, major: &windows::core::GUID) -> Option<u32> {
    (0..MAX_STREAMS).find_map(|i| {
        let t = unsafe { reader.GetNativeMediaType(i, 0) }.ok()?;
        (unsafe { t.GetGUID(&MF_MT_MAJOR_TYPE) }.ok()? == *major).then_some(i)
    })
}

/// The first sound track, read as stored (Xenon's mix comes first).
fn first_audio(reader: &IMFSourceReader) -> Option<(u32, IMFMediaType, u32)> {
    let i = first_stream(reader, &MFMediaType_Audio)?;
    let t = unsafe { reader.GetNativeMediaType(i, 0) }.ok()?;
    unsafe {
        reader.SetStreamSelection(i, true).ok()?;
        reader.SetCurrentMediaType(i, None, &t).ok()?;
    }
    let bps = unsafe { t.GetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND) }
        .map_or(AUDIO_BPS, |b| b.saturating_mul(8));
    Some((i, t, bps))
}

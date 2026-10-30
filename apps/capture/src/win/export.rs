//! The gallery's exports of a saved video (crate::reframe plans them): a
//! vertical 9:16 copy (with the recording's webcam on top when asked), a copy
//! that fits in a number of megabytes, and a GIF.
//! Frames are decoded to NV12, cropped and scaled on the CPU and encoded again
//! (H.264, on the GPU's encoder when it takes system memory, Windows' own
//! otherwise); the first sound track, the mix, is copied as stored. The server
//! runs one export at a time; `export_cancel` stops it between two frames and
//! leaves no file behind.

use std::mem::ManuallyDrop;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use windows::core::{w, Error, Interface, Result, HSTRING, PCWSTR};
use windows::Win32::Foundation::GENERIC_WRITE;
use windows::Win32::Graphics::Imaging::{
    GUID_ContainerFormatGif, GUID_WICPixelFormat32bppBGR, GUID_WICPixelFormat8bppIndexed,
    IWICBitmapEncoder, IWICImagingFactory, IWICMetadataQueryWriter, IWICStream,
    WICBitmapDitherTypeErrorDiffusion, WICBitmapEncoderNoCache, WICBitmapPaletteTypeCustom,
};
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, eAVEncH264VProfile_High, CODECAPI_AVEncCommonMeanBitRate,
    CODECAPI_AVEncCommonRateControlMode, IMF2DBuffer, IMFMediaType, IMFSample, IMFSinkWriter,
    IMFSourceReader, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFMediaType_Audio, MFMediaType_Video,
    MFNominalRange_0_255, MFTranscodeContainerType_MPEG4, MFVideoArea, MFVideoFormat_H264,
    MFVideoFormat_NV12, MFVideoTransferMatrix_BT601, MF_MT_ALL_SAMPLES_INDEPENDENT,
    MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_MPEG2_PROFILE,
    MF_MT_SUBTYPE, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_YUV_MATRIX, MF_PD_DURATION,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_DISABLE_THROTTLING,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR, MF_SOURCE_READER_ALL_STREAMS,
    MF_SOURCE_READER_ANY_STREAM, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
    MF_SOURCE_READER_MEDIASOURCE, MF_TRANSCODE_CONTAINERTYPE,
};
use windows::Win32::System::Com::StructuredStorage::{CAUB, PROPVARIANT};
use windows::Win32::System::Variant::{VARENUM, VT_UI1, VT_UI2, VT_UI8, VT_VECTOR};

use super::edit::{factory, spawn, text, Jobs, TICKS};
use super::record::encoder::{attributes, tag_bt709, video_type};
use crate::bubble::{self, Corner};
use crate::proto::{Fail, Notify};
use crate::reframe::{self, Crop, Focus, Pace, Resampler, Yuv};

/// Asked to stop: the running export ends at its next frame.
static CANCEL: AtomicBool = AtomicBool::new(false);
/// A GIF past this many bytes stops: no chat or page takes one that big.
const GIF_MAX_BYTES: u64 = 256 * 1_000_000;
/// Tries at a copy that must fit, each with less bitrate than the last.
const FIT_TRIES: u32 = 3;
/// The sound's bitrate when the file does not say (what Xenon records).
const AUDIO_BPS: u32 = 192_000;
/// Progress events at most every this much of the clip.
const PROGRESS_STEP: f64 = 0.03;
/// The sizes a copy may be asked to fit in, in megabytes (1 000 000 bytes:
/// apps that count in MiB still take it).
const FIT_MB_MAX: u64 = 4000;
/// Streams looked at in a file (Xenon writes at most four).
const MAX_STREAMS: u32 = 16;

#[derive(Clone, Copy)]
enum Kind {
    /// The part kept, and the corner of the webcam bubble to put on top.
    Vertical(Focus, Option<Corner>),
    Fit(u64),
    Gif,
}

/// Why an export stopped; anything Windows refused is `Failed`.
enum Stop {
    Cancelled,
    TooBig,
    TooLong,
    Failed,
}

impl From<Error> for Stop {
    fn from(_: Error) -> Stop {
        Stop::Failed
    }
}

impl Stop {
    fn code(&self) -> &'static str {
        match self {
            Stop::Cancelled => "cancelled",
            Stop::TooBig => "too_big",
            Stop::TooLong => "too_long",
            Stop::Failed => "export_failed",
        }
    }
}

type Out<T> = std::result::Result<T, Stop>;

/// A saved video opened for decoding to NV12 (what the decoder gives and
/// the encoder takes: no colour conversion either way).
struct Source {
    reader: IMFSourceReader,
    /// The reader's index of the (first) video stream.
    video: u32,
    /// The decoded frame, and the part of it that is picture (no padding rows).
    frame: (u32, u32),
    visible: Crop,
    fps: u32,
    seconds: f64,
    yuv: Yuv,
    /// The first sound track: reader stream, stored type, bits per second.
    audio: Option<(u32, IMFMediaType, u32)>,
}

fn open(src: &str, with_audio: bool) -> Result<Source> {
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

/// What one encode makes: the parts of the source stacked top to bottom,
/// each with the size it is written at (all as wide as the copy), the copy's
/// size, frames per second and video bits per second.
struct Plan {
    parts: Vec<(Crop, (u32, u32))>,
    size: (u32, u32),
    fps: u32,
    bps: u32,
}

fn sink(out: &str, hardware: bool) -> Result<IMFSinkWriter> {
    let attrs = attributes(3)?;
    unsafe {
        attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)?;
        attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, hardware as u32)?;
        MFCreateSinkWriterFromURL(&HSTRING::from(out), None, &attrs)
    }
}

/// The source's colour tags on a type, so the copy plays in the same colours.
fn tag_like(t: &IMFMediaType, yuv: Yuv) -> Result<()> {
    tag_bt709(t)?;
    unsafe {
        if yuv.bt601 {
            t.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601.0 as u32)?;
        }
        if yuv.full {
            t.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_0_255.0 as u32)?;
        }
    }
    Ok(())
}

/// The H.264 stream, fed tight NV12 frames.
fn add_video(writer: &IMFSinkWriter, plan: &Plan, yuv: Yuv) -> Result<u32> {
    let (w, h) = plan.size;
    let out = video_type(&MFVideoFormat_H264, w, h, plan.fps)?;
    unsafe {
        out.SetUINT32(&MF_MT_AVG_BITRATE, plan.bps)?;
        out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
    }
    tag_like(&out, yuv)?;
    let stream = unsafe { writer.AddStream(&out)? };
    let input = video_type(&MFVideoFormat_NV12, w, h, plan.fps)?;
    unsafe {
        input.SetUINT32(&MF_MT_DEFAULT_STRIDE, w)?;
        input.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
    }
    tag_like(&input, yuv)?;
    // The GPU encoders ignore the type's bitrate (about twice the size asked
    // for); the encoder's own settings hold them to it.
    let rate = attributes(2)?;
    unsafe {
        rate.SetUINT32(
            &CODECAPI_AVEncCommonRateControlMode,
            eAVEncCommonRateControlMode_CBR.0 as u32,
        )?;
        rate.SetUINT32(&CODECAPI_AVEncCommonMeanBitRate, plan.bps)?;
        writer.SetInputMediaType(stream, &input, &rate)?;
    }
    Ok(stream)
}

/// Crops and scales NV12 frames: per part, the luma plane and the paired
/// chroma plane at half the size each way. Parts of the same width stacked
/// are one tight NV12 frame: their rows follow each other in both planes.
struct Scaler {
    parts: Vec<(Resampler, Resampler)>,
    /// The decoded frame (with any padding rows): where the chroma plane starts.
    frame: (u32, u32),
}

impl Scaler {
    fn new(frame: (u32, u32), parts: &[(Crop, (u32, u32))]) -> Scaler {
        let parts = parts
            .iter()
            .map(|&(crop, (w, h))| {
                let half = Crop {
                    x: crop.x / 2,
                    y: crop.y / 2,
                    w: (crop.w / 2).max(1),
                    h: (crop.h / 2).max(1),
                };
                (
                    Resampler::new(1, crop, (w, h)),
                    Resampler::new(2, half, (w / 2, h / 2)),
                )
            })
            .collect();
        Scaler { parts, frame }
    }

    fn luma_len(&self) -> usize {
        self.parts.iter().map(|p| p.0.len()).sum()
    }

    fn len(&self) -> usize {
        self.luma_len() + self.parts.iter().map(|p| p.1.len()).sum::<usize>()
    }

    /// Every part from the planes (`stride` bytes a row) into `out`.
    fn planes(&self, luma: &[u8], chroma: &[u8], stride: usize, out: &mut [u8]) {
        let (mut y, mut uv) = out.split_at_mut(self.luma_len());
        for (l, c) in &self.parts {
            let (this, rest) = std::mem::take(&mut y).split_at_mut(l.len());
            l.run(luma, stride, this);
            y = rest;
            let (this, rest) = std::mem::take(&mut uv).split_at_mut(c.len());
            c.run(chroma, stride, this);
            uv = rest;
        }
    }

    /// One decoded sample into `out` (`len()` bytes, tight NV12).
    fn run(&self, sample: &IMFSample, out: &mut [u8]) -> Result<()> {
        let (w, h) = (self.frame.0 as usize, self.frame.1 as usize);
        unsafe {
            let buffer = sample.ConvertToContiguousBuffer()?;
            if let Ok(b2) = buffer.cast::<IMF2DBuffer>() {
                let (mut line, mut pitch) = (std::ptr::null_mut(), 0i32);
                b2.Lock2D(&mut line, &mut pitch)?;
                let ok = pitch as usize >= w;
                if ok {
                    let p = pitch as usize;
                    let rows = luma_rows(buffer.GetCurrentLength()? as usize, p, h);
                    let all = std::slice::from_raw_parts(line, p * rows + p * rows.div_ceil(2));
                    self.planes(&all[..p * rows], &all[p * rows..], p, out);
                }
                b2.Unlock2D()?;
                return if ok { Ok(()) } else { Err(Error::empty()) };
            }
            let (mut data, mut len) = (std::ptr::null_mut(), 0u32);
            buffer.Lock(&mut data, None, Some(&mut len))?;
            let all = std::slice::from_raw_parts(data, len as usize);
            let split = (w * luma_rows(all.len(), w, h)).min(all.len());
            self.planes(&all[..split], &all[split..], w, out);
            buffer.Unlock()
        }
    }
}

/// The rows of the luma plane in a decoded NV12 buffer of `len` bytes: the
/// decoder pads the picture to its blocks (1080 is stored as 1088), and the
/// chroma plane starts after the padding, not after the visible rows.
fn luma_rows(len: usize, stride: usize, visible: usize) -> usize {
    (len / stride.max(1) * 2 / 3).max(visible)
}

fn write_frame(writer: &IMFSinkWriter, stream: u32, px: &[u8], at: i64, length: i64) -> Result<()> {
    unsafe {
        let buffer = MFCreateMemoryBuffer(px.len() as u32)?;
        let mut data = std::ptr::null_mut();
        buffer.Lock(&mut data, None, None)?;
        std::ptr::copy_nonoverlapping(px.as_ptr(), data, px.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(px.len() as u32)?;
        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(at)?;
        sample.SetSampleDuration(length)?;
        writer.WriteSample(stream, &sample)
    }
}

/// One read of the source: the reader stream, the sample if any, and whether
/// that stream ended. A read error stops the export.
fn read(reader: &IMFSourceReader, stream: u32) -> Out<(u32, Option<IMFSample>, bool)> {
    if CANCEL.load(Ordering::SeqCst) {
        return Err(Stop::Cancelled);
    }
    let (mut index, mut flags, mut sample) = (0u32, 0u32, None);
    unsafe {
        reader.ReadSample(
            stream,
            0,
            Some(&mut index),
            Some(&mut flags),
            None,
            Some(&mut sample),
        )?;
    }
    if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
        return Err(Stop::Failed);
    }
    Ok((
        index,
        sample,
        flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0,
    ))
}

/// Decodes `src`, crops and scales each kept frame and writes an MP4 to `out`.
fn transcode(
    src: &str,
    out: &str,
    plan: &Plan,
    hardware: bool,
    progress: &mut dyn FnMut(f64),
) -> Out<()> {
    let s = open(src, true)?;
    let writer = sink(out, hardware)?;
    let video = add_video(&writer, plan, s.yuv)?;
    let sound = match &s.audio {
        Some((i, t, _)) => unsafe {
            let a = writer.AddStream(t)?;
            writer.SetInputMediaType(a, t, None)?;
            Some((*i, a))
        },
        None => None,
    };
    unsafe { writer.BeginWriting()? };
    let scaler = Scaler::new(s.frame, &plan.parts);
    let mut nv12 = vec![0u8; scaler.len()];
    let mut pace = Pace::every(plan.fps);
    let length = (TICKS / plan.fps as f64) as i64;
    let total = (s.seconds * TICKS).max(1.0);
    // Every stream is moved so the copy starts at 0 with the first sample.
    let mut base: Option<i64> = None;
    let (mut video_done, mut sound_done) = (false, sound.is_none());
    while !(video_done && sound_done) {
        let (index, sample, ended) = read(&s.reader, MF_SOURCE_READER_ANY_STREAM.0 as u32)?;
        if index == s.video {
            if let Some(sample) = sample {
                let t = unsafe { sample.GetSampleTime()? };
                let t = t - *base.get_or_insert(t);
                if t >= 0 && pace.take(t) {
                    scaler.run(&sample, &mut nv12)?;
                    write_frame(&writer, video, &nv12, t, length)?;
                    progress(t as f64 / total);
                }
            }
            video_done |= ended;
        } else if let Some((_, a)) = sound.filter(|(i, _)| *i == index) {
            if let Some(sample) = sample {
                let t = unsafe { sample.GetSampleTime()? };
                let t = t - *base.get_or_insert(t);
                if t >= 0 {
                    unsafe {
                        sample.SetSampleTime(t)?;
                        writer.WriteSample(a, &sample)?;
                    }
                }
            }
            sound_done |= ended;
        } else if ended {
            break;
        }
    }
    unsafe { writer.Finalize()? };
    Ok(())
}

/// An encode on the GPU's encoder, again on Windows' own when that fails.
fn encode(src: &str, part: &str, plan: &Plan, progress: &mut dyn FnMut(f64)) -> Out<()> {
    match transcode(src, part, plan, true, progress) {
        Err(Stop::Failed) => {
            let _ = std::fs::remove_file(part);
            transcode(src, part, plan, false, progress)
        }
        other => other,
    }
}

/// The plan's crop moved into the frame (it was planned on the visible part),
/// on even pixels: NV12 pairs every two pixels for colour.
fn within(visible: Crop, c: Crop) -> Crop {
    Crop {
        x: (visible.x + c.x) & !1,
        y: (visible.y + c.y) & !1,
        w: c.w & !1,
        h: c.h & !1,
    }
}

/// Encoders take even sizes only.
fn even((w, h): (u32, u32)) -> (u32, u32) {
    ((w & !1).max(2), (h & !1).max(2))
}

/// A 9:16 copy; with the corner of the recording's webcam, that bubble on
/// top and the game below.
fn vertical(
    src: &str,
    part: &str,
    focus: Focus,
    webcam: Option<Corner>,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let s = open(src, false)?;
    let (w, h) = (s.visible.w, s.visible.h);
    let parts = match webcam {
        Some(corner) => {
            let split = reframe::vertical_split(w, h, focus, bubble::place(w, h, corner));
            vec![split.cam, split.game]
        }
        None => vec![reframe::vertical(w, h, focus)],
    };
    let parts: Vec<_> = parts
        .into_iter()
        .map(|(crop, size)| (within(s.visible, crop), even(size)))
        .collect();
    let size = (parts[0].1 .0, parts.iter().map(|p| p.1 .1).sum());
    let fps = s.fps.min(60);
    let plan = Plan {
        parts,
        size,
        fps,
        bps: reframe::vertical_bitrate(size.0, size.1, fps),
    };
    drop(s);
    encode(src, part, &plan, progress)?;
    Ok(size)
}

fn fit(
    src: &str,
    part: &str,
    target: u64,
    seconds: f64,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let s = open(src, true)?;
    let length = if s.seconds > 0.0 { s.seconds } else { seconds };
    if !length.is_finite() || length <= 0.0 {
        return Err(Stop::Failed);
    }
    let sound = s.audio.as_ref().map_or(0, |a| a.2);
    let Some(f) = reframe::fit(
        (s.visible.w, s.visible.h),
        s.fps.min(60),
        length,
        target,
        sound,
    ) else {
        return Err(Stop::TooLong);
    };
    let mut plan = Plan {
        parts: vec![(
            within(s.visible, Crop::whole(s.visible.w, s.visible.h)),
            even((f.width, f.height)),
        )],
        size: even((f.width, f.height)),
        fps: f.fps,
        bps: f.video_bps,
    };
    drop(s);
    for _ in 0..FIT_TRIES {
        encode(src, part, &plan, progress)?;
        let written = std::fs::metadata(part).map_err(|_| Stop::Failed)?.len();
        if written <= target {
            return Ok(plan.size);
        }
        let _ = std::fs::remove_file(part);
        let less = reframe::retry_bitrate(plan.bps, target, written);
        if less >= plan.bps {
            break;
        }
        plan.bps = less;
    }
    Err(Stop::TooLong)
}

/// A looping GIF, written frame by frame with a palette of its own each.
struct Gif {
    wic: IWICImagingFactory,
    encoder: IWICBitmapEncoder,
    _stream: IWICStream,
}

fn put(meta: &IWICMetadataQueryWriter, name: PCWSTR, value: &PROPVARIANT) -> Result<()> {
    unsafe { meta.SetMetadataByName(name, value) }
}

/// A byte-vector value that borrows `data`: never dropped, since clearing it
/// would hand Rust's memory to CoTaskMemFree.
fn bytes_value(data: &mut [u8]) -> ManuallyDrop<PROPVARIANT> {
    let mut pv = ManuallyDrop::new(PROPVARIANT::default());
    unsafe {
        let v = &mut *pv.Anonymous.Anonymous;
        v.vt = VARENUM(VT_VECTOR.0 | VT_UI1.0);
        v.Anonymous.caub = CAUB {
            cElems: data.len() as u32,
            pElems: data.as_mut_ptr(),
        };
    }
    pv
}

impl Gif {
    fn create(out: &str) -> Result<Gif> {
        let wic = factory()?;
        unsafe {
            let stream = wic.CreateStream()?;
            stream.InitializeFromFilename(&HSTRING::from(out), GENERIC_WRITE.0)?;
            let encoder = wic.CreateEncoder(&GUID_ContainerFormatGif, std::ptr::null())?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
            // The NETSCAPE block: play again and again, as people expect a GIF to.
            let meta = encoder.GetMetadataQueryWriter()?;
            let mut app = *b"NETSCAPE2.0";
            put(&meta, w!("/appext/Application"), &bytes_value(&mut app))?;
            let mut forever = [3u8, 1, 0, 0, 0];
            put(&meta, w!("/appext/Data"), &bytes_value(&mut forever))?;
            Ok(Gif {
                wic,
                encoder,
                _stream: stream,
            })
        }
    }

    fn frame(&self, bgrx: &[u8], (w, h): (u32, u32)) -> Result<()> {
        unsafe {
            let bitmap =
                self.wic
                    .CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat32bppBGR, w * 4, bgrx)?;
            let palette = self.wic.CreatePalette()?;
            palette.InitializeFromBitmap(&bitmap, 256, false)?;
            let indexed = self.wic.CreateFormatConverter()?;
            indexed.Initialize(
                &bitmap,
                &GUID_WICPixelFormat8bppIndexed,
                WICBitmapDitherTypeErrorDiffusion,
                &palette,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let (mut frame, mut props) = (None, None);
            self.encoder.CreateNewFrame(&mut frame, &mut props)?;
            let frame = frame.ok_or_else(Error::empty)?;
            frame.Initialize(props.as_ref())?;
            frame.SetSize(w, h)?;
            let mut format = GUID_WICPixelFormat8bppIndexed;
            frame.SetPixelFormat(&mut format)?;
            frame.SetPalette(&palette)?;
            let mut delay = PROPVARIANT::default();
            let v = &mut *delay.Anonymous.Anonymous;
            v.vt = VT_UI2;
            v.Anonymous.uiVal = reframe::GIF_DELAY_CS;
            put(
                &frame.GetMetadataQueryWriter()?,
                w!("/grctlext/Delay"),
                &delay,
            )?;
            frame.WriteSource(&indexed, std::ptr::null())?;
            frame.Commit()
        }
    }

    fn finish(self) -> Result<()> {
        unsafe { self.encoder.Commit() }
    }
}

fn gif(src: &str, part: &str, progress: &mut dyn FnMut(f64)) -> Out<(u32, u32)> {
    let s = open(src, false)?;
    let size = even(reframe::gif_size(s.visible.w, s.visible.h));
    let scaler = Scaler::new(
        s.frame,
        &[(
            within(s.visible, Crop::whole(s.visible.w, s.visible.h)),
            size,
        )],
    );
    let mut nv12 = vec![0u8; scaler.len()];
    let luma = (size.0 * size.1) as usize;
    let out = Gif::create(part)?;
    let mut pace = Pace::new(reframe::GIF_DELAY_CS as i64 * 100_000);
    let total = (s.seconds * TICKS).max(1.0);
    let mut base: Option<i64> = None;
    let mut frames = 0u32;
    loop {
        let (_, sample, ended) = read(&s.reader, s.video)?;
        if let Some(sample) = sample {
            let t = unsafe { sample.GetSampleTime()? };
            let t = t - *base.get_or_insert(t);
            if t >= 0 && pace.take(t) {
                scaler.run(&sample, &mut nv12)?;
                let (y, uv) = nv12.split_at(luma);
                out.frame(&reframe::nv12_to_bgrx(y, uv, size, s.yuv), size)?;
                frames += 1;
                progress(t as f64 / total);
                if frames.is_multiple_of(25)
                    && std::fs::metadata(part).map_or(0, |m| m.len()) > GIF_MAX_BYTES
                {
                    return Err(Stop::TooBig);
                }
            }
        }
        if ended {
            break;
        }
    }
    if frames == 0 {
        return Err(Stop::Failed);
    }
    out.finish()?;
    Ok(size)
}

fn run(src: &str, out: &str, kind: Kind, seconds: f64, progress: &mut dyn FnMut(f64)) -> Value {
    let part = format!("{out}.part");
    let made = match kind {
        Kind::Vertical(focus, webcam) => vertical(src, &part, focus, webcam, progress),
        Kind::Fit(target) => fit(src, &part, target, seconds, progress),
        Kind::Gif => gif(src, &part, progress),
    };
    let (w, h) = match made {
        Ok(size) => size,
        Err(stop) => {
            let _ = std::fs::remove_file(&part);
            return json!({ "error": stop.code() });
        }
    };
    let settled = match kind {
        Kind::Gif => std::fs::rename(&part, out).map_err(|_| {
            let _ = std::fs::remove_file(&part);
            "write_failed"
        }),
        _ => crate::faststart::settle(Path::new(&part), Path::new(out)).map_err(|(code, _)| code),
    };
    match settled {
        Ok(()) => {
            let bytes = std::fs::metadata(out).map_or(0, |m| m.len());
            json!({ "width": w, "height": h, "bytes": bytes })
        }
        Err(code) => json!({ "error": code }),
    }
}

/// `{ src, out, kind, focus?, mb?, seconds?, token }`: `kind` "vertical"
/// (`focus` left|center|right), "fit" (`mb` megabytes, `seconds` the clip's
/// length when the file does not say) or "gif". Events: `export_progress`
/// `{ token, pct }` while it works, then `export_done` with `width`, `height`
/// and `bytes`, or `error` (cancelled, too_long, too_big, export_failed,
/// disk_full, write_failed).
pub fn start_export(req: &Value, notify: Notify, jobs: &Jobs) -> std::result::Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let kind = match req.get("kind").and_then(Value::as_str) {
        Some("vertical") => Kind::Vertical(
            Focus::parse(req.get("focus").and_then(Value::as_str)),
            Corner::parse(req.get("webcam").and_then(Value::as_str)),
        ),
        Some("fit") => {
            let mb = req
                .get("mb")
                .and_then(Value::as_u64)
                .filter(|m| (1..=FIT_MB_MAX).contains(m))
                .ok_or_else(|| Fail::code("bad_request"))?;
            Kind::Fit(mb * 1_000_000)
        }
        Some("gif") => Kind::Gif,
        _ => return Err(Fail::code("bad_request")),
    };
    let seconds = req
        .get("seconds")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(0.0);
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    CANCEL.store(false, Ordering::SeqCst);
    let (tell, tag) = (notify.clone(), token.clone());
    let mut last = -1.0f64;
    let mut progress = move |f: f64| {
        let f = f.clamp(0.0, 1.0);
        if f - last >= PROGRESS_STEP {
            last = f;
            tell(json!({ "event": "export_progress", "token": tag, "pct": (f * 100.0).round() }));
        }
    };
    spawn(jobs, notify, "export_done", token, move || {
        run(&src, &out, kind, seconds, &mut progress)
    })
}

/// Stops the running export at its next frame; nothing running is fine.
pub fn cancel_export() -> Value {
    CANCEL.store(true, Ordering::SeqCst);
    json!({ "cancelled": true })
}

#[cfg(test)]
mod tests {
    use super::luma_rows;

    #[test]
    fn the_chroma_plane_starts_after_the_decoders_padding_rows() {
        // 1080p stored as 1088 rows, 1620 as 1632, 2160 as itself.
        assert_eq!(luma_rows(1920 * 1088 * 3 / 2, 1920, 1080), 1088);
        assert_eq!(luma_rows(2880 * 1632 * 3 / 2, 2880, 1620), 1632);
        assert_eq!(luma_rows(3840 * 2160 * 3 / 2, 3840, 2160), 2160);
        // A short buffer never moves the plane above the visible rows.
        assert_eq!(luma_rows(10, 1920, 1080), 1080);
        assert_eq!(luma_rows(100, 0, 4), 66);
    }
}

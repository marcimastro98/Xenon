// Windows export: writing the copy, frame by frame, at the new size and bitrate.

use std::sync::atomic::Ordering;
use windows::core::{Error, HSTRING, Interface, Result};
use windows::Win32::Media::MediaFoundation::{CODECAPI_AVEncCommonMeanBitRate, CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR, eAVEncH264VProfile_High, IMF2DBuffer, IMFMediaType, IMFSample, IMFSinkWriter, IMFSourceReader, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_MPEG2_PROFILE, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_YUV_MATRIX, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_DISABLE_THROTTLING, MF_SOURCE_READER_ANY_STREAM, MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READERF_ERROR, MF_TRANSCODE_CONTAINERTYPE, MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL, MFNominalRange_0_255, MFTranscodeContainerType_MPEG4, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoTransferMatrix_BT601};
use crate::reframe::{Crop, Pace, Resampler, Yuv};
use super::{CANCEL, Out, Stop};
use super::source::open;
use super::super::edit::TICKS;
use super::super::record::encoder::{attributes, tag_bt709, video_type};

/// What one encode makes: the parts of the source stacked top to bottom,
/// each with the size it is written at (all as wide as the copy), the copy's
/// size, frames per second and video bits per second.
pub(super) struct Plan {
    pub(super) parts: Vec<(Crop, (u32, u32))>,
    pub(super) size: (u32, u32),
    pub(super) fps: u32,
    pub(super) bps: u32,
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
pub(super) struct Scaler {
    pub(super) parts: Vec<(Resampler, Resampler)>,
    /// The decoded frame (with any padding rows): where the chroma plane starts.
    pub(super) frame: (u32, u32),
}

impl Scaler {
    pub(super) fn new(frame: (u32, u32), parts: &[(Crop, (u32, u32))]) -> Scaler {
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

    pub(super) fn len(&self) -> usize {
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
    pub(super) fn run(&self, sample: &IMFSample, out: &mut [u8]) -> Result<()> {
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
pub(super) fn luma_rows(len: usize, stride: usize, visible: usize) -> usize {
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
pub(super) fn read(reader: &IMFSourceReader, stream: u32) -> Out<(u32, Option<IMFSample>, bool)> {
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
pub(super) fn encode(src: &str, part: &str, plan: &Plan, progress: &mut dyn FnMut(f64)) -> Out<()> {
    match transcode(src, part, plan, true, progress) {
        Err(Stop::Failed) => {
            let _ = std::fs::remove_file(part);
            transcode(src, part, plan, false, progress)
        }
        other => other,
    }
}

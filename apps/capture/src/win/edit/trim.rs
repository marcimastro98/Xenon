// Windows: cutting a saved video to a start and an end without encoding it again.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use serde_json::Value;
use windows::core::{Error, HSTRING, Result};
use windows::Win32::Media::MediaFoundation::{IMFSinkWriter, IMFSourceReader, MF_ACCESSMODE_WRITE, MF_FILEFLAGS_NONE, MF_MT_MAJOR_TYPE, MF_OPENMODE_DELETE_IF_EXIST, MF_SINK_WRITER_DISABLE_THROTTLING, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_ANY_STREAM, MF_SOURCE_READERF_ENDOFSTREAM, MF_TRANSCODE_CONTAINERTYPE, MFCreateAttributes, MFCreateFile, MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFMediaType_Audio, MFMediaType_Video, MFSampleExtension_CleanPoint, MFTranscodeContainerType_MPEG4};
use crate::proto::Fail;
use super::{SCAN_BACK, seek, TICKS, Trimmed, VIDEO};

/// Copies `src` from the keyframe at or before `start` to `end` (seconds;
/// `end` past the end = to the end) into `out`, every stream as it is stored.
pub fn trim(src: &str, out: &str, start: f64, end: f64) -> Result<Trimmed> {
    let from = (start.max(0.0) * TICKS) as i64;
    let to = (end * TICKS) as i64;
    let key = keyframe_before(src, from)?;
    let reader = open_all(src)?;
    let writer = sink(out)?;
    // The reader's streams, the ones copied, and the writer's stream for each.
    let mut streams: Vec<(u32, u32)> = Vec::new();
    for i in 0.. {
        let Ok(native) = (unsafe { reader.GetNativeMediaType(i, 0) }) else {
            break;
        };
        let major = unsafe { native.GetGUID(&MF_MT_MAJOR_TYPE)? };
        if major != MFMediaType_Video && major != MFMediaType_Audio {
            continue;
        }
        unsafe {
            reader.SetStreamSelection(i, true)?;
            reader.SetCurrentMediaType(i, None, &native)?;
            let s = writer.AddStream(&native)?;
            writer.SetInputMediaType(s, &native, None)?;
            streams.push((i, s));
        }
    }
    if streams.is_empty() {
        return Err(Error::empty());
    }
    unsafe { writer.BeginWriting()? };
    seek(&reader, key);
    let mut done = vec![false; streams.len()];
    let mut last_end = 0i64;
    while done.iter().any(|d| !d) {
        let mut index = 0u32;
        let mut flags = 0u32;
        let mut sample = None;
        unsafe {
            reader.ReadSample(
                MF_SOURCE_READER_ANY_STREAM.0 as u32,
                0,
                Some(&mut index),
                Some(&mut flags),
                None,
                Some(&mut sample),
            )?;
        }
        let Some(k) = streams.iter().position(|(i, _)| *i == index) else {
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0
                && index == MF_SOURCE_READER_ANY_STREAM.0 as u32
            {
                break;
            }
            continue;
        };
        if let Some(s) = sample {
            let t = unsafe { s.GetSampleTime()? };
            if t >= to {
                done[k] = true;
            } else if t >= key && !done[k] {
                let d = unsafe { s.GetSampleDuration().unwrap_or(0) };
                unsafe {
                    s.SetSampleTime(t - key)?;
                    writer.WriteSample(streams[k].1, &s)?;
                }
                last_end = last_end.max(t - key + d);
            }
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            done[k] = true;
        }
    }
    unsafe { writer.Finalize()? };
    Ok(Trimmed {
        start: key as f64 / TICKS,
        seconds: last_end as f64 / TICKS,
    })
}

/// The time of the last video keyframe at or before `at` (0 when none).
fn keyframe_before(src: &str, at: i64) -> Result<i64> {
    let reader = unsafe { MFCreateSourceReaderFromURL(&HSTRING::from(src), None)? };
    unsafe {
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        reader.SetStreamSelection(VIDEO, true)?;
        let native = reader.GetNativeMediaType(VIDEO, 0)?;
        reader.SetCurrentMediaType(VIDEO, None, &native)?;
    }
    // A little before: the reader lands on a keyframe before what it is asked.
    seek(&reader, (at - SCAN_BACK).max(0));
    let mut key = 0i64;
    loop {
        let mut flags = 0u32;
        let mut sample = None;
        unsafe { reader.ReadSample(VIDEO, 0, None, Some(&mut flags), None, Some(&mut sample))? };
        if let Some(s) = sample {
            let t = unsafe { s.GetSampleTime()? };
            if t > at {
                break;
            }
            if unsafe { s.GetUINT32(&MFSampleExtension_CleanPoint) }.unwrap_or(0) != 0 {
                key = t;
            }
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }
    }
    Ok(key)
}

fn open_all(src: &str) -> Result<IMFSourceReader> {
    unsafe {
        let r = MFCreateSourceReaderFromURL(&HSTRING::from(src), None)?;
        r.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        Ok(r)
    }
}

fn sink(out: &str) -> Result<IMFSinkWriter> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 2)?;
        let attrs = attrs.ok_or_else(Error::empty)?;
        attrs.SetGUID(&MF_TRANSCODE_CONTAINERTYPE, &MFTranscodeContainerType_MPEG4)?;
        attrs.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        let file = MFCreateFile(
            MF_ACCESSMODE_WRITE,
            MF_OPENMODE_DELETE_IF_EXIST,
            MF_FILEFLAGS_NONE,
            &HSTRING::from(out),
        )?;
        MFCreateSinkWriterFromURL(None, &file, &attrs)
    }
}

/// Gallery jobs running now; while any runs the engine does not exit for idleness.
pub type Jobs = Arc<AtomicUsize>;

/// Preview widths the server may ask for.
pub(super) const THUMB_MIN: u64 = 64;
pub(super) const THUMB_MAX: u64 = 1280;

pub(in super::super) fn text(req: &Value, key: &str) -> std::result::Result<String, Fail> {
    match req.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_owned()),
        _ => Err(Fail::code("bad_request")),
    }
}

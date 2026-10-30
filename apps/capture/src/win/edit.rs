//! The gallery's work on files Xenon saved: a small JPEG preview of a picture
//! or a video, and a trimmed copy of a video. A trim copies the streams as
//! they are stored (no re-encoding: instant, no quality lost), so it starts
//! on the keyframe at or before the asked start (recordings have one every
//! second). Each job runs on a thread of its own; the caller answers with an
//! event when it is done.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use windows::core::{Error, Interface, Result, GUID, HSTRING};
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR,
    GUID_WICPixelFormat32bppBGR, IWICBitmapSource, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapEncoderNoCache, WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom,
    WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::Media::MediaFoundation::{
    IMF2DBuffer, IMFSample, IMFSinkWriter, IMFSourceReader, MFCreateAttributes, MFCreateFile,
    MFCreateMediaType, MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFMediaType_Audio,
    MFMediaType_Video, MFSampleExtension_CleanPoint, MFShutdown, MFStartup,
    MFTranscodeContainerType_MPEG4, MFVideoFormat_RGB32, MFSTARTUP_LITE, MF_ACCESSMODE_WRITE,
    MF_FILEFLAGS_NONE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
    MF_OPENMODE_DELETE_IF_EXIST, MF_SINK_WRITER_DISABLE_THROTTLING, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_ANY_STREAM,
    MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
    MF_TRANSCODE_CONTAINERTYPE, MF_VERSION,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Variant::VT_I8;

use crate::proto::{Fail, Notify};

const VIDEO: u32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
/// 100-ns units per second (Media Foundation time).
pub(super) const TICKS: f64 = 10_000_000.0;
/// Where a video's preview is taken: past a fade-in, inside the shortest clip.
const THUMB_AT_S: f64 = 1.0;
/// How far before the asked start the keyframe search begins (Xenon's
/// recordings have a keyframe every second).
const SCAN_BACK: i64 = 10 * TICKS as i64;
/// A copy shorter than this (a range past the last frame) is no clip.
const MIN_SECONDS: f64 = 0.25;

/// COM and Media Foundation for one job's thread, undone when it ends.
pub struct Worker;

impl Worker {
    pub fn start() -> Worker {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let _ = MFStartup(MF_VERSION, MFSTARTUP_LITE);
        }
        Worker
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

pub(super) fn factory() -> Result<IWICImagingFactory> {
    unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
}

/// A JPEG `width` pixels wide (never wider than the source) of the picture or
/// video at `src`. Answers the source's size.
pub fn thumb(src: &str, out: &str, width: u32, video: bool) -> Result<(u32, u32)> {
    let wic = factory()?;
    let (source, w, h) = if video {
        let (bgrx, w, h) = video_frame(src)?;
        let bitmap = unsafe {
            wic.CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat32bppBGR, w * 4, &bgrx)?
        };
        (bitmap.cast::<IWICBitmapSource>()?, w, h)
    } else {
        unsafe {
            let decoder = wic.CreateDecoderFromFilename(
                &HSTRING::from(src),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )?;
            let frame = decoder.GetFrame(0)?;
            let (mut w, mut h) = (0, 0);
            frame.GetSize(&mut w, &mut h)?;
            (frame.cast::<IWICBitmapSource>()?, w, h)
        }
    };
    if w == 0 || h == 0 {
        return Err(Error::empty());
    }
    let tw = width.clamp(16, w.max(16)).min(w);
    let th = ((h as u64 * tw as u64) / w as u64).max(1) as u32;
    write_jpeg(&wic, &source, tw, th, out)?;
    Ok((w, h))
}

/// A JPEG of a picture in memory (tight 24-bit BGR rows), scaled down to
/// `max_width` when wider. Answers the size written.
pub fn jpeg(bgr: &[u8], w: u32, h: u32, max_width: u32, out: &str) -> Result<(u32, u32)> {
    if w == 0 || h == 0 || bgr.len() < (w * h * 3) as usize {
        return Err(Error::empty());
    }
    let wic = factory()?;
    let bitmap =
        unsafe { wic.CreateBitmapFromMemory(w, h, &GUID_WICPixelFormat24bppBGR, w * 3, bgr)? };
    let source = bitmap.cast::<IWICBitmapSource>()?;
    let tw = w.min(max_width.max(16));
    let th = ((h as u64 * tw as u64) / w as u64).max(1) as u32;
    write_jpeg(&wic, &source, tw, th, out)?;
    Ok((tw, th))
}

/// Scales `source` to `tw` x `th` and writes it to `out` as a JPEG.
fn write_jpeg(
    wic: &IWICImagingFactory,
    source: &IWICBitmapSource,
    tw: u32,
    th: u32,
    out: &str,
) -> Result<()> {
    unsafe {
        let scaler = wic.CreateBitmapScaler()?;
        scaler.Initialize(source, tw, th, WICBitmapInterpolationModeFant)?;
        let bgr = wic.CreateFormatConverter()?;
        bgr.Initialize(
            &scaler,
            &GUID_WICPixelFormat24bppBGR,
            WICBitmapDitherTypeNone,
            None,
            0.0,
            WICBitmapPaletteTypeCustom,
        )?;
        let stream = wic.CreateStream()?;
        stream.InitializeFromFilename(&HSTRING::from(out), GENERIC_WRITE.0)?;
        let encoder = wic.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut props = None;
        encoder.CreateNewFrame(&mut frame, &mut props)?;
        let frame = frame.ok_or_else(Error::empty)?;
        frame.Initialize(props.as_ref())?;
        frame.SetSize(tw, th)?;
        let mut format = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut format)?;
        frame.WriteSource(&bgr, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;
    }
    Ok(())
}

/// One decoded frame near THUMB_AT_S (the first one in a shorter clip), as
/// tight 32-bit BGRX rows.
fn video_frame(src: &str) -> Result<(Vec<u8>, u32, u32)> {
    unsafe {
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 1)?;
        let attrs = attrs.ok_or_else(Error::empty)?;
        // The reader converts to RGB itself (decoder + colour converter).
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
        let reader = MFCreateSourceReaderFromURL(&HSTRING::from(src), &attrs)?;
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        reader.SetStreamSelection(VIDEO, true)?;
        let want = MFCreateMediaType()?;
        want.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        want.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
        reader.SetCurrentMediaType(VIDEO, None, &want)?;
        let size = reader
            .GetCurrentMediaType(VIDEO)?
            .GetUINT64(&MF_MT_FRAME_SIZE)?;
        let (w, h) = ((size >> 32) as u32, size as u32);
        seek(&reader, (THUMB_AT_S * TICKS) as i64);
        let mut last = None;
        loop {
            let mut flags = 0u32;
            let mut sample = None;
            reader.ReadSample(VIDEO, 0, None, Some(&mut flags), None, Some(&mut sample))?;
            if let Some(s) = sample {
                last = Some(s);
                break;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
        // A clip shorter than the seek point: its first frame instead.
        let sample = match last {
            Some(s) => s,
            None => {
                seek(&reader, 0);
                let mut sample = None;
                reader.ReadSample(VIDEO, 0, None, None, None, Some(&mut sample))?;
                sample.ok_or_else(Error::empty)?
            }
        };
        Ok((rows(&sample, w, h)?, w, h))
    }
}

/// A decoded RGB32 sample as tight top-down 32-bit BGRX rows.
pub(super) fn rows(sample: &IMFSample, w: u32, h: u32) -> Result<Vec<u8>> {
    let mut out = vec![0u8; (w * h * 4) as usize];
    let row = (w * 4) as usize;
    unsafe {
        let buffer = sample.ConvertToContiguousBuffer()?;
        if let Ok(b2) = buffer.cast::<IMF2DBuffer>() {
            let mut line = std::ptr::null_mut();
            let mut pitch = 0i32;
            b2.Lock2D(&mut line, &mut pitch)?;
            if pitch.unsigned_abs() as usize >= row {
                for y in 0..h as isize {
                    let from = line.offset(y * pitch as isize);
                    std::ptr::copy_nonoverlapping(
                        from,
                        out.as_mut_ptr().add(y as usize * row),
                        row,
                    );
                }
            }
            b2.Unlock2D()?;
        } else {
            let mut data = std::ptr::null_mut();
            let mut len = 0u32;
            buffer.Lock(&mut data, None, Some(&mut len))?;
            let n = out.len().min(len as usize);
            std::ptr::copy_nonoverlapping(data, out.as_mut_ptr(), n);
            buffer.Unlock()?;
        }
    }
    Ok(out)
}

/// Moves the reader to `ticks` (it lands on the keyframe before); a source
/// that cannot seek just starts at the beginning.
pub(super) fn seek(reader: &IMFSourceReader, ticks: i64) {
    let mut at = PROPVARIANT::default();
    unsafe {
        let v = &mut *at.Anonymous.Anonymous;
        v.vt = VT_I8;
        v.Anonymous.hVal = ticks;
        let _ = reader.SetCurrentPosition(&GUID::zeroed(), &at);
    }
}

pub struct Trimmed {
    /// Where the copy really starts and how long it is, in seconds.
    pub start: f64,
    pub seconds: f64,
}

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
const THUMB_MIN: u64 = 64;
const THUMB_MAX: u64 = 1280;

pub(super) fn text(req: &Value, key: &str) -> std::result::Result<String, Fail> {
    match req.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_owned()),
        _ => Err(Fail::code("bad_request")),
    }
}

/// Runs `work` on a thread of its own and sends its answer as the event
/// `{ event, token, ... }`; the request itself answers `{ queued: true }`.
pub(super) fn spawn(
    jobs: &Jobs,
    notify: Notify,
    event: &'static str,
    token: Value,
    work: impl FnOnce() -> Value + Send + 'static,
) -> std::result::Result<Value, Fail> {
    jobs.fetch_add(1, Ordering::SeqCst);
    let jobs = jobs.clone();
    std::thread::spawn(move || {
        let answer = {
            let _com = Worker::start();
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                .unwrap_or_else(|_| json!({ "error": "crashed" }))
        };
        jobs.fetch_sub(1, Ordering::SeqCst);
        let mut line = json!({ "event": event, "token": token });
        if let (Some(line), Some(answer)) = (line.as_object_mut(), answer.as_object()) {
            line.extend(answer.clone());
        }
        notify(line);
    });
    Ok(json!({ "queued": true }))
}

/// `{ src, out, width?, video?, token }`: a JPEG preview of a saved picture or
/// video, written to `out` (through `out.part`). Answers the
/// event `thumb_done` with `width`/`height` of the source, or `error`.
pub fn start_thumb(req: &Value, notify: Notify, jobs: &Jobs) -> std::result::Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let width = req
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or(480)
        .clamp(THUMB_MIN, THUMB_MAX) as u32;
    let video = req.get("video").and_then(Value::as_bool).unwrap_or(false);
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    spawn(jobs, notify, "thumb_done", token, move || {
        let part = format!("{out}.part");
        let made = thumb(&src, &part, width, video).and_then(|size| {
            std::fs::rename(&part, &out).map_err(|_| Error::empty())?;
            Ok(size)
        });
        match made {
            Ok((w, h)) => json!({ "width": w, "height": h }),
            Err(_) => {
                let _ = std::fs::remove_file(&part);
                json!({ "error": "thumb_failed" })
            }
        }
    })
}

/// `{ src, out, start, end, token }` (seconds): a trimmed copy of a video,
/// streams copied as stored. Answers the event `trim_done` with where the copy
/// really starts and how long it is, or `error`.
pub fn start_trim(req: &Value, notify: Notify, jobs: &Jobs) -> std::result::Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let num = |k: &str| req.get(k).and_then(Value::as_f64).filter(|n| n.is_finite());
    let (Some(start), Some(end)) = (num("start"), num("end")) else {
        return Err(Fail::code("bad_request"));
    };
    if start < 0.0 || end <= start {
        return Err(Fail::code("bad_range"));
    }
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    spawn(jobs, notify, "trim_done", token, move || {
        let part = format!("{out}.part");
        let cut = match trim(&src, &part, start, end) {
            Ok(cut) => cut,
            Err(_) => {
                let _ = std::fs::remove_file(&part);
                return json!({ "error": "trim_failed" });
            }
        };
        if cut.seconds < MIN_SECONDS {
            let _ = std::fs::remove_file(&part);
            return json!({ "error": "empty" });
        }
        match crate::faststart::settle(Path::new(&part), Path::new(&out)) {
            Ok(()) => json!({ "start": cut.start, "seconds": cut.seconds }),
            Err((code, _)) => json!({ "error": code }),
        }
    })
}

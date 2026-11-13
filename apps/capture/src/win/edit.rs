//! The gallery's work on files Xenon saved: a small JPEG preview of a picture
//! or a video, and a trimmed copy of a video. A trim copies the streams as
//! they are stored (no re-encoding: instant, no quality lost), so it starts
//! on the keyframe at or before the asked start (recordings have one every
//! second). Each job runs on a thread of its own; the caller answers with an
//! event when it is done.

use std::path::Path;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use windows::core::{Error, GUID, Interface, Result};
use windows::Win32::Graphics::Imaging::{CLSID_WICImagingFactory, IWICImagingFactory};
use windows::Win32::Media::MediaFoundation::{IMF2DBuffer, IMFSample, IMFSourceReader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION, MFShutdown, MFStartup, MFSTARTUP_LITE};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Variant::VT_I8;

use crate::proto::{Fail, Notify};

mod thumb;
mod trim;

pub use thumb::{jpeg, thumb};
pub use trim::{Jobs, trim};
use trim::{THUMB_MAX, THUMB_MIN};
pub(super) use trim::text;

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

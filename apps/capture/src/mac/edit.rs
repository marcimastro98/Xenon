//! Gallery jobs on macOS: previews (sips, qlmanage), trims (avconvert) and the
//! sound for a transcript (afconvert). Each runs on a thread of its own and
//! answers with an event, like the Windows engine (win/edit.rs).

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::run;
use super::tools;
use crate::proto::{Fail, Notify};

/// Gallery jobs running now; while any runs the engine does not exit for idleness.
pub type Jobs = Arc<AtomicUsize>;

const THUMB_MIN: u64 = 64;
const THUMB_MAX: u64 = 1280;
const THUMB_DEADLINE: Duration = Duration::from_secs(30);
/// A passthrough copy reads and writes the file once; an hour of 1080p is a
/// few gigabytes.
const TRIM_DEADLINE: Duration = Duration::from_secs(15 * 60);
const SPEECH_DEADLINE: Duration = Duration::from_secs(30 * 60);
/// A trim shorter than this is not worth keeping (as win/edit.rs).
const MIN_SECONDS: f64 = 0.5;

pub fn text(req: &Value, key: &str) -> Result<String, Fail> {
    match req.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_owned()),
        _ => Err(Fail::code("bad_request")),
    }
}

/// Runs `work` on its own thread; the answer comes as `{ event, token, ... }`.
pub(super) fn spawn(
    jobs: &Jobs,
    notify: Notify,
    event: &'static str,
    token: Value,
    work: impl FnOnce() -> Value + Send + 'static,
) -> Result<Value, Fail> {
    jobs.fetch_add(1, Ordering::SeqCst);
    let jobs = jobs.clone();
    std::thread::spawn(move || {
        let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
            .unwrap_or_else(|_| json!({ "error": "crashed" }));
        jobs.fetch_sub(1, Ordering::SeqCst);
        let mut line = json!({ "event": event, "token": token });
        if let (Some(line), Some(answer)) = (line.as_object_mut(), answer.as_object()) {
            line.extend(answer.clone());
        }
        notify(line);
    });
    Ok(json!({ "queued": true }))
}

/// `{ src, out, width?, video?, token }`: see win/edit.rs `start_thumb`.
pub fn start_thumb(req: &Value, notify: Notify, jobs: &Jobs) -> Result<Value, Fail> {
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
        let made = if video {
            video_thumb(&src, width, &part)
        } else {
            picture_thumb(&src, width, &part)
        };
        match made.filter(|_| std::fs::rename(&part, &out).is_ok()) {
            Some((w, h)) => json!({ "width": w, "height": h }),
            None => {
                let _ = std::fs::remove_file(&part);
                json!({ "error": "thumb_failed" })
            }
        }
    })
}

/// A JPEG of a saved picture; answers the picture's own size.
fn picture_thumb(src: &str, width: u32, out: &str) -> Option<(u32, u32)> {
    let size = run::run(
        run::SIPS,
        &[
            "-g".into(),
            "pixelWidth".into(),
            "-g".into(),
            "pixelHeight".into(),
            src.into(),
        ],
        None,
        THUMB_DEADLINE,
    )
    .filter(|o| o.ok)
    .and_then(|o| tools::sips_size(&o.stdout))?;
    sips_jpeg(src, width.min(size.0), out)?;
    Some(size)
}

/// A JPEG of a video's preview frame, through Quick Look; answers the frame's size.
fn video_thumb(src: &str, width: u32, out: &str) -> Option<(u32, u32)> {
    let dir = format!("{out}.frame");
    std::fs::create_dir_all(&dir).ok()?;
    let made = (|| {
        run::run(
            run::QLMANAGE,
            &tools::video_frame_args(src, width, &dir),
            None,
            THUMB_DEADLINE,
        )
        .filter(|o| o.ok)?;
        let name = Path::new(src).file_name()?.to_string_lossy().into_owned();
        let frame = format!("{dir}/{name}.png");
        let head = std::fs::read(&frame).ok()?;
        let size = tools::png_size(&head)?;
        sips_jpeg(&frame, width, out)?;
        Some(size)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    made
}

fn sips_jpeg(src: &str, width: u32, out: &str) -> Option<()> {
    run::run(
        run::SIPS,
        &tools::thumb_args(src, width, out),
        None,
        THUMB_DEADLINE,
    )
    .filter(|o| o.ok)
    .filter(|_| std::fs::metadata(out).is_ok_and(|m| m.len() > 0))
    .map(|_| ())
}

/// `{ src, out, start, end, token }`: see win/edit.rs `start_trim`. avconvert
/// copies the streams as stored; the cut starts where it was asked.
pub fn start_trim(req: &Value, notify: Notify, jobs: &Jobs) -> Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let num = |k: &str| req.get(k).and_then(Value::as_f64).filter(|n| n.is_finite());
    let (Some(start), Some(end)) = (num("start"), num("end")) else {
        return Err(Fail::code("bad_request"));
    };
    if start < 0.0 || end <= start {
        return Err(Fail::code("bad_range"));
    }
    let seconds = end - start;
    if seconds < MIN_SECONDS {
        return Err(Fail::code("bad_range"));
    }
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    spawn(jobs, notify, "trim_done", token, move || {
        // avconvert picks the container by the name's extension: a .mov first.
        let part = format!("{out}.part.mov");
        let made = run::run(
            run::AVCONVERT,
            &tools::trim_args(&src, &part, start, seconds),
            None,
            TRIM_DEADLINE,
        )
        .is_some_and(|o| o.ok)
            && std::fs::metadata(&part).is_ok_and(|m| m.len() > 0)
            && std::fs::rename(&part, &out).is_ok();
        if made {
            json!({ "start": start, "seconds": seconds })
        } else {
            let _ = std::fs::remove_file(&part);
            json!({ "error": "trim_failed" })
        }
    })
}

/// `{ src, out, token }`: the video's sound as a 16 kHz mono WAV (see
/// win/speech.rs). Answers `speech_done` with `seconds` and `cut`, or `error`
/// `no_audio` when the video has no sound to read.
pub fn start_speech(req: &Value, notify: Notify, jobs: &Jobs) -> Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    spawn(jobs, notify, "speech_done", token, move || {
        let part = format!("{out}.part.wav");
        let made = to_wav(&src, &part) && std::fs::rename(&part, &out).is_ok();
        if !made {
            let _ = std::fs::remove_file(&part);
            return json!({ "error": "no_audio" });
        }
        let seconds = tools::wav_seconds(std::fs::metadata(&out).map_or(0, |m| m.len()));
        if seconds <= 0.0 {
            let _ = std::fs::remove_file(&out);
            return json!({ "error": "no_audio" });
        }
        json!({ "seconds": seconds, "cut": false })
    })
}

/// afconvert reads most videos directly; a container it cannot open goes
/// through an M4A of the sound alone. Neither working means there is no sound.
fn to_wav(src: &str, out: &str) -> bool {
    let wav = |from: &str| {
        run::run(
            run::AFCONVERT,
            &tools::speech_args(from, out),
            None,
            SPEECH_DEADLINE,
        )
        .is_some_and(|o| o.ok)
            && std::fs::metadata(out).is_ok_and(|m| m.len() > crate::speech::HEADER_LEN as u64)
    };
    if wav(src) {
        return true;
    }
    let sound = format!("{out}.m4a");
    let ok = run::run(
        run::AVCONVERT,
        &tools::sound_only_args(src, &sound),
        None,
        SPEECH_DEADLINE,
    )
    .is_some_and(|o| o.ok)
        && wav(&sound);
    let _ = std::fs::remove_file(&sound);
    ok
}

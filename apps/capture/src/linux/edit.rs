//! Gallery jobs on Linux, all through ffmpeg: previews, trims and the sound for
//! a transcript. Each runs on a thread of its own and answers with an event,
//! like the Windows engine (win/edit.rs).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::run;
use super::tools;
use crate::proto::{Fail, Notify};

/// Gallery jobs running now; while any runs the engine does not exit for idleness.
pub type Jobs = Arc<AtomicUsize>;

/// ffmpeg and ffprobe, as found on PATH.
#[derive(Clone)]
pub struct Ffmpeg {
    pub ffmpeg: String,
    pub ffprobe: String,
}

const THUMB_MIN: u64 = 64;
const THUMB_MAX: u64 = 1280;
const THUMB_DEADLINE: Duration = Duration::from_secs(30);
/// A passthrough copy reads and writes the file once.
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

fn made(out: &str) -> bool {
    std::fs::metadata(out).is_ok_and(|m| m.len() > 0)
}

/// `{ src, out, width?, video?, token }`: see win/edit.rs `start_thumb`.
pub fn start_thumb(req: &Value, notify: Notify, jobs: &Jobs, ff: &Ffmpeg) -> Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let width = req
        .get("width")
        .and_then(Value::as_u64)
        .unwrap_or(480)
        .clamp(THUMB_MIN, THUMB_MAX) as u32;
    let video = req.get("video").and_then(Value::as_bool).unwrap_or(false);
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    let ff = ff.clone();
    spawn(jobs, notify, "thumb_done", token, move || {
        let part = format!("{out}.part");
        let size = run::run(
            &ff.ffprobe,
            &tools::probe_size_args(&src),
            None,
            THUMB_DEADLINE,
        )
        .filter(|o| o.ok)
        .and_then(|o| tools::parse_size(&o.stdout));
        let shoot = |pick: bool| {
            run::run(
                &ff.ffmpeg,
                &tools::thumb_args(&src, width, pick, &part),
                None,
                THUMB_DEADLINE,
            )
            .is_some_and(|o| o.ok)
                && made(&part)
        };
        // ffmpeg's thumbnail filter writes nothing for a video shorter than
        // its batch (wf-recorder keeps one frame of a screen that never
        // changed): the first frame stands in.
        let ok = size.is_some()
            && (shoot(video) || (video && shoot(false)))
            && std::fs::rename(&part, &out).is_ok();
        match size.filter(|_| ok) {
            Some((w, h)) => json!({ "width": w, "height": h }),
            None => {
                let _ = std::fs::remove_file(&part);
                json!({ "error": "thumb_failed" })
            }
        }
    })
}

/// `{ src, out, start, end, token }`: see win/edit.rs `start_trim`.
pub fn start_trim(req: &Value, notify: Notify, jobs: &Jobs, ff: &Ffmpeg) -> Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let num = |k: &str| req.get(k).and_then(Value::as_f64).filter(|n| n.is_finite());
    let (Some(start), Some(end)) = (num("start"), num("end")) else {
        return Err(Fail::code("bad_request"));
    };
    if start < 0.0 || end <= start || end - start < MIN_SECONDS {
        return Err(Fail::code("bad_range"));
    }
    let seconds = end - start;
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    let ffmpeg = ff.ffmpeg.clone();
    spawn(jobs, notify, "trim_done", token, move || {
        let part = format!("{out}.part");
        let ok = run::run(
            &ffmpeg,
            &tools::trim_args(&src, &part, start, seconds),
            None,
            TRIM_DEADLINE,
        )
        .is_some_and(|o| o.ok)
            && made(&part)
            && std::fs::rename(&part, &out).is_ok();
        if ok {
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
pub fn start_speech(req: &Value, notify: Notify, jobs: &Jobs, ff: &Ffmpeg) -> Result<Value, Fail> {
    let src = text(req, "src")?;
    let out = text(req, "out")?;
    let token = req.get("token").cloned().unwrap_or(Value::Null);
    let ffmpeg = ff.ffmpeg.clone();
    spawn(jobs, notify, "speech_done", token, move || {
        let part = format!("{out}.part");
        // ffmpeg fails on a video with no sound ("does not contain any stream").
        let ok = run::run(
            &ffmpeg,
            &tools::speech_args(&src, &part),
            None,
            SPEECH_DEADLINE,
        )
        .is_some_and(|o| o.ok)
            && std::fs::rename(&part, &out).is_ok();
        let seconds = if ok {
            tools::wav_seconds(std::fs::metadata(&out).map_or(0, |m| m.len()))
        } else {
            0.0
        };
        if seconds <= 0.0 {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&out);
            return json!({ "error": "no_audio" });
        }
        json!({ "seconds": seconds, "cut": false })
    })
}

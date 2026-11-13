//! The gallery's exports of a saved video on macOS, answered as on Windows
//! (win/export.rs; crate::reframe plans them): a vertical 9:16 copy (with the
//! recording's webcam on top when asked), a copy that fits in a number of
//! megabytes, and a GIF. AVFoundation decodes (reader.rs), the frames are cut
//! and scaled on the CPU (crate::stack) and AVFoundation encodes them again
//! (encode.rs); the first sound track, the mix, is copied as stored. ImageIO
//! writes the GIF (image.rs). `export_cancel` stops it between two frames and
//! leaves no file behind.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use objc2::rc::{autoreleasepool, Retained};
use objc2_core_media::CMSampleBuffer;
use serde_json::{json, Value};

use super::edit::{spawn, text, Jobs};
use super::encode::Encoder;
use super::reader::Read;
use crate::bubble::Corner;
use crate::proto::{Fail, Notify};
use crate::reframe::{Focus, Pace};
use crate::stack::Stack;

mod source;
mod copies;

use copies::{fit, gif, vertical};
use source::{Frames, Opened, Plan};

/// Asked to stop: the running export ends at its next frame.
static CANCEL: AtomicBool = AtomicBool::new(false);
/// A GIF past this many bytes is refused: no chat or page takes one that big.
const GIF_MAX_BYTES: u64 = 256 * 1_000_000;
/// ImageIO wants a GIF's frame count before its first frame, so the frames
/// wait in memory until the end; past this many bytes of them, `too_big`
/// (about 80 s at the GIF's size).
const GIF_MAX_HELD: usize = 512 * 1_000_000;
/// Tries at a copy that must fit, each with less bitrate than the last.
const FIT_TRIES: u32 = 3;
/// Progress events at most every this much of the clip.
const PROGRESS_STEP: f64 = 0.03;
/// The sizes a copy may be asked to fit in, in megabytes (as win/export.rs).
const FIT_MB_MAX: u64 = 4000;
/// Neither track taking more for this long is a stuck encoder.
const STALL: Duration = Duration::from_secs(30);
/// The wait before asking a busy encoder again.
const IDLE: Duration = Duration::from_millis(2);

#[derive(Clone, Copy)]
enum Kind {
    /// The part kept, and the corner of the webcam bubble to put on top.
    Vertical(Focus, Option<Corner>),
    Fit(u64),
    Gif,
}

/// Why an export stopped; anything AVFoundation refused is `Failed`.
enum Stop {
    Cancelled,
    TooBig,
    TooLong,
    DiskFull,
    Failed,
}

impl From<Fail> for Stop {
    fn from(f: Fail) -> Stop {
        if f.code == "disk_full" {
            Stop::DiskFull
        } else {
            Stop::Failed
        }
    }
}

impl Stop {
    fn code(&self) -> &'static str {
        match self {
            Stop::Cancelled => "cancelled",
            Stop::TooBig => "too_big",
            Stop::TooLong => "too_long",
            Stop::DiskFull => "disk_full",
            Stop::Failed => "export_failed",
        }
    }
}

type Out<T> = Result<T, Stop>;

fn cancelled() -> Out<()> {
    match CANCEL.load(Ordering::SeqCst) {
        true => Err(Stop::Cancelled),
        false => Ok(()),
    }
}

/// One turn of the copy loop: a frame to the video input and a piece of
/// sound to its input, each when that input takes more. Whether anything moved.
fn step(
    o: &Opened,
    encoder: &Encoder,
    frames: &mut Frames,
    first: &mut Option<Retained<CMSampleBuffer>>,
    done: &mut (bool, bool),
    progress: &mut dyn FnMut(f64),
) -> Out<bool> {
    let mut moved = false;
    if !done.0 && encoder.video_ready() {
        moved = true;
        match o.next(first) {
            Read::Sample(s) => frames.take(&s, encoder, progress)?,
            Read::End => {
                done.0 = true;
                encoder.end_video();
            }
            Read::Failed => return Err(Stop::Failed),
        }
    }
    // A sound the copy cannot take is still read: a track left unread holds
    // the reader up.
    if !done.1 && (encoder.sound_ready() || !encoder.has_sound()) {
        moved = true;
        match o.source.next_sound() {
            Read::Sample(s) => encoder.sound(&s)?,
            Read::End => {
                done.1 = true;
                encoder.end_sound();
            }
            Read::Failed => return Err(Stop::Failed),
        }
    }
    Ok(moved)
}

fn feed(o: &Opened, encoder: &Encoder, plan: &Plan, progress: &mut dyn FnMut(f64)) -> Out<()> {
    let base = o.base()?;
    encoder.begin(base);
    let mut frames = Frames {
        stack: Stack::new(&plan.parts),
        pace: Pace::every(plan.fps),
        base,
        total: o.total(),
    };
    let mut first = Some(o.first.clone());
    let mut done = (false, o.source.sound.is_none());
    let mut busy_since = Instant::now();
    while !(done.0 && done.1) {
        cancelled()?;
        encoder.check()?;
        let moved =
            autoreleasepool(|_| step(o, encoder, &mut frames, &mut first, &mut done, progress))?;
        if moved {
            busy_since = Instant::now();
        } else if busy_since.elapsed() > STALL {
            return Err(Stop::Failed);
        } else {
            std::thread::sleep(IDLE);
        }
    }
    Ok(())
}

fn run(src: &str, out: &str, kind: Kind, seconds: f64, progress: &mut dyn FnMut(f64)) -> Value {
    let ext = if matches!(kind, Kind::Gif) {
        "gif"
    } else {
        "mp4"
    };
    let part = PathBuf::from(format!("{out}.part.{ext}"));
    let _ = std::fs::remove_file(&part);
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
        _ => crate::faststart::settle(&part, Path::new(out)).map_err(|(code, _)| code),
    };
    match settled {
        Ok(()) => {
            let bytes = std::fs::metadata(out).map_or(0, |m| m.len());
            json!({ "width": w, "height": h, "bytes": bytes })
        }
        Err(code) => json!({ "error": code }),
    }
}

/// `{ src, out, kind, focus?, webcam?, mb?, seconds?, token }`, as
/// win/export.rs `start_export`: answers `{ queued }`, then `export_progress`
/// `{ token, pct }` events and `export_done` with `width`, `height` and
/// `bytes`, or `error` (cancelled, too_long, too_big, export_failed,
/// disk_full, write_failed).
pub fn start_export(req: &Value, notify: Notify, jobs: &Jobs) -> Result<Value, Fail> {
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

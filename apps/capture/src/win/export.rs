//! The gallery's exports of a saved video (crate::reframe plans them): a
//! vertical 9:16 copy (with the recording's webcam on top when asked), a copy
//! that fits in a number of megabytes, and a GIF.
//! Frames are decoded to NV12, cropped and scaled on the CPU and encoded again
//! (H.264, on the GPU's encoder when it takes system memory, Windows' own
//! otherwise); the first sound track, the mix, is copied as stored. The server
//! runs one export at a time; `export_cancel` stops it between two frames and
//! leaves no file behind.
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use windows::core::Error;

use super::edit::{Jobs, spawn, text};
use crate::bubble::Corner;
use crate::proto::{Fail, Notify};
use crate::reframe::Focus;

mod source;
mod encode;
mod copies;
mod gif;

use copies::{fit, vertical};
#[cfg(test)]
use encode::luma_rows;
use gif::gif;

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

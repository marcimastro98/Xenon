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
use super::frame::{self, Locked};
use super::image;
use super::reader::{self, Read, Source};
use super::writer::Shape;
use crate::bubble::{self, Corner};
use crate::proto::{Fail, Notify};
use crate::reframe::{self, Crop, Focus, Pace, Resampler};
use crate::stack::Stack;
use crate::video::TICKS_PER_SECOND;

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

/// A source with its first frame read: every plan is made on the size the
/// decoder hands, which is what the CPU cuts.
struct Opened {
    source: Source,
    first: Retained<CMSampleBuffer>,
    size: (u32, u32),
}

fn open(src: &str, pixels: u32, with_sound: bool) -> Out<Opened> {
    let source = reader::open(src, pixels, with_sound).ok_or(Stop::Failed)?;
    let Read::Sample(first) = source.next_video() else {
        return Err(Stop::Failed);
    };
    let buffer = unsafe { first.image_buffer() }.ok_or(Stop::Failed)?;
    let size = frame::size(&buffer);
    if size.0 < 2 || size.1 < 2 {
        return Err(Stop::Failed);
    }
    Ok(Opened {
        source,
        first,
        size,
    })
}

impl Opened {
    /// The first frame again, then the rest.
    fn next(&self, first: &mut Option<Retained<CMSampleBuffer>>) -> Read {
        match first.take() {
            Some(s) => Read::Sample(s),
            None => self.source.next_video(),
        }
    }

    fn base(&self) -> Out<i64> {
        reader::time_of(&self.first).ok_or(Stop::Failed)
    }

    fn total(&self) -> f64 {
        (self.source.seconds * TICKS_PER_SECOND as f64).max(1.0)
    }
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

/// A crop on even pixels: NV12 pairs every two pixels for colour.
fn even_crop(c: Crop) -> Crop {
    Crop {
        x: c.x & !1,
        y: c.y & !1,
        w: c.w & !1,
        h: c.h & !1,
    }
}

/// Encoders take even sizes only.
fn even((w, h): (u32, u32)) -> (u32, u32) {
    ((w & !1).max(2), (h & !1).max(2))
}

/// Each frame the copy keeps: cut and stacked into a frame from the
/// encoder's pool, with the source's colour tags.
struct Frames {
    stack: Stack,
    pace: Pace,
    base: i64,
    total: f64,
}

impl Frames {
    fn take(
        &mut self,
        sample: &CMSampleBuffer,
        encoder: &Encoder,
        progress: &mut dyn FnMut(f64),
    ) -> Out<()> {
        let Some(t) = reader::time_of(sample) else {
            return Ok(());
        };
        let at = t - self.base;
        if at < 0 || !self.pace.take(at) {
            return Ok(());
        }
        let src = unsafe { sample.image_buffer() }.ok_or(Stop::Failed)?;
        let out = encoder.blank()?;
        {
            let from = Locked::read(&src).ok_or(Stop::Failed)?;
            let mut to = Locked::write(&out).ok_or(Stop::Failed)?;
            let (Some(src_planes), Some(out_planes)) = (from.planes(), to.planes_mut()) else {
                return Err(Stop::Failed);
            };
            self.stack.run(src_planes, out_planes);
        }
        // Primaries, matrix and transfer, so the copy plays in the same colours.
        src.propagate_attachments(&out);
        encoder.picture(&out, t)?;
        progress(at as f64 / self.total);
        Ok(())
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

/// The opened source encoded as `plan` says into an MP4 at `part`.
fn transcode(o: Opened, part: &Path, plan: &Plan, progress: &mut dyn FnMut(f64)) -> Out<()> {
    let _ = std::fs::remove_file(part);
    let shape = Shape {
        width: plan.size.0,
        height: plan.size.1,
        fps: plan.fps,
        bitrate: plan.bps,
        tracks: 0,
    };
    let encoder = Encoder::new(part, &shape, o.source.sound.as_ref().map(|s| s.format()))?;
    match feed(&o, &encoder, plan, progress) {
        Ok(()) => encoder.finish().map_err(Stop::from),
        Err(stop) => {
            encoder.cancel();
            Err(stop)
        }
    }
}

/// A 9:16 copy; with the corner of the recording's webcam, that bubble on
/// top and the game below.
fn vertical(
    src: &str,
    part: &Path,
    focus: Focus,
    webcam: Option<Corner>,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let o = open(src, reader::NV12, true)?;
    let (w, h) = o.size;
    let parts = match webcam {
        Some(corner) => {
            let split = reframe::vertical_split(w, h, focus, bubble::place(w, h, corner));
            vec![split.cam, split.game]
        }
        None => vec![reframe::vertical(w, h, focus)],
    };
    let parts: Vec<_> = parts
        .into_iter()
        .map(|(crop, size)| (even_crop(crop), even(size)))
        .collect();
    let size = (parts[0].1 .0, parts.iter().map(|p| p.1 .1).sum());
    let fps = o.source.fps.min(60);
    let plan = Plan {
        parts,
        size,
        fps,
        bps: reframe::vertical_bitrate(size.0, size.1, fps),
    };
    transcode(o, part, &plan, progress)?;
    Ok(size)
}

fn fit(
    src: &str,
    part: &Path,
    target: u64,
    seconds: f64,
    progress: &mut dyn FnMut(f64),
) -> Out<(u32, u32)> {
    let o = open(src, reader::NV12, true)?;
    let length = if o.source.seconds > 0.0 {
        o.source.seconds
    } else {
        seconds
    };
    if !length.is_finite() || length <= 0.0 {
        return Err(Stop::Failed);
    }
    let sound = o.source.sound.as_ref().map_or(0, |s| s.bps);
    let (w, h) = o.size;
    let f =
        reframe::fit((w, h), o.source.fps.min(60), length, target, sound).ok_or(Stop::TooLong)?;
    let size = even((f.width, f.height));
    let mut plan = Plan {
        parts: vec![(even_crop(Crop::whole(w, h)), size)],
        size,
        fps: f.fps,
        bps: f.video_bps,
    };
    let mut opened = Some(o);
    for _ in 0..FIT_TRIES {
        let o = match opened.take() {
            Some(o) => o,
            None => open(src, reader::NV12, true)?,
        };
        transcode(o, part, &plan, progress)?;
        let written = std::fs::metadata(part).map_err(|_| Stop::Failed)?.len();
        if written <= target {
            return Ok(size);
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

/// A looping GIF: the decoder's colour frames scaled to the GIF's size,
/// written by ImageIO with a palette of its own each.
fn gif(src: &str, part: &Path, progress: &mut dyn FnMut(f64)) -> Out<(u32, u32)> {
    let o = open(src, reader::BGRA, false)?;
    let (w, h) = o.size;
    let size = even(reframe::gif_size(w, h));
    let scale = Resampler::new(4, Crop::whole(w, h), size);
    let mut px = vec![0u8; scale.len()];
    let most = GIF_MAX_HELD / scale.len().max(1);
    let mut pace = Pace::new(reframe::GIF_DELAY_CS as i64 * 100_000);
    let (base, total) = (o.base()?, o.total());
    let mut first = Some(o.first.clone());
    let mut kept = Vec::new();
    loop {
        cancelled()?;
        let sample = match o.next(&mut first) {
            Read::Sample(s) => s,
            Read::End => break,
            Read::Failed => return Err(Stop::Failed),
        };
        let Some(at) = reader::time_of(&sample).map(|t| t - base) else {
            continue;
        };
        if at < 0 || !pace.take(at) {
            continue;
        }
        let picture = autoreleasepool(|_| {
            let buffer = unsafe { sample.image_buffer() }?;
            let locked = Locked::read(&buffer)?;
            let plane = locked.plane(0)?;
            scale.run(plane.data, plane.stride, &mut px);
            image::from_bgrx(&px, size)
        });
        kept.push(picture.ok_or(Stop::Failed)?);
        progress(at as f64 / total);
        if kept.len() > most {
            return Err(Stop::TooBig);
        }
    }
    cancelled()?;
    if kept.is_empty() || !image::write_gif(&kept, reframe::GIF_DELAY_CS, part) {
        return Err(Stop::Failed);
    }
    if std::fs::metadata(part).map_or(0, |m| m.len()) > GIF_MAX_BYTES {
        return Err(Stop::TooBig);
    }
    Ok(size)
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
